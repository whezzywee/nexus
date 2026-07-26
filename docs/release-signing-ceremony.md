# Offline release-signing ceremony

Production release signing happens on a dedicated offline workstation. The
Ed25519 seed must never enter this repository, a developer workstation, CI, a
chat transcript, or an application bundle.

1. Build and test the release in CI, then export the unsigned release record,
   artifact hashes, provenance, and reproducibility comparison on removable
   media.
2. On the offline workstation, independently hash every artifact and compare
   the values with the unsigned record.
3. Review the product version, Core compatibility pin, platform, byte length,
   HTTPS artifact URL, and rollback implications.
4. Run `scripts/offline-sign-release.ps1` with a private-key file outside the
   workspace. The signer refuses keys stored under the repository.
   If the release changes the managed Core compatibility value, also review an
   unsigned one-hop pin transition and run
   `scripts/offline-sign-core-pin.ps1`. The pin must name this release, the
   compatibility value accepted by the current build, and the value required
   by the new release.
5. Verify the emitted public key against the separately recorded Nexus trust
   root. Transfer only the signed record back to the online release operator.
6. Have a second operator verify the signature and hashes before publishing the
   record to the release-manifest contract.
7. If any artifact or signing workstation is suspect, publish an offline-root
   signed revocation before distributing a replacement release.

Windows Authenticode signing is a separate step backed by the organization
certificate configured in the protected release workflow. The Ed25519 release
root and Authenticode key must not be the same key.

The `production-release` environment must pin
`NEXUS_CODESIGN_CERT_SHA256` to the lowercase SHA-256 fingerprint of the
certificate's DER bytes. The workflow rejects a missing, expired,
non-code-signing, or unexpected certificate, requires trusted timestamps, and
emits `authenticode-report.json` with the signed candidate bundle.
