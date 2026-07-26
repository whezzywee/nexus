# Meeting-link acceptance

Date: 2026-07-26

Scope: local two-browser acceptance of gateway-minted share links, encrypted
signaling, WebRTC negotiation, post-join media renegotiation, phone reflow, and
leave cleanup. This is repository-controlled evidence, not a claim that a
public HTTPS gateway or production TURN relay has been deployed.

## Configuration

- Nexus Web served from `http://127.0.0.1:5180`.
- Nexus Gateway served from `http://127.0.0.1:8787`.
- The host used a one-hour `meeting` capability only to request the friend
  invitation.
- The shared link contained the time-limited room capability and a distinct
  256-bit room encryption key inside the URL fragment.
- Two isolated Chromium profiles represented the host and guest.
- Guest viewport: 390×844.
- Browser fake-media devices supplied deterministic microphone and camera
  tracks; they did not replace signaling or WebRTC with a mock.

## Results

- The gateway minted the invitation and the browser produced a shareable link.
- A second browser parsed the link and displayed the correct room before
  joining.
- Both peers authenticated to the room-bound WebSocket without placing the
  bearer capability or room key in the socket URL.
- The gateway reported two of six participants.
- Encrypted offer, answer, and ICE exchange produced `connected` peer routes in
  both browsers.
- Enabling the guest microphone after connection renegotiated successfully; the
  host received one live remote audio track.
- Enabling the guest camera after the microphone renegotiated successfully; the
  host retained the live audio track and received one live video track.
- Leaving removed the remote media tile and returned the host to one
  participant.
- The 390×844 page had `clientWidth = scrollWidth = 390`.
- Browser error collections were empty in both profiles.

## Screenshots

- `../../../.artifacts/qa/meeting-links-20260726/screenshots/two-browser-guest-phone.png`
- `../../../.artifacts/qa/meeting-links-20260726/screenshots/two-browser-host-desktop.png`
- `../../../.artifacts/qa/meeting-links-20260726/screenshots/phone-audio-video-sent.png`
- `../../../.artifacts/qa/meeting-links-20260726/screenshots/desktop-audio-video-received.png`

The screenshots live in ignored local evidence storage and are not part of a
release artifact.

## Meeting-only production-path acceptance

A second acceptance pass exercised the deployable meeting-only web surface
without any Freenet runtime:

- a desktop host exchanged the private host passphrase for a short-lived token,
  minted an invitation, and produced a fragment-only link;
- an isolated 390×844 phone profile opened the link and joined the same room;
- the phone enabled microphone and camera after joining;
- the desktop received one live audio and one live video track;
- the phone viewport and document scroll width both remained 390 pixels;
- leaving removed the remote media tile and returned the host to one
  participant;
- both browser error logs were empty.

Evidence is under the ignored directory
`.artifacts/qa/meeting-only-20260726/`. This proves the meeting-only browser
path locally. It does not replace the external two-network phone and relay-only
acceptance required after deployment.

## Remaining public-release evidence

- Deploy Nexus Web and the gateway on operator-controlled HTTPS/WSS origins.
- Replace the private-pilot host passphrase with account authentication before
  allowing untrusted users to create meetings.
- Deploy production TURN and pass relay-only calls from independent networks.
- Test actual iOS and Android browsers, permission denial/recovery, background
  transitions, Bluetooth routing, and network changes.
- Complete the existing independent review, soak, pilot, accessibility,
  notification, signing, and real-node propagation gates.
