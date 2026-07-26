import {
  decryptEnvelope,
  type EncryptedEnvelope,
  encryptEnvelope,
  generateConversationKey,
  type SealedEpochKey,
  X25519GroupCipher,
} from "@nexus/crypto";
import { type LocalIdentity, signDevicePayload, verifyDevicePayload } from "@nexus/identity";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  concatBytes,
  type DeviceCertificate,
} from "@nexus/protocol";

export type { EncryptedEnvelope } from "@nexus/crypto";

export interface ConversationDevice {
  identityId: string;
  deviceId: string;
  encryptionPublicKey: string;
}

export interface UnsignedEpochRotationOperation {
  protocolVersion: 2;
  operationId: string;
  conversationId: string;
  actorId: string;
  actorDeviceId: string;
  actorSequence: number;
  epoch: number;
  devices: ConversationDevice[];
  sealedKeys: SealedEpochKey[];
  createdAt: string;
}

export interface EpochRotationOperation extends UnsignedEpochRotationOperation {
  publicKey: string;
  deviceCertificate: DeviceCertificate;
  signature: string;
}

export interface UnsignedConversationControllerTransferOperation {
  protocolVersion: 2;
  operationId: string;
  conversationId: string;
  actorId: string;
  actorDeviceId: string;
  actorSequence: number;
  conversationEpoch: number;
  targetIdentityId: string;
  targetDeviceId: string;
  createdAt: string;
}

export interface ConversationControllerTransferOperation
  extends UnsignedConversationControllerTransferOperation {
  publicKey: string;
  deviceCertificate: DeviceCertificate;
  signature: string;
}

export interface ConversationState {
  schemaVersion: 2;
  conversationId: string;
  creatorId: string;
  creatorDeviceId: string;
  creatorEncryptionPublicKey: string;
  rotations: Record<string, EpochRotationOperation>;
  transfers: Record<string, ConversationControllerTransferOperation>;
  controllerId: string;
  controllerDeviceId: string;
  epoch: number;
  devices: Record<string, ConversationDevice>;
  sealedKeys: Record<string, SealedEpochKey>;
  actorSequences: Record<string, number>;
}

export interface PreparedEpochRotation {
  operation: EpochRotationOperation;
  key: CryptoKey;
}

const encoder = new TextEncoder();
const ROTATION_DOMAIN = encoder.encode("nexus:conversation-epoch-rotation:v2");
const CONTROLLER_TRANSFER_DOMAIN = encoder.encode("nexus:conversation-controller-transfer:v2");

export function initialConversationState(
  conversationId: string,
  creatorId: string,
  creatorDeviceId: string,
  creatorEncryptionPublicKey: Uint8Array,
): ConversationState {
  const device: ConversationDevice = {
    identityId: creatorId,
    deviceId: creatorDeviceId,
    encryptionPublicKey: bytesToBase64Url(creatorEncryptionPublicKey),
  };
  return {
    schemaVersion: 2,
    conversationId,
    creatorId,
    creatorDeviceId,
    creatorEncryptionPublicKey: device.encryptionPublicKey,
    rotations: {},
    transfers: {},
    controllerId: creatorId,
    controllerDeviceId: creatorDeviceId,
    epoch: 0,
    devices: { [creatorDeviceId]: device },
    sealedKeys: {},
    actorSequences: {},
  };
}

export async function signConversationControllerTransfer(
  identity: LocalIdentity,
  unsigned: UnsignedConversationControllerTransferOperation,
): Promise<ConversationControllerTransferOperation> {
  if (
    unsigned.actorId !== identity.identityId ||
    unsigned.actorDeviceId !== identity.deviceId ||
    unsigned.actorSequence !== identity.nextSequence
  ) {
    throw new Error("Conversation controller transfer actor does not match the signing device");
  }
  validateControllerTransferShape(unsigned);
  const deviceSignature = await signDevicePayload(
    identity,
    canonicalConversationControllerTransferBytes(unsigned),
    unsigned.actorId,
    unsigned.actorDeviceId,
  );
  identity.nextSequence += 1;
  await identity.onChange?.(identity);
  return {
    ...unsigned,
    ...deviceSignature,
  };
}

