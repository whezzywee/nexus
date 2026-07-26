import type { CommunityMembershipState, CommunityRole } from "@nexus/community";
import { type LocalIdentity, signDevicePayload, verifyDevicePayload } from "@nexus/identity";
import { concatBytes, type DeviceCertificate } from "@nexus/protocol";

export type ModerationAction = "hide" | "report" | "timeout" | "remove" | "appeal";
export type ModerationScope = "local" | "community";

export interface UnsignedModerationOperation {
  protocolVersion: 2;
  operationId: string;
  communityId: string;
  communityEpoch: number;
  actorId: string;
  actorDeviceId: string;
  actorSequence: number;
  action: ModerationAction;
  scope: ModerationScope;
  targetIdentityId: string;
  messageId?: string;
  reason: string;
  expiresAt?: string;
  createdAt: string;
}

export interface ModerationOperation extends UnsignedModerationOperation {
  publicKey: string;
  deviceCertificate: DeviceCertificate;
  signature: string;
}

export interface ModerationState {
  schemaVersion: 2;
  communityId: string;
  operations: Record<string, ModerationOperation>;
  actorSequences: Record<string, number>;
  hiddenMessageIds: string[];
  activeTimeouts: Record<string, ModerationOperation>;
  removedIdentityIds: string[];
  openAppeals: Record<string, ModerationOperation>;
}

const encoder = new TextEncoder();
const DOMAIN = encoder.encode("nexus:moderation-operation:v2");
const MAX_REASON_LENGTH = 500;
const MAX_OPERATIONS = 4096;

export function initialModerationState(communityId: string): ModerationState {
  return {
    schemaVersion: 2,
    communityId,
    operations: {},
    actorSequences: {},
    hiddenMessageIds: [],
    activeTimeouts: {},
    removedIdentityIds: [],
    openAppeals: {},
  };
}

export async function signModerationOperation(
  identity: LocalIdentity,
  operation: UnsignedModerationOperation,
): Promise<ModerationOperation> {
  validateShape(operation);
  if (
    operation.actorId !== identity.identityId ||
    operation.actorDeviceId !== identity.deviceId ||
    operation.actorSequence !== identity.nextSequence
  ) {
    throw new Error("Moderation operation actor does not match the signing device");
  }
  const deviceSignature = await signDevicePayload(
    identity,
    canonicalModerationBytes(operation),
    operation.actorId,
    operation.actorDeviceId,
  );
  identity.nextSequence += 1;
  await identity.onChange?.(identity);
  return {
    ...operation,
    ...deviceSignature,
  };
}

export async function verifyModerationOperation(operation: ModerationOperation): Promise<boolean> {
  try {
    validateShape(operation);
    const { publicKey, deviceCertificate, signature, ...unsigned } = operation;
    return verifyDevicePayload(
      { publicKey, deviceCertificate, signature },
      canonicalModerationBytes(unsigned),
      operation.actorId,
      operation.actorDeviceId,
    );
  } catch {
    return false;
  }
}

export async function applyModerationOperation(
  current: ModerationState,
  membership: CommunityMembershipState,
  operation: ModerationOperation,
): Promise<ModerationState> {
  if (current.operations[operation.operationId]) return current;
  if (!(await verifyModerationOperation(operation))) {
    throw new Error("Moderation operation signature is invalid");
  }
  if (
    current.communityId !== operation.communityId ||
    membership.communityId !== operation.communityId ||
    operation.communityEpoch > membership.epoch ||
    operation.actorSequence <= (current.actorSequences[operation.actorDeviceId] ?? 0)
  ) {
    throw new Error("Moderation operation sequence or community epoch is invalid");
  }
  if (!canApplyModeration(current, membership, operation)) {
    throw new Error("The actor lacks authority for this moderation action");
  }

  const next = structuredClone(current);
  next.operations[operation.operationId] = operation;
  next.actorSequences[operation.actorDeviceId] = operation.actorSequence;
  if (operation.action === "hide" && operation.messageId) {
    next.hiddenMessageIds = [...new Set([...next.hiddenMessageIds, operation.messageId])].sort();
  } else if (operation.action === "timeout") {
    next.activeTimeouts[operation.targetIdentityId] = operation;
  } else if (operation.action === "remove") {
    next.removedIdentityIds = [
      ...new Set([...next.removedIdentityIds, operation.targetIdentityId]),
    ].sort();
    delete next.activeTimeouts[operation.targetIdentityId];
  } else if (operation.action === "appeal") {
    next.openAppeals[operation.operationId] = operation;
  }

  const ordered = Object.values(next.operations).sort((left, right) =>
    left.operationId.localeCompare(right.operationId),
  );
  if (ordered.length > MAX_OPERATIONS) {
    const retained = ordered.slice(-MAX_OPERATIONS);
    next.operations = Object.fromEntries(retained.map((entry) => [entry.operationId, entry]));
  }
  return next;
}

