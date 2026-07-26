# Browser QA report — 2026-07-26

Scope: Nexus Web at 390 × 844 and Nexus Desktop at 1440 × 900 and
1024 × 768, using the Vite development builds.

## Result

No open reproducible functional or automated-accessibility violations remain
in the tested Phase 1 slice.

One desktop accessibility issue was found and fixed during this pass: twelve
small secondary labels failed WCAG AA color contrast. The muted-text palette
and composer hints were raised to a passing contrast. The final axe-core 4.12.1
results were:

- Nexus Web: 0 violations, 27 rules passed.
- Nexus Desktop: 0 violations, 27 rules passed.
- Both clients retain one incomplete contrast review because axe cannot
  determine gradient backgrounds or reliably evaluate single-letter avatars;
  these require manual review rather than representing known failures.

## Workflows exercised

- Loaded both clients and checked browser console/runtime errors.
- Queued a message while offline in Nexus Web, reconnected, and confirmed the
  retryable marker cleared without losing the message.
- Queued a message while offline in Nexus Desktop, reconnected, and confirmed
  it remained in the converged timeline.
- Switched the active desktop development identity from Mara to Theo and sent a
  second message as Theo.
- Confirmed the desktop member panel collapses at the compact viewport.
- Recorded Core Web Vitals: Web LCP 508 ms / CLS 0; Desktop LCP 568 ms /
  CLS 0.08 on the local development server.

## Phase 1 real-runtime follow-up

- Opened one headed browser instance with peer-A desktop, peer-B desktop, and
  phone-web tabs.
- Confirmed each configured client connected to the loopback native bridge and
  real two-node Freenet runtime.
- Sent `Phase 1 UI round trip` by clicking Send and `Enter key works` with the
  keyboard; peer B received both.
- Measured the desktop composer at 48 px at rest and 110 px at its multiline
  cap.
- Measured the 390 px phone composer at 50 px at rest and 118 px at its
  multiline cap.
- Re-ran axe-core WCAG A/AA checks after the real-runtime and composer changes;
  both clients reported zero violations.
- Cleared and rechecked console and uncaught page-error buffers.

## Phase 2 follow-up

- Reopened one browser instance with exactly two real-runtime tabs: Mara on
  peer A and Theo on peer B.
- Sent `phase-2-browser-1785039200` from Mara with Enter and observed the same
  signed operation in Theo's peer-B timeline.
- Confirmed the 1440 × 900 desktop reports `Freenet live`, `Local Core`, and
  `Subscribed`, with no horizontal overflow.
- Re-measured the resting desktop composer at 48 px overall / 32 px textarea.
- Re-measured the 390 × 844 phone composer at 50 px overall / 36 px textarea,
  with no horizontal overflow.
- Visually reviewed the new screenshots after identity/outbox integration and
  found no clipped composer, covered timeline, or layout regression.

## Phase 3 authority and attachment follow-up

- Community addition reached peer B at epoch 1; removal reached it at epoch 2
  with the removed member's device list cleared.
- A private conversation with two device envelopes reached peer B at epoch 1;
  epoch 2 omitted the removed device and its sealed key.
- An immutable content-addressed chunk and its signed attachment-index entry
  propagated from peer A to peer B.
- A signed, roster-bound, recipient-encrypted call offer propagated through the
  voice-session contract.
- An offline-root-signed release and its signed revocation propagated through
  the release-manifest contract.
- In the single visible browser instance, peer B selected
  `attachment-fixture.txt` and sent `phase-3 attachment via real Freenet`; peer
  A rendered the signed message and a `Verified attachment` badge.
- At 1440 Ã— 900 the desktop composer measured 850 Ã— 48 and its textarea
  736 Ã— 32.
- At 390 Ã— 844 the responsive composer measured 374 Ã— 48 and its textarea
  260 Ã— 32; document scroll width equaled client width at 390 px.

## Phase 3 product transport and call-control follow-up

- Removed direct plaintext Core WebSocket URLs from the web development
  launcher; the web client now receives only the token-protected loopback
  bridge configuration.
- In one visible browser instance, peer A published
  `attachment-fixture.txt`; peer B received its signed reference, fetched and
  SHA-256-verified the real chunks/index, and completed the save control.
