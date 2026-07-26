import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  canonicalDeviceCertificateBytes,
  canonicalMessageBytes,
  type DeviceCertificate,
  type DeviceSignature,
  type MessageOperation,
  type UnsignedDeviceCertificate,
  type UnsignedMessageOperation,
} from "@nexus/protocol";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { ulid } from "ulid";

export interface LocalIdentity {
  identityId: string;
  deviceId: string;
  displayName: string;
  rootPublicKey: CryptoKey;
  rootPrivateKey?: CryptoKey;
  rootPublicKeyBytes: Uint8Array;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
  deviceCertificate: DeviceCertificate;
  nextSequence: number;
  nextCertificateSequence: number;
  onChange?: (identity: LocalIdentity) => Promise<void>;
}

export interface LegacyStoredIdentity {
  version: 1;
  identityId: string;
  deviceId: string;
  displayName: string;
  publicKey: string;
  privateKey: string;
  nextSequence: number;
}

export interface StoredIdentity {
  version: 2;
  identityId: string;
  deviceId: string;
  displayName: string;
  rootPublicKey: string;
  rootPrivateKey?: string;
  publicKey: string;
  privateKey: string;
  deviceCertificate: DeviceCertificate;
  nextSequence: number;
  nextCertificateSequence: number;
}

export type SupportedStoredIdentity = StoredIdentity | LegacyStoredIdentity;

export interface LegacyIdentityRecoveryBundle {
  version: 1;
  kdf: "PBKDF2-SHA-256";
  iterations: 310_000;
  cipher: "AES-256-GCM";
  salt: string;
  nonce: string;
  ciphertext: string;
}

export interface IdentityRecoveryBundle {
  version: 2;
  kdf: "Argon2id";
  memoryKiB: 65_536;
  passes: 3;
  parallelism: 1;
  cipher: "AES-256-GCM";
  salt: string;
  nonce: string;
  ciphertext: string;
}

export type SupportedIdentityRecoveryBundle = IdentityRecoveryBundle | LegacyIdentityRecoveryBundle;

const RECOVERY_CONTEXT_V1 = new TextEncoder().encode("nexus-identity-recovery:v1");
const RECOVERY_CONTEXT_V2 = new TextEncoder().encode("nexus-identity-recovery:v2");
const ARGON2_MEMORY_KIB = 65_536 as const;
const ARGON2_PASSES = 3 as const;
const ARGON2_PARALLELISM = 1 as const;

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>;
}

async function exportPublicKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

async function importPublicKey(bytes: Uint8Array): Promise<CryptoKey> {
  if (bytes.byteLength !== 32) throw new Error("Ed25519 public key must contain 32 bytes");
  return crypto.subtle.importKey("raw", ownedBuffer(bytes), { name: "Ed25519" }, true, ["verify"]);
}

async function importPrivateKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", ownedBuffer(bytes), { name: "Ed25519" }, true, ["sign"]);
}

async function verifySigningKeyPair(publicKey: CryptoKey, privateKey: CryptoKey): Promise<void> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const signature = await crypto.subtle.sign("Ed25519", privateKey, ownedBuffer(challenge));
  if (!(await crypto.subtle.verify("Ed25519", publicKey, signature, ownedBuffer(challenge)))) {
    throw new Error("Stored signing private key does not match its public key");
  }
}

async function generateEncryptionPublicKey(): Promise<Uint8Array> {
  const keyPair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
}

async function issueDeviceCertificate(
  rootPrivateKey: CryptoKey,
  rootPublicKeyBytes: Uint8Array,
  identityId: string,
  deviceId: string,
  signingPublicKeyBytes: Uint8Array,
  encryptionPublicKeyBytes: Uint8Array,
  issuanceSequence: number,
): Promise<DeviceCertificate> {
  if (encryptionPublicKeyBytes.byteLength !== 32) {
    throw new Error("A certified device encryption key must contain 32 bytes");
  }
  const unsigned: UnsignedDeviceCertificate = {
    version: 2,
    identityId,
    deviceId,
    rootPublicKey: bytesToBase64Url(rootPublicKeyBytes),
    signingPublicKey: bytesToBase64Url(signingPublicKeyBytes),
    encryptionPublicKey: bytesToBase64Url(encryptionPublicKeyBytes),
    issuanceSequence,
    issuedAt: new Date().toISOString(),
  };
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      rootPrivateKey,
      ownedBuffer(canonicalDeviceCertificateBytes(unsigned)),
    ),
  );
  return { ...unsigned, signature: bytesToBase64Url(signature) };
}

