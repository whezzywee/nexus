import type { DeviceCertificate } from "./device-authority";

export const PROTOCOL_VERSION = 2 as const;
export const MAX_MESSAGE_CONTENT_BYTES = 8 * 1024;
export const MAX_MESSAGE_OPERATION_BYTES = 32 * 1024;
export const SEGMENT_MESSAGE_TARGET = 512;
export const SEGMENT_STATE_HARD_LIMIT = 8 * 1024 * 1024;

export type Ulid = string;
export type IdentityId = string;
export type DeviceId = string;

export type DeliveryState = "queued" | "submitting" | "accepted" | "retryable" | "rejected";

export interface UnsignedMessageOperation {
  protocolVersion: typeof PROTOCOL_VERSION;
  operationId: Ulid;
  messageId: Ulid;
  channelId: Ulid;
  authorId: IdentityId;
  authorDeviceId: DeviceId;
  actorSequence: number;
  createdAt: string;
  clientGeneratedOrder: Ulid;
  content: string;
  replyTo?: Ulid;
  attachmentReferences: string[];
  encryptionMetadata?: {
    suite: string;
    epoch: number;
  };
  editVersion: number;
  deletionTombstone: boolean;
}

export interface MessageOperation extends UnsignedMessageOperation {
  publicKey: string;
  deviceCertificate: DeviceCertificate;
  signature: string;
}

export interface DisplayMessage extends MessageOperation {
  deliveryState: DeliveryState;
}

export interface SegmentState {
  schemaVersion: typeof PROTOCOL_VERSION;
  messages: Record<Ulid, MessageOperation>;
  seenOperationIds: Ulid[];
}

export interface OperationReceipt {
  operationId: Ulid;
  state: Exclude<DeliveryState, "queued" | "submitting">;
  acceptedAt?: string;
  errorCode?: string;
}
