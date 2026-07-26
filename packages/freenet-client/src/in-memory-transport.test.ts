import { createLocalIdentity, signMessageOperation } from "@nexus/identity";
import { PROTOCOL_VERSION } from "@nexus/protocol";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { InMemoryContractHub, InMemoryContractTransport } from "./in-memory-transport";

describe("in-memory contract transport", () => {
  it("broadcasts an accepted signed operation to two peers", async () => {
    const hub = new InMemoryContractHub();
    const first = new InMemoryContractTransport(hub, "segment");
    const second = new InMemoryContractTransport(hub, "segment");
    const identity = await createLocalIdentity("Ada");
    await Promise.all([first.connect(), second.connect()]);

    const messageId = ulid();
    const operation = await signMessageOperation(identity, {
      protocolVersion: PROTOCOL_VERSION,
      operationId: ulid(),
      messageId,
      channelId: ulid(),
      authorId: identity.identityId,
      authorDeviceId: identity.deviceId,
      actorSequence: identity.nextSequence,
      createdAt: new Date().toISOString(),
      clientGeneratedOrder: ulid(),
      content: "hello from peer one",
      attachmentReferences: [],
      editVersion: 0,
      deletionTombstone: false,
    });

    const received = new Promise<void>((resolve) => {
      second.subscribe((state) => {
        if (state.messages[messageId]) {
          resolve();
        }
      });
    });
    expect((await first.submit(operation)).state).toBe("accepted");
    await received;
    expect((await second.read()).messages[messageId]?.content).toBe("hello from peer one");
  });
});
