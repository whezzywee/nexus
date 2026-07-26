# Real-node soak operations

`scripts/soak-freenet.ps1` repeatedly runs every two-node Freenet acceptance
flow and writes machine-readable evidence. It is a campaign harness, not proof
that a campaign has happened.

[ADR 0005](adr/0005-device-signing-authority.md) is implemented. Start a
qualifying release-candidate soak only from the immutable candidate submitted
for independent review, recording its source/archive hash and using
production-equivalent services. Earlier shared-root runs do not qualify.

The 2026-07-26 smoke campaign failed because peer B intermittently remained on
private-conversation epoch 1 after peer A accepted epoch 2; the same flow passed
only after the bounded harness created fresh nodes and retried. See
[the propagation blocker](core-propagation-blocker.md) and preserved campaign
`.artifacts/soak/freenet/20260726T141452Z`. Do not start the qualifying campaign
until the blocker exit criteria pass.

## Campaign

Run a minimum 72-hour campaign on a dedicated host with the release-candidate
Core binary and contract artifacts:

```powershell
$env:NEXUS_FREENET_BIN = "C:\release-candidate\freenet.exe"
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/soak-freenet.ps1 `
  -DurationHours 72 `
  -PauseSeconds 30
```

Evidence is written under `.artifacts/soak/freenet/<campaign-id>/`:

- `summary.json` records the campaign boundary and pass/fail totals.
- `events.jsonl` records one bounded result per iteration.
- `iteration-*.log` preserves the full Core and test output.

The harness fails closed on the first unsuccessful iteration or transient retry,
even when the bounded acceptance harness eventually succeeds. Preserve the
entire directory as a release artifact; do not rerun only the failed test and
discard the earlier failure.

## Acceptance

A qualifying campaign has no failed iteration, no unexplained process restart,
no increasing resident-memory or disk trend, and no stale peer or port left
after an iteration. In parallel, collect host CPU, memory, disk, Core process
count, reconnects, contract operation latency, and client error counts.

The automated two-node suite covers message, membership/revocation, private
conversation rotation, attachment, voice signaling, and release/revocation
flows. An external pilot must additionally exercise upgrades, sleep/wake,
network loss, relay-only calling, notifications, accessibility, recovery, and
real user workflows. Pilot participants must give informed consent and receive
a tested support and data-removal path.
