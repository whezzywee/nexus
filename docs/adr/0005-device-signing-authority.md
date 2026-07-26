# ADR 0005: Distinct certified device signing keys

Status: accepted and implemented in protocol v2; independent review pending

## Problem

Protocol v1 copied the same extractable Ed25519 identity private key to every
linked device. Operations included a device ID, but verification proved only
possession of the shared identity key. A revoked vault could therefore sign an
operation while asserting an active sibling's device ID.

## Decision

Protocol v2 uses:

1. An Ed25519 identity root whose public-key SHA-256 fingerprint is the stable
   identity ID.
2. A distinct Ed25519 signing key and X25519 encryption key generated on every
   device.
3. A canonical, domain-separated, root-signed device certificate binding the
   identity ID, device ID, both device public keys, issuance sequence, issuance
   time, and optional expiry.
4. Signed operations carrying the certificate and verifying the operation only
   against its certified device signing key, never against the root key.
5. Per-device operation sequences and permanent community revocation
   tombstones. An active certified authority may remove a device; a tombstoned
   device ID can never be authorized again in that community.
6. Conversation authorization that also matches the actor certificate's X25519
   key against the current device roster.
7. Protocol-v1 contract state rejected by protocol-v2 contracts. Local v1
   storage is upgraded by generating a distinct certified local device key;
   deployments with copied v1 vaults must revoke those historical device IDs
   and rotate conversation epochs before release.

The root private key is not copied to a newly linked device. The product's
link/recovery path decrypts a recovery file only long enough to issue a new
device certificate, then persists the linked device without root authority.
Copying one v2 device vault therefore cannot mint certificates or impersonate a
sibling.

The identity root remains the ultimate recovery authority. Compromise of the
root is identity compromise and is outside the narrower device-vault revocation
guarantee; root custody and the legacy migration ceremony remain subjects for
the independent cryptographic/application review.

## Canonical verification

TypeScript and Rust use the same `nexus:device-certificate:v2` framing and
protocol-v2 operation domains. Verification checks:

- the root fingerprint equals the asserted identity ID;
- the certificate root signature is valid;
- the asserted identity and device IDs equal the certificate values;
- the operation public key equals the certified device signing key; and
- the device signature covers the canonical operation bytes.

## Acceptance evidence

- TypeScript tests prove linked vaults contain distinct signing keys and no root
  private key, sibling-ID impersonation fails, recovery export from a linked
  vault fails, and v1 local storage upgrades to v2.
- Rust tests prove distinct root/device keys, browser-generated protocol-v2
  canonical bytes, sibling-ID impersonation rejection, permanent revocation
  tombstones, and conversation certificate/roster key binding.
- The real two-node Freenet test adds a linked device, propagates its
  revocation, and confirms the contract rejects a valid signature from the
  revoked key when it asserts the active owner's device ID.

Independent cryptographic/application approval is still required before the
production release gate closes.
