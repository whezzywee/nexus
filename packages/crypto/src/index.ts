import { base64UrlToBytes, bytesToBase64Url } from "@nexus/protocol";

const AES_GCM_NONCE_BYTES = 12;
const X25519_KEY_BYTES = 32;

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export interface EncryptedEnvelope {
  suite: "AES-256-GCM";
  nonce: string;
  ciphertext: string;
}

export interface DeviceEncryptionKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

export interface EpochKeyRecipient {
  deviceId: string;
  publicKey: Uint8Array;
}

export interface SealedEpochKey {
  suite: "X25519-HKDF-SHA-256+AES-256-GCM";
  conversationId: string;
  epoch: number;
  recipientDeviceId: string;
  ephemeralPublicKey: string;
  salt: string;
  envelope: EncryptedEnvelope;
}

export interface GroupCipher {
  sealEpochKey(
    conversationId: string,
    epoch: number,
    key: CryptoKey,
    recipients: EpochKeyRecipient[],
  ): Promise<SealedEpochKey[]>;
  openEpochKey(
    sealed: SealedEpochKey,
    recipientDeviceId: string,
    recipientPrivateKey: CryptoKey,
  ): Promise<CryptoKey>;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBuffer(bytes)));
}

export async function generateConversationKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function exportConversationKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

export async function importConversationKey(bytes: Uint8Array): Promise<CryptoKey> {
  if (bytes.byteLength !== 32) {
    throw new Error("An AES-256 conversation key must contain 32 bytes");
  }
  return crypto.subtle.importKey("raw", ownedBuffer(bytes), "AES-GCM", true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptEnvelope(
  key: CryptoKey,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): Promise<EncryptedEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(nonce),
        additionalData: ownedBuffer(associatedData),
        tagLength: 128,
      },
      key,
      ownedBuffer(plaintext),
    ),
  );
  return {
    suite: "AES-256-GCM",
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(ciphertext),
  };
}

export async function decryptEnvelope(
  key: CryptoKey,
  envelope: EncryptedEnvelope,
  associatedData: Uint8Array,
): Promise<Uint8Array> {
  if (envelope.suite !== "AES-256-GCM") {
    throw new Error(`Unsupported envelope suite: ${envelope.suite}`);
  }
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(base64UrlToBytes(envelope.nonce)),
        additionalData: ownedBuffer(associatedData),
        tagLength: 128,
      },
      key,
      ownedBuffer(base64UrlToBytes(envelope.ciphertext)),
    ),
  );
}

export async function generateDeviceEncryptionKeyPair(): Promise<DeviceEncryptionKeyPair> {
  const keyPair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyBytes: new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)),
  };
}

export async function exportDeviceEncryptionPrivateKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("pkcs8", key));
}

export async function importDeviceEncryptionPrivateKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", ownedBuffer(bytes), { name: "X25519" }, true, [
    "deriveBits",
  ]);
}

export class X25519GroupCipher implements GroupCipher {
  async sealEpochKey(
    conversationId: string,
    epoch: number,
    key: CryptoKey,
    recipients: EpochKeyRecipient[],
  ): Promise<SealedEpochKey[]> {
    if (!conversationId || !Number.isSafeInteger(epoch) || epoch < 1) {
      throw new Error("Conversation epoch metadata is invalid");
    }
    if (new Set(recipients.map((recipient) => recipient.deviceId)).size !== recipients.length) {
      throw new Error("Epoch key recipients must be unique devices");
    }
    const plaintext = await exportConversationKey(key);
    return Promise.all(
      recipients.map(async (recipient) => {
        if (recipient.publicKey.byteLength !== X25519_KEY_BYTES) {
          throw new Error("An X25519 recipient public key must contain 32 bytes");
        }
        const ephemeral = await generateDeviceEncryptionKeyPair();
        const recipientPublicKey = await crypto.subtle.importKey(
          "raw",
          ownedBuffer(recipient.publicKey),
          { name: "X25519" },
          false,
          [],
        );
        const sharedSecret = new Uint8Array(
          await crypto.subtle.deriveBits(
            { name: "X25519", public: recipientPublicKey },
            ephemeral.privateKey,
            256,
          ),
        );
        assertContributorySharedSecret(sharedSecret);
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const wrappingKey = await deriveWrappingKey(
          sharedSecret,
          salt,
          epochContext(conversationId, epoch, recipient.deviceId),
        );
        return {
          suite: "X25519-HKDF-SHA-256+AES-256-GCM" as const,
          conversationId,
          epoch,
          recipientDeviceId: recipient.deviceId,
          ephemeralPublicKey: bytesToBase64Url(ephemeral.publicKeyBytes),
          salt: bytesToBase64Url(salt),
          envelope: await encryptEnvelope(
            wrappingKey,
            plaintext,
            epochContext(conversationId, epoch, recipient.deviceId),
          ),
        };
      }),
    );
  }

  async openEpochKey(
    sealed: SealedEpochKey,
    recipientDeviceId: string,
    recipientPrivateKey: CryptoKey,
  ): Promise<CryptoKey> {
    if (
      sealed.suite !== "X25519-HKDF-SHA-256+AES-256-GCM" ||
      sealed.recipientDeviceId !== recipientDeviceId
    ) {
      throw new Error("Sealed epoch key is not addressed to this device");
    }
    const ephemeralPublicKey = await crypto.subtle.importKey(
      "raw",
      ownedBuffer(base64UrlToBytes(sealed.ephemeralPublicKey)),
      { name: "X25519" },
      false,
      [],
    );
    const sharedSecret = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "X25519", public: ephemeralPublicKey },
        recipientPrivateKey,
        256,
      ),
    );
    assertContributorySharedSecret(sharedSecret);
    const context = epochContext(sealed.conversationId, sealed.epoch, sealed.recipientDeviceId);
    const wrappingKey = await deriveWrappingKey(
      sharedSecret,
      base64UrlToBytes(sealed.salt),
      context,
    );
    return importConversationKey(await decryptEnvelope(wrappingKey, sealed.envelope, context));
  }
}

async function deriveWrappingKey(
  sharedSecret: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", ownedBuffer(sharedSecret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ownedBuffer(salt),
      info: ownedBuffer(info),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function assertContributorySharedSecret(secret: Uint8Array): void {
  if (secret.byteLength !== X25519_KEY_BYTES || secret.every((byte) => byte === 0)) {
    throw new Error("X25519 key agreement produced an invalid shared secret");
  }
}

function epochContext(conversationId: string, epoch: number, deviceId: string): Uint8Array {
  return new TextEncoder().encode(
    `nexus:conversation-key:v1:${conversationId}:${epoch}:${deviceId}`,
  );
}
