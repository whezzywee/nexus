import type { MessageOperation, OperationReceipt, SegmentState } from "@nexus/protocol";

export type TransportStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "unavailable";

export type SegmentListener = (state: SegmentState) => void;
export type StatusListener = (status: TransportStatus) => void;

export interface ContractTransport {
  readonly kind: "freenet" | "gateway" | "simulation";
  connect(): Promise<void>;
  read(): Promise<SegmentState>;
  submit(operation: MessageOperation): Promise<OperationReceipt>;
  subscribe(listener: SegmentListener): () => void;
  subscribeStatus(listener: StatusListener): () => void;
  disconnect(): Promise<void>;
}
