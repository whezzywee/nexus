import { decryptEnvelope, type EncryptedEnvelope, encryptEnvelope, sha256 } from "@nexus/crypto";
import { type LocalIdentity, signDevicePayload, verifyDevicePayload } from "@nexus/identity";
import { bytesToHex, concatBytes, type DeviceCertificate, hexToBytes } from "@nexus/protocol";
import { ulid } from "ulid";

export const ATTACHMENT_CHUNK_BYTES = 256 * 1024;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_CHUNKS = Math.ceil(MAX_ATTACHMENT_BYTES / ATTACHMENT_CHUNK_BYTES);
const MAX_ATTACHMENT_STORED_CHUNK_BYTES = Math.ceil((ATTACHMENT_CHUNK_BYTES + 16) / 3) * 4 + 512;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface AttachmentChunk {
  index: number;
  plaintextBytes: number;
  storedBytes: number;
  sha256: string;
}

export interface AttachmentManifest {
  version: 2;
  attachmentId: string;
  fileName: string;
  mediaType: string;
  totalBytes: number;
  contentSha256: string;
  chunkBytes: typeof ATTACHMENT_CHUNK_BYTES;
  encrypted: boolean;
  chunks: AttachmentChunk[];
}

export interface PreparedAttachment {
  reference: string;
  manifest: AttachmentManifest;
  chunks: Map<string, Uint8Array>;
}

export interface ResolvedAttachment {
  reference: string;
  manifest: AttachmentManifest;
  bytes: Uint8Array;
}

export type AttachmentProgress = (completed: number, total: number) => void;

export interface AttachmentTransferOptions {
  onProgress?: AttachmentProgress;
  signal?: AbortSignal;
  resumeFromChunk?: number;
}

export interface AttachmentRepository {
  publish(
    prepared: PreparedAttachment,
    identity: LocalIdentity,
    targetId: string,
    options?: AttachmentTransferOptions,
  ): Promise<void>;
  fetch(
    reference: string,
    conversationKey?: CryptoKey,
    options?: AttachmentTransferOptions,
  ): Promise<ResolvedAttachment>;
}

export interface UnsignedAttachmentIndexOperation {
  protocolVersion: 2;
  operationId: string;
  targetId: string;
  authorId: string;
  authorDeviceId: string;
  actorSequence: number;
  reference: string;
  manifest: AttachmentManifest;
  createdAt: string;
}

export interface AttachmentIndexOperation extends UnsignedAttachmentIndexOperation {
  publicKey: string;
  deviceCertificate: DeviceCertificate;
  signature: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const INDEX_DOMAIN = encoder.encode("nexus:attachment-index-operation:v2");

export async function prepareAttachment(
  bytes: Uint8Array,
  fileName: string,
  mediaType: string,
  conversationKey?: CryptoKey,
): Promise<PreparedAttachment> {
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error("Attachment exceeds the 25 MiB limit");
  }
  if (!fileName.trim() || fileName.length > 255 || mediaType.length > 128) {
    throw new Error("Attachment metadata is invalid");
  }
  const attachmentId = ulid();
  const chunks = new Map<string, Uint8Array>();
  const records: AttachmentChunk[] = [];
  const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / ATTACHMENT_CHUNK_BYTES));
  for (let index = 0; index < chunkCount; index += 1) {
    const plaintext = bytes.slice(
      index * ATTACHMENT_CHUNK_BYTES,
      Math.min((index + 1) * ATTACHMENT_CHUNK_BYTES, bytes.byteLength),
    );
    const stored = conversationKey
      ? encoder.encode(
          JSON.stringify(
            await encryptEnvelope(
              conversationKey,
              plaintext,
              attachmentContext(attachmentId, index),
            ),
          ),
        )
      : plaintext;
    const hash = bytesToHex(await sha256(stored));
    chunks.set(hash, stored);
    records.push({
      index,
      plaintextBytes: plaintext.byteLength,
      storedBytes: stored.byteLength,
      sha256: hash,
    });
  }
  const manifest: AttachmentManifest = {
    version: 2,
    attachmentId,
    fileName,
    mediaType,
    totalBytes: bytes.byteLength,
    contentSha256: bytesToHex(await sha256(bytes)),
    chunkBytes: ATTACHMENT_CHUNK_BYTES,
    encrypted: Boolean(conversationKey),
    chunks: records,
  };
  const manifestHash = bytesToHex(await sha256(encoder.encode(JSON.stringify(manifest))));
  return {
    reference: `nexus-attachment:${manifestHash}`,
    manifest,
    chunks,
  };
}