export async function verifyDeviceCertificate(certificate: DeviceCertificate): Promise<boolean> {
  try {
    if (
      certificate.version !== 2 ||
      !Number.isSafeInteger(certificate.issuanceSequence) ||
      certificate.issuanceSequence < 1 ||
      base64UrlToBytes(certificate.rootPublicKey).byteLength !== 32 ||
      base64UrlToBytes(certificate.signingPublicKey).byteLength !== 32 ||
      base64UrlToBytes(certificate.encryptionPublicKey).byteLength !== 32
    ) {
      return false;
    }
    const rootPublicKeyBytes = base64UrlToBytes(certificate.rootPublicKey);
    const fingerprint = new Uint8Array(
      await crypto.subtle.digest("SHA-256", ownedBuffer(rootPublicKeyBytes)),
    );
    if (bytesToHex(fingerprint) !== certificate.identityId) return false;
    if (certificate.expiresAt && Date.parse(certificate.expiresAt) <= Date.now()) return false;
    const rootPublicKey = await importPublicKey(rootPublicKeyBytes);
    const { signature: _signature, ...unsigned } = certificate;
    return crypto.subtle.verify(
      "Ed25519",
      rootPublicKey,
      ownedBuffer(base64UrlToBytes(certificate.signature)),
      ownedBuffer(canonicalDeviceCertificateBytes(unsigned)),
    );
  } catch {
    return false;
  }
}

export async function signDevicePayload(
  identity: LocalIdentity,
  payload: Uint8Array,
  assertedIdentityId: string,
  assertedDeviceId: string,
): Promise<DeviceSignature> {
  if (
    assertedIdentityId !== identity.identityId ||
    assertedDeviceId !== identity.deviceId ||
    identity.deviceCertificate.identityId !== assertedIdentityId ||
    identity.deviceCertificate.deviceId !== assertedDeviceId
  ) {
    throw new Error("Operation actor does not match the certified signing device");
  }
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", identity.privateKey, ownedBuffer(payload)),
  );
  return {
    publicKey: bytesToBase64Url(identity.publicKeyBytes),
    deviceCertificate: identity.deviceCertificate,
    signature: bytesToBase64Url(signature),
  };
}

export async function verifyDevicePayload(
  signed: DeviceSignature,
  payload: Uint8Array,
  assertedIdentityId: string,
  assertedDeviceId: string,
): Promise<boolean> {
  try {
    if (
      signed.deviceCertificate.identityId !== assertedIdentityId ||
      signed.deviceCertificate.deviceId !== assertedDeviceId ||
      signed.deviceCertificate.signingPublicKey !== signed.publicKey ||
      !(await verifyDeviceCertificate(signed.deviceCertificate))
    ) {
      return false;
    }
    const publicKey = await importPublicKey(base64UrlToBytes(signed.publicKey));
    return crypto.subtle.verify(
      "Ed25519",
      publicKey,
      ownedBuffer(base64UrlToBytes(signed.signature)),
      ownedBuffer(payload),
    );
  } catch {
    return false;
  }
}

