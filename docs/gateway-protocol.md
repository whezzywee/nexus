# Nexus gateway protocol

## Goal

The gateway gives browser clients the minimum operations Nexus needs without
publishing a raw Freenet node administration surface.

The browser speaks HTTPS and secure WebSocket to the gateway. The gateway uses
the pinned Freenet client API on a private loopback or private network.

When `NEXUS_WEB_STATIC_DIR` points to a built Nexus Web directory, the gateway
also serves those static files as a fallback. This is used by the temporary
single-origin friend preview; it does not change the gateway's authority or
enable a Freenet simulator.

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

For a standalone private meeting pilot, set
`NEXUS_GATEWAY_MEETING_ONLY=true`. In this mode the contract update route is
not registered, health reports Freenet as disabled, and the contract key,
upstream URL/token, and idempotency journal are not required. Meeting
invitations, encrypted WebSocket signaling, and TURN credentials remain
available. This is an explicit reduced deployment mode, not a simulated
Freenet connection.

When the gateway is reachable only through a controlled same-stack reverse
proxy, `NEXUS_GATEWAY_TRUST_PROXY_HEADERS=true` makes rate limiting use the
proxy-provided `X-Forwarded-For` client address. Do not enable it on a gateway
that clients can reach directly; otherwise callers could forge their apparent
address. The checked-in pilot stack does not publish the gateway container and
enables this setting behind Caddy.

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
POST /nexus/v1/meeting-host-sessions
POST /nexus/v1/meeting-invites
GET  /nexus/v1/meetings/{room-id}  (WebSocket upgrade)
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

`POST /meeting-invites` requires the `meeting` permission and accepts a bounded
URL-safe room ID plus a human-readable room name. It returns a gateway-signed,
time-limited capability with `meeting` and `turn` permissions. The web client
places that capability inside the URL fragment, so normal page requests,
referrer headers, reverse-proxy request targets, and static-host logs do not
receive it. The link is still a bearer capability: anyone who receives it can
join until it expires, so clients must not upload it to analytics or diagnostics.

`GET /meetings/{room-id}` upgrades to a bounded small-room WebSocket. The first
client frame carries the invitation capability and a fresh participant/device
ID; the capability must be unexpired, have `meeting` permission, and be bound
to the room in the path. The gateway caps rooms at six participants and relays
only URL-safe encrypted signal payloads to an online recipient. Offers,
answers, and ICE candidates are AES-256-GCM encrypted in the browser with a
room key held only in the URL fragment. The capability and encryption key are
never placed in the WebSocket URL.

For a small private pilot, operators may configure
`NEXUS_MEETING_HOST_SECRET_FILE` and expose
`POST /meeting-host-sessions`. A host sends the private 32–256 character
passphrase using the `Nexus-Host` authorization scheme and receives a
short-lived token containing only the `meeting` permission. The endpoint is
IP/subject rate-limited, performs an exact constant-time comparison, returns
`Cache-Control: no-store`, and is disabled when no host secret is configured.
The web client keeps the resulting token in memory only. The passphrase is
never included in an invitation and is not an identity system; replace this
pilot boundary with normal account authentication before opening hosting to
untrusted users.

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
