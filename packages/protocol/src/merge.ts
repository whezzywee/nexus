import { parseMessageOperation } from "./schema";
import { type MessageOperation, PROTOCOL_VERSION, type SegmentState, type Ulid } from "./types";

const MAX_SEEN_OPERATION_IDS = 4096;

export function emptySegmentState(): SegmentState {
  return {
    schemaVersion: PROTOCOL_VERSION,
    messages: {},
    seenOperationIds: [],
  };
}

function winner(left: MessageOperation, right: MessageOperation): MessageOperation {
  if (left.editVersion !== right.editVersion) {
    return left.editVersion > right.editVersion ? left : right;
  }
  if (left.deletionTombstone !== right.deletionTombstone) {
    return left.deletionTombstone ? left : right;
  }
  return left.operationId >= right.operationId ? left : right;
}

function boundSeenOperationIds(ids: Iterable<Ulid>): Ulid[] {
  return [...new Set(ids)].sort().slice(-MAX_SEEN_OPERATION_IDS);
}

export function applyMessageOperation(
  state: SegmentState,
  untrustedOperation: unknown,
): SegmentState {
  const operation = parseMessageOperation(untrustedOperation);
  if (state.seenOperationIds.includes(operation.operationId)) {
    return state;
  }

  const current = state.messages[operation.messageId];
  const messages = {
    ...state.messages,
    [operation.messageId]: current ? winner(current, operation) : operation,
  };

  return canonicalizeSegmentState({
    schemaVersion: PROTOCOL_VERSION,
    messages,
    seenOperationIds: boundSeenOperationIds([...state.seenOperationIds, operation.operationId]),
  });
}

export function mergeSegmentStates(left: SegmentState, right: SegmentState): SegmentState {
  const messageIds = new Set([...Object.keys(left.messages), ...Object.keys(right.messages)]);
  const messages: Record<string, MessageOperation> = {};

  for (const messageId of [...messageIds].sort()) {
    const leftMessage = left.messages[messageId];
    const rightMessage = right.messages[messageId];
    messages[messageId] =
      leftMessage && rightMessage
        ? winner(leftMessage, rightMessage)
        : (leftMessage ?? rightMessage);
  }

  return canonicalizeSegmentState({
    schemaVersion: PROTOCOL_VERSION,
    messages,
    seenOperationIds: boundSeenOperationIds([...left.seenOperationIds, ...right.seenOperationIds]),
  });
}

export function canonicalizeSegmentState(state: SegmentState): SegmentState {
  return {
    schemaVersion: PROTOCOL_VERSION,
    messages: Object.fromEntries(
      Object.entries(state.messages).sort(([left], [right]) => left.localeCompare(right)),
    ),
    seenOperationIds: boundSeenOperationIds(state.seenOperationIds),
  };
}

export function orderedMessages(state: SegmentState): MessageOperation[] {
  return Object.values(state.messages).sort((left, right) => {
    const byOrder = left.clientGeneratedOrder.localeCompare(right.clientGeneratedOrder);
    return byOrder === 0 ? left.messageId.localeCompare(right.messageId) : byOrder;
  });
}