export async function createLocalIdentity(
  displayName: string,
  encryptionPublicKeyBytes?: Uint8Array,
): Promise<LocalIdentity> {
  const [rootKeyPair, deviceKeyPair, encryptionPublicKey] = await Promise.all([
    generateSigningKeyPair(),
    generateSigningKeyPair(),
    encryptionPublicKeyBytes
      ? Promise.resolve(Uint8Array.from(encryptionPublicKeyBytes))
      : generateEncryptionPublicKey(),
  ]);
  const rootPublicKeyBytes = await exportPublicKey(rootKeyPair.publicKey);
  const publicKeyBytes = await exportPublicKey(deviceKeyPair.publicKey);
  const fingerprint = new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownedBuffer(rootPublicKeyBytes)),
  );
  const identityId = bytesToHex(fingerprint);
  const deviceId = ulid();
  const deviceCertificate = await issueDeviceCertificate(
    rootKeyPair.privateKey,
    rootPublicKeyBytes,
    identityId,
    deviceId,
    publicKeyBytes,
    encryptionPublicKey,
    1,
  );

  return {
    identityId,
    deviceId,
    displayName,
    rootPublicKey: rootKeyPair.publicKey,
    rootPrivateKey: rootKeyPair.privateKey,
    rootPublicKeyBytes,
    publicKey: deviceKeyPair.publicKey,
    privateKey: deviceKeyPair.privateKey,
    publicKeyBytes,
    deviceCertificate,
    nextSequence: 1,
    nextCertificateSequence: 2,
  };
}

export async function exportStoredIdentity(identity: LocalIdentity): Promise<StoredIdentity> {
  return {
    version: 2,
    identityId: identity.identityId,
    deviceId: identity.deviceId,
    displayName: identity.displayName,
    rootPublicKey: bytesToBase64Url(identity.rootPublicKeyBytes),
    rootPrivateKey: identity.rootPrivateKey
      ? bytesToBase64Url(
          new Uint8Array(await crypto.subtle.exportKey("pkcs8", identity.rootPrivateKey)),
        )
      : undefined,
    publicKey: bytesToBase64Url(identity.publicKeyBytes),
    privateKey: bytesToBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", identity.privateKey)),
    ),
    deviceCertificate: identity.deviceCertificate,
    nextSequence: identity.nextSequence,
    nextCertificateSequence: identity.nextCertificateSequence,
  };
}

export async function importStoredIdentity(
  record: SupportedStoredIdentity,
  migrationEncryptionPublicKey?: Uint8Array,
): Promise<LocalIdentity> {
  if (record.version === 1) {
    return migrateLegacyStoredIdentity(record, migrationEncryptionPublicKey);
  }
  if (
    record.version !== 2 ||
    !record.deviceId ||
    !record.displayName ||
    !Number.isSafeInteger(record.nextSequence) ||
    record.nextSequence < 1 ||
    !Number.isSafeInteger(record.nextCertificateSequence) ||
    record.nextCertificateSequence <= record.deviceCertificate.issuanceSequence
  ) {
    throw new Error("Stored identity metadata is invalid");
  }
  const rootPublicKeyBytes = base64UrlToBytes(record.rootPublicKey);
  const publicKeyBytes = base64UrlToBytes(record.publicKey);
  const fingerprint = new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownedBuffer(rootPublicKeyBytes)),
  );
  if (bytesToHex(fingerprint) !== record.identityId) {
    throw new Error("Stored identity fingerprint does not match its root public key");
  }
  const [rootPublicKey, publicKey, privateKey] = await Promise.all([
    importPublicKey(rootPublicKeyBytes),
    importPublicKey(publicKeyBytes),
    importPrivateKey(base64UrlToBytes(record.privateKey)),
  ]);
  await verifySigningKeyPair(publicKey, privateKey);
  const rootPrivateKey = record.rootPrivateKey
    ? await importPrivateKey(base64UrlToBytes(record.rootPrivateKey))
    : undefined;
  if (rootPrivateKey) {
    await verifySigningKeyPair(rootPublicKey, rootPrivateKey);
  }
  if (
    !(await verifyDeviceCertificate(record.deviceCertificate)) ||
    record.deviceCertificate.identityId !== record.identityId ||
    record.deviceCertificate.deviceId !== record.deviceId ||
    record.deviceCertificate.rootPublicKey !== record.rootPublicKey ||
    record.deviceCertificate.signingPublicKey !== record.publicKey
  ) {
    throw new Error("Stored device certificate is invalid");
  }
  return {
    identityId: record.identityId,
    deviceId: record.deviceId,
    displayName: record.displayName,
    rootPublicKey,
    rootPrivateKey,
    rootPublicKeyBytes,
    publicKey,
    privateKey,
    publicKeyBytes,
    deviceCertificate: record.deviceCertificate,
    nextSequence: record.nextSequence,
    nextCertificateSequence: record.nextCertificateSequence,
  };
}

