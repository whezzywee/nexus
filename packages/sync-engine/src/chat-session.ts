import {
  decryptPrivateMessage,
  type EncryptedEnvelope,
  encryptPrivateMessage,
} from "@nexus/conversation";
import type { ContractTransport, TransportStatus } from "@nexus/freenet-client";
import { type LocalIdentity, signMessageOperation } from "@nexus/identity";
import {
  applyMessageOperation,
  type DeliveryState,
  type DisplayMessage,
  emptySegmentState,
  type MessageOperation,
  orderedMessages,
  PROTOCOL_VERSION,
  type SegmentState,
} from "@nexus/protocol";
import { ulid } from "ulid";

export interface ChatSnapshot {
  messages: DisplayMessage[];
  status: TransportStatus;
  queuedCount: number;
}

type SnapshotListener = (snapshot: ChatSnapshot) => void;

export interface RetryQueueStore {
  load(channelId: string, identityId: string): Promise<MessageOperation[]>;
  save(channelId: string, identityId: string, operations: MessageOperation[]): Promise<void>;
}

export interface SendMessageOptions {
  attachmentReferences?: string[];
  private?: boolean;
  encryptionMetadata?: {
    suite: string;
    epoch: number;
  };
}

export interface PrivateConversationContext {
  conversationId: string;
  epoch: number;
  key: CryptoKey;
}

export class ChatSession {
  private state: SegmentState = emptySegmentState();
  private status: TransportStatus = "disconnected";
  private readonly pending = new Map<string, DisplayMessage>();
  private readonly retryQueue: MessageOperation[] = [];
  private readonly listeners = new Set<SnapshotListener>();
  private readonly decryptedBodies = new Map<string, string>();
  private privateConversation: PrivateConversationContext | null = null;
  private unsubscribeSegment: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  constructor(
    readonly identity: LocalIdentity,
    private readonly channelId: string,
    private readonly transport: ContractTransport,
    private readonly retryStore?: RetryQueueStore,
  ) {}

  async start(): Promise<void> {
    if (this.retryStore) {
      const restored = await this.retryStore.load(this.channelId, this.identity.identityId);
      for (const operation of restored) {
        if (
          operation.channelId !== this.channelId ||
          operation.authorId !== this.identity.identityId
        ) {
          throw new Error("Persisted retry operation does not belong to this session");
        }
        this.retryQueue.push(operation);
        this.pending.set(operation.operationId, {
          ...operation,
          deliveryState: "retryable",
        });
      }
    }
    this.unsubscribeStatus = this.transport.subscribeStatus((status) => {
      this.status = status;
      this.emit();
      if (status === "connected") {
        void this.flushRetries();
      }
    });
    this.unsubscribeSegment = this.transport.subscribe((state) => {
      this.state = state;
      for (const operationId of [...this.pending.keys()]) {
        if (state.seenOperationIds.includes(operationId)) {
          this.pending.delete(operationId);
        }
      }
      this.emit();
      void this.decryptAcceptedMessages();
    });
    await this.transport.connect();
    this.state = await this.transport.read();
    this.emit();
    await this.decryptAcceptedMessages();
  }

  configurePrivateConversation(context: PrivateConversationContext | null): void {
    this.privateConversation = context;
    this.decryptedBodies.clear();
    this.emit();
    void this.decryptAcceptedMessages();
  }

  async send(content: string, options: SendMessageOptions = {}): Promise<void> {
    const normalized = content.trim();
    const attachmentReferences = [...new Set(options.attachmentReferences ?? [])];
    if (!normalized && attachmentReferences.length === 0) {
      return;
    }
    if (attachmentReferences.length > 8) {
      throw new Error("A message can reference at most eight attachments");
    }
    const messageId = ulid();
    let wireContent = normalized;
    let encryptionMetadata = options.encryptionMetadata;
    if (options.private) {
      const context = this.privateConversation;
      if (!context) {
        throw new Error("This device does not have an authorized private-conversation epoch key");
      }
      const envelope = await encryptPrivateMessage(
        context.conversationId,
        context.epoch,
        messageId,
        normalized,
        context.key,
      );
      wireContent = JSON.stringify(envelope);
      encryptionMetadata = {
        suite: "AES-256-GCM",
        epoch: context.epoch,
      };
      this.decryptedBodies.set(messageId, normalized);
    }
    const operation = await signMessageOperation(this.identity, {
      protocolVersion: PROTOCOL_VERSION,
      operationId: ulid(),
      messageId,
      channelId: this.channelId,
      authorId: this.identity.identityId,
      authorDeviceId: this.identity.deviceId,
      actorSequence: this.identity.nextSequence,
      createdAt: new Date().toISOString(),
      clientGeneratedOrder: ulid(),
      content: wireContent,
      attachmentReferences,
      encryptionMetadata,
      editVersion: 0,
      deletionTombstone: false,
    });
    this.pending.set(operation.operationId, { ...operation, deliveryState: "submitting" });
    this.emit();
    await this.submitOrQueue(operation);
  }

