import {
  applyMembershipOperation,
  initialMembershipState,
  signMembershipOperation,
} from "@nexus/community";
import { createLocalIdentity } from "@nexus/identity";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import {
  applyModerationOperation,
  initialModerationState,
  signModerationOperation,
  visibleModerationAudit,
} from "./index";

describe("signed moderation audit", () => {
  it("allows reports and role-authorized timeouts while rejecting member timeouts", async () => {
    const owner = await createLocalIdentity("Owner");
    const member = await createLocalIdentity("Member");
    const communityId = ulid();
    let membership = initialMembershipState(communityId, owner.identityId, [owner.deviceId]);
    membership = await applyMembershipOperation(
      membership,
      await signMembershipOperation(owner, {
        protocolVersion: 2,
        operationId: ulid(),
        communityId,
        actorId: owner.identityId,
        actorDeviceId: owner.deviceId,
        actorSequence: owner.nextSequence,
        targetIdentityId: member.identityId,
        targetDeviceIds: [member.deviceId],
        action: "add",
        role: "member",
        epoch: 1,
        createdAt: new Date().toISOString(),
      }),
    );
    let moderation = initialModerationState(communityId);
    moderation = await applyModerationOperation(
      moderation,
      membership,
      await signModerationOperation(member, {
        protocolVersion: 2,
        operationId: ulid(),
        communityId,
        communityEpoch: membership.epoch,
        actorId: member.identityId,
        actorDeviceId: member.deviceId,
        actorSequence: member.nextSequence,
        action: "report",
        scope: "community",
        targetIdentityId: owner.identityId,
        messageId: ulid(),
        reason: "Needs review",
        createdAt: new Date().toISOString(),
      }),
    );

    const unauthorized = await signModerationOperation(member, {
      protocolVersion: 2,
      operationId: ulid(),
      communityId,
      communityEpoch: membership.epoch,
      actorId: member.identityId,
      actorDeviceId: member.deviceId,
      actorSequence: member.nextSequence,
      action: "timeout",
      scope: "community",
      targetIdentityId: owner.identityId,
      reason: "Not allowed",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    await expect(applyModerationOperation(moderation, membership, unauthorized)).rejects.toThrow(
      /lacks authority/,
    );

    const timeout = await signModerationOperation(owner, {
      protocolVersion: 2,
      operationId: ulid(),
      communityId,
      communityEpoch: membership.epoch,
      actorId: owner.identityId,
      actorDeviceId: owner.deviceId,
      actorSequence: owner.nextSequence,
      action: "timeout",
      scope: "community",
      targetIdentityId: member.identityId,
      reason: "Cooling-off period",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    moderation = await applyModerationOperation(moderation, membership, timeout);

    expect(moderation.activeTimeouts[member.identityId]?.operationId).toBe(timeout.operationId);
    expect(visibleModerationAudit(moderation)).toHaveLength(2);
  });

  it("detects modified signed records and supports a signed appeal", async () => {
    const owner = await createLocalIdentity("Owner");
    const member = await createLocalIdentity("Member");
    const communityId = ulid();
    let membership = initialMembershipState(communityId, owner.identityId, [owner.deviceId]);
    membership = await applyMembershipOperation(
      membership,
      await signMembershipOperation(owner, {
        protocolVersion: 2,
        operationId: ulid(),
        communityId,
        actorId: owner.identityId,
        actorDeviceId: owner.deviceId,
        actorSequence: owner.nextSequence,
        targetIdentityId: member.identityId,
        targetDeviceIds: [member.deviceId],
        action: "add",
        role: "member",
        epoch: 1,
        createdAt: new Date().toISOString(),
      }),
    );
    let moderation = initialModerationState(communityId);
    const timeout = await signModerationOperation(owner, {
      protocolVersion: 2,
      operationId: ulid(),
      communityId,
      communityEpoch: membership.epoch,
      actorId: owner.identityId,
      actorDeviceId: owner.deviceId,
      actorSequence: owner.nextSequence,
      action: "timeout",
      scope: "community",
      targetIdentityId: member.identityId,
      reason: "Cooling-off period",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    moderation = await applyModerationOperation(moderation, membership, timeout);

    await expect(
      applyModerationOperation(initialModerationState(communityId), membership, {
        ...timeout,
        reason: "Changed after signing",
      }),
    ).rejects.toThrow(/signature is invalid/);

    const appeal = await signModerationOperation(member, {
      protocolVersion: 2,
      operationId: ulid(),
      communityId,
      communityEpoch: membership.epoch,
      actorId: member.identityId,
      actorDeviceId: member.deviceId,
      actorSequence: member.nextSequence,
      action: "appeal",
      scope: "community",
      targetIdentityId: member.identityId,
      reason: "Please review the decision",
      createdAt: new Date().toISOString(),
    });
    moderation = await applyModerationOperation(moderation, membership, appeal);
    expect(moderation.openAppeals[appeal.operationId]).toEqual(appeal);
  });
});
