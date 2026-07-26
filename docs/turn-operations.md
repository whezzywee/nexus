# Production TURN operations

The repository contains a deployable Coturn baseline and a matching
short-lived credential endpoint. It is not a record of a live deployment.
Production readiness still requires operator-owned DNS, public addresses,
certificates, secret storage, monitoring, capacity, and an external relay-only
call.

## Components

- `deploy/turn/compose.yaml` runs Coturn with host networking, a read-only
  filesystem, dropped capabilities, TLS, TURN REST authentication, private-peer
  deny rules, bounded allocations, and loopback-only Prometheus metrics.
- `POST /nexus/v1/turn-credentials` on the Nexus gateway requires an
  authenticated access token with the `turn` permission. It returns a
  five-minute HMAC-SHA1 TURN REST credential by default and sets
  `Cache-Control: no-store`.
- The same shared secret must be present in the Coturn secret file and
  `NEXUS_TURN_SECRET` on the gateway. It must never ship in either client.

## Required gateway configuration

```text
NEXUS_TURN_SECRET=<at least 32 random bytes>
NEXUS_TURN_URLS=turn:relay.example:3478?transport=udp,turn:relay.example:3478?transport=tcp,turns:relay.example:5349?transport=tcp
NEXUS_TURN_TTL_SECONDS=300
```

Issue gateway access tokens with the `turn` permission only to authenticated
call participants. The existing per-subject and per-IP token buckets also
protect credential issuance.

## Deployment sequence

1. Allocate a dedicated public relay address and DNS name. Open TCP/UDP 3478,
   TCP 5349, and UDP 49160-49999. Do not place the UDP relay range behind a
   proxy that rewrites source addresses.
2. Pin `NEXUS_COTURN_IMAGE` to an immutable Coturn image revision or digest.
   The baseline was written for the official Coturn 4 image family.
3. Store one high-entropy shared secret in a root-readable file, configure the
   same value in the gateway secret store, and provide a valid TLS full chain
   and private key for the relay DNS name.
4. Set `NEXUS_TURN_EXTERNAL_IP` to the public address. If the host is behind
   one-to-one NAT, use Coturn's `public/private` mapping form.
5. Start the service, scrape `127.0.0.1:9641/metrics` from a same-host agent,
   and verify UDP, TCP, and TLS listeners from an external network.
6. Request a credential through the gateway, force `iceTransportPolicy:
   "relay"`, and complete two-party audio/data plus the supported small-room
   mesh from at least two independent networks.

The official Coturn image recommends host networking for large relay port
ranges. Size the range and bandwidth caps from observed peak concurrent
allocations; the checked-in values are conservative pilot defaults, not an
unbounded production capacity claim.

## Monitoring and incident response

Alert on listener failure, credential endpoint 5xx rate, authentication
failures, allocation saturation, relay port exhaustion, abnormal bytes per
allocation, and certificate expiry. Logs and metric labels must not contain
raw credentials or stable client identity keys.

To rotate the shared secret without dropping active issuance, place the new and
old secrets on separate lines in the Coturn secret file, restart Coturn, switch
the gateway to the new secret, wait longer than the credential TTL, then remove
the old line and restart again. If a secret is exposed, rotate immediately,
revoke affected gateway access tokens, and review relay traffic for abuse.
