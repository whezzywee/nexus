# Prototype status

This document is the claim boundary for the current Nexus repository. It
separates code that has been exercised from architecture that is intentionally
still future work.

## Verified on 2026-07-26

- `pnpm lint` completed with no errors or warnings.
- All TypeScript workspaces passed `pnpm typecheck`.
- Unit tests passed across protocol, identity, encryption, transport, runtime,
  and sync packages.
- Both React production bundles passed `pnpm build`.
- Browser QA exercised offline queue/retry, identity switching, desktop compact
  layout, console errors, and axe-core accessibility checks in both clients;
  both ended with zero automated accessibility violations.
- `cargo test --workspace --all-targets` compiled the desktop shell, gateway,
  protocol, and all seven contracts, then passed the complete Rust suite.
- `cargo clippy --workspace --all-targets -- -D warnings` passed.
- the message, community, private-conversation, attachment-index,
  attachment-chunk, voice-session, and release-manifest contracts built for
  `wasm32-unknown-unknown`.
- `tauri build --debug --no-bundle` produced a Windows desktop executable.
- four consecutive two-process Freenet Core 0.2.107 runs accepted a signed
  message delta on peer A, delivered a live update notification to subscribed
  peer B, and returned peer B state containing the message.
- the configured desktop and web service layers exchanged signed messages
  across those real nodes through the loopback native bridge;
- the desktop composer measures 48 px at rest and is capped at 110 px overall;
  the phone composer measures 50 px at rest and is capped at 118 px overall;
- the Phase 1 desktop and phone views ended with zero automated WCAG A/AA
  violations and no uncaught page errors.
- the official Windows x64 Core 0.2.107 release asset matched the pinned
  SHA-256, started under the Tauri supervisor, recovered with a new PID after a
  forced termination, and stopped cleanly;
- Windows DPAPI protected and restored a private device-state fixture for the
  current OS user; identity storage/recovery and retry-outbox restart tests
  passed;
- the hardened gateway's authorization, hash/idempotency validation, token
  buckets, loopback-upstream rule, and durable receipt journal tests passed;
- signed membership epochs, X25519 per-device epoch-key envelopes, encrypted
  content-addressed attachments, and replay-protected call signaling passed
  their shared-package tests;
- six real-network acceptance tests passed against two Core 0.2.107 processes:
  signed messaging, membership removal, conversation key rotation, attachment
  delivery/indexing, encrypted call signaling, and signed release
  publication/revocation;
- a real attachment selected in the desktop composer propagated through the
  signed message contract to the other visible browser tab. Desktop measured
  48 px/32 px for composer/textarea at 1440×900; the fixed phone layout measured
  48 px/32 px at 390×844 with no horizontal overflow;
- a later real-node browser pass published attachment chunks and their signed
  index through peer A, fetched and hash-verified them through peer B, and
  completed the product save control;
- both clients expose call join/leave, mic, camera, screen-share, media-device,
  and route-diagnostic controls; the browser joined with test media devices and
  exposed accessible call state;
- recovery bundle v2 Argon2id derivation, persisted X25519 device keys,
  self-authorized device roster updates, updater trust/revocation/hash/rollback
  policy, and offline release-record signing passed focused tests;
- managed Core install support compiles for pinned Linux and macOS x64/arm64
  archives in addition to Windows x64;
- `pnpm package:windows` produced an NSIS installer and checksummed contract
  package under `.artifacts/release/20260726-080310`.
- a real loopback Pion TURN service minted five-minute authenticated
  credentials and passed direct two-party, relay-only two-party, and
  three-person relay-only audio/data acceptance;
- the real two-node message test now submits content modified after signing,
  proves Core rejects it without changing state, then accepts and propagates
  the original valid operation;
- five independent seeded libFuzzer targets compile for the community,
  conversation, attachment, voice, and release families, and CI runs them as
  separate Linux/nightly jobs;
- JavaScript and Rust advisory scans report no known vulnerability advisory.
  RustSec still reports 18 allowed transitive maintenance/unsoundness warnings,
  recorded in the final audit;
- a local acceptance-only Authenticode exercise signed the real installer copy
  and detected a modified copy as `HashMismatch`, without claiming public
  certificate trust.
- both clients now search the locally displayed timeline by content or author,
  preserve message order, expose keyboard shortcuts and responsive search UI,
  and produce private-message notification copy without plaintext;
- the Phase 4 browser pass exercised search at 1440x900 and 390x844 in one
  browser instance. A compact search-button naming defect was found, fixed, and
  re-audited; both clients ended with zero automated WCAG A/AA violations.
