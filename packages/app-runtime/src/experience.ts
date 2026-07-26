import type { DisplayMessage } from "@nexus/protocol";

export interface MessageNotificationCopy {
  title: string;
  body: string;
}

export function searchDisplayMessages(
  messages: readonly DisplayMessage[],
  query: string,
  resolveAuthor: (authorId: string) => string,
): DisplayMessage[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...messages];

  return messages.filter((message) => {
    const searchableText =
      `${resolveAuthor(message.authorId)} ${message.content}`.toLocaleLowerCase();
    return searchableText.includes(normalizedQuery);
  });
}

export function acceptedMessageIds(messages: readonly DisplayMessage[]): Set<string> {
  return new Set(
    messages
      .filter((message) => message.deliveryState === "accepted")
      .map((message) => message.operationId),
  );
}

export function findNewRemoteMessages(
  messages: readonly DisplayMessage[],
  previouslyAccepted: ReadonlySet<string>,
  ownIdentityIds: ReadonlySet<string>,
): DisplayMessage[] {
  return messages.filter(
    (message) =>
      message.deliveryState === "accepted" &&
      !previouslyAccepted.has(message.operationId) &&
      !ownIdentityIds.has(message.authorId),
  );
}

export function messageNotificationCopy(
  message: DisplayMessage,
  author: string,
  channelName: string,
): MessageNotificationCopy {
  if (message.encryptionMetadata) {
    return {
      title: `New private message in #${channelName}`,
      body: "Open Nexus to read it.",
    };
  }

  const compactContent = message.content.replace(/\s+/g, " ").trim();
  const preview =
    compactContent.length > 96 ? `${compactContent.slice(0, 95).trimEnd()}…` : compactContent;
  return {
    title: `New message in #${channelName}`,
    body: preview ? `${author}: ${preview}` : `${author} sent a message.`,
  };
}