export async function verifyConversationControllerTransfer(
  operation: ConversationControllerTransferOperation,
): Promise<boolean> {
  try {
    validateControllerTransferShape(operation);
    const { publicKey, deviceCertificate, signature, ...unsigned } = operation;
    return verifyDevicePayload(
      { publicKey, deviceCertificate, signature },
      canonicalConversationControllerTransferBytes(unsigned),
      operation.actorId,
      operation.actorDeviceId,
    );
  } catch {
    return false;
  }
}

export async function applyConversationControllerTransfer(
  current: ConversationState,
  operation: ConversationControllerTransferOperation,
): Promise<ConversationState> {
  if (current.transfers[operation.operationId]) return current;
  if (!(await verifyConversationControllerTransfer(operation))) {
    throw new Error("Conversation controller transfer signature is invalid");
  }
  if (
    operation.conversationId !== current.conversationId ||
    operation.actorId !== current.controllerId ||
    operation.conversationEpoch !== current.epoch ||
    operation.actorSequence <= (current.actorSequences[operation.actorDeviceId] ?? 0)
  ) {
    throw new Error("Conversation controller transfer sequence or authority is invalid");
  }
  const actorDevice = current.devices[operation.actorDeviceId];
  const targetDevice = current.devices[operation.targetDeviceId];
  if (
    !actorDevice ||
    actorDevice.identityId !== current.controllerId ||
    actorDevice.encryptionPublicKey !== operation.deviceCertificate.encryptionPublicKey ||
    !targetDevice ||
    targetDevice.identityId !== operation.targetIdentityId
  ) {
    throw new Error("Conversation controller transfer device is not authorized");
  }
  return {
    ...current,
    transfers: { ...current.transfers, [operation.operationId]: operation },
    controllerId: operation.targetIdentityId,
    controllerDeviceId: operation.targetDeviceId,
    actorSequences: {
      ...current.actorSequences,
      [operation.actorDeviceId]: operation.actorSequence,
    },
  };
}

export async function prepareEpochRotation(
  identity: LocalIdentity,
  state: ConversationState,
  operationId: string,
  devices: ConversationDevice[],
  createdAt = new Date().toISOString(),
): Promise<PreparedEpochRotation> {
  const normalizedDevices = normalizeDevices(devices);
  if (normalizedDevices.length === 0) {
    throw new Error("A private conversation must authorize at least one device");
  }
  const key = await generateConversationKey();
  const epoch = state.epoch + 1;
  const sealedKeys = await new X25519GroupCipher().sealEpochKey(
    state.conversationId,
    epoch,
    key,
    normalizedDevices.map((device) => ({
      deviceId: device.deviceId,
      publicKey: base64UrlToBytes(device.encryptionPublicKey),
    })),
  );
  return {
    key,
    operation: await signEpochRotation(identity, {
      protocolVersion: 2,
      operationId,
      conversationId: state.conversationId,
      actorId: identity.identityId,
      actorDeviceId: identity.deviceId,
      actorSequence: identity.nextSequence,
      epoch,
      devices: normalizedDevices,
      sealedKeys,
      createdAt,
    }),
  };
}

