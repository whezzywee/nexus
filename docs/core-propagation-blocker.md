# Freenet propagation qualification blocker

Updated: 2026-07-26

## Status

**Open release blocker.** Do not begin the 72-hour qualifying soak until this
reproducer completes repeatedly without a retry.

The protocol-v2 contracts and client pass individual two-node acceptance runs,
but rapid fresh-node sequences can intermittently leave peer B on the first
authoritative state after peer A accepts a second update. The bounded acceptance
harness may pass on retry; the soak harness correctly treats any retry as a
failure.

The latest focused diagnosis isolates the remaining failure below the Nexus
contract/client layer: the writer accepts epoch 2, the reader's Core event
journal receives the epoch-2 delta, but that reader does not materialize the new
state for subsequent GET requests. This matches open Freenet Core
cross-node-update defects, but remains a qualification blocker until a reviewed
Core fix/version passes the complete zero-retry campaign.

## Preserved evidence

- Campaign: `.artifacts/soak/freenet/20260726T141452Z`
- Result: `failed`
- Failing flow: `private_conversation_roundtrip`
- Observed state: peer B received epoch 1, the epoch-2 notification was
  coalesced, and direct reads did not recover epoch 2 within 60 seconds.
- Retry result: the same flow passed immediately with fresh nodes.
- Full review attempt:
  `.artifacts/independent-review/20260726T144355Z/evidence/freenet-two-node.log`
  - two initial message PUT attempts timed out before a third fresh-node attempt
    passed;
  - private-conversation epoch 2 was missed once before a fresh-node retry
    passed;
  - the release update timed out on all three fresh-node attempts, so the
    complete run failed.

The independent-review preparation run also preserved a separate transient
community propagation retry. Together these observations rule out treating a
single successful direct run as soak evidence and show that the issue is not
limited to one contract.

- Focused diagnosis:
  `.artifacts/real-node-diagnosis/20260726T160007Z`
  - the release flow passed four fresh zero-retry runs after its initial GET was
    corrected to establish the intended subscription;
  - an initial private-conversation run exposed a separate readiness race for
    the large streamed PUT;
  - after requiring three consecutive healthy topology samples, two fresh
    private-conversation runs passed and the third failed at epoch 2 after
    73.43 seconds;
  - the failed reader journal contains the epoch-2 delta while only the writer
    journal contains the resulting epoch-2 state.

## Reproduction

Use the pinned Core binary and the checked-in contracts:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/soak-freenet.ps1 `
  -DurationHours 0.01 `
  -MaxIterations 1 `
  -PauseSeconds 0
```

For a focused run:

```powershell
$env:NEXUS_FREENET_BIN = (
  Resolve-Path ".research\freenet-install\bin\freenet.exe"
).Path
& "$env:USERPROFILE\.cargo\bin\cargo.exe" test `
  -p nexus-freenet-two-node-tests `
  --test private_conversation_roundtrip `
  -- --ignored --nocapture
```

Run the focused command repeatedly with fresh Core processes. Preserve the first
failure's complete stdout/stderr and Core logs; do not discard it after a retry.

## Investigation completed

- Reduced each two-node topology to one minimum and four maximum connections,
  eliminating unrelated connection-rate log storms.
- Isolated every Core process into its own log directory so a failure can be
  attributed to the writer or reader without cross-process rolling-log
  contention.
- Required three consecutive healthy topology samples before declaring the
  network ready. This corrected a distinct premature streamed-PUT start but did
  not eliminate the later epoch-2 failure.
- Added a bounded teardown drain between fresh-node test pairs.
- Confirmed the accepted second state is valid and that retrying with fresh
  nodes passes.
- Tested explicit subscription renewal and subscribed reads as diagnostics.
  They did not resolve the missed state and were removed rather than retained as
  an unproven workaround.
- Checked Freenet Core 0.2.108, the latest official release on 2026-07-26. Its
  published runtime change is unrelated to this propagation path, and the
  matching high-priority Core issue
  [#4681](https://github.com/freenet/freenet-core/issues/4681) remains open, so
  the candidate remains pinned until an upgrade is justified and fully
  requalified.

## Exit criteria

1. Reduce the failure to a minimal client/Core transcript and determine whether
   the state is lost, not broadcast, not delivered, or not returned by a later
   read.
2. Fix the responsible Nexus path or adopt a reviewed Core fix/version.
3. Run the complete two-node suite repeatedly with zero retry markers.
4. Recreate the immutable review packet and protected fuzz artifacts.
5. Complete a new 72-hour soak with zero failures, retries, stale peers, or
   unexplained restarts.
