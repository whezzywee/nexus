import { signMessageOperation, verifyMessageOperation } from "@nexus/identity";
import {
  bytesToBase64Url,
  canonicalMessageBytes,
  type MessageOperation,
  PROTOCOL_VERSION,
} from "@nexus/protocol";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import {
  createLinkedDeviceState,
  createLocalDeviceState,
  exportStoredDeviceState,
  importStoredDeviceState,
  type LegacyStoredDeviceState,
  loadOrCreateDeviceState,
} from "./index";

describe("persistent device state", () => {
  it("restores signing and X25519 keys and rejects a mismatched encryption key", async () => {
    const original = await createLocalDeviceState("Mara");
    const stored = await exportStoredDeviceState(original);
    const restored = await importStoredDeviceState(stored);
    expect(restored.identity.identityId).toBe(original.identity.identityId);
    expect(restored.identity.deviceId).toBe(original.identity.deviceId);
    expect(restored.encryption.publicKeyBytes).toEqual(original.encryption.publicKeyBytes);

    const other = await createLocalDeviceState("Other");
    const otherStored = await exportStoredDeviceState(other);
    await expect(
      importStoredDeviceState({
        ...stored,
        encryptionPrivateKey: otherStored.encryptionPrivateKey,
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("links a distinct device to the same identity and persists sequence changes", async () => {
    const primary = await createLocalDeviceState("Mara");
    const linked = await createLinkedDeviceState(primary.identity);
    expect(linked.identity.identityId).toBe(primary.identity.identityId);
    expect(linked.identity.deviceId).not.toBe(primary.identity.deviceId);
    expect(linked.identity.publicKeyBytes).not.toEqual(primary.identity.publicKeyBytes);
    expect(linked.identity.rootPrivateKey).toBeUndefined();
    expect(linked.encryption.publicKeyBytes).not.toEqual(primary.encryption.publicKeyBytes);

    const records = new Map<string, string>();
    const store = {
      async load(profile: string) {
        return records.get(profile) ?? null;
      },
      async save(profile: string, payload: string) {
        records.set(profile, payload);
      },
    };
    const created = await loadOrCreateDeviceState(store, "primary", "Mara");
    created.identity.nextSequence = 7;
    await created.identity.onChange?.(created.identity);
    const restored = await loadOrCreateDeviceState(store, "primary", "ignored");
    expect(restored.identity.nextSequence).toBe(7);
    expect(restored.encryption.publicKeyBytes).toEqual(created.encryption.publicKeyBytes);
  });

  it("rejects a linked device signature that claims to be its sibling device", async () => {
    const primary = await createLocalDeviceState("Mara");
    const linked = await createLinkedDeviceState(primary.identity);
    const operation = await signMessageOperation(linked.identity, {
      protocolVersion: PROTOCOL_VERSION,
      operationId: ulid(),
      messageId: ulid(),
      channelId: ulid(),
      authorId: linked.identity.identityId,
      authorDeviceId: linked.identity.deviceId,
      actorSequence: linked.identity.nextSequence,
      createdAt: new Date().toISOString(),
      clientGeneratedOrder: ulid(),
      content: "linked device message",
      attachmentReferences: [],
      editVersion: 0,
      deletionTombstone: false,
    });
    expect(await verifyMessageOperation(operation)).toBe(true);

    const { signature: _signature, ...claimedAsPrimary } = {
      ...operation,
      authorDeviceId: primary.identity.deviceId,
    };
    const forgedSignature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        linked.identity.privateKey,
        Uint8Array.from(canonicalMessageBytes(claimedAsPrimary)).buffer,
      ),
    );
    const forged: MessageOperation = {
      ...claimedAsPrimary,
      signature: bytesToBase64Url(forgedSignature),
    };
    expect(await verifyMessageOperation(forged)).toBe(false);
  });

  it("migrates a legacy shared signing key into separate root and device keys", async () => {
    const original = await createLocalDeviceState("Legacy Mara");
    const current = await exportStoredDeviceState(original);
    const legacyRootPrivateKey = current.identity.rootPrivateKey;
    if (!legacyRootPrivateKey) throw new Error("Primary device root authority is missing");
    const legacy: LegacyStoredDeviceState = {
      version: 1,
      identity: {
        version: 1,
        identityId: current.identity.identityId,
        deviceId: current.identity.deviceId,
        displayName: current.identity.displayName,
        publicKey: current.identity.rootPublicKey,
        privateKey: legacyRootPrivateKey,
        nextSequence: 11,
      },
      encryptionPublicKey: current.encryptionPublicKey,
      encryptionPrivateKey: current.encryptionPrivateKey,
    };

    const migrated = await importStoredDeviceState(legacy);
    expect(migrated.identity.rootPublicKeyBytes).toEqual(original.identity.rootPublicKeyBytes);
    expect(migrated.identity.publicKeyBytes).not.toEqual(migrated.identity.rootPublicKeyBytes);
    expect(migrated.identity.deviceCertificate.signingPublicKey).toBe(
      bytesToBase64Url(migrated.identity.publicKeyBytes),
    );
    expect(migrated.identity.deviceCertificate.encryptionPublicKey).toBe(
      legacy.encryptionPublicKey,
    );
    expect(migrated.identity.nextSequence).toBe(11);
    expect((await exportStoredDeviceState(migrated)).version).toBe(2);
  });
});
