import { type LocalIdentity, signDevicePayload, verifyDevicePayload } from "@nexus/identity";
import { concatBytes, type DeviceCertificate } from "@nexus/protocol";

export {
  buildMeetingUrl,
  createMeetingHostSession,
  createMeetingInvite,
  MEETING_FRAGMENT_KEY,
  MEETING_LINK_VERSION,
  type MeetingHostSession,
  type MeetingInvite,
  parseMeetingUrl,
  validateMeetingInvite,
} from "./meeting-links";
export {
  importRoomKey,
  type MeetingSignal,
  MeetingSignalingClient,
  type MeetingSignalingEvents,
  type MeetingSignalingOptions,
  meetingWebSocketUrl,
} from "./meeting-signaling";

export type MediaSlot = "microphone" | "camera" | "screen";

export interface CallSession {
  callId: string;
  localPeerId: string;
  iceServers: RTCIceServer[];
}

export interface PeerDescriptor {
  peerId: string;
}

export interface IceSignal {
  peerId: string;
  candidate: RTCIceCandidateInit;
}

export interface MediaRouteDiagnostics {
  peerId: string;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  signalingState: RTCSignalingState;
  route: "unknown" | "direct" | "relayed";
}

export interface TurnCredential {
  urls: string[];
  username: string;
  credential: string;
  expiresAt: number;
}

export async function fetchTurnCredential(
  endpoint: URL,
  authorization?: string,
  now = Date.now(),
): Promise<TurnCredential> {
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname))
  ) {
    throw new Error("TURN credential endpoint must use HTTPS or loopback HTTP");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: authorization ? { authorization } : undefined,
  });
  if (!response.ok) {
    throw new Error(`TURN credential request failed (${response.status})`);
  }
  const credential = (await response.json()) as TurnCredential;
  if (
    !Array.isArray(credential.urls) ||
    credential.urls.length === 0 ||
    credential.urls.some(
      (url) => typeof url !== "string" || (!url.startsWith("turn:") && !url.startsWith("turns:")),
    ) ||
    !credential.username ||
    !credential.credential ||
    !Number.isSafeInteger(credential.expiresAt) ||
    credential.expiresAt <= now + 30_000 ||
    credential.expiresAt > now + 60 * 60_000
  ) {
    throw new Error("TURN credential response is invalid or not short-lived");
  }
  return credential;
}

export function turnIceServer(credential: TurnCredential): RTCIceServer {
  return {
    urls: credential.urls,
    username: credential.username,
    credential: credential.credential,
  };
}