export async function createLinkedIdentity(
  source: LocalIdentity,
  encryptionPublicKeyBytes: Uint8Array,
  displayName = source.displayName,
): Promise<LocalIdentity> {
  if (!source.rootPrivateKey) {
    throw new Error("Linking a device requires the identity root recovery authority");
  }
  const deviceKeyPair = await generateSigningKeyPair();
  const publicKeyBytes = await exportPublicKey(deviceKeyPair.publicKey);
  const deviceId = ulid();
  const issuanceSequence = source.nextCertificateSequence;
  const deviceCertificate = await issueDeviceCertificate(
    source.rootPrivateKey,
    source.rootPublicKeyBytes,
    source.identityId,
    deviceId,
    publicKeyBytes,
    encryptionPublicKeyBytes,
    issuanceSequence,
  );
  source.nextCertificateSequence += 1;
  await source.onChange?.(source);
  return {
    identityId: source.identityId,
    deviceId,
    displayName,
    rootPublicKey: source.rootPublicKey,
    rootPublicKeyBytes: Uint8Array.from(source.rootPublicKeyBytes),
    publicKey: deviceKeyPair.publicKey,
    privateKey: deviceKeyPair.privateKey,
    publicKeyBytes,
    deviceCertificate,
    nextSequence: 1,
    nextCertificateSequence: source.nextCertificateSequence,
  };
}

async function migrateLegacyStoredIdentity(
  record: LegacyStoredIdentity,
  migrationEncryptionPublicKey?: Uint8Array,
): Promise<LocalIdentity> {
  if (
    !record.deviceId ||
    !record.displayName ||
    !Number.isSafeInteger(record.nextSequence) ||
    record.nextSequence < 1
  ) {
    throw new Error("Legacy stored identity metadata is invalid");
  }
  const rootPublicKeyBytes = base64UrlToBytes(record.publicKey);
  const fingerprint = new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownedBuffer(rootPublicKeyBytes)),
  );
  if (bytesToHex(fingerprint) !== record.identityId) {
    throw new Error("Legacy identity fingerprint does not match its root public key");
  }
  const [rootPublicKey, rootPrivateKey, deviceKeyPair, encryptionPublicKey] = await Promise.all([
    importPublicKey(rootPublicKeyBytes),
    importPrivateKey(base64UrlToBytes(record.privateKey)),
    generateSigningKeyPair(),
    migrationEncryptionPublicKey
      ? Promise.resolve(Uint8Array.from(migrationEncryptionPublicKey))
      : generateEncryptionPublicKey(),
  ]);
  await verifySigningKeyPair(rootPublicKey, rootPrivateKey);
  const publicKeyBytes = await exportPublicKey(deviceKeyPair.publicKey);
  const deviceCertificate = await issueDeviceCertificate(
    rootPrivateKey,
    rootPublicKeyBytes,
    record.identityId,
    record.deviceId,
    publicKeyBytes,
    encryptionPublicKey,
    1,
  );
  return {
    identityId: record.identityId,
    deviceId: record.deviceId,
    displayName: record.displayName,
    rootPublicKey,
    rootPrivateKey,
    rootPublicKeyBytes,
    publicKey: deviceKeyPair.publicKey,
    privateKey: deviceKeyPair.privateKey,
    publicKeyBytes,
    deviceCertificate,
    nextSequence: record.nextSequence,
    nextCertificateSequence: 2,
  };
}

export async function createIdentityRecoveryBundle(
  identity: LocalIdentity,
  passphrase: string,
): Promise<IdentityRecoveryBundle> {
  if (!identity.rootPrivateKey) {
    throw new Error("Recovery export requires the identity root authority");
  }
  if (passphrase.length < 12) {
    throw new Error("Recovery passphrase must contain at least 12 characters");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveArgon2idRecoveryKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(await exportStoredIdentity(identity)));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(nonce),
        additionalData: ownedBuffer(RECOVERY_CONTEXT_V2),
        tagLength: 128,
      },
      key,
      ownedBuffer(plaintext),
    ),
  );
  return {
    version: 2,
    kdf: "Argon2id",
    memoryKiB: ARGON2_MEMORY_KIB,
    passes: ARGON2_PASSES,
    parallelism: ARGON2_PARALLELISM,
    cipher: "AES-256-GCM",
    salt: bytesToBase64Url(salt),
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(ciphertext),
  };
}

