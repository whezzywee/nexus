import {
  type DeviceEncryptionKeyPair,
  exportDeviceEncryptionPrivateKey,
  generateDeviceEncryptionKeyPair,
  importDeviceEncryptionPrivateKey,
} from "@nexus/crypto";
import {
  createLinkedIdentity,
  createLocalIdentity,
  exportStoredIdentity,
  importStoredIdentity,
  type LegacyStoredIdentity,
  type LocalIdentity,
  type StoredIdentity,
  type SupportedStoredIdentity,
} from "@nexus/identity";
import { base64UrlToBytes, bytesToBase64Url } from "@nexus/protocol";

export interface LocalDeviceState {
  identity: LocalIdentity;
  encryption: DeviceEncryptionKeyPair;
}

export interface LegacyStoredDeviceState {
  version: 1;
  identity: LegacyStoredIdentity;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
}

export interface StoredDeviceState {
  version: 2;
  identity: StoredIdentity;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
}

export type SupportedStoredDeviceState = StoredDeviceState | LegacyStoredDeviceState;

export interface DeviceSecretStore {
  load(profile: string): Promise<string | null>;
  save(profile: string, payload: string): Promise<void>;
}

export async function createLocalDeviceState(displayName: string): Promise<LocalDeviceState> {
  const encryption = await generateDeviceEncryptionKeyPair();
  const identity = await createLocalIdentity(displayName, encryption.publicKeyBytes);
  return { identity, encryption };
}

export async function createLinkedDeviceState(
  source: LocalIdentity,
  displayName = source.displayName,
): Promise<LocalDeviceState> {
  const encryption = await generateDeviceEncryptionKeyPair();
  const identity = await createLinkedIdentity(source, encryption.publicKeyBytes, displayName);
  return {
    identity,
    encryption,
  };
}

export async function exportStoredDeviceState(
  device: LocalDeviceState,
): Promise<StoredDeviceState> {
  return {
    version: 2,
    identity: await exportStoredIdentity(device.identity),
    encryptionPublicKey: bytesToBase64Url(device.encryption.publicKeyBytes),
    encryptionPrivateKey: bytesToBase64Url(
      await exportDeviceEncryptionPrivateKey(device.encryption.privateKey),
    ),
  };
}

export async function importStoredDeviceState(
  stored: SupportedStoredDeviceState,
): Promise<LocalDeviceState> {
  if (stored.version !== 1 && stored.version !== 2) {
    throw new Error("Stored device state version is unsupported");
  }
  const publicKeyBytes = base64UrlToBytes(stored.encryptionPublicKey);
  if (publicKeyBytes.byteLength !== 32) {
    throw new Error("Stored device encryption public key is invalid");
  }
  const publicKey = await crypto.subtle.importKey(
    "raw",
    ownedBuffer(publicKeyBytes),
    { name: "X25519" },
    true,
    [],
  );
  const [identity, privateKey] = await Promise.all([
    importStoredIdentity(
      stored.identity as SupportedStoredIdentity,
      stored.version === 1 ? publicKeyBytes : undefined,
    ),
    importDeviceEncryptionPrivateKey(base64UrlToBytes(stored.encryptionPrivateKey)),
  ]);
  await verifyEncryptionKeyPair(publicKey, privateKey);
  if (identity.deviceCertificate.encryptionPublicKey !== stored.encryptionPublicKey) {
    throw new Error("Stored encryption key is not bound by the device certificate");
  }
  return {
    identity,
    encryption: { publicKey, privateKey, publicKeyBytes },
  };
}

export async function loadOrCreateDeviceState(
  store: DeviceSecretStore,
  profile: string,
  displayName: string,
): Promise<LocalDeviceState> {
  const payload = await store.load(profile);
  const device = payload
    ? await importStoredDeviceState(JSON.parse(payload) as SupportedStoredDeviceState)
    : await createLocalDeviceState(displayName);
  const persist = async () => {
    await store.save(profile, JSON.stringify(await exportStoredDeviceState(device)));
  };
  device.identity.onChange = persist;
  await persist();
  return device;
}

async function verifyEncryptionKeyPair(publicKey: CryptoKey, privateKey: CryptoKey): Promise<void> {
  const ephemeral = await generateDeviceEncryptionKeyPair();
  const [left, right] = await Promise.all([
    crypto.subtle.deriveBits({ name: "X25519", public: publicKey }, ephemeral.privateKey, 256),
    crypto.subtle.deriveBits({ name: "X25519", public: ephemeral.publicKey }, privateKey, 256),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  if (
    leftBytes.byteLength !== rightBytes.byteLength ||
    leftBytes.some((byte, index) => byte !== rightBytes[index])
  ) {
    throw new Error("Stored device encryption private key does not match its public key");
  }
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}
