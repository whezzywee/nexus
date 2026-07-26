import type { DisplayMessage } from "@nexus/protocol";
import { describe, expect, it } from "vitest";
import {
  acceptedMessageIds,
  findNewRemoteMessages,
  messageNotificationCopy,
  searchDisplayMessages,
} from "./experience";

function message(
  operationId: string,
  authorId: string,
  content: string,
  overrides: Partial<DisplayMessage> = {},
): DisplayMessage {
  return {
    protocolVersion: 2,
    operationId,
    messageId: operationId,
    channelId: "01K10KJ6P20S58KQBV5P4E3T9Z",
    authorId,
    authorDeviceId: `${authorId}-device`,
    actorSequence: 1,
    createdAt: "2026-07-26T12:00:00.000Z",
    clientGeneratedOrder: operationId,
    content,
    attachmentReferences: [],
    editVersion: 0,
    deletionTombstone: false,
    publicKey: "public-key",
    deviceCertificate: {
      version: 2,
      identityId: authorId,
      deviceId: `${authorId}-device`,
      rootPublicKey: "root-public-key",
      signingPublicKey: "public-key",
      encryptionPublicKey: "encryption-public-key",
      issuanceSequence: 1,
      issuedAt: "2026-07-26T12:00:00.000Z",
      signature: "certificate-signature",
    },
    signature: "signature",
    deliveryState: "accepted",
    ...overrides,
  };
}

describe("Phase 4 client experience helpers", () => {
  it("searches locally displayed content and author names without changing message order", () => {
    const messages = [
      message("01", "mara", "Bring the telescope"),
      message("02", "theo", "Campfire notes"),
    ];
    const names = new Map([
      ["mara", "Mara"],
      ["theo", "Theo"],
    ]);

    expect(searchDisplayMessages(messages, " telescope ", (id) => names.get(id) ?? id)).toEqual([
      messages[0],
    ]);
    expect(searchDisplayMessages(messages, "THEO", (id) => names.get(id) ?? id)).toEqual([
      messages[1],
    ]);
  });

  it("only returns newly accepted messages written by another identity", () => {
    const oldRemote = message("01", "mara", "Old");
    const newOwn = message("02", "theo", "Mine");
    const newRemote = message("03", "mara", "New");
    const queuedRemote = message("04", "mara", "Queued", { deliveryState: "queued" });

    expect(
      findNewRemoteMessages(
        [oldRemote, newOwn, newRemote, queuedRemote],
        new Set(["01"]),
        new Set(["theo"]),
      ),
    ).toEqual([newRemote]);
    expect(acceptedMessageIds([oldRemote, queuedRemote])).toEqual(new Set(["01"]));
  });

  it("never places private message content in notification copy", () => {
    const privateMessage = message("01", "mara", "A private launch code", {
      encryptionMetadata: { suite: "AES-256-GCM", epoch: 4 },
    });

    const copy = messageNotificationCopy(privateMessage, "Mara", "campfire");
    expect(copy.title).toContain("private message");
    expect(copy.body).not.toContain(privateMessage.content);
  });
});
