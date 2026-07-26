import {
  type CommunityMembershipState,
  initialMembershipState,
  signMembershipOperation,
} from "@nexus/community";
import {
  type ConversationDevice,
  type ConversationState,
  initialConversationState,
  prepareEpochRotation,
  signConversationControllerTransfer,
  verifyEpochRotation,
} from "@nexus/conversation";
import { X25519GroupCipher } from "@nexus/crypto";
import type { LocalDeviceState } from "@nexus/device";
import type { FreenetBridgeTransport } from "@nexus/freenet-client";
import {
  applyModerationOperation,
  initialModerationState,
  type ModerationAction,
  type ModerationState,
  signModerationOperation,
} from "@nexus/moderation";
import { bytesToBase64Url } from "@nexus/protocol";
import type { ChatSession } from "@nexus/sync-engine";
import { ulid } from "ulid";
import { InvitationAttemptLimiter, type InvitationRateStatus } from "./invite-limits";

export const PHASE3_COMMUNITY_ID = "01K10KJ6P20S58KQBV5P4E3CMT";
export const PHASE3_CONVERSATION_ID = "01K10KJ6P20S58KQBV5P4E3CNV";

export interface DeviceInvite {
  identityId: string;
  deviceId: string;
  displayName: string;
  encryptionPublicKey: string;
}

export interface AuthoritySnapshot {
  community: CommunityMembershipState;
  conversation: ConversationState;
  invite: DeviceInvite;
  authorized: boolean;
  canManage: boolean;
  canRotate: boolean;
  canTransfer: boolean;
  encryptionEpoch: number | null;
  invitationRate: InvitationRateStatus;
  moderation: ModerationState;
  error?: string;
}

export interface ModerationRequest {
  action: ModerationAction;
  targetIdentityId: string;
  reason: string;
  messageId?: string;
  timeoutMinutes?: number;
}

type AuthorityListener = (snapshot: AuthoritySnapshot) => void;

