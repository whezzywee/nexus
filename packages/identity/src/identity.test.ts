import { canonicalMessageBytes, PROTOCOL_VERSION } from "@nexus/protocol";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import {
  createIdentityRecoveryBundle,
  createLinkedIdentity,
  createLocalIdentity,
  exportStoredIdentity,
  importStoredIdentity,
  restoreIdentityRecoveryBundle,
  signMessageOperation,
  verifyMessageOperation,
} from "./index";

describe("local identity", () => {
  it("signs a canonical operation and rejects modified content", async () => {
    const identity = await createLocalIdentity("Mara");
    const operation = await signMessageOperation(identity, {
      protocolVersion: PROTOCOL_VERSION,
      operationId: ulid(),
      messageId: ulid(),
      channelId: ulid(),
      authorId: identity.identityId,
      authorDeviceId: identity.deviceId,
      actorSequence: identity.nextSequence,
      createdAt: new Date().toISOString(),
      clientGeneratedOrder: ulid(),
      content: "signed content",
      attachmentReferences: [],
      editVersion: 0,
      deletionTombstone: false,
    });

    expect(canonicalMessageBytes(operation).byteLength).toBeGreaterThan(0);
    expect(await verifyMessageOperation(operation)).toBe(true);
    expect(
      await verifyMessageOperation({
        ...operation,
        content: "tampered content",
      }),
    ).toBe(false);
  });

  it("restores the same device key and next sequence", async () => {
    const original = await createLocalIdentity("Mara");
    original.nextSequence = 9;
    const restored = await importStoredIdentity(await exportStoredIdentity(original));

    expect(restored.identityId).toBe(original.identityId);
    expect(restored.deviceId).toBe(original.deviceId);
    expect(restored.nextSequence).toBe(9);
  });

  it("encrypts recovery material and rejects the wrong passphrase", async () => {
    const original = await createLocalIdentity("Mara");
    const bundle = await createIdentityRecoveryBundle(original, "correct horse battery staple");
    expect(bundle).toMatchObject({
      version: 2,
      kdf: "Argon2id",
      memoryKiB: 65_536,
      passes: 3,
      parallelism: 1,
    });
    const restored = await restoreIdentityRecoveryBundle(bundle, "correct horse battery staple");

    expect(restored.identityId).toBe(original.identityId);
    await expect(
      restoreIdentityRecoveryBundle(bundle, "definitely wrong password"),
    ).rejects.toThrow();
  }, 30_000);

  it("does not give a linked device the root recovery authority", async () => {
    const primary = await createLocalIdentity("Mara");
    const linked = await createLinkedIdentity(primary, crypto.getRandomValues(new Uint8Array(32)));

    expect(linked.rootPrivateKey).toBeUndefined();
    await expect(
      createIdentityRecoveryBundle(linked, "correct horse battery staple"),
    ).rejects.toThrow(/root authority/);
    await expect(
      createLinkedIdentity(linked, crypto.getRandomValues(new Uint8Array(32))),
    ).rejects.toThrow(/root recovery authority/);
  });
});