- Joined the voice room with browser media devices, exercised microphone and
  camera toggles, confirmed screen-share, device-selection, route-diagnostic,
  and leave controls were exposed, and observed the accessible
  `Waiting for peers` call state.
- At 390 × 844 the composer measured 50 px, its textarea 36 px, and document
  scroll width exactly matched the 390 px viewport.
- Automated WCAG 2 A/AA audits completed with zero violations at both
  390 × 844 and 1440 × 900 after correcting the desktop sidebar-label
  contrast.

## Phase 3 authority and private-message product acceptance

- Bootstrapped authoritative community and private-conversation state through
  the local bridge backed by two real Core 0.2.107 nodes.
- Linked peer B from peer A, rotated to private epoch 2, and confirmed peer B
  opened its independently sealed epoch key.
- Submitted `phase-3 encrypted authority proof`; the bridge payload contained
  an AES-256-GCM envelope and did not contain the plaintext, while the
  authorized client rendered the decrypted text.
- Revoked peer B, rotated to epoch 3, and confirmed peer B immediately entered
  the locked state and cleared its decrypted message cache.
- Linked the desktop device, promoted it to admin, and mutated authoritative
  community membership from the desktop client. The owner then rotated to
  epoch 5 and both web and desktop clients decrypted
  `epoch-five cross-client proof`.
- Hardened the six-family real-node acceptance runner for transient Core
  bootstrap timeouts and notification coalescing; all message, community,
  private-conversation, attachment, voice, and release/revocation round trips
  completed.
- Automated axe audits reported zero violations for the web client at
  1440 × 900 and 390 × 844, and for the desktop client at 1440 × 900 and
  1024 × 768.

## Phase 3 infrastructure and independent QA follow-up

- A real Pion TURN service minted five-minute authenticated credentials,
  rejected unauthenticated requests, and passed direct two-party, relay-only
  two-party, and three-person relay-only audio/data routes.
- The message contract's real two-node test now submits content modified after
  signing, observes Core's explicit invalid-signature rejection, proves the
  authoritative state is unchanged, and then completes the valid round trip.
- The combined input harness was replaced by five independent seeded targets
  for community, conversation, attachment, voice, and release data. Each target
  compiles, and CI runs the targets as separate Linux/nightly jobs.
- JavaScript lint, type checks, and workspace tests passed. Rust workspace
  tests passed from an isolated target directory while the live Phase 1
  runtime remained open.
- Dependency audits and Semgrep completed with no actionable finding after
  pinned dependency updates.
- A DeepSeek V4 Pro max-reasoning QA pass was challenged against exact call
  sites and test evidence. It retracted its earlier claims about the message
  merge path, call expiry, TURN interoperability, and the now-split input
  targets; no confirmed code defect remained.
- A local acceptance-only Authenticode exercise signed a copy of the real
  installer and detected a modified copy as `HashMismatch`. It makes no public
  trust claim; production certificate provisioning remains open.

## Phase 4 search and notification follow-up

- Added shared, locally evaluated search over the messages already displayed by
  the authorized client. Author and content queries preserve timeline order and
  do not publish a search index or query.
- Added explicit opt-in notification controls to both clients. Initial history,
  self-authored messages, and focused-client updates are suppressed.
- Added native Tauri and browser notification delivery paths. Private-message
  copy is generic and a focused unit test proves the decrypted body is not
  included.
- In one browser instance, exercised desktop and web search at 1440x900 and
  390x844, including Ctrl+F/Ctrl+K, close/reset, author filtering, and empty
  result behavior.
- Found one compact-layout accessibility defect: hiding the visual text also
  removed the desktop search button's accessible name. Added an explicit name
  and reran axe-core 4.12.1; both clients finished with zero WCAG A/AA
  violations.
- Cleared and rechecked console and uncaught page-error buffers after the final
  hot reload. No application error remained. Denied and unavailable permission
  states are implemented, while delivered installed-build notifications on
  each supported operating-system family remain a Phase 4 acceptance item.

## Phase 4 resilience and operations follow-up

- Added and tested signed hide, report, timeout, remove, and appeal operations,
  role authorization, signature rejection, an inspectable audit, and bounded
  invitation attempts with retry guidance.
