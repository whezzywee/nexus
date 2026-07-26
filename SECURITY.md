# Security policy

Nexus is an early prototype and has not completed an independent security
review. Do not rely on it for high-risk or sensitive communication yet.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Send a private report
through the repository host's private vulnerability-reporting feature. If that
feature has not been enabled yet, contact the maintainers privately before
sharing reproduction details.

Include the affected version or commit, impact, prerequisites, a minimal
reproduction, and any suggested mitigation. Avoid accessing other people's
data, degrading public infrastructure, or retaining data beyond what is needed
to demonstrate the issue.

The maintainers should acknowledge a report within seven days, provide a
status update within fourteen days, and coordinate disclosure after a fix is
available. These are targets, not a warranty.

## In scope

- identity, device authorization, recovery, and key rotation;
- signed operations and deterministic contract merges;
- private-message and attachment confidentiality or integrity;
- gateway authorization, isolation, and abuse controls;
- update verification, rollback prevention, and signing workflows;
- desktop node lifecycle and protected local persistence.

The current known limitations are documented in
[`docs/security-model.md`](docs/security-model.md) and
[`docs/prototype-status.md`](docs/prototype-status.md).
