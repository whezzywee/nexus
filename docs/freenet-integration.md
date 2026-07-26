# Freenet integration findings

Status: Phase 0 research complete

Research date: 2026-07-26

Production pin: Freenet Core `v0.2.107`, commit
`cfa5d0987d58e29018639d3cfdbd45fc7ca62874`

## Sources inspected

The research checkout inspected current `freenet/freenet-core` HEAD
`cfa5d0987d58e29018639d3cfdbd45fc7ca62874` (2026-07-26), including Core
`0.2.107`, `fdev` `0.3.269`, the WebSocket server, contract runtime, website
contract, website publisher, operation documentation, and hosting/eviction
design.

Official references:

- [Freenet Core](https://github.com/freenet/freenet-core)
- [Freenet manual](https://freenet.org/build/manual/)
- [Contract interface](https://freenet.org/build/manual/contract-interface/)
- [TypeScript SDK](https://freenet.org/build/manual/typescript-sdk/)
- [User interface guide](https://freenet.org/build/manual/components/ui/)
- [Application tutorial](https://freenet.org/build/manual/tutorial/)
- [Manifest format](https://freenet.org/build/manual/manifest/)
- [Publish a website](https://freenet.org/build/manual/publish-a-website/)
- [Official example index](https://freenet.org/build/manual/example-app/)
- [Raven TypeScript/Vite example](https://github.com/freenet/raven), inspected
  at `90405d80ea3f3f104326d706e400502f9fc65c22`
- [River group-chat example](https://github.com/freenet/river), inspected at
  `b1bc4373cae12e7f153858af7cfa8f8bb290cc4a`

The official examples confirmed these working patterns:

- Rust/Wasm contracts implement `ContractInterface`.
- Local delegates implement `DelegateInterface` and can use node-managed secret
  storage.
- Parameterized shard contracts are instantiated with `PutRequest`.
- Browser clients use the published TypeScript SDK and serialize `get` calls.
- State merges must be deterministic across update order and every inbound
  state/update path must be validated.
- A static Vite output can be packaged into a signed Freenet web container.

## Contract API

A Rust contract implements four operations:

```rust
validate_state(parameters, state, related)
update_state(parameters, state, updates)
summarize_state(parameters, state)
get_state_delta(parameters, state, summary)
```

`Parameters`, `State`, deltas, and summaries are byte arrays. Nexus owns its
wire encoding and will use versioned CBOR in contracts. A contract executes on
untrusted peers, so it cannot contain private keys or plaintext private state.
It must validate full-state merges as rigorously as ordinary delta updates.

`RelatedContracts` exists in the API, but current documentation still describes
cross-contract reads during validation/update as future work. Nexus therefore
does not make correctness depend on synchronous cross-contract reads. References
between contracts are identifiers and proofs validated within the receiving
contract's available inputs.

## Node application API

The supported browser/Node client is
`@freenetorg/freenet-stdlib` `0.3.0`. Nexus pins this exact version in the
lockfile. The production adapter uses the documented V1 command endpoint:

```text
ws://127.0.0.1:7509/v1/contract/command
wss://gateway.example/nexus/v1/stream
```

The local node route is `/v1/contract/command`. Core source also contains a V2
route, but the published TypeScript guide and SDK examples use V1, so Nexus does
not depend on V2 yet.

`FreenetWsApi` exposes:

```text
put(PutRequest)
get(GetRequest)
update(UpdateRequest)
subscribe(SubscribeRequest)
disconnect(DisconnectRequest)
```

Responses arrive through both promises and a `ResponseHandler`. Subscription
updates arrive via `onContractUpdateNotification`.

Important SDK constraint: `get()` responses use one FIFO queue without request
correlation. Nexus must serialize all reads per WebSocket connection. Updates
may have application-level request IDs, but the adapter must not assume raw SDK
request correlation that does not exist.

Phase 1 also found that the pinned TypeScript SDK/Core pair can decode
FlatBuffers UPDATE frames but does not complete the request on Core 0.2.107.
The same signed operation succeeds through `freenet-stdlib`'s native WebSocket
protocol. The reproducible local runtime therefore exposes a loopback-only
native bridge with a random bearer token, a single configured-contract
allowlist, 32 KiB request limits, signature validation, and only state-read and
operation-submit routes. This is a compatibility boundary, not an
authoritative service or a public gateway.

When a UI runs inside a Freenet web-container shell, its empty auth token is
injected by the shell. A standalone client must use the node's supported auth
configuration. Nexus Desktop binds the managed node to loopback and never
exposes its command endpoint publicly by default.

## Current `fdev` surface

The `fdev` Clap source currently defines:

- `init`, `new`, `build`, `inspect`, `publish`
- `query`, `diagnostics`
- `wasm-runtime`
- `execute put|get|update|subscribe|get-contract-id`
- `test`
- `network-metrics-server`
- `verify-state`
- `website init|publish|update|list`

Relevant verified examples:

```text
freenet local
fdev build
fdev publish --code <contract.wasm> contract --state <state>
fdev execute get <contract-key> --output state.bin
fdev execute update <contract-key> <delta-file>
fdev execute subscribe <contract-key>
fdev website init nexus-web
fdev website publish apps/web/dist --key nexus-web
fdev website update apps/web/dist --key nexus-web
```

Exact flags must be checked against the pinned `fdev --help` in CI before a
release; command source is authoritative when prose and binaries differ.

## Website publishing

Current `fdev website` tooling:

1. generates an Ed25519 signing key outside the repository;
2. xz-compresses a tar archive whose root contains `index.html`;
3. signs `version_be_bytes || archive`;
4. puts a web-container contract parameterized by the public key;
5. updates by submitting a strictly higher version.

The stable contract key derives from the container Wasm and public key. The
website runs in a sandboxed iframe with a restrictive CSP. Nexus Web therefore:

- uses Vite `base: "./"`;
- bundles fonts, icons, and runtime assets locally;
- does not require third-party scripts or CDN assets;
- treats external fetches as unavailable inside the Freenet container.

The website signing key is an offline/release secret. It is never committed.
The built-in website contract rejects rollback versions. Nexus' release
manifest separately keeps a known-good version and rollback policy for clients;
performing a website rollback requires a newly signed, higher-version container
whose content matches the selected known-good build.

## Hosting, subscription, caching, and availability

There is no permanent application-level pin API in the inspected release.
Current Core demand-driven hosting ranks contracts by:

1. local subscription count;
2. downstream subscriber count;
3. real GET/PUT recency;
4. contract key as deterministic tie-break.

A local subscription makes a contract one of the last eviction candidates.
It is **not an absolute pin**. Under enough pressure a subscribed contract can
still be evicted. Real GET/PUT access renews the recency signal for contracts
that are not subscribed.

Nexus Desktop's closest-supported availability mechanism is therefore:

- keep live subscriptions to the web contract, release manifest, discovery
  contracts, and joined-community active segments;
- periodically perform genuine health/read checks only when needed, not fake
  traffic intended to game retention;
- surface actual subscription and node diagnostics;
- describe the behavior as “help distribute while subscribed and within the
  node's resource budget,” never “permanently pinned.”

Historical immutable message segments may be fetched on demand. The desktop
client should subscribe only to active segments and high-value indexes, avoiding
unbounded subscription growth.

## Limits at the pinned release

| Surface | Current limit | Nexus consequence |
|---|---:|---|
| Contract state | 50 MiB | Hard node-level PUT/UPDATE ceiling |
| Stream chunk | 256 KiB | SDK chunks large payloads automatically |
| Chunking threshold | 512 KiB | Payloads above this are streamed |
| Chunks per stream | 256 | Roughly 64 MiB reassembly capacity |
| Concurrent streams | 8 | Adapter applies backpressure |
| WebSocket message | 100 MiB | Server upgrade ceiling; not an app budget |
| Contract Wasm code | 10 MiB | Keep contracts small and separate |
| Local subscribers per contract | 256 | Split hot shared state; retry visibly |

The 50 MiB state limit binds before the nominal 64 MiB stream capacity. The
website contract source contains a 100 MiB sanity bound, but current `fdev`
preflights against the real 50 MiB node state limit.

Freenet does not define a semantic chat-message limit. Nexus defines stricter
application budgets for the MVP:

- UTF-8 message body: 8 KiB;
- complete message operation: 32 KiB;
- message segment target: 512 messages or 4 MiB encoded, whichever comes first;
- hard segment state rejection: 8 MiB;
- attachments: separate content-addressed chunks, never embedded in messages.

These lower limits bound validation cost and leave room for merge overhead.
They must be load-tested before being raised.

## Pin and update policy

`freenet/core-version.toml` is the single machine-readable Core pin. Rust
contract dependencies use exact `freenet-stdlib = "=0.8.4"` and the TypeScript
client uses exact `@freenetorg/freenet-stdlib = "0.3.0"`. The lockfiles pin
transitive dependencies.

Before changing the Core pin:

1. inspect Core, `fdev`, SDK, and official examples again;
2. build every contract for `wasm32-unknown-unknown`;
3. run contract convergence and malformed-state tests;
4. run a two-node publish/get/update/subscribe test;
5. test web-container publishing and loading;
6. test desktop node lifecycle and clean shutdown;
7. record changed limits, routes, authentication, and retention behavior here.

## Capability gaps and abstractions

| Requested capability | Current finding | Nexus boundary |
|---|---|---|
| Permanent pin | Not available as a guaranteed pin | `AvailabilityLease`, implemented by active subscriptions and diagnostics |
| Large installer as one contract | Unsafe and above state limit | `ArtifactStore`, initially signed multi-contract chunks |
| Browser raw node access | Too broad for public exposure | `GatewayTransport`, constrained Nexus operations only |
| Large-room media | Freenet is not media transport | `MediaRouter`, mesh now and SFU later |
| Cross-contract validation reads | Not a safe current dependency | Proof-carrying operations and client orchestration |

Local development uses `InMemoryContractTransport`. It implements the same
application transport contract as Freenet, is explicitly labeled “simulation,”
and cannot be selected in a production build.