export function stunIceServer(rawUrls?: string): RTCIceServer | null {
  const urls = (rawUrls ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (urls.length === 0) return null;
  if (
    urls.length > 8 ||
    urls.some((url) => url.length > 512 || (!url.startsWith("stun:") && !url.startsWith("stuns:")))
  ) {
    throw new Error("STUN configuration must contain 1–8 bounded stun: or stuns: URLs");
  }
  return { urls };
}

export interface MediaRouterEvents {
  onIceCandidate(signal: IceSignal): void;
  onRemoteTrack(peerId: string, event: RTCTrackEvent): void;
  onConnectionState(peerId: string, state: RTCPeerConnectionState): void;
  onNegotiationNeeded?(peerId: string): void;
}

export type CallSignalType = "offer" | "answer" | "ice" | "leave";

export interface UnsignedCallSignalEnvelope {
  version: 2;
  signalId: string;
  callId: string;
  callEpoch: number;
  senderIdentityId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  sequence: number;
  expiresAt: number;
  type: CallSignalType;
  ciphertext: string;
}

export interface CallSignalEnvelope extends UnsignedCallSignalEnvelope {
  publicKey: string;
  deviceCertificate: DeviceCertificate;
  signature: string;
}

export async function signCallSignalEnvelope(
  identity: LocalIdentity,
  envelope: UnsignedCallSignalEnvelope,
): Promise<CallSignalEnvelope> {
  if (
    envelope.senderIdentityId !== identity.identityId ||
    envelope.senderDeviceId !== identity.deviceId ||
    envelope.sequence < 1
  ) {
    throw new Error("Call signal sender does not match the signing identity");
  }
  const deviceSignature = await signDevicePayload(
    identity,
    canonicalCallSignalBytes(envelope),
    envelope.senderIdentityId,
    envelope.senderDeviceId,
  );
  return {
    ...envelope,
    ...deviceSignature,
  };
}

export async function verifyCallSignalEnvelope(envelope: CallSignalEnvelope): Promise<boolean> {
  try {
    const { publicKey, deviceCertificate, signature, ...unsigned } = envelope;
    return verifyDevicePayload(
      { publicKey, deviceCertificate, signature },
      canonicalCallSignalBytes(unsigned),
      envelope.senderIdentityId,
      envelope.senderDeviceId,
    );
  } catch {
    return false;
  }
}

export class CallSignalInbox {
  private readonly senderSequences = new Map<string, number>();

  constructor(
    private readonly callId: string,
    private readonly callEpoch: number,
    private readonly recipientDeviceId: string,
  ) {}

  async accept(envelope: CallSignalEnvelope, now = Date.now()): Promise<void> {
    if (!(await verifyCallSignalEnvelope(envelope))) {
      throw new Error("Call signal signature is invalid");
    }
    if (
      envelope.callId !== this.callId ||
      envelope.callEpoch !== this.callEpoch ||
      envelope.recipientDeviceId !== this.recipientDeviceId
    ) {
      throw new Error("Call signal is outside this recipient session");
    }
    if (envelope.expiresAt <= now || envelope.expiresAt > now + 5 * 60_000) {
      throw new Error("Call signal expiry is invalid");
    }
    const key = `${envelope.senderIdentityId}:${envelope.senderDeviceId}`;
    if (envelope.sequence <= (this.senderSequences.get(key) ?? 0)) {
      throw new Error("Call signal was replayed or reordered");
    }
    this.senderSequences.set(key, envelope.sequence);
  }
}

function canonicalCallSignalBytes(envelope: UnsignedCallSignalEnvelope): Uint8Array {
  const encoder = new TextEncoder();
  const fields = [
    "nexus:call-signal:v2",
    envelope.signalId,
    envelope.callId,
    envelope.callEpoch.toString(),
    envelope.senderIdentityId,
    envelope.senderDeviceId,
    envelope.recipientDeviceId,
    envelope.sequence.toString(),
    envelope.expiresAt.toString(),
    envelope.type,
    envelope.ciphertext,
  ];
  return concatBytes(
    fields.map((value) => {
      const bytes = encoder.encode(value);
      const framed = new Uint8Array(4 + bytes.byteLength);
      new DataView(framed.buffer).setUint32(0, bytes.byteLength, false);
      framed.set(bytes, 4);
      return framed;
    }),
  );
}

export interface MediaRouter {
  join(session: CallSession): Promise<void>;
  addParticipant(peer: PeerDescriptor): Promise<void>;
  removeParticipant(peerId: string): Promise<void>;
  createOffer(peerId: string): Promise<RTCSessionDescriptionInit>;
  receiveDescription(peerId: string, description: RTCSessionDescriptionInit): Promise<void>;
  receiveIceCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void>;
  setTrack(slot: MediaSlot, track: MediaStreamTrack | null): Promise<void>;
  leave(): Promise<void>;
  diagnostics(): Promise<MediaRouteDiagnostics[]>;
}

interface PeerState {
  connection: RTCPeerConnection;
  senders: Map<MediaSlot, RTCRtpSender>;
  controlChannel?: RTCDataChannel;
}

export class MeshMediaRouter implements MediaRouter {
  private session: CallSession | null = null;
  private readonly peers = new Map<string, PeerState>();
  private readonly tracks = new Map<MediaSlot, MediaStreamTrack>();

  constructor(private readonly events: MediaRouterEvents) {}

  async join(session: CallSession): Promise<void> {
    if (this.session) {
      throw new Error("The media router has already joined a call");
    }
    this.session = session;
  }

  async addParticipant(peer: PeerDescriptor): Promise<void> {
    const session = this.requireSession();
    if (peer.peerId === session.localPeerId) {
      throw new Error("A mesh participant cannot connect to itself");
    }
    if (this.peers.has(peer.peerId)) {
      return;
    }
    const connection = new RTCPeerConnection({ iceServers: session.iceServers });
    const state: PeerState = { connection, senders: new Map() };
    connection.onnegotiationneeded = () => this.events.onNegotiationNeeded?.(peer.peerId);
    if (session.localPeerId.localeCompare(peer.peerId) < 0) {
      state.controlChannel = connection.createDataChannel("nexus-control", {
        ordered: true,
      });
    }
    connection.ondatachannel = (event) => {
      state.controlChannel = event.channel;
    };
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.events.onIceCandidate({
          peerId: peer.peerId,
          candidate: event.candidate.toJSON(),
        });
      }
    };
    connection.ontrack = (event) => this.events.onRemoteTrack(peer.peerId, event);
    connection.onconnectionstatechange = () =>
      this.events.onConnectionState(peer.peerId, connection.connectionState);
    for (const [slot, track] of this.tracks) {
      state.senders.set(slot, connection.addTrack(track));
    }
    this.peers.set(peer.peerId, state);
  }

  async removeParticipant(peerId: string): Promise<void> {
    const state = this.peers.get(peerId);
    if (!state) return;
    state.connection.close();
    this.peers.delete(peerId);
  }

  async createOffer(peerId: string): Promise<RTCSessionDescriptionInit> {
    const connection = this.requirePeer(peerId).connection;
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    return offer;
  }

  async receiveDescription(peerId: string, description: RTCSessionDescriptionInit): Promise<void> {
    const connection = this.requirePeer(peerId).connection;
    await connection.setRemoteDescription(description);
    if (description.type === "offer") {
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
    }
  }

  localDescription(peerId: string): RTCSessionDescriptionInit | null {
    return this.requirePeer(peerId).connection.localDescription?.toJSON() ?? null;
  }

  async receiveIceCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    await this.requirePeer(peerId).connection.addIceCandidate(candidate);
  }

  async setTrack(slot: MediaSlot, track: MediaStreamTrack | null): Promise<void> {
    const previous = this.tracks.get(slot);
    if (previous && previous !== track) {
      previous.stop();
    }
    if (track) {
      this.tracks.set(slot, track);
    } else {
      this.tracks.delete(slot);
    }
    for (const state of this.peers.values()) {
      const sender = state.senders.get(slot);
      if (sender) {
        await sender.replaceTrack(track);
      } else if (track) {
        state.senders.set(slot, state.connection.addTrack(track));
      }
    }
  }

  async startMicrophone(deviceId?: string): Promise<MediaStreamTrack> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
    const track = stream.getAudioTracks()[0];
    if (!track) {
      throw new Error("No microphone track was provided");
    }
    await this.setTrack("microphone", track);
    return track;
  }

  async startCamera(deviceId?: string): Promise<MediaStreamTrack> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      throw new Error("No camera track was provided");
    }
    await this.setTrack("camera", track);
    return track;
  }

  async startScreenShare(): Promise<MediaStreamTrack> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      throw new Error("No screen track was provided");
    }
    track.addEventListener("ended", () => {
      void this.setTrack("screen", null);
    });
    await this.setTrack("screen", track);
    return track;
  }

  meshSizeWarning(): string | null {
    const participantCount = this.peers.size + 1;
    return participantCount > 6
      ? `This ${participantCount}-person room exceeds the recommended mesh size of six.`
      : null;
  }

  async diagnostics(): Promise<MediaRouteDiagnostics[]> {
    const diagnostics: MediaRouteDiagnostics[] = [];
    for (const [peerId, state] of this.peers) {
      const stats = await state.connection.getStats();
      let route: MediaRouteDiagnostics["route"] = "unknown";
      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
          const local = stats.get(report.localCandidateId);
          const remote = stats.get(report.remoteCandidateId);
          route =
            local?.candidateType === "relay" || remote?.candidateType === "relay"
              ? "relayed"
              : "direct";
        }
      });
      diagnostics.push({
        peerId,
        connectionState: state.connection.connectionState,
        iceConnectionState: state.connection.iceConnectionState,
        signalingState: state.connection.signalingState,
        route,
      });
    }
    return diagnostics;
  }

  async leave(): Promise<void> {
    for (const track of this.tracks.values()) {
      track.stop();
    }
    this.tracks.clear();
    for (const state of this.peers.values()) {
      state.connection.close();
    }
    this.peers.clear();
    this.session = null;
  }

  private requireSession(): CallSession {
    if (!this.session) {
      throw new Error("Join a call before adding participants");
    }
    return this.session;
  }

  private requirePeer(peerId: string): PeerState {
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new Error(`Unknown mesh peer: ${peerId}`);
    }
    return peer;
  }
}