export async function restoreIdentityRecoveryBundle(
  bundle: SupportedIdentityRecoveryBundle,
  passphrase: string,
): Promise<LocalIdentity> {
  if (bundle.version === 1) {
    return restoreLegacyIdentityRecoveryBundle(bundle, passphrase);
  }
  if (
    bundle.version !== 2 ||
    bundle.kdf !== "Argon2id" ||
    bundle.memoryKiB !== ARGON2_MEMORY_KIB ||
    bundle.passes !== ARGON2_PASSES ||
    bundle.parallelism !== ARGON2_PARALLELISM ||
    bundle.cipher !== "AES-256-GCM"
  ) {
    throw new Error("Unsupported identity recovery bundle");
  }
  const key = await deriveArgon2idRecoveryKey(passphrase, base64UrlToBytes(bundle.salt));
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: ownedBuffer(base64UrlToBytes(bundle.nonce)),
      additionalData: ownedBuffer(RECOVERY_CONTEXT_V2),
      tagLength: 128,
    },
    key,
    ownedBuffer(base64UrlToBytes(bundle.ciphertext)),
  );
  return importStoredIdentity(
    JSON.parse(new TextDecoder().decode(plaintext)) as SupportedStoredIdentity,
  );
}

async function deriveArgon2idRecoveryKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const derived = await argon2idAsync(new TextEncoder().encode(passphrase), salt, {
    t: ARGON2_PASSES,
    m: ARGON2_MEMORY_KIB,
    p: ARGON2_PARALLELISM,
    dkLen: 32,
    asyncTick: 10,
    maxmem: 96 * 1024 * 1024,
  });
  return crypto.subtle.importKey("raw", ownedBuffer(derived), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function restoreLegacyIdentityRecoveryBundle(
  bundle: LegacyIdentityRecoveryBundle,
  passphrase: string,
): Promise<LocalIdentity> {
  if (
    bundle.version !== 1 ||
    bundle.kdf !== "PBKDF2-SHA-256" ||
    bundle.iterations !== 310_000 ||
    bundle.cipher !== "AES-256-GCM"
  ) {
    throw new Error("Unsupported legacy identity recovery bundle");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: ownedBuffer(base64UrlToBytes(bundle.salt)),
      iterations: bundle.iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: ownedBuffer(base64UrlToBytes(bundle.nonce)),
      additionalData: ownedBuffer(RECOVERY_CONTEXT_V1),
      tagLength: 128,
    },
    key,
    ownedBuffer(base64UrlToBytes(bundle.ciphertext)),
  );
  return importStoredIdentity(
    JSON.parse(new TextDecoder().decode(plaintext)) as SupportedStoredIdentity,
  );
}

export async function signMessageOperation(
  identity: LocalIdentity,
  operation: UnsignedMessageOperation,
): Promise<MessageOperation> {
  if (
    operation.authorId !== identity.identityId ||
    operation.authorDeviceId !== identity.deviceId
  ) {
    throw new Error("Operation author does not match the signing identity");
  }
  if (operation.actorSequence !== identity.nextSequence) {
    throw new Error(`Expected actor sequence ${identity.nextSequence}`);
  }

  const deviceSignature = await signDevicePayload(
    identity,
    canonicalMessageBytes(operation),
    operation.authorId,
    operation.authorDeviceId,
  );
  identity.nextSequence += 1;
  await identity.onChange?.(identity);

  return {
    ...operation,
    ...deviceSignature,
  };
}

export async function verifyMessageOperation(operation: MessageOperation): Promise<boolean> {
  try {
    const { publicKey, deviceCertificate, signature, ...unsigned } = operation;
    return verifyDevicePayload(
      { publicKey, deviceCertificate, signature },
      canonicalMessageBytes(unsigned),
      operation.authorId,
      operation.authorDeviceId,
    );
  } catch {
    return false;
  }
}