export async function signEpochRotation(
  identity: LocalIdentity,
  unsigned: UnsignedEpochRotationOperation,
): Promise<EpochRotationOperation> {
  if (
    unsigned.actorId !== identity.identityId ||
    unsigned.actorDeviceId !== identity.deviceId ||
    unsigned.actorSequence !== identity.nextSequence
  ) {
    throw new Error("Epoch rotation actor does not match the signing device");
  }
  const operation = {
    ...unsigned,
    devices: normalizeDevices(unsigned.devices),
    sealedKeys: normalizeSealedKeys(unsigned.sealedKeys),
  };
  const deviceSignature = await signDevicePayload(
    identity,
    canonicalEpochRotationBytes(operation),
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

export async function verifyEpochRotation(operation: EpochRotationOperation): Promise<boolean> {
  try {
    validateRotationShape(operation);
    const { publicKey, deviceCertificate, signature, ...unsigned } = operation;
    return verifyDevicePayload(
      { publicKey, deviceCertificate, signature },
      canonicalEpochRotationBytes(unsigned),
      operation.actorId,
      operation.actorDeviceId,
    );
  } catch {
    return false;
  }
}

export async function applyEpochRotation(
  current: ConversationState,
  operation: EpochRotationOperation,
): Promise<ConversationState> {
  if (current.rotations[operation.operationId]) return current;
  if (!(await verifyEpochRotation(operation))) {
    throw new Error("Conversation epoch rotation signature or envelope roster is invalid");
  }
  if (
    operation.conversationId !== current.conversationId ||
    operation.actorId !== current.controllerId ||
    operation.epoch !== current.epoch + 1 ||
    operation.actorSequence <= (current.actorSequences[operation.actorDeviceId] ?? 0)
  ) {
    throw new Error("Conversation epoch rotation sequence or authority is invalid");
  }
  const actorDevice = current.devices[operation.actorDeviceId];
  if (
    !actorDevice ||
    actorDevice.identityId !== current.controllerId ||
    actorDevice.encryptionPublicKey !== operation.deviceCertificate.encryptionPublicKey
  ) {
    throw new Error("Conversation epoch rotation came from a removed device");
  }
  if (!operation.devices.some((device) => device.identityId === current.controllerId)) {
    throw new Error("A conversation rotation cannot remove its controller identity");
  }
  const nextDevices = Object.fromEntries(
    operation.devices.map((device) => [device.deviceId, device]),
  );
  const fallbackControllerDevice = operation.devices.find(
    (device) => device.identityId === current.controllerId,
  );
  if (!fallbackControllerDevice) {
    throw new Error("Conversation rotation lost its controller device");
  }
  const controllerDeviceId = nextDevices[current.controllerDeviceId]
    ? current.controllerDeviceId
    : fallbackControllerDevice.deviceId;
  return {
    ...current,
    rotations: { ...current.rotations, [operation.operationId]: operation },
    epoch: operation.epoch,
    controllerDeviceId,
    devices: nextDevices,
    sealedKeys: Object.fromEntries(
      operation.sealedKeys.map((sealed) => [sealed.recipientDeviceId, sealed]),
    ),
    actorSequences: {
      ...current.actorSequences,
      [operation.actorDeviceId]: operation.actorSequence,
    },
  };
}

export function canonicalConversationControllerTransferBytes(
  operation: UnsignedConversationControllerTransferOperation,
): Uint8Array {
  const fields = [
    operation.protocolVersion.toString(),
    operation.operationId,
    operation.conversationId,
    operation.actorId,
    operation.actorDeviceId,
    operation.actorSequence.toString(),
    operation.conversationEpoch.toString(),
    operation.targetIdentityId,
    operation.targetDeviceId,
    operation.createdAt,
  ];
  return concatBytes([
    frame(CONTROLLER_TRANSFER_DOMAIN),
    ...fields.map((field) => frame(encoder.encode(field))),
  ]);
}

export function canonicalEpochRotationBytes(operation: UnsignedEpochRotationOperation): Uint8Array {
  const deviceRecords = normalizeDevices(operation.devices)
    .map((device) =>
      [device.identityId, device.deviceId, device.encryptionPublicKey].join("\u001f"),
    )
    .join("\u001e");
  const sealedRecords = normalizeSealedKeys(operation.sealedKeys)
    .map((sealed) =>
      [
        sealed.suite,
        sealed.conversationId,
        sealed.epoch.toString(),
        sealed.recipientDeviceId,
        sealed.ephemeralPublicKey,
        sealed.salt,
        sealed.envelope.suite,
        sealed.envelope.nonce,
        sealed.envelope.ciphertext,
      ].join("\u001f"),
    )
    .join("\u001e");
  const fields = [
    operation.protocolVersion.toString(),
    operation.operationId,
    operation.conversationId,
    operation.actorId,
    operation.actorDeviceId,
    operation.actorSequence.toString(),
    operation.epoch.toString(),
    deviceRecords,
    sealedRecords,
    operation.createdAt,
  ];
  return concatBytes([
    frame(ROTATION_DOMAIN),
    ...fields.map((field) => frame(encoder.encode(field))),
  ]);
}

export async function encryptPrivateMessage(
  conversationId: string,
  epoch: number,
  messageId: string,
  plaintext: string,
  key: CryptoKey,
): Promise<EncryptedEnvelope> {
  return encryptEnvelope(
    key,
    encoder.encode(plaintext),
    privateMessageContext(conversationId, epoch, messageId),
  );
}

export async function decryptPrivateMessage(
  conversationId: string,
  epoch: number,
  messageId: string,
  envelope: EncryptedEnvelope,
  key: CryptoKey,
): Promise<string> {
  return new TextDecoder().decode(
    await decryptEnvelope(key, envelope, privateMessageContext(conversationId, epoch, messageId)),
  );
}

function privateMessageContext(
  conversationId: string,
  epoch: number,
  messageId: string,
): Uint8Array {
  return encoder.encode(`nexus:private-message:v1:${conversationId}:${epoch}:${messageId}`);
}

function validateRotationShape(operation: UnsignedEpochRotationOperation) {
  const devices = normalizeDevices(operation.devices);
  const sealed = normalizeSealedKeys(operation.sealedKeys);
  if (
    devices.length === 0 ||
    devices.length !== operation.devices.length ||
    sealed.length !== operation.sealedKeys.length ||
    sealed.length !== devices.length ||
    new Set(devices.map((device) => device.deviceId)).size !== devices.length ||
    new Set(sealed.map((item) => item.recipientDeviceId)).size !== sealed.length
  ) {
    throw new Error("Conversation epoch device and envelope rosters do not match");
  }
  const deviceIds = new Set(devices.map((device) => device.deviceId));
  for (const item of sealed) {
    if (
      item.conversationId !== operation.conversationId ||
      item.epoch !== operation.epoch ||
      !deviceIds.has(item.recipientDeviceId)
    ) {
      throw new Error("Sealed epoch key metadata does not match the rotation");
    }
  }
}

function validateControllerTransferShape(
  operation: UnsignedConversationControllerTransferOperation,
) {
  if (
    operation.protocolVersion !== 2 ||
    !operation.operationId ||
    !operation.conversationId ||
    !operation.actorId ||
    !operation.actorDeviceId ||
    operation.actorSequence < 1 ||
    operation.conversationEpoch < 1 ||
    !operation.targetIdentityId ||
    !operation.targetDeviceId ||
    !operation.createdAt
  ) {
    throw new Error("Conversation controller transfer is malformed");
  }
}

function normalizeDevices(devices: ConversationDevice[]): ConversationDevice[] {
  return [...devices].sort((left, right) => {
    const identityOrder = left.identityId.localeCompare(right.identityId);
    return identityOrder || left.deviceId.localeCompare(right.deviceId);
  });
}

function normalizeSealedKeys(sealedKeys: SealedEpochKey[]): SealedEpochKey[] {
  return [...sealedKeys].sort((left, right) =>
    left.recipientDeviceId.localeCompare(right.recipientDeviceId),
  );
}

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.byteLength);
  new DataView(output.buffer).setUint32(0, bytes.byteLength, false);
  output.set(bytes, 4);
  return output;
}