export async function restoreAttachment(
  prepared: PreparedAttachment,
  conversationKey?: CryptoKey,
): Promise<Uint8Array> {
  await validateManifestReference(prepared.reference, prepared.manifest);
  if (prepared.manifest.encrypted !== Boolean(conversationKey)) {
    throw new Error("Attachment encryption key availability does not match the manifest");
  }
  const plaintext: Uint8Array[] = [];
  for (const record of prepared.manifest.chunks) {
    const stored = prepared.chunks.get(record.sha256);
    if (
      !stored ||
      stored.byteLength !== record.storedBytes ||
      bytesToHex(await sha256(stored)) !== record.sha256
    ) {
      throw new Error(`Attachment chunk ${record.index} failed content verification`);
    }
    const decoded = conversationKey
      ? await decryptEnvelope(
          conversationKey,
          JSON.parse(decoder.decode(stored)) as EncryptedEnvelope,
          attachmentContext(prepared.manifest.attachmentId, record.index),
        )
      : stored;
    if (decoded.byteLength !== record.plaintextBytes) {
      throw new Error(`Attachment chunk ${record.index} length is invalid`);
    }
    plaintext.push(decoded);
  }
  const restored = concatBytes(plaintext);
  if (
    restored.byteLength !== prepared.manifest.totalBytes ||
    bytesToHex(await sha256(restored)) !== prepared.manifest.contentSha256
  ) {
    throw new Error("Assembled attachment failed content verification");
  }
  return restored;
}

export async function validateManifestReference(
  reference: string,
  manifest: AttachmentManifest,
): Promise<void> {
  let totalBytes = 0;
  if (
    manifest.version !== 2 ||
    !ULID_PATTERN.test(manifest.attachmentId) ||
    !manifest.fileName.trim() ||
    manifest.fileName.length > 255 ||
    manifest.mediaType.length > 128 ||
    manifest.chunkBytes !== ATTACHMENT_CHUNK_BYTES ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes < 0 ||
    manifest.totalBytes > MAX_ATTACHMENT_BYTES ||
    !SHA256_PATTERN.test(manifest.contentSha256) ||
    manifest.chunks.length === 0 ||
    manifest.chunks.length > MAX_ATTACHMENT_CHUNKS ||
    manifest.chunks.some((chunk, index) => {
      if (
        chunk.index !== index ||
        !Number.isSafeInteger(chunk.plaintextBytes) ||
        chunk.plaintextBytes < 0 ||
        chunk.plaintextBytes > ATTACHMENT_CHUNK_BYTES ||
        (manifest.totalBytes > 0 && chunk.plaintextBytes === 0) ||
        !Number.isSafeInteger(chunk.storedBytes) ||
        chunk.storedBytes < 0 ||
        chunk.storedBytes > MAX_ATTACHMENT_STORED_CHUNK_BYTES ||
        !SHA256_PATTERN.test(chunk.sha256)
      ) {
        return true;
      }
      totalBytes += chunk.plaintextBytes;
      return false;
    }) ||
    totalBytes !== manifest.totalBytes
  ) {
    throw new Error("Attachment manifest is invalid");
  }
  const expected = `nexus-attachment:${bytesToHex(
    await sha256(encoder.encode(JSON.stringify(manifest))),
  )}`;
  if (reference !== expected) {
    throw new Error("Attachment reference does not match its manifest");
  }
}

