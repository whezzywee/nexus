import { type LocalIdentity, signDevicePayload, verifyDevicePayload } from "@nexus/identity";
import { concatBytes, type DeviceCertificate } from "@nexus/protocol";

export type CommunityRole = "owner" | "admin" | "moderator" | "member";
export type MembershipAction = "add" | "remove" | "set_role" | "set_devices";

export interface CommunityMember {
  identityId: string;
  deviceIds: string[];
  role: CommunityRole;
  active: boolean;
}

export interface UnsignedMembershipOperation {
  protocolVersion: 2;
  operationId: string;
  communityId: string;
  actorId: string;
  actorDeviceId: string;
  actorSequence: number;
  targetIdentityId: string;
  targetDeviceIds: string[];
  action: MembershipAction;
  role?: CommunityRole;
  epoch: number;
  createdAt: string;
}

export interface MembershipOperation extends UnsignedMembershipOperation {
  publicKey: string;
  deviceCertificate: DeviceCertificate;
  signature: string;
}

export interface CommunityMembershipState {
  schemaVersion: 2;
  communityId: string;
  epoch: number;
  ownerId: string;
  ownerDeviceIds: string[];
  operations: Record<string, MembershipOperation>;
  members: Record<string, CommunityMember>;
  actorSequences: Record<string, number>;
  revokedDeviceIds: string[];
  seenOperationIds: string[];
}

const encoder = new TextEncoder();
const DOMAIN = encoder.encode("nexus:membership-operation:v2");

export function initialMembershipState(
  communityId: string,
  ownerId: string,
  ownerDeviceIds: string[],
): CommunityMembershipState {
  return {
    schemaVersion: 2,
    communityId,
    epoch: 0,
    ownerId,
    ownerDeviceIds: [...new Set(ownerDeviceIds)].sort(),
    operations: {},
    members: {
      [ownerId]: {
        identityId: ownerId,
        deviceIds: [...new Set(ownerDeviceIds)].sort(),
        role: "owner",
        active: true,
      },
    },
    actorSequences: {},
    revokedDeviceIds: [],
    seenOperationIds: [],
  };
}

export async function signMembershipOperation(
  identity: LocalIdentity,
  operation: UnsignedMembershipOperation,
): Promise<MembershipOperation> {
  if (
    operation.actorId !== identity.identityId ||
    operation.actorDeviceId !== identity.deviceId ||
    operation.actorSequence !== identity.nextSequence
  ) {
    throw new Error("Membership operation actor does not match the signing device");
  }
  const deviceSignature = await signDevicePayload(
    identity,
    canonicalMembershipBytes(operation),
    operation.actorId,
    operation.actorDeviceId,
  );
  identity.nextSequence += 1;
  await identity.onChange?.(identity);
  return {
    ...operation,
    targetDeviceIds: [...new Set(operation.targetDeviceIds)].sort(),
    ...deviceSignature,
  };
}

