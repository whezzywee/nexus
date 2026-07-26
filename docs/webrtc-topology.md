# WebRTC topology

## MVP

Nexus uses a full peer-to-peer mesh for one-to-one and small-room calls. A room
warns at more than six participants. The UI never describes mesh as suitable
for large rooms.

```text
Freenet voice-session contract
  └─ encrypted offer/answer/ICE envelopes
       ├─ peer A <==== WebRTC media ====> peer B
       ├─ peer A <==== WebRTC media ====> peer C
       └─ peer B <==== WebRTC media ====> peer C
```

Freenet carries only short-lived coordination. `RTCPeerConnection` carries
voice, video, and screen media.

## Media router boundary

```ts
interface MediaRouter {
  join(session: CallSession): Promise<void>;
  addParticipant(peer: PeerDescriptor): Promise<void>;
  setMicrophone(track: MediaStreamTrack | null): Promise<void>;
  setCamera(track: MediaStreamTrack | null): Promise<void>;
  setScreen(track: MediaStreamTrack | null): Promise<void>;
  leave(): Promise<void>;
  diagnostics(): MediaRouteDiagnostics;
}
```

`MeshMediaRouter` is the MVP implementation. A future SFU adapter implements
the same interface without changing call pages or device controls.

## Media behavior

- `getUserMedia` requests only the selected microphone/camera.
- `getDisplayMedia` starts only from an explicit user action.
- Screen capture stops when the track ends or the user leaves.
- Echo cancellation, noise suppression, and automatic gain control default on.
- Push-to-talk is an application state layered over the local audio track.
- Output-device selection is feature-detected because browser support varies.
- System audio is offered only when the OS/browser capture surface supports it.
- Reduced-motion applies to activity indicators and call transitions.

## Signaling security

Every signaling envelope is encrypted to the recipient device key and signed by
the sender device. Associated data binds call ID, sender, recipient, sequence,
expiry, and envelope type. Clients reject:

- bad signatures or recipients;
- expired offers, answers, and candidates;
- repeated or decreasing sender sequences;
- envelopes for a closed/replaced call epoch.

Presence and signaling leak metadata even when their bodies are encrypted.

## STUN and TURN

Configuration supports multiple STUN and TURN URLs. Production TURN credentials
are short-lived and scoped. The diagnostics view reports:

- candidate pair type;
- direct, server-reflexive, or TURN-relayed route;
- ICE and connection state;
- round-trip time, loss, and selected codec;
- TURN health without exposing credentials.

TURN relays encrypted WebRTC packets and incurs infrastructure/bandwidth cost.
It is not an authoritative social database. WebRTC can reveal IP addresses to
call peers; using TURN-only mode reduces peer IP exposure at added cost.

The production Coturn baseline, gateway credential endpoint, secret rotation,
monitoring, and external relay acceptance procedure are documented in
[Production TURN operations](turn-operations.md).
