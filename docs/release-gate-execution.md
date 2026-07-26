# Release-gate execution record

Updated: 2026-07-26

This is the handoff from repository engineering to release qualification. A
gate is complete only when its evidence names the same immutable candidate
archive and artifact hashes. Local smoke tests and internal review are useful
preparation, not substitutes for the external decision.

## Candidate identity

- Browser acceptance:
  `.artifacts/acceptance/20260726-browser/REPORT.md`

Use the newest directory under `.artifacts/independent-review/` that contains
`REVIEW-PACKET.md`, then read its `SOURCE-ARCHIVE-SHA256.txt`. A newer directory
without `REVIEW-PACKET.md` is a preserved failed preparation attempt, not a
completed packet. Do not copy a packet identity into source before the archive
is built: changing that source would invalidate the recorded hash.

Before production qualification, import this source into the release
repository, commit it, and create a reviewed candidate tag. Recreate the packet
from that tag so the packet records the real revision. A different source
archive or binary restarts every candidate-bound gate.

## Gate register

| Gate | Current state | Required owner/input | Qualifying evidence |
| --- | --- | --- | --- |
| Independent cryptographic/application review | Packet ready; decision open | Reviewer independent of implementation, review scope and retest agreement | Signed/datable report naming archive SHA-256, findings, remediation retests, and accept/reject decision |
| Protected Linux fuzz/sanitizer campaign | Workflow ready; run open | Hosted repository with protected branch and artifact retention | Five successful address-sanitized target artifacts from the same commit; scheduled campaign duration recorded in metadata |
| Trusted Windows signing | Workflow hardened; run open | Organization certificate, protected environment approval, PFX/password secrets, pinned certificate SHA-256 | Signed installer bundle, provenance attestation, `authenticode-report.json`, SignTool verification, installer SHA-256 |
| Installed notifications | Browser denied-state behavior passed; delivery open | Signed installed candidate, published protocol-v2 message contract, two certified devices, clean support-target machine | Completed notification matrix with screenshots, version/hash/signer, safe private-message copy, restart/update results |
| Screen reader and actual zoom | Automated support passed and bypass navigation added; human acceptance open | Human tester using declared screen reader and 200%/400% application zoom | Completed pass/fail matrix, versions, screenshots/recording, and issue retests |
| Production TURN | Baseline/runbook ready; deployment open | Public DNS/IP, TLS certificate, immutable Coturn image, secret store, monitoring, two independent networks | Deployment revision, listener/metric checks, relay-only call results, capacity result, successful secret rotation |
| Multi-day real-node soak | Smoke failed; propagation blocker open | Resolve `docs/core-propagation-blocker.md`, then use a dedicated host with exact candidate Core/contracts and production-equivalent monitoring | Unedited 72-hour evidence directory with zero failures/retries and attached resource-trend report |
| External pilot | Runbook ready; pilot open | Release owner, consented cohort, support/incident owner, all preceding critical gates | Dated pilot summary naming candidate, cohort/stages, incident register, fixes/retests, exit decision |

## Commands and handoffs

### Independent review

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/prepare-independent-review.ps1 `
  -IncludeRealNodeRun
```

The reviewer should verify `SOURCE-ARCHIVE-SHA256.txt` before extracting the
archive and follow `docs/independent-review-brief.md`.

### Protected fuzzing

Run `.github/workflows/ci.yml` from the candidate commit using
`workflow_dispatch` for the agreed campaign length. Scheduled protected runs
use 1,800 seconds per target. Preserve every `fuzz-<target>-<sha>` artifact.
The local MSVC supplemental attempt is recorded at
`.artifacts/fuzz/local-supplemental-20260726/campaign.log`; its sancov linker
failure is non-qualifying and is why the acceptance job targets Linux.

### Trusted signing

Configure the `production-release` environment with required reviewers,
`NEXUS_CODESIGN_PFX`, `NEXUS_CODESIGN_PASSWORD`,
`NEXUS_CODESIGN_CERT_SHA256`, and
`NEXUS_RELEASE_TRUST_ROOT_PUBLIC_KEY`, then dispatch
`.github/workflows/trusted-release.yml`. Do not copy any private key into the
workspace.

### Installed, TURN, soak, and pilot

Follow `docs/installed-acceptance.md`, `docs/turn-operations.md`,
`docs/soak-operations.md`, and `docs/pilot-operations.md` in that order. Store
redacted evidence with the release record; never store private messages,
recovery material, signing keys, stable TURN credentials, or access tokens.

Qualification is currently stopped at the real-node propagation blocker
documented in `docs/core-propagation-blocker.md`. A successful retry is not
acceptance evidence.

## Stop conditions

Stop qualification and create a new candidate after any source/binary change,
unresolved critical/high authority or privacy finding, sanitizer crash,
signature mismatch, unsafe notification disclosure, inaccessible critical
path, soak failure or retry, TURN credential exposure, or pilot data-loss
event.