export async function applyMembershipOperation(
  current: CommunityMembershipState,
  operation: MembershipOperation,
): Promise<CommunityMembershipState> {
  if (current.seenOperationIds.includes(operation.operationId)) return current;
  if (!(await verifyMembershipOperation(operation))) {
    throw new Error("Membership operation signature is invalid");
  }
  if (
    operation.communityId !== current.communityId ||
    operation.epoch !== current.epoch + 1 ||
    operation.actorSequence <= (current.actorSequences[operation.actorDeviceId] ?? 0)
  ) {
    throw new Error("Membership operation sequence or epoch is invalid");
  }
  const actor = current.members[operation.actorId];
  if (
    !actor?.active ||
    !actor.deviceIds.includes(operation.actorDeviceId) ||
    !canApply(actor.role, current, operation)
  ) {
    throw new Error("Membership actor lacks authority for this operation");
  }

  const next = structuredClone(current);
  const target = next.members[operation.targetIdentityId];
  const requestedDevices = [...new Set(operation.targetDeviceIds)].sort();
  if (
    (operation.action === "add" || operation.action === "set_devices") &&
    requestedDevices.some((deviceId) => next.revokedDeviceIds.includes(deviceId))
  ) {
    throw new Error("A revoked device cannot be authorized again");
  }
  if (operation.action === "add") {
    if (!operation.role || operation.role === "owner" || operation.targetDeviceIds.length === 0) {
      throw new Error("Member add requires devices and a non-owner role");
    }
    next.members[operation.targetIdentityId] = {
      identityId: operation.targetIdentityId,
      deviceIds: requestedDevices,
      role: operation.role,
      active: true,
    };
  } else if (operation.action === "remove") {
    if (!target?.active || target.role === "owner") {
      throw new Error("Membership removal target is invalid");
    }
    next.revokedDeviceIds = [...new Set([...next.revokedDeviceIds, ...target.deviceIds])].sort();
    target.active = false;
    target.deviceIds = [];
  } else if (operation.action === "set_role") {
    if (
      !target?.active ||
      !operation.role ||
      (operation.role === "owner" && actor.role !== "owner")
    ) {
      throw new Error("Role assignment target is invalid");
    }
    if (operation.role === "owner") {
      for (const member of Object.values(next.members)) {
        if (member.active && member.role === "owner") member.role = "admin";
      }
    }
    target.role = operation.role;
  } else {
    if (!target?.active || operation.role || operation.targetDeviceIds.length === 0) {
      throw new Error("Device roster update target is invalid");
    }
    next.revokedDeviceIds = [
      ...new Set([
        ...next.revokedDeviceIds,
        ...target.deviceIds.filter((deviceId) => !requestedDevices.includes(deviceId)),
      ]),
    ].sort();
    target.deviceIds = requestedDevices;
  }
  next.epoch = operation.epoch;
  next.operations[operation.operationId] = operation;
  next.actorSequences[operation.actorDeviceId] = operation.actorSequence;
  next.seenOperationIds = [...next.seenOperationIds, operation.operationId].slice(-4096);
  return next;
}

export async function verifyMembershipOperation(operation: MembershipOperation): Promise<boolean> {
  try {
    const { publicKey, deviceCertificate, signature, ...unsigned } = operation;
    return verifyDevicePayload(
      { publicKey, deviceCertificate, signature },
      canonicalMembershipBytes(unsigned),
      operation.actorId,
      operation.actorDeviceId,
    );
  } catch {
    return false;
  }
}

export function canonicalMembershipBytes(operation: UnsignedMembershipOperation): Uint8Array {
  const fields = [
    operation.protocolVersion.toString(),
    operation.operationId,
    operation.communityId,
    operation.actorId,
    operation.actorDeviceId,
    operation.actorSequence.toString(),
    operation.targetIdentityId,
    [...new Set(operation.targetDeviceIds)].sort().join("\u001f"),
    operation.action,
    operation.role ?? "",
    operation.epoch.toString(),
    operation.createdAt,
  ];
  return concatBytes([frame(DOMAIN), ...fields.map((field) => frame(encoder.encode(field)))]);
}

function canApply(
  actorRole: CommunityRole,
  state: CommunityMembershipState,
  operation: MembershipOperation,
): boolean {
  if (actorRole === "owner") return true;
  const targetRole = state.members[operation.targetIdentityId]?.role;
  if (operation.action === "set_devices" && operation.actorId === operation.targetIdentityId) {
    return true;
  }
  if (actorRole === "admin") {
    return operation.role !== "owner" && targetRole !== "owner";
  }
  if (actorRole === "moderator") {
    return operation.action === "remove" && targetRole === "member";
  }
  return false;
}

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.byteLength);
  new DataView(output.buffer).setUint32(0, bytes.byteLength, false);
  output.set(bytes, 4);
  return output;
}
