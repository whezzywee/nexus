import type { AuthoritySnapshot } from "@nexus/app-runtime";
import { RecoveryControls, type RecoveryWorkflowState } from "./recovery";

export interface AuthorityControlsProps {
  authority: AuthoritySnapshot;
  activeIdentityId?: string;
  inviteDraft: string;
  busy: boolean;
  error?: string | null;
  recovery: RecoveryWorkflowState;
  setInviteDraft(value: string): void;
  authorizeInvite(): void;
  promoteAdmin(identityId: string): void;
  transferOwnership(identityId: string): void;
  revokeDevice(deviceId: string): void;
  appealLatestDecision(): void;
}

export function AuthorityControls({
  authority,
  activeIdentityId,
  inviteDraft,
  busy,
  error,
  recovery,
  setInviteDraft,
  authorizeInvite,
  promoteAdmin,
  transferOwnership,
  revokeDevice,
  appealLatestDecision,
}: AuthorityControlsProps) {
  return (
    <>
      <p>
        {authority.authorized
          ? "This device is authorized. New messages are encrypted before submission."
          : "This device is awaiting authorization from an owner or admin."}
      </p>
      <label>
        This device invitation
        <input readOnly value={JSON.stringify(authority.invite)} aria-label="Device invitation" />
      </label>
      {authority.canRotate && (
        <>
          <label>
            Authorize a device
            <textarea
              value={inviteDraft}
              onChange={(event) => setInviteDraft(event.target.value)}
              placeholder="Paste a device invitation"
              aria-label="Device invitation to authorize"
            />
          </label>
          <button type="button" disabled={busy || !inviteDraft.trim()} onClick={authorizeInvite}>
            Authorize and rotate
          </button>
          <small>
            {authority.invitationRate.remaining} device-link attempts available
            {authority.invitationRate.retryAfterSeconds > 0
              ? ` · retry in ${authority.invitationRate.retryAfterSeconds}s`
              : ""}
          </small>
        </>
      )}
      <ul>
        {Object.values(authority.community.members)
          .filter((member) => member.active)
          .flatMap((member) =>
            member.deviceIds.map((deviceId) => (
              <li key={deviceId}>
                <span>
                  {member.role} · {member.identityId.slice(0, 7)} · {deviceId.slice(0, 7)}
                </span>
                {authority.canManage && deviceId !== authority.invite.deviceId && (
                  <>
                    {member.role === "member" && deviceId === member.deviceIds[0] && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => promoteAdmin(member.identityId)}
                      >
                        Make admin
                      </button>
                    )}
                    {authority.canTransfer &&
                      member.role !== "owner" &&
                      deviceId === member.deviceIds[0] && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => transferOwnership(member.identityId)}
                        >
                          Transfer owner
                        </button>
                      )}
                    {authority.canRotate && (
                      <button type="button" disabled={busy} onClick={() => revokeDevice(deviceId)}>
                        Revoke
                      </button>
                    )}
                  </>
                )}
              </li>
            )),
          )}
      </ul>
      <details className="moderation-audit">
        <summary>Signed moderation audit</summary>
        <ul>
          {Object.values(authority.moderation.operations)
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .slice(0, 8)
            .map((operation) => (
              <li key={operation.operationId}>
                <span>
                  {operation.action} · {operation.targetIdentityId.slice(0, 7)} · {operation.reason}
                </span>
              </li>
            ))}
          {Object.keys(authority.moderation.operations).length === 0 && (
            <li>No moderation decisions recorded.</li>
          )}
        </ul>
        {Object.values(authority.moderation.operations).some(
          (operation) =>
            ["timeout", "remove"].includes(operation.action) &&
            operation.targetIdentityId === activeIdentityId,
        ) && (
          <button type="button" disabled={busy} onClick={appealLatestDecision}>
            Appeal latest decision
          </button>
        )}
      </details>
      <details className="recovery-tools">
        <RecoveryControls state={recovery} />
      </details>
      {(error || authority.error) && <span role="alert">{error ?? authority.error}</span>}
    </>
  );
}
