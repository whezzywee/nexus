# Phase 4 checklist

Status: repository-controlled Phase 4 implementation is substantially complete
as of 2026-07-26, but production qualification is open. Search, privacy-safe
notifications, community operations, resilience/support controls, and opt-in
reliability reporting are implemented. Installed-build, accessibility, relay,
pilot, soak, signing, and independent-review evidence remain open.

## Find and return

- [x] Search the locally displayed timeline by message text or author without
      publishing an index or query.
- [x] Preserve timeline order, show a live result count, support empty results,
      and clear the query when search closes.
- [x] Support mouse/touch activation plus Ctrl/Cmd+F and Ctrl/Cmd+K.
- [x] Expose the search experience in both desktop and phone layouts.
- [x] Verify filtering and keyboard behavior in one browser instance at
      1440x900 and 390x844.

## Privacy-safe notifications

- [x] Ask for notification permission only after an explicit user action and
      persist the user's enabled preference locally.
- [x] Notify only for newly accepted remote messages while the client is not
      focused; suppress initial history and the user's own messages.
- [x] Never place private-message plaintext in notification copy.
- [x] Wire the web Notification API and the native Tauri notification plugin,
      including denied and unavailable states.
- [ ] Verify a delivered notification from an installed desktop build on each
      supported operating-system family.
      The current public installed target is Windows. Its managed Core starts,
      but the installed client cannot enter the notification path until a
      production message-contract ID is published and configured.

## Community operations

- [x] Add moderation actions for hide, report, timeout, remove, and appeal.
- [x] Record moderation decisions in a signed, inspectable audit trail.
- [x] Add rate-limit feedback and abuse-resistant invitation controls.

## Resilience and support

- [x] Add attachment cancellation and resumable transfers.
- [x] Add a user-exportable diagnostics bundle with sensitive values removed.
- [x] Add managed-node port selection and signed compatibility-pin rotation.
- [x] Add recovery rehearsal, lost-device, and owner-transfer flows.

## Release experience

- [ ] Complete manual keyboard, screen-reader, contrast, zoom, and reduced-motion
      review on the supported client matrix.
      Automated WCAG A/AA scans, keyboard traversal, and 200%-equivalent reflow
      passed for both clients; human screen-reader and actual browser/application
      zoom review remain open.
- [x] Add opt-in, data-minimized crash and reliability reporting with a visible
      off switch and retention policy.
- [x] Refactor shared client workflows, publish contribution/security
      boundaries, and complete the desktop/mobile visual refresh.
- [ ] Run a small external pilot, repair its top failures, and complete a
      multi-day real-node soak.
- [ ] Deploy and operate the production TURN relay, then pass relay-only calls
      from independent networks with monitoring and secret rotation enabled.
      The credential endpoint, hardened Coturn baseline, operating runbook, and
      local Pion TURN acceptance are complete.
- [ ] Complete the remaining Phase 3 release-qualification gates and publish a
      trusted installer with rollback and support documentation.

## Readiness estimate

Repository-controlled engineering is approximately 85–90% complete. Public
release qualification is less complete because its remaining gates require
independent people or protected production infrastructure. The core protocol, real-node
transport, identity, private conversations, attachments, calls, updater trust
logic, managed node, community controls, recovery, diagnostics, and main client
surfaces exist. The device-authority correction and migration are implemented
and internally verified. The remaining work includes independent review,
protected CI/signing, installed notification
checks, manual assistive-technology review, pilot feedback, production relay
operations, multi-day soak, and release support.

## Implementation notes

- Moderation operations are signed and verified against the current membership
  epoch. The current audit is stored by the client; moving the audit into a
  dedicated shared contract remains a future durability improvement.
- Ownership transfer first hands private-conversation controller authority to
  an authorized successor device, then changes the membership role. Retrying
  safely finishes an interrupted handoff.
- Recovery exports use the existing Argon2id bundle format. A rehearsal verifies
  the file without mutation; actual recovery creates a new linked device and
  requires approval from an existing authorized device.
- Reliability reporting is off by default. It records only event category,
  timestamp, and client surface, caps the local queue at 100 events, expires
  unsent events after 14 days, and clears immediately when disabled.
