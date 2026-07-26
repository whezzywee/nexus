# ADR 0004: Root identity, device keys, and replaceable group cipher

Status: partially superseded by ADR 0005; encryption decision remains accepted

## Decision

An identity root is intended to authorize per-device signing/encryption keys.
The current implementation completed the per-device encryption half but not the
per-device signing half; ADR 0005 records that release-blocking gap. Private
conversation content uses a symmetric epoch key encrypted to every authorized
device through the versioned X25519/HKDF/AES-GCM construction. A `GroupCipher`
interface separates key management from product behavior.

## Consequences

Member removal rotates future keys but cannot revoke previously received
content. The MVP does not claim MLS-level forward secrecy or post-compromise
security. MLS can replace the provider without rewriting conversations or UI.
