# Independent cryptographic and application review brief

## Independence and stop condition

This brief is an input to an external review, not the review itself. The
reviewer must not have designed or implemented Nexus, must disclose material
conflicts, and must be free to publish the full findings to the project owner.
Protocol-v2 device authority is implemented in
[ADR 0005](adr/0005-device-signing-authority.md). The reviewer must independently
confirm the remediation rather than relying on the internal audit or tests.

## Required reviewer capabilities

The lead reviewer should have practical experience with Ed25519/X25519 protocol
design, authenticated encryption, password KDFs, multi-device identity and
revocation, distributed-state validation, TypeScript Web Crypto, Rust, and
desktop/web application security. Application testing should include Tauri,
browser storage/service workers, update/signing chains, and network/gateway
abuse controls.

## Review scope

- `packages/identity`, `packages/device`, and the complete recovery format.
- `packages/crypto`, private-conversation envelopes, nonce/context construction,
  key lifecycle, memory/storage boundaries, and error handling.
- TypeScript and Rust canonical bytes, signatures, IDs, monotonic sequences,
  authorization, revocation, replay prevention, and cross-language fixtures.
- Every Freenet contract's validation, merge, delta, summary, bounds, and
  migration behavior.
- Attachments, call signaling, TURN credential issuance, gateway
  authentication/rate limits, and service-worker/cache privacy.
- Desktop vault, managed Core boundary, CSP/capabilities, updater, offline
  release root, Authenticode, provenance, and rollback/revocation.
- Abuse cases: copied/stolen vault, revoked device, malicious member,
  compromised gateway, stale/partitioned peers, replay/rollback, resource
  exhaustion, malicious attachment, and compromised release service.

Out of scope must be listed explicitly; silence is not an exclusion.

## Mandatory questions

1. Can any revoked or removed device produce an operation accepted as another
   active device, owner, moderator, conversation controller, or release signer?
2. Are device certificates, operations, revocations, and migrations
   unambiguous, domain-separated, length-framed, versioned, and rollback-safe?
3. Does copying one local vault enable sibling impersonation or recovery-root
   use outside the explicit recovery ceremony?
4. Does every TypeScript verifier agree byte-for-byte and decision-for-decision
   with its Rust/contract counterpart, including malformed and boundary inputs?
5. Can an unauthorized peer learn message/attachment/call plaintext or retain
   access after membership removal and epoch rotation?
6. Are X25519 all-zero results, AEAD nonce uniqueness, associated data, key
   separation, randomness, and key destruction handled correctly?
7. Are the Argon2id implementation and parameters suitable for the supported
   hardware and the recovery threat model?
8. Can untrusted input cause unbounded state, CPU, memory, disk, network,
   notification, media, or log growth?
9. Can a gateway, service worker, updater, release operator, or compromised
   dependency silently cross its stated trust boundary?
10. Is the protocol-v1-to-v2 migration atomic, recoverable, downgrade-resistant,
    and safe under partition/replay?

## Required deliverables

- A dated, signed report naming the exact source archive/commit and toolchain.
- Executive verdict and severity rubric.
- Reproduction steps and minimal test fixtures for every finding.
- Code-level review notes for all in-scope cryptographic constructions.
- A threat-model delta showing any assumption the reviewer changed.
- Fuzz/static/dynamic test commands and preserved outputs.
- A finding register with owner, remediation, retest evidence, and status.
- A separate retest letter closing or retaining each critical/high finding.

The project must publish the report or an agreed public summary that retains
every finding's severity and disposition. “No findings” without scope,
methodology, and evidence does not close this gate.

## Reviewer handoff

Provide a clean source archive, lockfiles, SBOM/dependency inventory, compiler
versions, contract Wasm hashes, protocol fixtures, architecture/security/ADR
documents, the final internal audit, CI/fuzz artifacts, two-node logs, and test
identities with no production secret. Never give the reviewer a production
release root, Authenticode private key, TURN secret, or user data.

Generate the reproducible handoff with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/prepare-independent-review.ps1 `
  -IncludeRealNodeRun
```

The packet records the exact source-archive hash, per-file hashes, toolchain,
dependency inventories, contract Wasm hashes, cross-language fixture, quality
logs, and optional real-node transcript. The external report must name the
packet campaign ID and source-archive SHA-256.
