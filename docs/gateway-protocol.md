# Nexus gateway protocol

## Goal

The gateway gives browser clients the minimum operations Nexus needs without
publishing a raw Freenet node administration surface.

The browser speaks HTTPS and secure WebSocket to the gateway. The gateway uses
the pinned Freenet client API on a private loopback or private network.

## Implemented authorization boundary

The current update endpoint requires a bearer token shaped as
`v1.<base64url-json-claims>.<base64url-hmac-sha256>`. The signature covers
`v1.<payload>`. Claims contain:

```json
{
  "sub": "stable-gateway-subject",
  "exp": 1785039000,
  "permissions": ["write", "turn"],
  "contracts": ["allowlisted-contract-key"]
}
```

The HMAC secret is operator infrastructure and never ships to clients. An
identity service or community invitation service issues short-lived tokens;
the gateway does not mint social identities.

Required deployment configuration:

```text
NEXUS_GATEWAY_HMAC_SECRET
NEXUS_GATEWAY_CONTRACT_KEYS
NEXUS_GATEWAY_ORIGINS
NEXUS_GATEWAY_UPSTREAM_URL
NEXUS_GATEWAY_UPSTREAM_TOKEN
NEXUS_GATEWAY_IDEMPOTENCY_PATH
```

Optional production TURN credential configuration:

```text
NEXUS_TURN_SECRET
NEXUS_TURN_URLS
NEXUS_TURN_TTL_SECONDS
```

Completed receipts persist in an atomic on-disk journal so a gateway restart
can replay an identical result without storing decrypted content. The upstream
adapter must independently honor the same idempotency key. Plain HTTP upstream
is accepted only on loopback; other upstreams require HTTPS. Non-loopback
gateway binds fail closed unless explicit origins and a durable journal path
are configured. TLS termination still belongs in a correctly configured
same-host reverse proxy.

## HTTP API

The implemented HTTP surface is:

```text
GET  /nexus/v1/health
POST /nexus/v1/contracts/{key}/updates
POST /nexus/v1/turn-credentials
```

`POST /updates` requires:

```json
{
  "operation_id": "01...",
  "contract_type": "message-segment",
  "encoding": "cbor",
  "payload": "<base64url>",
  "payload_hash": "<hex>"
}
```

The gateway validates the route's contract type, key shape, size, encoding, and
payload hash before forwarding opaque bytes. It does not claim an operation was
accepted until Freenet returns success.

`Idempotency-Key` must equal `operation_id`. A bounded TTL cache stores only the
result code and hash, never decrypted content. Retrying an identical operation
returns the original result; reusing an ID with different bytes is rejected.

`POST /turn-credentials` requires the `turn` permission and returns a bounded
TURN REST username/password plus configured `turn:`/`turns:` URLs. Responses
are never cacheable. The shared relay secret remains operator-only; see
[Production TURN operations](turn-operations.md).

## Subscription stream

```text
wss://gateway.example/nexus/v1/stream
```

Client frames:

```json
{"type":"subscribe","request_id":"...","key":"...","summary":"<base64url>"}
{"type":"unsubscribe","request_id":"...","key":"..."}
{"type":"ping","request_id":"..."}
```

Server frames:

```json
{"type":"subscribed","request_id":"...","key":"..."}
{"type":"contract_update","key":"...","sequence":12,"update":"<base64url>"}
{"type":"health","freenet":"ready","lag_ms":18}
{"type":"error","request_id":"...","code":"rate_limited"}
```

Reconnect creates a fresh subscription using the client's last summary. Event
sequence is connection-local diagnostics, not global authority.

## Scope controls

- Allowlisted Nexus contract Wasm code hashes and contract-type budgets.
- Separate public read, authenticated write, subscription, and publish quotas.
- Maximum request and decompressed sizes.
- Per-IP and per-identity-key token buckets.
- Bounded concurrent upstream operations and subscriptions.
- Timeouts and circuit breakers around Core.
- No forwarding of diagnostics, node configuration, delegate secret, process,
  filesystem, or arbitrary administration endpoints.
- Strict origin allowlist, TLS, security headers, and WebSocket origin checks.

Rate limits slow abuse but do not make identity keys trusted. Contracts remain
the final authority for signatures and permissions.

## Multiple gateways

The client health-scores bundled and manually entered gateways by reachability,
latency, compatible protocol version, and Core state. Reads and subscriptions
may fail over automatically. A write may fail over automatically only before
any gateway has accepted it; otherwise the same idempotent operation is retried.
Sensitive identity/device or membership changes require visible confirmation
before switching to an untrusted manual gateway.

No gateway assigns canonical social IDs or stores canonical state. Switching
gateways and retrieving the same Freenet contract keys must reconstruct the same
social state.

## Privacy

Gateways learn IP address, timing, contract keys, sizes, and frequency. They may
learn public content. They must not receive private identity keys, conversation
keys, decrypted direct messages, private-channel plaintext, raw TURN secrets,
or plaintext private notification bodies.
