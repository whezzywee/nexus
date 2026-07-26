import { createLocalIdentity } from "@nexus/identity";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { applyMembershipOperation, initialMembershipState, signMembershipOperation } from "./index";

describe("community membership", () => {
  it("enforces authority and advances the key-rotation epoch on removal", async () => {
    const owner = await createLocalIdentity("Owner");
    const member = await createLocalIdentity("Member");
    const communityId = ulid();
    let state = initialMembershipState(communityId, owner.identityId, [owner.deviceId]);
    state = await applyMembershipOperation(
      state,
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
    expect(state.members[member.identityId]?.active).toBe(true);

    await expect(
      signMembershipOperation(member, {
        protocolVersion: 2,
        operationId: ulid(),
        communityId,
        actorId: member.identityId,
        actorDeviceId: member.deviceId,
        actorSequence: member.nextSequence,
        targetIdentityId: owner.identityId,
        targetDeviceIds: [],
        action: "remove",
        epoch: 2,
        createdAt: new Date().toISOString(),
      }).then((operation) => applyMembershipOperation(state, operation)),
    ).rejects.toThrow(/lacks authority/);

    state = await applyMembershipOperation(
      state,
      await signMembershipOperation(owner, {
        protocolVersion: 2,
        operationId: ulid(),
        communityId,
        actorId: owner.identityId,
        actorDeviceId: owner.deviceId,
        actorSequence: owner.nextSequence,
        targetIdentityId: member.identityId,
        targetDeviceIds: [],
        action: "remove",
        epoch: 2,
        createdAt: new Date().toISOString(),
      }),
    );
    expect(state.epoch).toBe(2);
    expect(state.members[member.identityId]?.active).toBe(false);
    expect(state.members[member.identityId]?.deviceIds).toEqual([]);
  });

  it("rejects authority claimed by a device that is not currently authorized", async () => {
    const owner = await createLocalIdentity("Owner");
    const member = await createLocalIdentity("Member");
    const communityId = ulid();
    const state = initialMembershipState(communityId, owner.identityId, [owner.deviceId]);
    const operation = await signMembershipOperation(owner, {
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
    });
    const ownerMember = state.members[owner.identityId];
    if (!ownerMember) throw new Error("Owner bootstrap member is missing");
    ownerMember.deviceIds = ["replacement-device"];

    await expect(applyMembershipOperation(state, operation)).rejects.toThrow(/lacks authority/);
  });

  it("lets an authorized device link and revoke sibling devices", async () => {
    const owner = await createLocalIdentity("Owner");
    const communityId = ulid();
    let state = initialMembershipState(communityId, owner.identityId, [owner.deviceId]);
    const linkedDeviceId = ulid();
    state = await applyMembershipOperation(
      state,
      await signMembershipOperation(owner, {
        protocolVersion: 2,
        operationId: ulid(),
        communityId,
        actorId: owner.identityId,
        actorDeviceId: owner.deviceId,
        actorSequence: owner.nextSequence,
        targetIdentityId: owner.identityId,
        targetDeviceIds: [owner.deviceId, linkedDeviceId],
        action: "set_devices",
        epoch: 1,
        createdAt: new Date().toISOString(),
      }),
    );
    expect(state.members[owner.identityId]?.deviceIds).toContain(linkedDeviceId);

    state = await applyMembershipOperation(
      state,
      await signMembershipOperation(owner, {
        protocolVersion: 2,
        operationId: ulid(),
        communityId,
        actorId: owner.identityId,
        actorDeviceId: owner.deviceId,
        actorSequence: owner.nextSequence,
        targetIdentityId: owner.identityId,
        targetDeviceIds: [owner.deviceId],
        action: "set_devices",
        epoch: 2,
        createdAt: new Date().toISOString(),
      }),
    );
    expect(state.members[owner.identityId]?.deviceIds).toEqual([owner.deviceId]);
    expect(state.revokedDeviceIds).toContain(linkedDeviceId);

    await expect(
      signMembershipOperation(owner, {
        protocolVersion: 2,
        operationId: ulid(),
        communityId,
        actorId: owner.identityId,
        actorDeviceId: owner.deviceId,
        actorSequence: owner.nextSequence,
        targetIdentityId: owner.identityId,
        targetDeviceIds: [owner.deviceId, linkedDeviceId],
        action: "set_devices",
        epoch: 3,
        createdAt: new Date().toISOString(),
      }).then((operation) => applyMembershipOperation(state, operation)),
    ).rejects.toThrow(/cannot be authorized again/);
  });

  it("transfers the owner role with a signed operation", async () => {
    const founder = await createLocalIdentity("Founder");
    const successor = await createLocalIdentity("Successor");
    const communityId = ulid();
    let state = initialMembershipState(communityId, founder.identityId, [founder.deviceId]);
    state = await applyMembershipOperation(
      state,
      await signMembershipOperation(founder, {
        protocolVersion: 2,
        operationId: ulid(),
        communityId,
        actorId: founder.identityId,
        actorDeviceId: founder.deviceId,
        actorSequence: founder.nextSequence,
        targetIdentityId: successor.identityId,
        targetDeviceIds: [successor.deviceId],
        action: "add",
        role: "admin",
        epoch: 1,
        createdAt: new Date().toISOString(),
      }),
    );
    state = await applyMembershipOperation(
      state,
      await signMembershipOperation(founder, {
        protocolVersion: 2,
        operationId: ulid(),
        communityId,
        actorId: founder.identityId,
        actorDeviceId: founder.deviceId,
        actorSequence: founder.nextSequence,
        targetIdentityId: successor.identityId,
        targetDeviceIds: [],
        action: "set_role",
        role: "owner",
        epoch: 2,
        createdAt: new Date().toISOString(),
      }),
    );

    expect(state.members[successor.identityId]?.role).toBe("owner");
    expect(state.members[founder.identityId]?.role).toBe("admin");
  });
});
