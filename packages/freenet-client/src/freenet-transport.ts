import {
  ContractKey,
  type DelegateResponse,
  DeltaUpdate,
  DisconnectRequest,
  FreenetWsApi,
  GetRequest,
  type GetResponse,
  type HostError,
  type PutResponse,
  type ResponseHandler,
  UpdateData,
  UpdateDataType,
  type UpdateNotification,
  UpdateRequest,
  type UpdateResponse,
} from "@freenetorg/freenet-stdlib";
import {
  emptySegmentState,
  type MessageOperation,
  type OperationReceipt,
  type SegmentState,
} from "@nexus/protocol";
import bs58 from "bs58";
import type {
  ContractTransport,
  SegmentListener,
  StatusListener,
  TransportStatus,
} from "./contract-transport";

function keyFromInstanceId(instanceId: string, codeHash: string): ContractKey {
  const parsed = ContractKey.fromInstanceId(instanceId);
  return new ContractKey(parsed.bytes(), bs58.decode(codeHash));
}

function decodeState(response: GetResponse): SegmentState {
  if (response.state.length === 0) {
    return emptySegmentState();
  }
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(response.state))) as SegmentState;
}

export interface FreenetTransportOptions {
  websocketUrl: URL;
  contractInstanceId: string;
  contractCodeHash: string;
  authToken?: string;
}

export class FreenetContractTransport implements ContractTransport {
  readonly kind = "freenet" as const;
  private readonly key: ContractKey;
  private api: FreenetWsApi | null = null;
  private readChain: Promise<void> = Promise.resolve();
  private status: TransportStatus = "disconnected";
  private readonly segmentListeners = new Set<SegmentListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private openResolver: (() => void) | null = null;
  private openRejecter: ((reason: Error) => void) | null = null;

  constructor(private readonly options: FreenetTransportOptions) {
    this.key = keyFromInstanceId(options.contractInstanceId, options.contractCodeHash);
  }

  async connect(): Promise<void> {
    if (this.api) {
      return;
    }
    this.setStatus("connecting");
    const handler: ResponseHandler = {
      onContractPut: (_response: PutResponse) => {},
      onContractGet: (_response: GetResponse) => {},
      onContractUpdate: (_response: UpdateResponse) => {},
      onContractUpdateNotification: (_notification: UpdateNotification) => {
        this.read()
          .then((state) => {
            for (const listener of this.segmentListeners) {
              listener(state);
            }
          })
          .catch(() => this.setStatus("reconnecting"));
      },
      onContractNotFound: (_instanceId: Uint8Array) => {
        this.openRejecter?.(new Error("Freenet message segment contract was not found"));
      },
      onDelegateResponse: (_response: DelegateResponse) => {},
      onErr: (error: HostError) => {
        this.setStatus("unavailable");
        this.openRejecter?.(new Error(error.cause));
      },
      onOpen: () => {
        this.setStatus("connected");
        this.openResolver?.();
      },
      onClose: () => this.setStatus("disconnected"),
    };

    const opened = new Promise<void>((resolve, reject) => {
      this.openResolver = resolve;
      this.openRejecter = reject;
    });
    this.api = new FreenetWsApi(this.options.websocketUrl, handler, this.options.authToken ?? "");
    await opened;
    // A blocking GET+subscribe is the deterministic Core path: the GET only
    // resolves after the downstream subscription chain is registered.
    await this.api.get(new GetRequest(this.key, false, true, true));
  }

  async read(): Promise<SegmentState> {
    const api = this.requireApi();
    const request = new GetRequest(this.key, false);
    const pending = this.readChain.then(
      () => api.get(request),
      () => api.get(request),
    );
    this.readChain = pending.then(
      () => undefined,
      () => undefined,
    );
    return decodeState(await pending);
  }

  async submit(operation: MessageOperation): Promise<OperationReceipt> {
    const payload = new TextEncoder().encode(JSON.stringify(operation));
    const update = new UpdateData(UpdateDataType.DeltaUpdate, new DeltaUpdate(Array.from(payload)));
    try {
      await this.requireApi().update(new UpdateRequest(this.key, update));
      return {
        operationId: operation.operationId,
        state: "accepted",
        acceptedAt: new Date().toISOString(),
      };
    } catch {
      return {
        operationId: operation.operationId,
        state: "retryable",
        errorCode: "freenet_update_failed",
      };
    }
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
    const api = this.api;
    this.api = null;
    try {
      if (api) {
        await api.disconnect(new DisconnectRequest("Nexus client disconnected"));
      }
    } finally {
      this.setStatus("disconnected");
    }
  }

  private requireApi(): FreenetWsApi {
    if (!this.api) {
      throw new Error("Freenet transport is not connected");
    }
    return this.api;
  }

  private setStatus(status: TransportStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}
