# Nexus architecture

## System boundaries

```text
Nexus Desktop UI ─┐
                  ├─ shared application services ─ FreenetTransport ─ local Core
Nexus Web UI ─────┘                              └ GatewayTransport ─ gateway ─ Core

shared services ─ IdentityVault
                ├ OperationQueue
                ├ SyncEngine
                ├ PermissionEvaluator
                ├ WebRtcSessionManager
                └ MediaRouter (mesh implementation for MVP)
```

Desktop and web share domain behavior, not page layouts. Desktop has a
multi-panel mouse/keyboard UI and native lifecycle integration. Web has a
touch-first, one-column chat and bottom navigation on phones.

## Authority

Freenet contracts are authoritative for shared community, channel, message,
membership, invitation, presence, signaling, and release state. SQLite and
IndexedDB contain only local encrypted caches, drafts, queues, read markers,
search indexes, and diagnostics.

The gateway is transport infrastructure. It is not authoritative, does not
mint identities, and cannot decrypt end-to-end encrypted content.

## Shared package responsibilities

- `protocol`: versioned schemas, stable identifiers, validation, permission
  types, canonical signing bytes.
- `freenet-client`: serialized reads, request adaptation, subscriptions,
  retry-safe operation IDs, node/gateway transport boundary.
- `app-runtime`: validated runtime configuration and selection between the
  real Freenet paths and the explicit development simulator.
- `client-react`: behaviorally identical React workflows such as authority
  controls, recovery, privacy-safe reliability consent, and composer sizing.
  It does not own page layout or visual identity.
- `identity`: identity lifecycle, device keys, export/import envelopes.
- `crypto`: standard-library wrappers for signing, sealed member-key envelopes,
  conversation encryption, hash verification, replay protection.
- `community`: signed membership operations, role authority, actor sequences,
  and membership/key-rotation epochs.
- `attachments`: encrypted 256 KiB chunk preparation, content-addressed
  manifests, and end-to-end reconstruction verification.
- `sync-engine`: operation queue, confirmed/failed states, deduplication,
  convergence, reconnect, and protected retry-store integration.
- `webrtc`: signaling envelopes, media device management, mesh router.
- `desktop-branding` and `web-branding`: import central product branding while
  exposing platform-specific presentation tokens.

## Stable identity and ordering

Public identifiers are 128-bit ULIDs represented in canonical uppercase text.
Cryptographic identities use encoded public-key fingerprints as their durable
identifier. Operations include:

```text
operation_id
schema_version
actor_id
device_id
actor_sequence
created_at
target_contract
payload
signature
```

`operation_id` provides idempotency. `actor_sequence` and a bounded recent-ID
window provide replay protection. Timestamps are user-facing hints and
deterministic ordering inputs only; a contract never depends on wall-clock time.

## Send state machine

```text
draft -> queued -> submitting -> accepted
                    |     |
                    |     +-> retryable
                    +------> rejected
retryable -> submitting
```

The UI says “sent” only after local Core or a gateway accepts the operation.
An accepted operation can still be synchronizing to other peers, which is shown
separately.

## Desktop Core lifecycle

```text
not_installed -> installing -> starting -> connecting -> ready
                                  |            |          |
                                  v            v          v
                                failed      degraded -> restarting
                                  ^                      |
                                  +----------------------+
ready|degraded|failed -> stopping -> not_installed
```

The manager uses a single-instance lock, detects a compatible external node,
binds the managed node to loopback, applies exponential restart backoff, captures
privacy-scrubbed logs, and stops only a node process it owns.

## Performance strategy

- Message segments are lazy-loaded and virtualized.
- All Freenet and native work stays off the UI thread.
- Active contracts are subscribed; history is demand-fetched.
- Queue processing is bounded and backpressured.
- Web routes and call UI are code-split.
- Cache quotas and a low-memory mode are explicit.
- Desktop contribution throttles on battery, metered connections, and detected
  fullscreen/gaming sessions where Windows APIs permit it.
