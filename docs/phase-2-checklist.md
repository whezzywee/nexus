# Phase 2 checklist

Status: complete for the Windows platform-hardening and product-foundation slice
on 2026-07-26.

## Managed Core and recovery

- [x] Pin the official Windows x64 Core 0.2.107 asset URL, byte length, and
      release SHA-256 digest.
- [x] Download to a staging path, verify before activation, and reject any
      installed binary that no longer matches the pin.
- [x] Let Tauri own Core startup, loopback binding, logs, lifecycle state,
      graceful stop, bounded exponential restart, and the exit-code-42 update
      boundary.
- [x] Download and launch the real release, force-kill it, observe a supervised
      restart with a new PID, then stop and clean it.
- [x] Persist the Ed25519 device identity and actor sequence under
      current-user Windows DPAPI protection.
- [x] Encrypt recovery exports with PBKDF2-SHA-256 and AES-256-GCM, validate
      restored public/private key agreement, and reject the wrong passphrase.
- [x] Persist the retry outbox before submission and restore the identical
      signed operation after an application restart.

## Public gateway controls

- [x] Require expiring HMAC-authenticated bearer claims with explicit write and
      contract scopes.
- [x] Enforce contract allowlists, CBOR-only updates, decoded size limits,
      payload hashes, and operation-ID-bound idempotency keys.
- [x] Apply independent per-IP and per-subject token buckets, bounded upstream
      concurrency, upstream timeouts, strict origin policy, and security
      headers.
- [x] Permit plaintext upstream transport only on loopback and fail closed when
      public deployment configuration is incomplete.
- [x] Persist completed idempotency receipts through an atomic on-disk journal
      and prove they survive a gateway restart.

## Product protocol foundations

- [x] Add signed role-gated community membership operations with monotonic
      actor sequences and membership epochs.
- [x] Seal a conversation epoch key independently to each authorized X25519
      device using HKDF-SHA-256 and AES-256-GCM.
- [x] Chunk attachments at 256 KiB, optionally encrypt each chunk, content
      address stored bytes, and verify chunks plus the assembled file.
- [x] Add signed, recipient-bound, expiring, replay-protected call signaling on
      top of the existing mesh media router.
- [x] Build a Windows NSIS installer and a checksummed development release
      manifest containing the installer and Freenet contract.

## Deferred to the integrated product/release phase

- [x] Publish and exercise authoritative community, private-conversation,
      attachment-index, voice-session, and release-manifest Freenet contracts.
- [ ] Integrate membership, private-message encryption, attachments, device
      linking/revocation, and calls into both product UIs.
- [ ] Provision short-lived TURN credentials and complete real multi-party
      media acceptance tests.
- [ ] Replace the portable PBKDF2 recovery KDF with reviewed Argon2id, complete
      independent cryptographic/security review, and fuzz new contract inputs.
- [ ] Add offline release signing, signature/revocation verification, updater
      integration, CI provenance, and non-Windows managed-Core packages.

The generated 0.1.0 installer is intentionally marked
`unsigned-development`; it is not a trusted update artifact.
