import type {
  AttachmentIndexOperation,
  AttachmentManifest,
  PreparedAttachment,
} from "@nexus/attachments";
import {
  base64UrlToBytes,
  bytesToBase64Url,
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

export interface FreenetBridgeTransportOptions {
  bridgeUrl: URL;
  bridgeToken: string;
  peer: "a" | "b";
}

export interface BridgeAttachmentDownload {
  operation: AttachmentIndexOperation;
  chunks: Record<string, string>;
}

export class FreenetBridgeTransport implements ContractTransport {
  readonly kind = "gateway" as const;
  private status: TransportStatus = "disconnected";
  private stopped = true;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly segmentListeners = new Set<SegmentListener>();
  private readonly statusListeners = new Set<StatusListener>();

  constructor(private readonly options: FreenetBridgeTransportOptions) {}

  async connect(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.setStatus("connecting");
    const response = await fetch(this.endpoint("health"));
    if (!response.ok) {
      this.stopped = true;
      this.setStatus("unavailable");
      throw new Error(`Nexus native bridge is unavailable (${response.status})`);
    }
    this.setStatus("connected");
    this.schedulePoll();
  }

  async read(): Promise<SegmentState> {
    const response = await fetch(this.endpoint(`peers/${this.options.peer}/state`), {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(await this.responseError(response));
    }
    return (await response.json()) as SegmentState;
  }

  async submit(operation: MessageOperation): Promise<OperationReceipt> {
    try {
      const response = await fetch(this.endpoint(`peers/${this.options.peer}/operations`), {
        method: "POST",
        headers: {
          ...this.headers(),
          "content-type": "application/json",
        },
        body: JSON.stringify(operation),
      });
      if (!response.ok) {
        throw new Error(await this.responseError(response));
      }
      return {
        operationId: operation.operationId,
        state: "accepted",
        acceptedAt: new Date().toISOString(),
      };
    } catch {
      this.setStatus("reconnecting");
      return {
        operationId: operation.operationId,
        state: "retryable",
        errorCode: "freenet_bridge_update_failed",
      };
    }
  }

  async publishAttachment(
    prepared: PreparedAttachment,
    operation: AttachmentIndexOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(this.endpoint(`peers/${this.options.peer}/attachments`), {
      method: "POST",
      headers: {
        ...this.headers(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operation,
        chunks: Object.fromEntries(
          [...prepared.chunks].map(([hash, bytes]) => [hash, bytesToBase64Url(bytes)]),
        ),
      }),
      signal,
    });
    if (!response.ok) throw new Error(await this.responseError(response));
  }

  async fetchAttachment(
    reference: string,
    signal?: AbortSignal,
  ): Promise<{
    operation: AttachmentIndexOperation;
    manifest: AttachmentManifest;
    chunks: Map<string, Uint8Array>;
  }> {
    const url = this.endpoint(`peers/${this.options.peer}/attachments`);
    url.searchParams.set("reference", reference);
    const response = await fetch(url, { headers: this.headers(), signal });
    if (!response.ok) throw new Error(await this.responseError(response));
    const payload = (await response.json()) as BridgeAttachmentDownload;
    return {
      operation: payload.operation,
      manifest: payload.operation.manifest,
      chunks: new Map(
        Object.entries(payload.chunks).map(([hash, encoded]) => [hash, base64UrlToBytes(encoded)]),
      ),
    };
  }

  async bootstrapAuthority<T>(family: "community" | "conversation", state: T): Promise<T> {
    const response = await fetch(
      this.endpoint(`peers/${this.options.peer}/authority/${family}/bootstrap`),
      {
        method: "POST",
        headers: {
          ...this.headers(),
          "content-type": "application/json",
        },
        body: JSON.stringify(state),
      },
    );
    if (!response.ok) throw new Error(await this.responseError(response));
    return (await response.json()) as T;
  }

  async readAuthority<T>(family: "community" | "conversation"): Promise<T> {
    const response = await fetch(this.endpoint(`peers/${this.options.peer}/authority/${family}`), {
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(await this.responseError(response));
    return (await response.json()) as T;
  }

  async submitAuthority(family: "community" | "conversation", operation: unknown): Promise<void> {
    const response = await fetch(this.endpoint(`peers/${this.options.peer}/authority/${family}`), {
      method: "POST",
      headers: {
        ...this.headers(),
        "content-type": "application/json",
      },
      body: JSON.stringify(operation),
    });
    if (!response.ok) throw new Error(await this.responseError(response));
  }

  subscribe(listener: SegmentListener): () => void {
    this.segmentListeners.add(listener);
    return () => this.segmentListeners.delete(listener);
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.setStatus("disconnected");
  }

  private endpoint(path: string): URL {
    return new URL(`${this.options.bridgeUrl.toString().replace(/\/$/, "")}/${path}`);
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.bridgeToken}`,
    };
  }

  private schedulePoll(): void {
    if (this.stopped || this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, 500);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      const state = await this.read();
      this.setStatus("connected");
      for (const listener of this.segmentListeners) {
        listener(state);
      }
    } catch {
      this.setStatus("reconnecting");
    } finally {
      this.schedulePoll();
    }
  }

  private async responseError(response: Response): Promise<string> {
    const retryAfter = response.headers.get("retry-after");
    const retryMessage =
      response.status === 429 && retryAfter
        ? ` Try again in ${retryAfter} second${retryAfter === "1" ? "" : "s"}.`
        : "";
    try {
      const payload = (await response.json()) as { error?: string };
      return `${payload.error || `Nexus native bridge request failed (${response.status})`}${retryMessage}`;
    } catch {
      return `Nexus native bridge request failed (${response.status})${retryMessage}`;
    }
  }

  private setStatus(status: TransportStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}
