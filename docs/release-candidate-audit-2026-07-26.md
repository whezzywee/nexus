# Nexus architecture and release audit — 2026-07-26

## Verdict

**NO-GO for a production release, with the protocol-v1 critical defect now
remediated in protocol v2.**

The repository has a credible and unusually broad prototype: the complete
quality suite passes, all six authoritative flows can pass across two real
Freenet Core 0.2.107 nodes, local TURN acceptance passes, and the desktop can
start its managed Core. Protocol v2 now replaces shared linked-device signing
keys with root-certified per-device keys and demonstrates failed
post-revocation sibling impersonation across two real nodes. A fail-closed soak
smoke also exposed an intermittent missed second authoritative update, so
real-node propagation stability is now an explicit release blocker alongside
independent review, protected Linux fuzz evidence, trusted signing, installed
acceptance, the external pilot/soak, and production TURN operations.

This document is a final internal architecture/release audit. It was produced
in the same implementation environment and is deliberately **not** labeled a
formal independent cryptographic or application review. That gate requires a
qualified reviewer who did not design or implement the system.

## Release-blocking findings

### C-01 — Linked-device revocation bypass

Severity: **critical; remediated in protocol v2, independent confirmation open**

Protocol v2 implements [ADR 0005](adr/0005-device-signing-authority.md):
every device has distinct Ed25519 signing and X25519 encryption keys, operations
carry a root-signed device certificate, TypeScript and Rust verify the same
canonical certificate/operation framing, sequences are per device, and
community revocations create permanent tombstones.

The regression suite proves that a copied linked vault has no root private key
and cannot sign as its sibling. A browser-generated protocol-v2 fixture verifies
in Rust. The real two-node test adds and revokes a linked device, then confirms
the contract rejects that revoked key's valid signature when it asserts the
active owner device ID.

Remaining disposition: obtain the formal independent cryptographic/application
review, including root custody, legacy-v1 migration, expiry semantics, recovery,
and protocol downgrade analysis. Protocol v1 remains forbidden in production.

### H-01 — Protected Linux sanitizer evidence is absent

Severity: **high release-process gap**

Five libFuzzer targets exist and the CI workflow runs them independently with
AddressSanitizer, bounded time, crash/log artifact retention, and a pinned
`cargo-fuzz` version. The current machine cannot produce the required evidence:
its Windows LLVM AddressSanitizer runtime is absent, the MSVC coverage symbols
needed by a no-sanitizer fallback are unavailable, and neither a Linux
subsystem nor a container engine is installed.

Required disposition: merge through protected CI, preserve one successful
artifact per target and commit, triage every crash, and add periodic longer
nightly campaigns. A workflow definition is not campaign evidence.

### H-02 — A publicly trusted release has not been produced

Severity: **high release-process gap**

The trusted release workflow now fails closed when the release trust root or
Authenticode material is missing, signs both the application executable and
NSIS installer through Tauri's `signCommand`, verifies both with SignTool,
attests the installer, and removes the temporary PFX. All third-party workflow
actions are pinned to immutable commit IDs.

No production certificate, protected environment approval record, protected
workflow run, verified installer, or published attestation was available.
Modern certificate policy may require a hardware-backed or managed remote
signer rather than an exportable PFX; the release operator must choose and
provision that trust model.

Required disposition: provision organization identity and key custody, require
independent production-environment approval, run the trusted workflow from the
reviewed tag/commit, verify the installed binary and installer on a clean
machine, preserve provenance, and publish only after protocol v2 receives its
independent review.

### H-03 — Installed notification acceptance is blocked

Severity: **high product-acceptance gap**

The installed Windows application launches and starts its managed Core
successfully. It then correctly refuses to enter the client because a published
production message-contract ID is not configured. The opt-in notification code
and native plugin exist, but an actual installed notification could not be
delivered through the product path.

Required disposition: after protocol v2 and contract publication, configure a
release-candidate build, install it cleanly, explicitly grant permission,
deliver one public and one private remote message while unfocused, verify
redacted private copy, verify denied/unavailable states, and preserve
screenshots/logs. Windows is the only current installed support target.

### H-04 — Real-node propagation is not soak-stable

Severity: **high product/operations gap**

A fresh direct campaign passed all six real two-node flows in this audit. A
subsequent one-iteration soak smoke failed when peer B received
private-conversation epoch 1 but did not recover epoch 2 within 60 seconds after
peer A accepted it; the bounded inner harness passed only after creating fresh
nodes and retrying. A separate preparation run preserved a transient community
propagation retry. The soak harness correctly fails on any such retry while
preserving its transcript.

The reduced test topology and bounded process-drain interval remove unrelated
connection churn but do not eliminate the missed update. Experimental
subscription renewals did not correct it and were removed. See
[the propagation blocker](core-propagation-blocker.md) and the preserved
campaign `.artifacts/soak/freenet/20260726T141452Z`.