export class FreenetAuthorityController {
  private community!: CommunityMembershipState;
  private conversation!: ConversationState;
  private epochKey: CryptoKey | null = null;
  private error: string | undefined;
  private moderation = initialModerationState(PHASE3_COMMUNITY_ID);
  private readonly listeners = new Set<AuthorityListener>();
  private readonly invitationLimiter = new InvitationAttemptLimiter();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly transport: FreenetBridgeTransport,
    private readonly device: LocalDeviceState,
    private readonly session: ChatSession,
  ) {}

  async start(): Promise<void> {
    const initialCommunity = initialMembershipState(
      PHASE3_COMMUNITY_ID,
      this.device.identity.identityId,
      [this.device.identity.deviceId],
    );
    const initialConversation = initialConversationState(
      PHASE3_CONVERSATION_ID,
      this.device.identity.identityId,
      this.device.identity.deviceId,
      this.device.encryption.publicKeyBytes,
    );
    this.community = await this.readOrBootstrap("community", initialCommunity);
    this.conversation = this.normalizeConversation(
      await this.readOrBootstrap("conversation", initialConversation),
    );
    await this.synchronizeActorSequence();
    await this.openCurrentEpoch();
    if (
      this.conversation.epoch === 0 &&
      this.conversation.controllerId === this.device.identity.identityId
    ) {
      await this.rotateConversation([this.localConversationDevice()]);
    }
    await this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), 2_000);
  }

  subscribe(listener: AuthorityListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): AuthoritySnapshot {
    const member = this.community.members[this.device.identity.identityId];
    return {
      community: structuredClone(this.community),
      conversation: structuredClone(this.conversation),
      invite: this.invite(),
      authorized: Boolean(
        member?.active && member.deviceIds.includes(this.device.identity.deviceId),
      ),
      canManage: member?.active === true && ["owner", "admin"].includes(member.role),
      canTransfer: member?.active === true && member.role === "owner",
      canRotate: this.conversation.controllerId === this.device.identity.identityId,
      encryptionEpoch: this.epochKey ? this.conversation.epoch : null,
      invitationRate: this.invitationLimiter.status(),
      moderation: structuredClone(this.moderation),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  invite(): DeviceInvite {
    return {
      identityId: this.device.identity.identityId,
      deviceId: this.device.identity.deviceId,
      displayName: this.device.identity.displayName,
      encryptionPublicKey: bytesToBase64Url(this.device.encryption.publicKeyBytes),
    };
  }

  async authorizeInvite(invite: DeviceInvite): Promise<void> {
    this.validateInvite(invite);
    this.invitationLimiter.consume(`${invite.identityId}:${invite.deviceId}`);
    await this.refresh();
    if (this.conversation.controllerId !== this.device.identity.identityId) {
      throw new Error(
        "Only the private-conversation creator can authorize devices and rotate keys",
      );
    }
    const current = this.community.members[invite.identityId];
    const targetDeviceIds = [...new Set([...(current?.deviceIds ?? []), invite.deviceId])].sort();
    const operation = await signMembershipOperation(this.device.identity, {
      protocolVersion: 2,
      operationId: ulid(),
      communityId: this.community.communityId,
      actorId: this.device.identity.identityId,
      actorDeviceId: this.device.identity.deviceId,
      actorSequence: this.device.identity.nextSequence,
      targetIdentityId: invite.identityId,
      targetDeviceIds,
      action: current?.active ? "set_devices" : "add",
      ...(current?.active ? {} : { role: "member" as const }),
      epoch: this.community.epoch + 1,
      createdAt: new Date().toISOString(),
    });
    await this.transport.submitAuthority("community", operation);
    await this.waitForCommunityEpoch(operation.epoch);
    const devices = [
      ...Object.values(this.conversation.devices).filter(
        (candidate) => candidate.deviceId !== invite.deviceId,
      ),
      {
        identityId: invite.identityId,
        deviceId: invite.deviceId,
        encryptionPublicKey: invite.encryptionPublicKey,
      },
    ];
    await this.rotateConversation(devices);
    await this.refresh();
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.refresh();
    if (this.conversation.controllerId !== this.device.identity.identityId) {
      throw new Error("Only the private-conversation creator can revoke devices and rotate keys");
    }
    const target = Object.values(this.community.members).find(
      (member) => member.active && member.deviceIds.includes(deviceId),
    );
    if (!target) throw new Error("The selected device is not active");
    const remaining = target.deviceIds.filter((candidate) => candidate !== deviceId);
    if (target.role === "owner" && remaining.length === 0) {
      throw new Error("The community owner must retain at least one device");
    }
    const operation = await signMembershipOperation(this.device.identity, {
      protocolVersion: 2,
      operationId: ulid(),
      communityId: this.community.communityId,
      actorId: this.device.identity.identityId,
      actorDeviceId: this.device.identity.deviceId,
      actorSequence: this.device.identity.nextSequence,
      targetIdentityId: target.identityId,
      targetDeviceIds: remaining,
      action: remaining.length === 0 ? "remove" : "set_devices",
      epoch: this.community.epoch + 1,
      createdAt: new Date().toISOString(),
    });
    await this.transport.submitAuthority("community", operation);
    await this.waitForCommunityEpoch(operation.epoch);
    await this.rotateConversation(
      Object.values(this.conversation.devices).filter(
        (candidate) => candidate.deviceId !== deviceId,
      ),
    );
    await this.refresh();
  }

  async setRole(identityId: string, role: "admin" | "moderator" | "member"): Promise<void> {
    await this.refresh();
    const target = this.community.members[identityId];
    if (!target?.active || target.role === "owner") {
      throw new Error("The selected community member cannot change role");
    }
    const operation = await signMembershipOperation(this.device.identity, {
      protocolVersion: 2,
      operationId: ulid(),
      communityId: this.community.communityId,
      actorId: this.device.identity.identityId,
      actorDeviceId: this.device.identity.deviceId,
      actorSequence: this.device.identity.nextSequence,
      targetIdentityId: identityId,
      targetDeviceIds: [],
      action: "set_role",
      role,
      epoch: this.community.epoch + 1,
      createdAt: new Date().toISOString(),
    });
    await this.transport.submitAuthority("community", operation);
    await this.waitForCommunityEpoch(operation.epoch);
    await this.refresh();
  }

  async transferOwnership(identityId: string): Promise<void> {
    await this.refresh();
    const actor = this.community.members[this.device.identity.identityId];
    const target = this.community.members[identityId];
    if (actor?.active !== true || actor.role !== "owner") {
      throw new Error("Only the current owner can transfer ownership");
    }
    if (!target?.active || target.role === "owner") {
      throw new Error("Ownership can only be transferred to an active non-owner member");
    }

    if (this.conversation.controllerId !== identityId) {
      if (this.conversation.controllerId !== this.device.identity.identityId) {
        throw new Error(
          "Private-conversation control must be reconciled by its current controller first",
        );
      }
      const targetDevice = Object.values(this.conversation.devices).find(
        (candidate) =>
          candidate.identityId === identityId && target.deviceIds.includes(candidate.deviceId),
      );
      if (!targetDevice) {
        throw new Error("The successor needs an authorized conversation device first");
      }
      const transfer = await signConversationControllerTransfer(this.device.identity, {
        protocolVersion: 2,
        operationId: ulid(),
        conversationId: this.conversation.conversationId,
        actorId: this.device.identity.identityId,
        actorDeviceId: this.device.identity.deviceId,
        actorSequence: this.device.identity.nextSequence,
        conversationEpoch: this.conversation.epoch,
        targetIdentityId: identityId,
        targetDeviceId: targetDevice.deviceId,
        createdAt: new Date().toISOString(),
      });
      await this.transport.submitAuthority("conversation", transfer);
      await this.waitForConversationController(identityId);
    }

    const operation = await signMembershipOperation(this.device.identity, {
      protocolVersion: 2,
      operationId: ulid(),
      communityId: this.community.communityId,
      actorId: this.device.identity.identityId,
      actorDeviceId: this.device.identity.deviceId,
      actorSequence: this.device.identity.nextSequence,
      targetIdentityId: identityId,
      targetDeviceIds: [],
      action: "set_role",
      role: "owner",
      epoch: this.community.epoch + 1,
      createdAt: new Date().toISOString(),
    });
    await this.transport.submitAuthority("community", operation);
    await this.waitForCommunityEpoch(operation.epoch);
    await this.refresh();
  }

  async moderate(request: ModerationRequest): Promise<void> {
    await this.refresh();
    const timeoutMinutes = Math.max(1, Math.min(24 * 60, request.timeoutMinutes ?? 15));
    const operation = await signModerationOperation(this.device.identity, {
      protocolVersion: 2,
      operationId: ulid(),
      communityId: this.community.communityId,
      communityEpoch: this.community.epoch,
      actorId: this.device.identity.identityId,
      actorDeviceId: this.device.identity.deviceId,
      actorSequence: this.device.identity.nextSequence,
      action: request.action,
      scope: request.action === "hide" ? "local" : "community",
      targetIdentityId: request.targetIdentityId,
      ...(request.messageId ? { messageId: request.messageId } : {}),
      reason: request.reason.trim(),
      ...(request.action === "timeout"
        ? { expiresAt: new Date(Date.now() + timeoutMinutes * 60_000).toISOString() }
        : {}),
      createdAt: new Date().toISOString(),
    });
    this.moderation = await applyModerationOperation(this.moderation, this.community, operation);
    this.emit();

    if (request.action === "remove") {
      const target = this.community.members[request.targetIdentityId];
      for (const deviceId of [...(target?.deviceIds ?? [])]) {
        await this.revokeDevice(deviceId);
      }
    }
  }

  async restoreModeration(state: ModerationState): Promise<void> {
    if (state.communityId !== this.community.communityId) {
      throw new Error("Moderation audit belongs to a different community");
    }
    let restored = initialModerationState(this.community.communityId);
    for (const operation of Object.values(state.operations).sort((left, right) =>
      left.operationId.localeCompare(right.operationId),
    )) {
      restored = await applyModerationOperation(restored, this.community, operation);
    }
    this.moderation = restored;
    this.emit();
  }

  async refresh(): Promise<void> {
    try {
      const [community, conversation] = await Promise.all([
        this.transport.readAuthority<CommunityMembershipState>("community"),
        this.transport.readAuthority<ConversationState>("conversation"),
      ]);
      this.community = community;
      this.conversation = this.normalizeConversation(conversation);
      await this.synchronizeActorSequence();
      this.error = undefined;
      await this.openCurrentEpoch();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.emit();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.session.configurePrivateConversation(null);
  }

  private async readOrBootstrap<T>(family: "community" | "conversation", initial: T): Promise<T> {
    try {
      return await this.transport.readAuthority<T>(family);
    } catch {
      return this.transport.bootstrapAuthority(family, initial);
    }
  }

  private async rotateConversation(devices: ConversationDevice[]): Promise<void> {
    if (devices.length === 0) throw new Error("A private conversation cannot have an empty roster");
    const prepared = await prepareEpochRotation(
      this.device.identity,
      this.conversation,
      ulid(),
      devices,
    );
    await this.transport.submitAuthority("conversation", prepared.operation);
    await this.waitForConversationEpoch(prepared.operation.epoch);
    if (devices.some((candidate) => candidate.deviceId === this.device.identity.deviceId)) {
      this.epochKey = prepared.key;
      this.session.configurePrivateConversation({
        conversationId: this.conversation.conversationId,
        epoch: prepared.operation.epoch,
        key: prepared.key,
      });
    }
  }

  private async openCurrentEpoch(): Promise<void> {
    const member = this.community.members[this.device.identity.identityId];
    const sealed = this.conversation.sealedKeys[this.device.identity.deviceId];
    const device = this.conversation.devices[this.device.identity.deviceId];
    const latest = Object.values(this.conversation.rotations).find(
      (rotation) => rotation.epoch === this.conversation.epoch,
    );
    if (
      !member?.active ||
      !member.deviceIds.includes(this.device.identity.deviceId) ||
      !device ||
      !sealed ||
      !latest ||
      !(await verifyEpochRotation(latest))
    ) {
      this.epochKey = null;
      this.session.configurePrivateConversation(null);
      return;
    }
    this.epochKey = await new X25519GroupCipher().openEpochKey(
      sealed,
      this.device.identity.deviceId,
      this.device.encryption.privateKey,
    );
    this.session.configurePrivateConversation({
      conversationId: this.conversation.conversationId,
      epoch: this.conversation.epoch,
      key: this.epochKey,
    });
  }

  private localConversationDevice(): ConversationDevice {
    return {
      identityId: this.device.identity.identityId,
      deviceId: this.device.identity.deviceId,
      encryptionPublicKey: bytesToBase64Url(this.device.encryption.publicKeyBytes),
    };
  }

  private async waitForCommunityEpoch(epoch: number): Promise<void> {
    await this.waitFor(async () => {
      this.community = await this.transport.readAuthority<CommunityMembershipState>("community");
      return this.community.epoch >= epoch;
    });
  }

  private async waitForConversationEpoch(epoch: number): Promise<void> {
    await this.waitFor(async () => {
      this.conversation = this.normalizeConversation(
        await this.transport.readAuthority<ConversationState>("conversation"),
      );
      return this.conversation.epoch >= epoch;
    });
  }

  private async waitForConversationController(identityId: string): Promise<void> {
    await this.waitFor(async () => {
      this.conversation = this.normalizeConversation(
        await this.transport.readAuthority<ConversationState>("conversation"),
      );
      return this.conversation.controllerId === identityId;
    });
  }

  private async waitFor(predicate: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Freenet authority state did not converge before the deadline");
  }

  private validateInvite(invite: DeviceInvite): void {
    if (
      !invite.identityId ||
      !invite.deviceId ||
      !invite.displayName ||
      !/^[A-Za-z0-9_-]{43}$/.test(invite.encryptionPublicKey)
    ) {
      throw new Error("Device invitation is malformed");
    }
  }

  private normalizeConversation(state: ConversationState): ConversationState {
    return {
      ...state,
      transfers: state.transfers ?? {},
      controllerId: state.controllerId || state.creatorId,
      controllerDeviceId: state.controllerDeviceId || state.creatorDeviceId,
    };
  }

  private async synchronizeActorSequence(): Promise<void> {
    const deviceId = this.device.identity.deviceId;
    const observed = Math.max(
      this.community.actorSequences[deviceId] ?? 0,
      this.conversation.actorSequences[deviceId] ?? 0,
    );
    if (this.device.identity.nextSequence <= observed) {
      this.device.identity.nextSequence = observed + 1;
      await this.device.identity.onChange?.(this.device.identity);
    }
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
