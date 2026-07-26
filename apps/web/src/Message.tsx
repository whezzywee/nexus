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

function shortIdentity(identityId: string): string {
  return identityId.slice(0, 7);
}

function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function Message({
  message,
  names,
  onDownload,
  onModerate,
  canManage,
  transferLabels,
}: MessageProps) {
  const name = names.get(message.authorId) ?? shortIdentity(message.authorId);
  const ownColor = name === "Mara" ? "mara" : "theo";
  return (
    <article className={`message ${message.deliveryState !== "accepted" ? "message-pending" : ""}`}>
      <div className={`avatar avatar-${ownColor}`} aria-hidden="true">
        {name.slice(0, 1)}
      </div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{name}</strong>
          <span>{timeLabel(message.createdAt)}</span>
          {message.deliveryState !== "accepted" && <em>{message.deliveryState}</em>}
        </div>
        <p>{message.content}</p>
        {message.attachmentReferences.length > 0 && (
          <div className="message-attachments">
            {message.attachmentReferences.map((reference) => (
              <button type="button" key={reference} onClick={() => onDownload(reference)}>
                <Paperclip size={13} />{" "}
                {transferLabels[reference] ?? "Download verified attachment"}
              </button>
            ))}
          </div>
        )}
      </div>
      {onModerate && (
        <details className="moderation-menu message-more">
          <summary aria-label={`More actions for ${name}'s message`}>
            <MoreHorizontal size={18} />
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
