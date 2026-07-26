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

## Temporary public-edge acceptance

The self-hosted `pnpm friend:preview` path was exercised through its generated
public `https://…trycloudflare.com` origin:

- the public health endpoint returned `ready` with Freenet explicitly
  `disabled`;
- the absent contract-update route rejected a POST rather than forwarding it;
- a desktop host exchanged the local private passphrase for a short-lived
  meeting token and generated a public fragment-only invitation;
- a separate 390×844 browser profile opened the public URL and joined over the
  tunneled WSS endpoint;
- enabling its microphone and camera produced one live audio and one live video
  track at the host;
- the public phone layout remained exactly 390 pixels wide with no horizontal
  overflow;
- both public browser error collections were empty;
- tunnel and gateway logs contained no `nexus-meeting` fragment, room key, or
  bearer join payload.

Screenshots are in ignored local evidence storage at
`.artifacts/qa/public-friend-preview-20260726/`. Both browser profiles ran on
the same test computer, so this proves the public HTTPS/WSS path but not a
physical-phone, independent-network, or TURN-relay route.

## Independent-network reciprocal media acceptance

GitHub Actions run
[`30218636442`](https://github.com/whezzywee/nexus/actions/runs/30218636442)
exercised the public friend-preview origin from a GitHub-hosted Linux runner
while a separate Chromium peer remained on the operator's local network:

- the remote peer used a 390×844 Chromium viewport with deterministic fake
  microphone and camera devices;
- the local and remote peers independently hashed the invitation fragment and
  produced the same SHA-256 fingerprint, proving that both received the same
  room capability and 256-bit room key without publishing either value;
- each side received one live remote audio track and one live remote video
  track;
- the remote page ran in a secure context with
  `clientWidth = scrollWidth = 390`;
- the connection used the friend-preview STUN-only configuration, so no TURN
  relay or fake signaling/media transport could satisfy the test;
- the remote workflow retained JSON and screenshot evidence, and the local
  reciprocal screenshot is in
  `.artifacts/qa/independent-network-20260726/`.

This acceptance exposed and fixed two real signal-ordering races. Inbound
WebSocket frames were previously decrypted concurrently, and outbound ICE
frames could finish encryption in a different order from their assigned
sequence numbers. Both paths are now serialized, with forced-race regression
tests in `packages/webrtc/src/meeting-signaling.test.ts`.

## Remaining public-release evidence

- Use an operator-controlled HTTPS/WSS hostname when stable uptime is required;
  account-less Quick Tunnels remain a temporary friend-preview mechanism.
- Replace the private-pilot host passphrase with account authentication before
  allowing untrusted users to create meetings.
- Deploy TURN and pass relay-only calls only for supported networks that cannot
  establish the now-proven direct STUN route.
- Test actual iOS and Android browsers, permission denial/recovery, background
  transitions, Bluetooth routing, and network changes.
- Complete the existing independent review, soak, pilot, accessibility,
  notification, signing, and real-node propagation gates.