- shared React workflows and client runtime/bootstrap code are split into
  focused packages and modules; the repository now includes an Apache-2.0
  open-source boundary, contribution/security policies, safe environment
  examples, and repository templates;
- the refreshed desktop and phone visual systems were rechecked at 1440x900
  and 390x844 with no horizontal overflow, page errors, or automated WCAG A/AA
  violations.
- the final internal architecture audit found a critical device-authority
  defect: linked devices copy the root Ed25519 private key, so revoking a device
  ID does not revoke that copy's signing authority.

The evidence and exact browser-QA scope are recorded in
[`docs/qa/2026-07-26/report.md`](qa/2026-07-26/report.md).

## What the development prototype proves

The development-only in-memory transport verifies Ed25519 signatures before
accepting operations and broadcasts accepted state to two independent
`ChatSession` instances. The test utilities seed Mara and Theo as separate
identities. The desktop and web clients can switch between them, submit
messages, disconnect the simulated network, queue an operation, and retry that
same operation after reconnection.

The Rust contract is not a mock. It implements Freenet's validate, update,
summarize, and delta methods against `freenet-stdlib` 0.8.4. Configured clients
use a random-token-protected, loopback-only bridge that translates their
allowlisted message reads and updates to Core's native protocol. This keeps the
browser-facing surface narrow while working around the pinned TypeScript SDK's
FlatBuffers UPDATE timeout. The direct SDK adapter remains available and
serializes GET requests because response matching is FIFO.

The managed desktop node is also no longer a placeholder. Tauri owns a pinned,
verified Core executable, exposes lifecycle status to the setup screen, binds
the API to loopback, appends process logs, backs off after crashes, and refuses
to silently cross the compatibility pin when Core exits with update code 42.
Identity sequences are protected before network submission, and retry
operations are restored with their original signatures and operation IDs.

The public gateway surface is constrained to allowlisted contract updates. It
authenticates scoped, expiring tokens; validates operation IDs, decoded size,
encoding, and payload hashes; applies independent network/identity quotas; and
persists completed idempotency receipts atomically. It forwards only to HTTPS
or a loopback HTTP adapter and does not expose Core administration.

## Not yet proven or implemented

- Community membership, private-conversation epochs, attachment indexes and
  immutable chunks, voice sessions, and release manifests now have Wasm
  contracts. Each family passed a two-real-node Core 0.2.107 propagation test,
  including membership/device removal, key rotation, attachment delivery,
  encrypted call signaling, and release revocation.
- Public chat messages remain signed plaintext. Private messages are encrypted
  with the current conversation epoch before submission; both clients now read
  and mutate authoritative membership, persist device encryption identities,
  link/revoke device records, rotate epochs, and decrypt only after local
  authorization checks. Protocol v2 uses root-certified per-device signing and
  encryption keys plus permanent revocation tombstones; a real two-node test
  rejects a revoked sibling attempting to impersonate the account root.
- Attachment publication/download, progress, cancellation, retry,
  verification, and save controls are wired through both clients.
- Call signaling validation, the mesh router, voice-session contract, product
  call controls, short-lived credential parsing, and real direct,
  relay-only, and three-person media acceptance are complete. Production relay
  deployment and operations remain future infrastructure work.
- Recovery bundle v2 uses Argon2id and v1 PBKDF2 remains importable. The Argon2
  implementation and cryptographic compositions have not received independent
  review.
- The NSIS package remains unsigned. Offline signing tools, updater
  verification, CI provenance, and fail-closed trusted-release workflows now
  exist, but the protected Authenticode certificate/secrets and production
  environment have not been provisioned or exercised.
- Managed Core packaging now pins Windows x64 plus Linux/macOS x64/arm64.
  Redacted diagnostics export, validated/persisted port selection, and
  offline-root-signed compatibility-pin rotation are implemented.
- Local search and privacy-safe notifications are implemented in both clients.
  Signed moderation/audit controls, invitation throttling, cancellable
  attachments, recovery rehearsal, lost-device replacement, owner transfer,
  and opt-in data-minimized reliability reporting are also implemented.
  Installed-build notification delivery on the current Windows support target
  and a full manual accessibility review remain.

## Next acceptance gate

Protocol-v2 device signing and migration are implemented and internally
verified. Remaining qualification requires formal independent review,
completed protected Linux fuzz/sanitizer campaigns,
production relay operations, installed notification checks, manual
assistive-technology review, an external pilot, a clean multi-day real-node
soak, and an exercised trusted-signing environment. No installer becomes a
trusted release until all gates pass for the same reviewed candidate.
