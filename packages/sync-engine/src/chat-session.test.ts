import { InMemoryContractHub, InMemoryContractTransport } from "@nexus/freenet-client";
import { createLocalIdentity } from "@nexus/identity";
import type { MessageOperation } from "@nexus/protocol";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { ChatSession, type RetryQueueStore } from "./chat-session";

class MemoryRetryStore implements RetryQueueStore {
  operations: MessageOperation[] = [];

  async load(): Promise<MessageOperation[]> {
    return structuredClone(this.operations);
  }

  async save(
    _channelId: string,
    _identityId: string,
    operations: MessageOperation[],
  ): Promise<void> {
    this.operations = structuredClone(operations);
  }
}

describe("chat session", () => {
  it("queues offline work and flushes the same operation after reconnect", async () => {
    const hub = new InMemoryContractHub();
    const transport = new InMemoryContractTransport(hub, "offline-test", 0);
    const identity = await createLocalIdentity("Mara");
    const session = new ChatSession(identity, ulid(), transport);
    await session.start();

    transport.setOnline(false);
    await session.send("hold this until the network returns");
    expect(session.snapshot().queuedCount).toBe(1);
    expect(session.snapshot().messages.at(-1)?.deliveryState).toBe("retryable");

    transport.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.snapshot().queuedCount).toBe(0);
    expect(session.snapshot().messages.at(-1)?.deliveryState).toBe("accepted");
  });

  it("restores and flushes an offline operation after an app restart", async () => {
    const hub = new InMemoryContractHub();
    const channelId = ulid();
    const identity = await createLocalIdentity("Mara");
    const retryStore = new MemoryRetryStore();
    const firstTransport = new InMemoryContractTransport(hub, "restart-test", 0);
    const firstSession = new ChatSession(identity, channelId, firstTransport, retryStore);
    await firstSession.start();

    firstTransport.setOnline(false);
    await firstSession.send("survive the restart");
    expect(retryStore.operations).toHaveLength(1);
    await firstSession.stop();

    const secondTransport = new InMemoryContractTransport(hub, "restart-test", 0);
    const restoredSession = new ChatSession(identity, channelId, secondTransport, retryStore);
    await restoredSession.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(restoredSession.snapshot().messages.at(-1)?.content).toBe("survive the restart");
    expect(restoredSession.snapshot().messages.at(-1)?.deliveryState).toBe("accepted");
    expect(retryStore.operations).toHaveLength(0);
    await restoredSession.stop();
  });

  it("submits ciphertext and decrypts only with the authorized epoch key", async () => {
    const hub = new InMemoryContractHub();
    const channelId = ulid();
    const conversationId = ulid();
    const sender = new ChatSession(
      await createLocalIdentity("Mara"),
      channelId,
      new InMemoryContractTransport(hub, "private-test", 0),
    );
    const recipient = new ChatSession(
      await createLocalIdentity("Theo"),
      channelId,
      new InMemoryContractTransport(hub, "private-test", 0),
    );
    const outsider = new ChatSession(
      await createLocalIdentity("Outsider"),
      channelId,
      new InMemoryContractTransport(hub, "private-test", 0),
    );
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    sender.configurePrivateConversation({ conversationId, epoch: 4, key });
    recipient.configurePrivateConversation({ conversationId, epoch: 4, key });
    await Promise.all([sender.start(), recipient.start(), outsider.start()]);

    await sender.send("epoch secret", { private: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const wire = await new InMemoryContractTransport(hub, "private-test", 0).read();
    const stored = Object.values(wire.messages)[0];
    expect(stored?.content).not.toContain("epoch secret");
    expect(stored?.encryptionMetadata).toEqual({ suite: "AES-256-GCM", epoch: 4 });
    expect(recipient.snapshot().messages.at(-1)?.content).toBe("epoch secret");
    expect(outsider.snapshot().messages.at(-1)?.content).toBe(
      "Encrypted message — this device is not authorized",
    );

    await Promise.all([sender.stop(), recipient.stop(), outsider.stop()]);
  });
});
