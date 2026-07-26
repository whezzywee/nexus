# Contributing to Nexus

Thank you for helping build Nexus. The project is an early prototype, so
changes should preserve its explicit security and release boundaries.

## Development setup

Install Node.js 22+, pnpm 11.9, Rust 1.89, the `wasm32-unknown-unknown`
target, and the platform tools required by Tauri.

```powershell
pnpm install
pnpm dev:desktop-ui
```

Use `pnpm dev:web` for the mobile-first web client. A real local Freenet slice
requires the setup described in the root README.

## Before opening a change

1. Keep protocol, cryptography, sync, and authority logic in shared packages.
2. Keep web and desktop presentation code independent unless the component is
   behaviorally identical on both clients.
3. Add tests for protocol operations, trust decisions, persistence changes,
   and failure recovery.
4. Do not commit identities, recovery bundles, credentials, signing material,
   generated installers, Core binaries, or runtime directories.
5. Run the relevant checks:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
```

## Change descriptions

Explain the user-visible outcome, tests performed, protocol or migration
impact, and any remaining risk. Changes affecting cryptography, authorization,
updates, gateway boundaries, or recovery should include a focused threat-model
note.

By submitting a contribution, you agree that it is licensed under the
Apache License 2.0.