export async function signAttachmentIndexOperation(
  identity: LocalIdentity,
  operation: UnsignedAttachmentIndexOperation,
): Promise<AttachmentIndexOperation> {
  if (
    operation.authorId !== identity.identityId ||
    operation.authorDeviceId !== identity.deviceId ||
    operation.actorSequence !== identity.nextSequence
  ) {
    throw new Error("Attachment index actor does not match the signing device");
  }
  await validateManifestReference(operation.reference, operation.manifest);
  const deviceSignature = await signDevicePayload(
    identity,
    canonicalAttachmentIndexBytes(operation),
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

export async function verifyAttachmentIndexOperation(
  operation: AttachmentIndexOperation,
): Promise<boolean> {
  try {
    await validateManifestReference(operation.reference, operation.manifest);
    const { publicKey, deviceCertificate, signature, ...unsigned } = operation;
    return verifyDevicePayload(
      { publicKey, deviceCertificate, signature },
      canonicalAttachmentIndexBytes(unsigned),
      operation.authorId,
      operation.authorDeviceId,
    );
  } catch {
    return false;
  }
}

export function canonicalAttachmentIndexBytes(
  operation: UnsignedAttachmentIndexOperation,
): Uint8Array {
  const fields = [
    operation.protocolVersion.toString(),
    operation.operationId,
    operation.targetId,
    operation.authorId,
    operation.authorDeviceId,
    operation.actorSequence.toString(),
    operation.reference,
    operation.createdAt,
  ];
  return concatBytes([frame(INDEX_DOMAIN), ...fields.map((field) => frame(encoder.encode(field)))]);
}

export function attachmentChunkParameters(chunkSha256: string): Uint8Array {
  const parameters = hexToBytes(chunkSha256);
  if (parameters.byteLength !== 32) {
    throw new Error("Attachment chunk parameters require a SHA-256 digest");
  }
  return parameters;
}

export class InMemoryAttachmentRepository implements AttachmentRepository {
  private readonly attachments = new Map<string, PreparedAttachment>();

  async publish(
    prepared: PreparedAttachment,
    identity: LocalIdentity,
    targetId: string,
    options?: AttachmentTransferOptions,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    await signAttachmentIndexOperation(identity, {
      protocolVersion: 2,
      operationId: ulid(),
      targetId,
      authorId: identity.identityId,
      authorDeviceId: identity.deviceId,
      actorSequence: identity.nextSequence,
      reference: prepared.reference,
      manifest: prepared.manifest,
      createdAt: new Date().toISOString(),
    });
    let completed = 0;
    for (const chunk of prepared.manifest.chunks) {
      options?.signal?.throwIfAborted();
      if (!prepared.chunks.has(chunk.sha256)) {
        throw new Error(`Prepared attachment is missing chunk ${chunk.index}`);
      }
      completed += 1;
      options?.onProgress?.(completed, prepared.manifest.chunks.length + 1);
    }
    options?.signal?.throwIfAborted();
    this.attachments.set(prepared.reference, clonePreparedAttachment(prepared));
    options?.onProgress?.(prepared.manifest.chunks.length + 1, prepared.manifest.chunks.length + 1);
  }

  async fetch(
    reference: string,
    conversationKey?: CryptoKey,
    options?: AttachmentTransferOptions,
  ): Promise<ResolvedAttachment> {
    options?.signal?.throwIfAborted();
    const stored = this.attachments.get(reference);
    if (!stored) throw new Error("Attachment is not available on this transport");
    let completed = Math.min(options?.resumeFromChunk ?? 0, stored.manifest.chunks.length);
    for (const chunk of stored.manifest.chunks.slice(completed)) {
      options?.signal?.throwIfAborted();
      completed = chunk.index + 1;
      options?.onProgress?.(completed, stored.manifest.chunks.length);
    }
    options?.signal?.throwIfAborted();
    return {
      reference,
      manifest: structuredClone(stored.manifest),
      bytes: await restoreAttachment(stored, conversationKey),
    };
  }
}

function clonePreparedAttachment(prepared: PreparedAttachment): PreparedAttachment {
  return {
    reference: prepared.reference,
    manifest: structuredClone(prepared.manifest),
    chunks: new Map([...prepared.chunks].map(([hash, bytes]) => [hash, Uint8Array.from(bytes)])),
  };
}

function attachmentContext(attachmentId: string, index: number): Uint8Array {
  return encoder.encode(`nexus:attachment-chunk:v2:${attachmentId}:${index}`);
}

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.byteLength);
  new DataView(output.buffer).setUint32(0, bytes.byteLength, false);
  output.set(bytes, 4);
  return output;
}
