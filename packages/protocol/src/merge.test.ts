import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { applyMessageOperation, emptySegmentState, mergeSegmentStates } from "./merge";
import { type MessageOperation, PROTOCOL_VERSION } from "./types";

const channelId = ulid();
const identityId = "a".repeat(64);
const deviceId = ulid();

function operation(
  overrides: Partial<MessageOperation> & Pick<MessageOperation, "messageId" | "operationId">,
): MessageOperation {
  return {
    protocolVersion: PROTOCOL_VERSION,
    channelId,
    authorId: identityId,
    authorDeviceId: deviceId,
    actorSequence: 1,
    createdAt: "2026-07-26T12:00:00.000+00:00",
    clientGeneratedOrder: ulid(),
    content: "hello",
    attachmentReferences: [],
    editVersion: 0,
    deletionTombstone: false,
    publicKey: "A".repeat(43),
    deviceCertificate: {
      version: 2,
      identityId,
      deviceId,
      rootPublicKey: "C".repeat(43),
      signingPublicKey: "A".repeat(43),
      encryptionPublicKey: "D".repeat(43),
      issuanceSequence: 1,
      issuedAt: "2026-07-26T12:00:00.000+00:00",
      signature: "E".repeat(86),
    },
    signature: "B".repeat(86),
    ...overrides,
  };
}

describe("message segment merge", () => {
  it("converges when concurrent updates arrive in opposite orders", () => {
    const first = operation({ messageId: ulid(), operationId: ulid(), content: "first" });
    const second = operation({
      messageId: ulid(),
      operationId: ulid(),
      actorSequence: 2,
      content: "second",
    });

    const forward = applyMessageOperation(
      applyMessageOperation(emptySegmentState(), first),
      second,
    );
    const reverse = applyMessageOperation(
      applyMessageOperation(emptySegmentState(), second),
      first,
    );

    expect(forward).toEqual(reverse);
  });

  it("is idempotent for duplicate operations", () => {
    const message = operation({ messageId: ulid(), operationId: ulid() });
    const once = applyMessageOperation(emptySegmentState(), message);
    expect(applyMessageOperation(once, message)).toEqual(once);
  });

  it("makes deletion win an equal-version conflict", () => {
    const messageId = ulid();
    const visible = operation({ messageId, operationId: ulid(), content: "visible" });
    const deleted = operation({
      messageId,
      operationId: ulid(),
      content: "",
      deletionTombstone: true,
    });

    const left = applyMessageOperation(emptySegmentState(), visible);
    const right = applyMessageOperation(emptySegmentState(), deleted);
    expect(mergeSegmentStates(left, right).messages[messageId]?.deletionTombstone).toBe(true);
    expect(mergeSegmentStates(right, left)).toEqual(mergeSegmentStates(left, right));
  });
});
