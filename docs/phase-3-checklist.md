# Phase 3 checklist

Status: the protocol-v2 device-authority correction is implemented and
internally verified, but Phase 3 is not release-complete as of 2026-07-26.
Independent review, protected Linux fuzz/sanitizer evidence, and trusted
production signing remain open.

## Completion boundary

- [x] Complete every Phase 3 implementation and acceptance task that can run in
      the repository or on the available development machine.
- [x] Implement distinct certified device signing keys and prove that a revoked
      device cannot impersonate an active sibling.
- [ ] Obtain a formal independent review and Argon2id approval.
- [ ] Record completed Linux/nightly input campaigns from protected CI runners.
- [ ] Provision the production signing identity and verify the resulting
      publicly trusted installer in the protected release environment.

The unchecked entries require an independent reviewer or protected
infrastructure. None is being marked complete without its evidence.

## Authoritative Freenet contracts

- [x] Publish signed community membership operations with role authority,
      authorized-device checks, deterministic conflict reduction, and epochs.
- [x] Exercise member addition and removal across two real Core 0.2.107 nodes;
      removal advances the epoch and clears the removed member's device roster.
- [x] Publish private-conversation epoch rotations with one independently sealed
      key per authorized X25519 device.
- [x] Exercise a two-device epoch followed by device removal across two real
      nodes; the removed device receives no epoch-two envelope.
- [x] Publish immutable, SHA-256-parameterized attachment chunk contracts and a
      signed attachment manifest index.
- [x] Deliver a chunk and its signed index entry across two real nodes.
- [x] Publish a bounded voice-session inbox that accepts only signed,
      roster-bound, recipient-bound signals for the current call epoch.
- [x] Deliver a recipient-encrypted offer across two real nodes.
- [x] Publish trust-root-bound release records and revocations.
- [x] Deliver an offline-root-signed release and a subsequent signed revocation
      across two real nodes.

## Product integration

- [x] Read and mutate authoritative community membership from both clients.
- [x] Persist distinct device signing and encryption keys, link devices, and
      expose cryptographically enforceable revocation and epoch rotation.
      Protocol v2 uses root-certified per-device Ed25519 signing and X25519
      encryption keys plus permanent revocation tombstones. Cross-language
      fixtures and a real two-node test reject revoked-sibling impersonation.
- [x] Encrypt private message bodies with the current conversation epoch key
      before submission and decrypt only after local authorization checks.
- [x] Let both composers select a real file, enforce attachment limits, prepare
      content-addressed chunks, include the reference in the signed message, and
      render a verified-attachment indicator.
- [x] Publish and fetch the prepared chunks/index from the product transports;
      add download, progress, retry, and save controls.
- [x] Add call join/leave, microphone, camera, screen-share, device selection,
      route diagnostics, and accessible call state to both clients.

## Infrastructure and security

- [x] Provision short-lived TURN REST credentials and run direct, relay-only,
      two-party, and small multi-party media acceptance.
      A real Pion TURN server minted five-minute authenticated credentials,
      rejected unauthenticated requests, and passed direct two-party,
      relay-only two-party, and three-person relay-only audio/data routes.
- [x] Replace portable PBKDF2 recovery with Argon2id.
      Recovery bundle v2 uses 64 MiB memory and three passes, while v1 PBKDF2
      bundles remain importable.
- [ ] Obtain independent approval of the recovery KDF construction and
      parameters.
- [ ] Fuzz every new contract decoder, state merge, and delta path.
      Five independent, seeded libFuzzer targets now compile for community,
      conversation, attachment, voice, and release inputs. CI runs each target
      in a separate Linux/nightly matrix job; a completed CI sanitizer campaign
      remains open.
- [ ] Complete independent cryptographic and application security review.
      The internal audit's release-blocking device-signing flaw is remediated
      and packaged for review. Internal verification is not a substitute for
      independent expert acceptance.
- [x] Add an offline release-signing ceremony and keep private release keys out
      of source, CI logs, and application bundles.
- [x] Verify release signatures, revocations, versions, artifact hashes, and
      rollback policy in the desktop updater before execution.
- [ ] Add CI provenance, reproducible-build evidence where practical, and
      trusted Windows code signing.
      CI now creates provenance and double-build hash evidence, and the trusted
      release workflow is fail-closed until the protected Authenticode secrets
      and production environment are provisioned. A local acceptance-only
      signature check proves signer metadata and tamper detection without
      claiming public trust.
- [x] Package managed Core for non-Windows platforms.
      Linux and macOS x64/arm64 assets are pinned by archive and extracted
      binary SHA-256, safely unpacked, and supervised by the desktop shell.
      This is packaging support only: the protected identity vault is currently
      implemented for Windows, so installed public support remains
      Windows-first.

The existing 0.1.0 installer remains `unsigned-development`. The release
contract and updater implement the trust, revocation, hash, and rollback
policy, but no installer is trusted until the protected signing environment
produces and verifies an Authenticode signature.