export function visibleModerationAudit(state: ModerationState): ModerationOperation[] {
  return Object.values(state.operations).sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.operationId.localeCompare(left.operationId),
  );
}

export function canonicalModerationBytes(operation: UnsignedModerationOperation): Uint8Array {
  const fields = [
    "2",
    operation.operationId,
    operation.communityId,
    operation.communityEpoch.toString(),
    operation.actorId,
    operation.actorDeviceId,
    operation.actorSequence.toString(),
    operation.action,
    operation.scope,
    operation.targetIdentityId,
    operation.messageId ?? "",
    operation.reason,
    operation.expiresAt ?? "",
    operation.createdAt,
  ];
  return concatBytes([frame(DOMAIN), ...fields.map((field) => frame(encoder.encode(field)))]);
}

function canApplyModeration(
  state: ModerationState,
  membership: CommunityMembershipState,
  operation: ModerationOperation,
): boolean {
  if (operation.action === "appeal") {
    const relevantDecision = Object.values(state.operations).some(
      (entry) =>
        ["timeout", "remove"].includes(entry.action) &&
        entry.targetIdentityId === operation.actorId,
    );
    return operation.actorId === operation.targetIdentityId && relevantDecision;
  }

  const actor = membership.members[operation.actorId];
  if (!actor?.active || !actor.deviceIds.includes(operation.actorDeviceId)) {
    return false;
  }
  if (operation.action === "report") return operation.scope === "community";
  if (operation.action === "hide" && operation.scope === "local") {
    return true;
  }

  const targetRole = membership.members[operation.targetIdentityId]?.role;
  if (!targetRole || targetRole === "owner") return false;
  return roleCanActOn(actor.role, targetRole);
}

function roleCanActOn(actorRole: CommunityRole, targetRole: CommunityRole): boolean {
  if (actorRole === "owner") return targetRole !== "owner";
  if (actorRole === "admin") return ["moderator", "member"].includes(targetRole);
  if (actorRole === "moderator") return targetRole === "member";
  return false;
}

function validateShape(operation: UnsignedModerationOperation): void {
  if (
    operation.protocolVersion !== 2 ||
    !operation.operationId ||
    !operation.communityId ||
    !operation.actorId ||
    !operation.actorDeviceId ||
    !Number.isSafeInteger(operation.actorSequence) ||
    operation.actorSequence < 1 ||
    !Number.isSafeInteger(operation.communityEpoch) ||
    operation.communityEpoch < 0 ||
    !operation.targetIdentityId ||
    !operation.reason.trim() ||
    operation.reason.length > MAX_REASON_LENGTH ||
    (operation.action === "hide" && !operation.messageId) ||
    (operation.action === "timeout" && !operation.expiresAt) ||
    (operation.scope === "local" && operation.action !== "hide")
  ) {
    throw new Error("Moderation operation metadata is invalid");
  }
}

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.byteLength);
  new DataView(output.buffer).setUint32(0, bytes.byteLength, false);
  output.set(bytes, 4);
  return output;
}
