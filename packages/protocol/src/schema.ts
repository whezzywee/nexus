import { z } from "zod";
import { DEVICE_AUTHORITY_VERSION } from "./device-authority";
import {
  MAX_MESSAGE_CONTENT_BYTES,
  MAX_MESSAGE_OPERATION_BYTES,
  type MessageOperation,
  PROTOCOL_VERSION,
} from "./types";

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const hexPattern = /^[0-9a-f]+$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

export const deviceCertificateSchema = z
  .object({
    version: z.literal(DEVICE_AUTHORITY_VERSION),
    identityId: z.string().regex(/^[0-9a-f]{64}$/),
    deviceId: z.string().regex(ulidPattern),
    rootPublicKey: z.string().regex(base64UrlPattern).max(128),
    signingPublicKey: z.string().regex(base64UrlPattern).max(128),
    encryptionPublicKey: z.string().regex(base64UrlPattern).max(128),
    issuanceSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    signature: z.string().regex(base64UrlPattern).max(256),
  })
  .strict();

export const messageOperationSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    operationId: z.string().regex(ulidPattern),
    messageId: z.string().regex(ulidPattern),
    channelId: z.string().regex(ulidPattern),
    authorId: z.string().min(16).max(128),
    authorDeviceId: z.string().min(16).max(128),
    actorSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    createdAt: z.iso.datetime({ offset: true }),
    clientGeneratedOrder: z.string().regex(ulidPattern),
    content: z.string().max(MAX_MESSAGE_CONTENT_BYTES),
    replyTo: z.string().regex(ulidPattern).optional(),
    attachmentReferences: z.array(z.string().min(16).max(256)).max(8),
    encryptionMetadata: z
      .object({
        suite: z.string().min(1).max(64),
        epoch: z.number().int().nonnegative(),
      })
      .optional(),
    editVersion: z.number().int().nonnegative().max(1_000_000),
    deletionTombstone: z.boolean(),
    publicKey: z.string().regex(base64UrlPattern).max(128),
    deviceCertificate: deviceCertificateSchema,
    signature: z.string().regex(base64UrlPattern).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    if (new TextEncoder().encode(value.content).byteLength > MAX_MESSAGE_CONTENT_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Message content exceeds ${MAX_MESSAGE_CONTENT_BYTES} UTF-8 bytes`,
        path: ["content"],
      });
    }
    const encodedLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (encodedLength > MAX_MESSAGE_OPERATION_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Message operation exceeds ${MAX_MESSAGE_OPERATION_BYTES} bytes`,
      });
    }
    if (value.publicKey.length > 0 && !hexPattern.test(value.authorId)) {
      context.addIssue({
        code: "custom",
        message: "Author identity must be a lowercase hexadecimal fingerprint",
        path: ["authorId"],
      });
    }
  });

export function parseMessageOperation(input: unknown): MessageOperation {
  return messageOperationSchema.parse(input);
}
