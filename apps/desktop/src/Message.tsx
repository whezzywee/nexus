import type { ModerationAction } from "@nexus/app-runtime";
import type { DisplayMessage } from "@nexus/protocol";
import { MoreHorizontal, Paperclip } from "lucide-react";

export interface MessageProps {
  message: DisplayMessage;
  names: Map<string, string>;
  onDownload: (reference: string) => void;
  onModerate?: (action: ModerationAction, message: DisplayMessage) => void;
  canManage: boolean;
  transferLabels: Record<string, string>;
}

function initials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
}

export function Message({
  message,
  names,
  onDownload,
  onModerate,
  canManage,
  transferLabels,
}: MessageProps) {
  const author = names.get(message.authorId) ?? message.authorId.slice(0, 7);
  return (
    <article className={`desktop-message ${message.deliveryState !== "accepted" ? "pending" : ""}`}>
      <div className={`person-avatar person-${author.toLowerCase()}`}>{initials(author)}</div>
      <div>
        <header>
          <strong>{author}</strong>
          <time>
            {new Intl.DateTimeFormat(undefined, {
              hour: "numeric",
              minute: "2-digit",
            }).format(new Date(message.createdAt))}
          </time>
          {message.deliveryState !== "accepted" && <em>{message.deliveryState}</em>}
        </header>
        <p>{message.content}</p>
        {message.attachmentReferences.length > 0 && (
          <div className="message-attachments">
            {message.attachmentReferences.map((reference) => (
              <button type="button" key={reference} onClick={() => onDownload(reference)}>
                <Paperclip size={12} />{" "}
                {transferLabels[reference] ?? "Download verified attachment"}
              </button>
            ))}
          </div>
        )}
      </div>
      {onModerate && (
        <details className="moderation-menu message-actions">
          <summary aria-label={`More actions for ${author}'s message`}>
            <MoreHorizontal size={17} />
          </summary>
          <div>
            <button type="button" onClick={() => onModerate("hide", message)}>
              Hide for me
            </button>
            <button type="button" onClick={() => onModerate("report", message)}>
              Report
            </button>
            {canManage && (
              <>
                <button type="button" onClick={() => onModerate("timeout", message)}>
                  Timeout 15m
                </button>
                <button type="button" onClick={() => onModerate("remove", message)}>
                  Remove member
                </button>
              </>
            )}
          </div>
        </details>
      )}
    </article>
  );
}
