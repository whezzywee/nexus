# Nexus security model

Status: initial threat model; requires independent review before production.

## Protected assets

- identity and device private keys;
- recovery material and exported identity bundles;
- private-community and conversation keys;
- direct-message and private-channel plaintext;
- membership and moderation authority;
- update and website signing keys;
- TURN credentials and gateway operational secrets;
- local decrypted cache and search index.

## Trust boundaries

Trusted on the user's device:

- reviewed Nexus code;
- OS secure storage and WebCrypto implementation;
- the local display/input path;
- a managed local Freenet node for local secret availability, not for plaintext
  confidentiality that E2EE is meant to protect.

Untrusted or partially trusted:

- remote Freenet peers and contract hosts;
- all gateways;
- STUN/TURN operators;
- WebRTC peers beyond the content intentionally shared with them;
- network observers;
- notification providers;
- attachment authors;
- local caches after device compromise.

Contracts are adversarial execution inputs and must validate every state/update
path. Gateways are never trusted with identity or conversation private keys.

## Cryptographic construction

Nexus does not invent cryptographic primitives. The initial design uses:

- Ed25519 signatures for identity/device operations and release manifests;
- X25519 ephemeral ECDH, HKDF-SHA-256, and AES-256-GCM WebCrypto envelopes for
  encrypting an epoch key to each authorized device in the current prototype;
- AES-256-GCM for message content;
- SHA-256 for content addressing and artifact verification;
- Argon2id with 64 MiB, three passes, one lane, a 128-bit salt, and a 256-bit
  output for recovery bundle v2. Legacy PBKDF2-SHA-256 bundle v1 remains
  import-only.

The X25519 envelope composition, recovery KDF parameters, and device signing
authority still require independent cryptographic review. Exact suites are
versioned in protocol envelopes. Canonical signing bytes are manual,
length-prefixed, and domain-separated. JSON serialization is never the signing
format.

The current WebCrypto identity and X25519 device keys are extractable because
linking and recovery export them. The desktop shell protects the serialized
device state with per-user DPAPI on Windows. Equivalent protected vaults are
not yet implemented on Linux or macOS, which blocks a cross-platform production
claim. The gateway never receives unencrypted private keys.

## Identity and devices

Protocol v2 uses an Ed25519 identity root to certify a distinct Ed25519 signing
key and X25519 encryption key for each device. Operations carry the root-signed
certificate and are verified against the certified device key while binding the
asserted identity and device IDs. Linked vaults do not retain the root private
key. Sequences are tracked per device; community removal creates a permanent
device-ID tombstone; conversation authority also matches the certified X25519
key against its roster. The TypeScript and Rust implementations share a
browser-generated fixture, and a two-node regression rejects revoked sibling
impersonation.

The root remains the ultimate recovery authority, so root compromise is full
identity compromise. Legacy-v1 copied vaults require an explicit migration,
historical-device revocation, and conversation epoch rotation. Root custody,
migration/downgrade behavior, certificate expiry semantics, and recovery still
require the independent review described by
[ADR 0005](adr/0005-device-signing-authority.md).

Export bundles are encrypted, authenticated, versioned, and contain an explicit
warning that anyone with the bundle and passphrase controls the identity.
Recovery phrases are optional and never silently generated or uploaded.

## Private conversations

The MVP uses a random symmetric key per conversation membership epoch. It is
encrypted separately to every authorized device public key. Member removal
rotates the epoch key for future messages. This does not provide post-compromise
security, full forward secrecy, or retroactive revocation comparable to a
mature MLS implementation. `GroupCipher` isolates this scheme so MLS can replace
it later.

End-to-end encryption protects content from gateways and storage peers. It does
not hide all metadata: contract keys, membership references, timing, message
sizes, IP addresses, gateway choice, and call participation can still leak.

## Gateway threats

A malicious gateway can observe metadata, omit/delay/reorder traffic, return
stale state, rate-limit users selectively, and correlate IP addresses with
contract keys. It cannot forge valid signed operations or decrypt properly
encrypted content.

Mitigations:

- signature and hash verification on device;
- monotonic sequences and idempotent operation IDs;
- multiple gateways and visible health/failover;
- signed release and schema metadata;
- retries against the same contract keys;
- no raw node administration proxy;
- padded private payload classes as a later metadata-hardening option.

## Malicious peers and contracts

Peers can send malformed, oversized, duplicate, replayed, or conflicting state.
Contracts enforce size bounds, signatures, authority, sequences, deterministic
merge, and bounded growth. Clients treat unverified contract state as hostile.
Parsing is allocation-bounded and fuzzed.

## WebRTC and IP exposure

Direct WebRTC commonly exposes participants' network addresses to each other.
STUN and TURN operators also observe connection metadata. TURN-only mode can
hide peer addresses from other peers but increases latency, infrastructure use,
and cost. Media remains encrypted in transit by WebRTC; this alone does not make
call metadata anonymous.

## Stolen device

An unlocked stolen device may expose active sessions, decrypted caches, and
keys available to the process. OS secure storage does not protect against all
malware or an already-unlocked session.

Mitigations include screen lock integration where available, encrypted local
storage, explicit device revocation, cache clearing, notification redaction,
and recovery from a separate device. Revocation cannot retract previously
downloaded plaintext.

## Updates

Release metadata and every artifact are signed and hashed. The updater verifies
the signature, revocation state, each chunk, and final file before execution.
Signing private keys remain offline or in protected release environments, never
in source or application bundles.

A stolen signing key is catastrophic until clients receive a valid revocation
or trust-root update. Nexus keeps an offline recovery/revocation procedure,
requires reproducible release evidence where practical, separates web and
desktop keys, and supports rollback metadata without executing unsigned older
artifacts.

## Spam and denial of service

Attackers can create identities cheaply, flood public-write contracts, exhaust
gateway quotas, force expensive signature checks, grow reactions/tombstones,
or overload mesh calls.

Mitigations:

- bounded contracts and operation sizes;
- deterministic post-merge truncation;
- per-identity and per-network gateway limits;
- invitation/role gates for community writes;
- local block/mute filters;
- proof-of-resource or antiflood-token extension point;
- bounded verification queues and caches;
- room-size warnings and call admission limits.

Rate limits and moderation reduce abuse; they do not eliminate Sybil attacks.

## Logging and diagnostics

Logs never contain private keys, recovery data, decrypted private messages,
access tokens, raw TURN credentials, or full encrypted payloads that enable
offline analysis. Exported diagnostics replace identity/contract identifiers
with bundle-local pseudonyms and let the user preview the manifest before save.

## Residual risks

- metadata correlation across gateways, Freenet, and WebRTC;
- compromised client builds or dependencies;
- endpoint malware and unlocked-device theft;
- implementation errors in canonical encoding or key rotation;
- state availability under network churn and cache pressure;
- early Freenet API and ecosystem changes;
- mesh performance beyond small rooms.
