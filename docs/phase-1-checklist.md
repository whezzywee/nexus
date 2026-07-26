# Phase 1 checklist

Status: complete for the local signed-text slice on 2026-07-26.

## Runtime and transport

- [x] Validate Phase 0 evidence and retain the pinned Core 0.2.107 contract.
- [x] Add validated client runtime configuration for desktop and web.
- [x] Remove the production-build simulation fallback.
- [x] Start two real local Core nodes and publish the real Wasm contract from
      one reproducible command.
- [x] Add a random-token-protected loopback native bridge with a single
      contract allowlist, signature validation, and a 32 KiB request cap.
- [x] Exchange a signed message between two configured client sessions across
      peer A and peer B.
- [x] Exchange a signed message through two visible client tabs using one
      browser instance.

## Composer and UI quality

- [x] Fix the desktop grid row that allowed the composer to consume the message
      viewport.
- [x] Keep the desktop composer at 48 px at rest and cap it at 110 px overall.
- [x] Keep the phone composer at 50 px at rest and cap it at 118 px overall.
- [x] Send with Enter and preserve Shift+Enter for line breaks.
- [x] Finish desktop and phone WCAG A/AA browser audits with zero automated
      violations.

## Reproducibility

- [x] Provide `pnpm dev:phase1` for the real Tauri slice.
- [x] Provide `pnpm dev:phase1:desktop-ui` and `pnpm dev:phase1:web` for browser
      QA.
- [x] Keep generated runtime descriptors and access tokens out of source
      control.
- [x] Add a conditional live client-layer integration test.

## Deferred beyond this slice

- [x] Verified Core download, install, and Tauri-owned process supervision.
- [x] Persistent OS-backed identity keys and device recovery.
- [x] Real-node interruption, restart/backoff, and queued-send recovery tests.
- [x] Public community gateway authorization and abuse controls.
- [x] Tested foundations for membership, encrypted group-key distribution,
      attachments, call signaling, and development release packaging.
- [ ] End-to-end authoritative contracts, product UI integration, TURN, and
      signed release/update infrastructure. These are tracked in the Phase 2
      checklist's integrated product/release section.
