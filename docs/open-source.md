# Open-source boundary

The original source code and documentation in this repository are available
under the Apache License 2.0. The root package remains marked `private` to
prevent accidental npm publication; this does not restrict the source license.

## Included

- Nexus web and desktop client source;
- shared TypeScript protocol, identity, cryptography, authority, sync, media,
  attachment, and React behavior packages;
- Nexus Rust protocol, contracts, gateway, desktop integration, tests, scripts,
  and documentation.

## Not relicensed

- Freenet Core binaries or source;
- third-party npm, Cargo, icon, font, or operating-system components;
- generated installers and downloaded artifacts;
- contributor or user data, identities, recovery bundles, credentials,
  certificates, signing keys, or service infrastructure.

Those materials retain their own licenses or are not distributable. Before
shipping a build that bundles Freenet Core or other binary dependencies,
collect and include their required notices and license texts.

## Repository hygiene

Runtime data, research downloads, build outputs, local environment files,
private keys, certificates, and managed Core binaries are ignored. The checked
in `.env.example` contains placeholders only. Values prefixed with `VITE_` are
compiled into browser assets and must never contain durable secrets.

Public source availability does not mean the current prototype is
production-safe. The release and review gaps remain listed in
[`prototype-status.md`](prototype-status.md).