  snapshot(): ChatSnapshot {
    const accepted: DisplayMessage[] = orderedMessages(this.state)
      .filter((message) => !message.deletionTombstone)
      .map((message) => this.displayMessage(message, "accepted"));
    const pending = [...this.pending.values()].map((message) =>
      this.displayMessage(message, message.deliveryState),
    );
    return {
      messages: [...accepted, ...pending].sort((left, right) =>
        left.clientGeneratedOrder.localeCompare(right.clientGeneratedOrder),
      ),
      status: this.status,
      queuedCount: this.retryQueue.length,
    };
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    this.unsubscribeSegment?.();
    this.unsubscribeStatus?.();
    await this.transport.disconnect();
  }

  private async submitOrQueue(operation: MessageOperation): Promise<void> {
    try {
      const receipt = await this.transport.submit(operation);
      if (receipt.state === "accepted") {
        this.state = applyMessageOperation(this.state, operation);
        this.pending.delete(operation.operationId);
      } else if (receipt.state === "retryable") {
        await this.queueRetry(operation);
      } else {
        this.pending.set(operation.operationId, {
          ...operation,
          deliveryState: "rejected",
        });
      }
    } catch {
      await this.queueRetry(operation);
    }
    this.emit();
  }

  private async queueRetry(operation: MessageOperation): Promise<void> {
    if (!this.retryQueue.some((queued) => queued.operationId === operation.operationId)) {
      this.retryQueue.push(operation);
    }
    this.pending.set(operation.operationId, { ...operation, deliveryState: "retryable" });
    await this.persistRetries();
  }

  private async flushRetries(): Promise<void> {
    while (this.retryQueue.length > 0 && this.status === "connected") {
      const operation = this.retryQueue[0];
      if (!operation) return;
      this.pending.set(operation.operationId, { ...operation, deliveryState: "submitting" });
      this.emit();
      try {
        const receipt = await this.transport.submit(operation);
        if (receipt.state === "retryable") {
          this.pending.set(operation.operationId, {
            ...operation,
            deliveryState: "retryable",
          });
          break;
        }
        this.retryQueue.shift();
        await this.persistRetries();
        if (receipt.state === "accepted") {
          this.state = applyMessageOperation(this.state, operation);
          this.pending.delete(operation.operationId);
        } else {
          this.pending.set(operation.operationId, {
            ...operation,
            deliveryState: "rejected",
          });
        }
      } catch {
        this.pending.set(operation.operationId, {
          ...operation,
          deliveryState: "retryable",
        });
        break;
      }
      this.emit();
    }
    this.emit();
  }

  private async persistRetries(): Promise<void> {
    await this.retryStore?.save(this.channelId, this.identity.identityId, [...this.retryQueue]);
  }

  private displayMessage(
    message: MessageOperation | DisplayMessage,
    deliveryState: DeliveryState,
  ): DisplayMessage {
    if (!message.encryptionMetadata) {
      return { ...message, deliveryState };
    }
    return {
      ...message,
      content:
        this.decryptedBodies.get(message.messageId) ??
        "Encrypted message — this device is not authorized",
      deliveryState,
    };
  }

  private async decryptAcceptedMessages(): Promise<void> {
    const context = this.privateConversation;
    if (!context) return;
    let changed = false;
    for (const message of orderedMessages(this.state)) {
      if (
        message.encryptionMetadata?.suite !== "AES-256-GCM" ||
        message.encryptionMetadata.epoch !== context.epoch ||
        this.decryptedBodies.has(message.messageId)
      ) {
        continue;
      }
      try {
        const envelope = JSON.parse(message.content) as EncryptedEnvelope;
        const plaintext = await decryptPrivateMessage(
          context.conversationId,
          context.epoch,
          message.messageId,
          envelope,
          context.key,
        );
        this.decryptedBodies.set(message.messageId, plaintext);
        changed = true;
      } catch {
        // Hostile or unauthorized ciphertext remains visibly locked.
      }
    }
    if (changed) this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
