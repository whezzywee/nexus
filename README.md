# Nexus

Nexus is an early decentralized communication platform with two purpose-built
clients:

- **Nexus Desktop** — a Windows-first Tauri application intended to manage or
  connect to a Freenet Core node.
- **Nexus Web** — a mobile-first PWA intended to reach Freenet through a
  constrained, community-operated gateway when no local node is available.

The clients share protocol types, identity and cryptography services, sync
logic, WebRTC utilities, and branding tokens. They deliberately do not share
their page layouts.

Freenet nodes and contracts remain authoritative; Nexus does not require a
central application server. The optional web gateway and TURN service are
non-authoritative edge helpers for browsers and difficult WebRTC network paths.

## Project status

Phase 0 research and architecture are complete against Freenet Core
`v0.2.107` / commit `cfa5d0987d58e29018639d3cfdbd45fc7ca62874`.
The Phase 1 local text slice, Phase 2 Windows hardening slice, and Phase 3
authoritative-contract slice are implemented:

- two development peers exchange signed message operations through the shared
  transport boundary;
- offline operations queue and retry without changing their operation IDs;
- deterministic merges, duplicate delivery, deletion precedence, invalid
  signatures, encryption context, and replica repair have automated tests;
- seven real Freenet Rust contracts compile to Wasm; signed messaging,
  membership removal, private key rotation, attachment delivery/indexing,
  encrypted call signaling, and signed release/revocation flows completed
  live-subscription round trips across two Core 0.2.107 processes;
- both clients select a real, configured Freenet runtime in production and use
  the simulator only as an explicit Vite-development fallback;
- `pnpm dev:phase1` starts two local Core nodes, publishes the real contract,
  starts a token-protected loopback native bridge, and launches Tauri;
- a live client-layer test and browser QA completed signed peer-A to peer-B
  message exchanges through that runtime;
- both independent React clients build, and the Tauri shell builds on Windows;
- Tauri can download the official Windows x64 Core asset, verify its pinned
  SHA-256 digest, supervise it on loopback, and restart it with bounded backoff;
- desktop device keys, actor sequences, and retry operations persist under
  current-user DPAPI protection, with an encrypted recovery-bundle format;
- the constrained gateway now has scoped expiring authorization, contract and
  origin allowlists, rate/concurrency/body limits, durable idempotency receipts,
  security headers, and fail-closed upstream transport rules;
- membership epochs, per-device group-key envelopes, encrypted
  content-addressed attachments, and call-signaling replay protection have
  tested shared-package implementations;
- both clients read and mutate authoritative community state, persist device
  encryption identities, link device records, rotate private epochs, encrypt
  message bodies before submission, and decrypt only for authorized devices;
- both composers publish and fetch real content-addressed attachments through
  the Freenet bridge, with progress, retry, verified download, and save state;
- both clients expose responsive, accessible call join/leave, microphone,
  camera, screen-share, device-selection, and route-diagnostic controls;
- recovery bundle v2 uses Argon2id, while legacy PBKDF2 bundles remain
  importable;
- the desktop updater verifies a pinned release trust root, revocations,
  versions, platform/Core compatibility, artifact hashes, and rollback policy;
- managed Core packaging now pins and supervises Windows, Linux, and macOS
  x64/arm64 releases;
- `pnpm package:windows` produces an NSIS installer, contract artifact, release
  manifest, and SHA-256 sums.

This is not yet a production messenger. The final internal audit found a
release-blocking device-authority flaw: linked devices currently share the root
signing key, so revoking a device ID does not revoke that copy's signing
authority. Protocol v2 must implement distinct root-certified device signing
keys before a release candidate. Protected Linux fuzz evidence, independent
review, installed notification/accessibility acceptance, a real pilot and soak,
production TURN operations, and a trusted signing run also remain. The
generated installer is explicitly an unsigned development artifact. See the
[release-candidate audit](docs/release-candidate-audit-2026-07-26.md) and
[prototype status](docs/prototype-status.md) for the precise boundary.

## Run the development slice

Prerequisites are Node.js 22+, pnpm 11.9, Rust 1.89, the
`wasm32-unknown-unknown` target, and Windows C++ build tools for Tauri. Install
dependencies, then launch the complete real local slice:

```powershell
pnpm install
pnpm dev:phase1
```

Alternative Phase 1 frontends:

```powershell
pnpm dev:phase1:desktop-ui
pnpm dev:phase1:web
```

The script uses the pinned Core executable under `.research` when present, or
`NEXUS_FREENET_BIN` when supplied. The plain simulation commands remain
`pnpm dev:desktop-ui` and `pnpm dev:web`.

## Verify

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo build -p nexus-message-segment-contract --release --target wasm32-unknown-unknown
pnpm test:freenet-two-node
```

## Read first

- [Prototype status](docs/prototype-status.md)
- [Release-candidate audit](docs/release-candidate-audit-2026-07-26.md)
- [Independent review brief](docs/independent-review-brief.md)
- [Installed acceptance matrix](docs/installed-acceptance.md)
- [External pilot operations](docs/pilot-operations.md)
- [Browser QA report](docs/qa/2026-07-26/report.md)
- [Freenet integration](docs/freenet-integration.md)
- [Architecture](docs/architecture.md)
- [Contract architecture](docs/contract-architecture.md)
- [Security model](docs/security-model.md)
- [Gateway protocol](docs/gateway-protocol.md)
- [WebRTC topology](docs/webrtc-topology.md)
- [TURN operations](docs/turn-operations.md)
- [Private meeting pilot deployment](docs/meeting-pilot-deployment.md)
- [Real-node soak operations](docs/soak-operations.md)
- [Phase 0 checklist](docs/phase-0-checklist.md)
- [Phase 1 checklist](docs/phase-1-checklist.md)
- [Phase 2 checklist](docs/phase-2-checklist.md)
- [Phase 3 checklist](docs/phase-3-checklist.md)
- [Phase 4 checklist](docs/phase-4-checklist.md)
- [Open-source boundary](docs/open-source.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

Nexus's original source code and documentation are licensed under the
[Apache License 2.0](LICENSE). Freenet Core and other third-party components
retain their own licenses and distribution obligations; see the
[open-source boundary](docs/open-source.md) before distributing bundled
binaries.