- Added cancellable attachment upload/download controls and verified a
  cancelled transfer can safely retry with the same content reference.
- Added redacted managed-node diagnostics export. Rust tests prove sensitive
  log lines and the local application-data path are removed.
- Added managed-node port validation/persistence and a signed one-hop Core
  compatibility-pin transition tied to a specific signed release.
- Added encrypted recovery export, non-mutating rehearsal, recovered linked
  device installation, and actor-sequence synchronization from shared state.
- Added a signed private-conversation controller handoff before membership
  ownership transfer. TypeScript and Rust tests prove the successor can rotate
  epochs and the founder can no longer do so.
- Added reliability reporting that is off by default, stores only event type,
  timestamp, and client surface, caps local retention, expires after 14 days,
  and immediately clears on disable.
- In the existing single browser instance, tested the reliability opt-in/off
  controls, Ctrl+F/Ctrl+K, reduced-motion media state, 1440x900 desktop layout,
  and 390x844 web layout. Both layouts had zero horizontal overflow and zero
  automated WCAG A/AA violations.
- The browser pass found and fixed two literal JSX expressions visible in the
  mobile navigation/composer area. Final console and page-error buffers were
  clear after reloading the corrected clients.

## Maintainability, open-source, and UI follow-up

- Extracted behaviorally identical authority, recovery, reliability, and
  composer behavior into `@nexus/client-react`, while retaining distinct web
  and desktop page layouts.
- Split both client entry points into dedicated runtime/bootstrap,
  notification, recovery-installation, and message-presentation modules. The
  primary web app fell from 1,461 to 1,014 lines and desktop from 1,924 to
  1,408 lines without changing protocol behavior.
- Added the Apache-2.0 license, contributor and conduct policies, private
  vulnerability guidance, safe environment placeholders, repository boundary
  documentation, and issue/pull-request templates. A source scan found no
  committed private keys, credential files, or common live-token patterns.
- Reworked both visual systems around flat charcoal surfaces, a restrained
  indigo accent, larger desktop typography, circular avatars, simpler copy,
  compact composers, and readable mobile voice controls.
- Rechecked the refreshed desktop at 1440x900 and mobile web at 390x844 in the
  existing browser instance. Both had zero automated WCAG A/AA violations,
  zero horizontal overflow, and no page errors after the final correction.

## Evidence

- [Mobile web initial state](screenshots/web-initial.png)
- [Mobile web offline queue](screenshots/web-offline-queued.png)
- [Desktop initial state](screenshots/desktop-initial.png)
- [Desktop offline queue](screenshots/desktop-offline-queued.png)
- [Desktop compact layout](screenshots/desktop-compact.png)
- [Desktop after contrast fix](screenshots/desktop-contrast-fixed.png)
- [Phase 1 desktop composer](phase1-desktop-composer.png)
- [Phase 1 phone composer](phase1-mobile-composer.png)
- [Phase 2 real desktop round trip](phase2-desktop.png)
- [Phase 2 phone composer](phase2-phone.png)
- [Phase 3 attachment desktop](phase3-attachment-desktop.png)
- [Phase 3 attachment phone](phase3-attachment-phone-fixed.png)
- [Phase 3 product desktop](phase3-product-desktop.png)
- [Phase 3 product phone](phase3-product-mobile.png)
- [Phase 3 authority web](phase3-authority-web.png)
- [Phase 3 authority web mobile](phase3-authority-web-mobile.png)
- [Phase 3 authority desktop](phase3-authority-desktop.png)
- [Phase 4 desktop search](phase4-search-desktop.png)
- [Phase 4 desktop search on phone layout](phase4-search-desktop-mobile-fixed.png)
- [Phase 4 web search on phone layout](phase4-search-web-mobile.png)
- [Phase 4 current desktop](phase4-desktop-current.png)
- [Phase 4 current mobile web](phase4-web-mobile-current.png)
- [Refreshed desktop UI](ui-refresh-desktop.png)
- [Refreshed mobile web UI](ui-refresh-web-mobile.png)

The screenshots with red numbered boxes are annotated interaction maps, not
part of the Nexus UI.
