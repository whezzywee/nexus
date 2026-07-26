# Installed release-candidate acceptance

This matrix is for the currently supported installed target: Windows. Linux and
macOS are not support targets until their protected identity vaults and full
matrix are implemented. Run this against the exact signed release candidate on
a clean machine; preserve application version, artifact SHA-256, signer,
contract IDs, Core version, timestamps, screenshots, and redacted diagnostics.

## Notification delivery

1. Install the signed candidate and verify the installer and installed
   executable signatures with SignTool.
2. Start the managed Core, configure the published protocol-v2 message
   contract, create two genuinely distinct certified devices, and confirm both
   can exchange a normal message.
3. Select `Enable alerts`; record the permission prompt and result. No prompt
   may appear before that action.
4. Unfocus the receiving app and send a remote public message. Verify exactly
   one notification, correct application identity, and safe generic fallback.
5. Send a remote private message. Verify no plaintext, attachment name, sender
   secret, contract ID, key material, or gateway token appears.
6. Verify initial-history replay, own messages, duplicate operations, focused
   app state, muted channels, and revoked-device traffic produce no
   notification.
7. Test denied permission, notifications disabled after previously enabled,
   app restart, system restart, sleep/wake, offline delivery/reconnect, and
   upgrade from the previous supported version.
8. Activate the notification and verify navigation reaches the correct safe
   surface without revealing content on the lock screen or to the wrong local
   profile.

## Screen reader and zoom

Use the screen reader and system/browser versions declared in the release
support matrix. Test from a clean profile with keyboard only:

- first run, managed Core progress/error, identity/recovery, navigation, search,
  channel list, timeline, composer, attachments, community/member operations,
  call controls/device selection, diagnostics, notifications, and updater;
- heading/landmark structure, accessible names/descriptions, state/value
  announcements, live regions, error association, focus order, focus return,
  modal trapping/escape, and non-color status;
- actual 200% and 400% zoom where applicable, text scaling, high contrast,
  reduced motion, narrow reflow, long localized text, and no clipped or
  unreachable control;
- call/transfer progress that does not repeatedly interrupt speech and privacy
  copy that does not announce private plaintext unexpectedly.

Record each result as pass, fail, not applicable, or blocked. Automated axe
results and viewport emulation may accompany this record but cannot replace it.
A critical path that is unusable without a pointer device blocks the release.

## Update and recovery

Verify a clean install, in-place signed update, interrupted update, rollback
policy, revoked release rejection, uninstall/reinstall, diagnostics export,
recovery rehearsal, actual recovery to a newly certified device, old-device
revocation, and failed post-revocation impersonation. Confirm uninstall and
documented data removal behavior match the support promise.
