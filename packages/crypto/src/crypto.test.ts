import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  exportConversationKey,
  generateConversationKey,
  generateDeviceEncryptionKeyPair,
  importConversationKey,
  X25519GroupCipher,
} from "./index";

describe("conversation encryption", () => {
  it("round-trips with bound associated data and rejects the wrong context", async () => {
    const generated = await generateConversationKey();
    const key = await importConversationKey(await exportConversationKey(generated));
    const context = new TextEncoder().encode("conversation:01:epoch:4");
    const plaintext = new TextEncoder().encode("private message");
    const envelope = await encryptEnvelope(key, plaintext, context);

    expect(new TextDecoder().decode(await decryptEnvelope(key, envelope, context))).toBe(
      "private message",
    );
    await expect(
      decryptEnvelope(key, envelope, new TextEncoder().encode("conversation:02:epoch:4")),
    ).rejects.toThrow();
  });

  it("seals an epoch key independently to authorized devices", async () => {
    const mara = await generateDeviceEncryptionKeyPair();
    const theo = await generateDeviceEncryptionKeyPair();
    const removed = await generateDeviceEncryptionKeyPair();
    const epochKey = await generateConversationKey();
    const cipher = new X25519GroupCipher();
    const sealed = await cipher.sealEpochKey("conversation-01", 3, epochKey, [
      { deviceId: "mara-device", publicKey: mara.publicKeyBytes },
      { deviceId: "theo-device", publicKey: theo.publicKeyBytes },
    ]);

    expect(sealed).toHaveLength(2);
    const maraEnvelope = sealed[0];
    const theoEnvelope = sealed[1];
    if (!maraEnvelope || !theoEnvelope) {
      throw new Error("Group cipher did not create both recipient envelopes");
    }
    const opened = await cipher.openEpochKey(theoEnvelope, "theo-device", theo.privateKey);
    expect(await exportConversationKey(opened)).toEqual(await exportConversationKey(epochKey));
    await expect(
      cipher.openEpochKey(maraEnvelope, "removed-device", removed.privateKey),
    ).rejects.toThrow(/not addressed/);
  });
});
