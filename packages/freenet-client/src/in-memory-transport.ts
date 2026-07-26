import { verifyMessageOperation } from "@nexus/identity";
import {
  applyMessageOperation,
  emptySegmentState,
  type MessageOperation,
  type OperationReceipt,
  type SegmentState,
} from "@nexus/protocol";
import type {
  ContractTransport,
  SegmentListener,
  StatusListener,
  TransportStatus,
} from "./contract-transport";

interface HubSegment {
  state: SegmentState;
  listeners: Set<SegmentListener>;
}

export class InMemoryContractHub {
  private readonly segments = new Map<string, HubSegment>();

  segment(key: string): HubSegment {
    const existing = this.segments.get(key);
    if (existing) {
      return existing;
    }
    const created = { state: emptySegmentState(), listeners: new Set<SegmentListener>() };
    this.segments.set(key, created);
    return created;
  }

  async submit(key: string, operation: MessageOperation): Promise<OperationReceipt> {
    if (!(await verifyMessageOperation(operation))) {
      return {
        operationId: operation.operationId,
        state: "rejected",
        errorCode: "invalid_signature",
      };
    }
    const segment = this.segment(key);
    segment.state = applyMessageOperation(segment.state, operation);
    for (const listener of segment.listeners) {
      queueMicrotask(() => listener(structuredClone(segment.state)));
    }
    return {
      operationId: operation.operationId,
      state: "accepted",
      acceptedAt: new Date().toISOString(),
    };
  }
}

export class InMemoryContractTransport implements ContractTransport {
  readonly kind = "simulation" as const;
  private status: TransportStatus = "disconnected";
  private readonly statusListeners = new Set<StatusListener>();
  private online = true;

  constructor(
    private readonly hub: InMemoryContractHub,
    private readonly segmentKey: string,
    private readonly latencyMs = 35,
  ) {}

  setOnline(online: boolean): void {
    this.online = online;
    this.setStatus(online ? "connected" : "unavailable");
  }

  async connect(): Promise<void> {
    this.setStatus("connecting");
    await this.delay();
    if (!this.online) {
      this.setStatus("unavailable");
      throw new Error("Simulation transport is offline");
    }
    this.setStatus("connected");
  }

  async read(): Promise<SegmentState> {
    this.assertOnline();
    await this.delay();
    return structuredClone(this.hub.segment(this.segmentKey).state);
  }

  async submit(operation: MessageOperation): Promise<OperationReceipt> {
    this.assertOnline();
    await this.delay();
    return this.hub.submit(this.segmentKey, operation);
  }

  subscribe(listener: SegmentListener): () => void {
    const listeners = this.hub.segment(this.segmentKey).listeners;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    this.setStatus("disconnected");
  }

  private setStatus(status: TransportStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private assertOnline(): void {
    if (!this.online) {
      throw new Error("Simulation transport is offline");
    }
  }

  private delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }
}
