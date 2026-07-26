import {
  exportConversationKey,
  generateDeviceEncryptionKeyPair,
  X25519GroupCipher,
} from "@nexus/crypto";
import { createLocalIdentity } from "@nexus/identity";
import { bytesToBase64Url } from "@nexus/protocol";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import {
  applyConversationControllerTransfer,
  applyEpochRotation,
  type ConversationDevice,
  decryptPrivateMessage,
  encryptPrivateMessage,
  initialConversationState,
  prepareEpochRotation,
  signConversationControllerTransfer,
} from "./index";

describe("private conversation epochs", () => {
  it("rotates after device removal and withholds the new key from that device", async () => {
    const maraEncryption = await generateDeviceEncryptionKeyPair();
    const theoEncryption = await generateDeviceEncryptionKeyPair();
    const mara = await createLocalIdentity("Mara", maraEncryption.publicKeyBytes);
    const theo = await createLocalIdentity("Theo", theoEncryption.publicKeyBytes);
    const conversationId = ulid();
    let state = initialConversationState(
      conversationId,
      mara.identityId,
      mara.deviceId,
      maraEncryption.publicKeyBytes,
    );
    const maraDevice: ConversationDevice = {
      identityId: mara.identityId,
      deviceId: mara.deviceId,
      encryptionPublicKey: bytesToBase64Url(maraEncryption.publicKeyBytes),
    };
    const theoDevice: ConversationDevice = {
      identityId: theo.identityId,
      deviceId: theo.deviceId,
      encryptionPublicKey: bytesToBase64Url(theoEncryption.publicKeyBytes),
    };

    const epochOne = await prepareEpochRotation(mara, state, ulid(), [maraDevice, theoDevice]);
    state = await applyEpochRotation(state, epochOne.operation);
    const messageId = ulid();
    const encrypted = await encryptPrivateMessage(
      conversationId,
      state.epoch,
      messageId,
      "private hello",
      epochOne.key,
    );
    const theoEnvelope = state.sealedKeys[theo.deviceId];
    if (!theoEnvelope) throw new Error("Theo did not receive the first epoch key");
    const theoEpochOneKey = await new X25519GroupCipher().openEpochKey(
      theoEnvelope,
      theo.deviceId,
      theoEncryption.privateKey,
    );
    expect(
      await decryptPrivateMessage(
        conversationId,
        state.epoch,
        messageId,
        encrypted,
        theoEpochOneKey,
      ),
    ).toBe("private hello");

    const epochTwo = await prepareEpochRotation(mara, state, ulid(), [maraDevice]);
    state = await applyEpochRotation(state, epochTwo.operation);
    expect(state.epoch).toBe(2);
    expect(state.devices[theo.deviceId]).toBeUndefined();
    expect(state.sealedKeys[theo.deviceId]).toBeUndefined();
    const maraEnvelope = state.sealedKeys[mara.deviceId];
    if (!maraEnvelope) throw new Error("Mara did not receive the rotated epoch key");
    const openedByMara = await new X25519GroupCipher().openEpochKey(
      maraEnvelope,
      mara.deviceId,
      maraEncryption.privateKey,
    );
    expect(await exportConversationKey(openedByMara)).toEqual(
      await exportConversationKey(epochTwo.key),
    );
  });

  it("hands epoch rotation control to an authorized member device", async () => {
    const founderEncryption = await generateDeviceEncryptionKeyPair();
    const successorEncryption = await generateDeviceEncryptionKeyPair();
    const founder = await createLocalIdentity("Founder", founderEncryption.publicKeyBytes);
    const successor = await createLocalIdentity("Successor", successorEncryption.publicKeyBytes);
    let state = initialConversationState(
      ulid(),
      founder.identityId,
      founder.deviceId,
      founderEncryption.publicKeyBytes,
    );
    const devices: ConversationDevice[] = [
      {
        identityId: founder.identityId,
        deviceId: founder.deviceId,
        encryptionPublicKey: bytesToBase64Url(founderEncryption.publicKeyBytes),
      },
      {
        identityId: successor.identityId,
        deviceId: successor.deviceId,
        encryptionPublicKey: bytesToBase64Url(successorEncryption.publicKeyBytes),
      },
    ];
    const firstEpoch = await prepareEpochRotation(founder, state, ulid(), devices);
    state = await applyEpochRotation(state, firstEpoch.operation);
    const transfer = await signConversationControllerTransfer(founder, {
      protocolVersion: 2,
      operationId: ulid(),
      conversationId: state.conversationId,
      actorId: founder.identityId,
      actorDeviceId: founder.deviceId,
      actorSequence: founder.nextSequence,
      conversationEpoch: state.epoch,
      targetIdentityId: successor.identityId,
      targetDeviceId: successor.deviceId,
      createdAt: new Date().toISOString(),
    });
    state = await applyConversationControllerTransfer(state, transfer);
    expect(state.controllerId).toBe(successor.identityId);

    const secondEpoch = await prepareEpochRotation(successor, state, ulid(), devices);
    state = await applyEpochRotation(state, secondEpoch.operation);
    expect(state.epoch).toBe(2);
    const staleFounderRotation = await prepareEpochRotation(founder, state, ulid(), devices);
    await expect(applyEpochRotation(state, staleFounderRotation.operation)).rejects.toThrow(
      "authority is invalid",
    );
  });
});