A later focused campaign isolated Core logs per node and required three
consecutive healthy topology samples before starting contract work. That
corrected a separate premature streamed-PUT race. The release flow then passed
four fresh zero-retry runs; two private-conversation runs passed, and the third
again failed at epoch 2 after 73.43 seconds. The reader's Core journal contains
the epoch-2 delta, but the reader never materialized epoch 2 for GET requests.
The logs and journals are preserved at
`.artifacts/real-node-diagnosis/20260726T160007Z`.

This behavior is consistent with Freenet Core's open high-priority
[cross-node subscriber/update defect](https://github.com/freenet/freenet-core/issues/4681).
Core 0.2.108 does not contain a relevant fix, so changing the pin would not
close this gate.

A final source-packet attempt reproduced the instability more broadly: two
initial message PUT attempts timed out, private epoch 2 required a fresh-node
retry, and release update delivery timed out on all three attempts. Its complete
transcript is preserved at
`.artifacts/independent-review/20260726T144355Z/evidence/freenet-two-node.log`.

Required disposition: first isolate and resolve the propagation blocker, repeat
the complete direct suite without retries, and recreate candidate-bound
evidence. Only after the protocol-v2 independent review, run at least 72 hours
on the actual release candidate, retain host telemetry and all failures, then operate a
consented external pilot with support, upgrade, recovery, deletion, network
loss, notification, accessibility, and relay-only call scenarios.

### H-05 — Production TURN is prepared but not deployed

Severity: **high operations gap**

The gateway has an authenticated, scoped, rate-limited short-lived TURN REST
credential endpoint. A hardened Coturn baseline and rotation/monitoring runbook
exist. Real local Pion TURN acceptance passed direct, relay-only two-party, and
small multi-party cases.

No operator-owned public address, DNS, TLS certificate, immutable deployed
image, secret store, firewall rule set, metrics/alerts, capacity record, or
independent-network relay-only call was available.

Required disposition: follow [the TURN operations runbook](turn-operations.md),
separate operator secrets from clients, deploy with external monitoring, test
UDP/TCP/TLS from independent networks, exercise secret rotation, and record
capacity before the pilot.

## Other material findings

### M-01 — Cross-platform desktop claims must stay scoped

Managed Core artifacts are pinned and packaged for Windows, Linux, and macOS,
but `apps/desktop/src-tauri/src/identity_vault.rs` implements protected identity
storage only for Windows and fails closed elsewhere. The current Tauri bundle
target is NSIS, so the honest public support boundary is Windows-first.

Do not advertise installed Linux or macOS support until native vaults,
packaging, notifications, accessibility, updater, and clean-install acceptance
pass on those systems.

### M-02 — Human accessibility acceptance remains open

Automated axe 4.12.1 WCAG A/AA scans reported zero violations for both clients.
Keyboard traversal reached the expected controls in a sensible order, and
640-pixel/720-pixel viewports used as 200%-equivalent reflow had no horizontal
overflow. Browser review identified missing bypass navigation; both clients now
provide a visible-on-focus “Skip to conversation” link. This is valuable
regression evidence, not a substitute for human testing with a screen reader
and real application/browser zoom.

Required disposition: test the supported matrix with screen-reader users or a
trained tester, 200% and 400% zoom where applicable, high contrast, reduced
motion, focus recovery, live regions, calls, notifications, attachment
progress, and recovery/error paths.

### M-03 — Recovery KDF needs independent parameter approval

Recovery bundle v2 uses Argon2id with 64 MiB, three passes, and parallelism one.
[RFC 9106](https://www.rfc-editor.org/rfc/rfc9106) recommends Argon2id and gives
a 64 MiB, three-pass, parallelism-four profile as its memory-constrained
recommendation. Parallelism one is not automatically unsafe, but the deviation,
password policy, WebAssembly implementation, memory handling, and device
performance require review and measurement.

### M-04 — Frontend bundles need later performance work

Both production builds pass, but their primary JavaScript chunks are roughly
569–591 kB before gzip and trigger the build warning. This is not a release
security blocker, but route/feature code splitting should be measured before a
mobile public beta.

### M-05 — Transitive Rust maintenance/unsoundness warnings remain

`cargo audit` reports no known vulnerability advisory, but it reports 18
allowed warnings. The material ones are an
[unsound `glib 0.18.5` iterator path](https://rustsec.org/advisories/RUSTSEC-2024-0429)
in the Linux GTK3/Tauri dependency graph and
[unmaintained `bincode 1.3.3`](https://rustsec.org/advisories/RUSTSEC-2025-0141)
through `freenet-stdlib 0.8.4`; the remaining warnings are largely related
transitive GTK3/UNIC/procedural-macro maintenance notices. The current Windows
target does not compile the GTK path, and no Nexus call to the affected glib
iterator was identified. These warnings still require upstream tracking and
explicit acceptance before Linux support. The directly used
[`rand 0.8.5` unsoundness advisory](https://rustsec.org/advisories/RUSTSEC-2026-0097)
was removed by updating to patched `rand 0.8.6`.

## Corrections made during the audit

- Replaced shared linked-device signing keys with protocol-v2 root-certified
  per-device Ed25519/X25519 keys, per-device sequences, permanent revocation
  tombstones, cross-language verification, and a real-node exploit regression.
- Added explicit rejection of the all-zero X25519 shared secret, consistent
  with [RFC 7748](https://www.rfc-editor.org/rfc/rfc7748).
- Hardened attachment manifest/chunk validation in TypeScript and Rust,
  including safe integer, aggregate size, identifier, hash, and encoded-storage
  bounds.
- Replaced lexical release-version comparison with SemVer and bounded release
  revocation state.
- Corrected service-worker caching so private/API responses and cross-origin
  responses are never inserted into the application cache.
- Reduced the Tauri notification capability from the plugin-wide default to
  only permission checks, explicit permission requests, and notification
  delivery.
- Added short-lived TURN credentials, a hardened deployment baseline, operating
  procedures, and real local TURN acceptance.
- Added production Authenticode integration and protected-workflow verification
  using the practices documented by
  [Microsoft SignTool](https://learn.microsoft.com/windows/win32/seccrypto/signtool)
  and [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/).
- Added GitHub artifact attestation and immutable action pins; GitHub documents
  the trust boundary in
  [artifact attestations](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations-to-establish-provenance-for-builds).
- Changed workspace package metadata from `UNLICENSED` to `Apache-2.0`, added
  JavaScript and Rust advisory checks to protected CI/release, updated `rand`
  to patched 0.8.6, and recorded the remaining transitive Rust warnings.
- Added fail-closed, evidence-producing Linux fuzz and multi-day soak harnesses.

## Evidence from this audit

| Check | Result |
| --- | --- |
| `pnpm audit --prod --audit-level moderate` | PASS — no known vulnerabilities |
| `cargo audit` | PASS — no known vulnerability advisory; 18 transitive maintenance/unsoundness warnings recorded |
| `pnpm lint` | PASS — 129 files |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS; one environment-dependent runtime test skipped |
| `pnpm build` | PASS; bundle-size warnings recorded |
| Tauri NSIS release build | PASS — custom signing hook invoked for app, installer, and NSIS components; credentials intentionally absent and artifacts confirmed `NotSigned` |
| `cargo fmt --all -- --check` | PASS |
| `cargo clippy --workspace --all-targets -- -D warnings` | PASS |
| `cargo test --workspace --all-targets` | PASS; explicit real-node cases ignored in this generic command |
| Final `pnpm test:freenet-two-node` | FAIL — message PUT and private epoch propagation required retries; release update timed out on all three attempts |
| Protocol-v2 revocation exploit regression | PASS — linked-device add/revoke propagated across two nodes; revoked sibling impersonation rejected |
| One-iteration soak smoke | FAIL — private-conversation epoch 2 did not reach peer B within 60 seconds and required fresh-node retry; campaign preserved at `.artifacts/soak/freenet/20260726T141452Z` |
| `pnpm test:turn` | PASS — direct, relay-only, and small multi-party |
| Windows local sanitizer attempt | BLOCKED — required LLVM/coverage runtime absent |
| Protected Linux fuzz campaign | OPEN — workflow prepared, no protected-run artifacts available |
| Installed managed Core start | PASS |
| Installed notification delivery | OPEN — production contract ID absent |
| Automated accessibility/reflow | PASS |
| Human screen-reader/zoom matrix | OPEN |
| Trusted production signing run | OPEN — certificate/protected secrets absent |
| Production TURN deployment | OPEN — operator infrastructure absent |
| External pilot / 72-hour soak | OPEN |
| Formal independent review | OPEN |

The existing local development installer predates the protocol-v2 remediation
and is therefore stale. It is
`target/release/bundle/nsis/Nexus_0.1.0_x64-setup.exe`, SHA-256
`09a28cb91adb1017fa6e8f9afad0161e00331d2c112e67337e2a5fa30e8135c3`.
It is confirmed `NotSigned` and must not be distributed as trusted software.

## Release gate

A release candidate may be cut only when all of the following are true:

1. ADR 0005 and its migration receive formal independent cryptographic and
   application review.
2. Protected Linux sanitizer artifacts are clean for the exact commit.
3. Windows clean-install, update/rollback, notification, accessibility, and
   managed-Core tests pass.
4. Production TURN passes relay-only calls from independent networks and has
   tested alerting/rotation.
5. A 72-hour real-node soak and a supported external pilot have no unresolved
   release blocker.
6. A separately approved trusted-release run produces a publicly trusted
   installer and verifiable provenance for the reviewed commit.

Until then, artifacts must retain an explicit development/preview label and
must not be presented as a secure production messenger.
