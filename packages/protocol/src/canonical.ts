import type { UnsignedMessageOperation } from "./types";

const encoder = new TextEncoder();
const DOMAIN = encoder.encode("nexus:message-operation:v2");

function field(bytes: Uint8Array): Uint8Array {
  const framed = new Uint8Array(4 + bytes.byteLength);
  new DataView(framed.buffer).setUint32(0, bytes.byteLength, false);
  framed.set(bytes, 4);
  return framed;
}

function text(value: string): Uint8Array {
  return field(encoder.encode(value));
}

function number(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return field(bytes);
}

function boolean(value: boolean): Uint8Array {
  return field(Uint8Array.of(value ? 1 : 0));
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function canonicalMessageBytes(operation: UnsignedMessageOperation): Uint8Array {
  const encryption = operation.encryptionMetadata
    ? `${operation.encryptionMetadata.suite}:${operation.encryptionMetadata.epoch}`
    : "";

  return concatBytes([
    field(DOMAIN),
    number(operation.protocolVersion),
    text(operation.operationId),
    text(operation.messageId),
    text(operation.channelId),
    text(operation.authorId),
    text(operation.authorDeviceId),
    number(operation.actorSequence),
    text(operation.createdAt),
    text(operation.clientGeneratedOrder),
    text(operation.content),
    text(operation.replyTo ?? ""),
    text(operation.attachmentReferences.join("\u001f")),
    text(encryption),
    number(operation.editVersion),
    boolean(operation.deletionTombstone),
  ]);
}
