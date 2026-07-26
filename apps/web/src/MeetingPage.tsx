import {
  buildMeetingUrl,
  createMeetingHostSession,
  createMeetingInvite,
  fetchTurnCredential,
  type MeetingHostSession,
  type MeetingInvite,
  type MeetingSignal,
  MeetingSignalingClient,
  MeshMediaRouter,
  parseMeetingUrl,
  stunIceServer,
  turnIceServer,
} from "@nexus/webrtc";
import { Camera, Link, Mic, PhoneOff, Share2, Signal, Users } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function shortParticipant(participantId: string): string {
  return participantId.slice(-6);
}

function configuredEndpoint(value: string): URL {
  return new URL(value, window.location.href);
}

function initialInvite(): { invite: MeetingInvite | null; error: string | null } {
  try {
    return { invite: parseMeetingUrl(new URL(window.location.href)), error: null };
  } catch (error) {
    return {
      invite: null,
      error: error instanceof Error ? error.message : "This meeting link could not be opened.",
    };
  }
}

export function MeetingPage() {
  const parsed = useRef(initialInvite());
  const [invite, setInvite] = useState<MeetingInvite | null>(parsed.current.invite);
  const [error, setError] = useState<string | null>(parsed.current.error);
  const [status, setStatus] = useState(
    parsed.current.invite ? `Ready for ${parsed.current.invite.roomName}` : "Create a private link",
  );
  const [hostAccessOpen, setHostAccessOpen] = useState(false);
  const [hostPassphrase, setHostPassphrase] = useState("");
  const [hostBusy, setHostBusy] = useState(false);
  const hostSession = useRef<MeetingHostSession | null>(null);
  const roomId = useRef(randomId("room"));
  const participantId = useRef(randomId("phone"));
  const routerRef = useRef<MeshMediaRouter | null>(null);
  const signalingRef = useRef<MeetingSignalingClient | null>(null);
  const pendingIce = useRef(new Map<string, RTCIceCandidateInit[]>());
  const remoteDescriptions = useRef(new Set<string>());
  const [joined, setJoined] = useState(false);
  const [microphoneActive, setMicrophoneActive] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [participants, setParticipants] = useState<string[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});

  useEffect(
    () => () => {
      signalingRef.current?.leave();
      void routerRef.current?.leave();
    },
    [],
  );

  useEffect(() => {
    function readMeetingLink() {
      const next = initialInvite();
      setInvite(next.invite);
      setError(next.error);
      if (next.invite) setStatus(`Ready for ${next.invite.roomName}`);
    }
    window.addEventListener("hashchange", readMeetingLink);
    return () => window.removeEventListener("hashchange", readMeetingLink);
  }, []);

  function configuredHostAuthorization(): string {
    const configured = (import.meta.env.VITE_NEXUS_MEETING_HOST_AUTHORIZATION || "").trim();
    if (configured) return configured;
    const current = hostSession.current;
    if (current && current.expiresAt > Date.now() + 30_000) return current.authorization;
    hostSession.current = null;
    return "";
  }

  async function ensureInvite(authorization = configuredHostAuthorization()) {
    if (invite) return invite;
    const endpoint = import.meta.env.VITE_NEXUS_MEETING_INVITE_URL as string | undefined;
    if (!endpoint) throw new Error("Meeting invitations are not configured.");
    const created = await createMeetingInvite(configuredEndpoint(endpoint), authorization, {
      roomId: roomId.current,
      roomName: "Friends meeting",
    });
    setInvite(created);
    setStatus(`Ready for ${created.roomName}`);
    return created;
  }

  async function shareMeeting() {
    const sessionEndpoint = import.meta.env.VITE_NEXUS_MEETING_HOST_SESSION_URL as
      | string
      | undefined;
    if (!invite && !configuredHostAuthorization() && sessionEndpoint) {
      setHostAccessOpen(true);
      setError(null);
      setStatus("Enter your private host passphrase first.");
      return;
    }
    try {
      const activeInvite = await ensureInvite();
      const appUrl =
        (import.meta.env.VITE_NEXUS_WEB_APP_URL as string | undefined) ?? window.location.href;
      const link = buildMeetingUrl(new URL(appUrl), activeInvite);
      if (navigator.share) {
        await navigator.share({
          title: activeInvite.roomName,
          text: "Join my private Nexus meeting",
          url: link.toString(),
        });
        setStatus("Meeting link shared.");
      } else {
        await navigator.clipboard.writeText(link.toString());
        setStatus("Meeting link copied.");
      }
      setError(null);
    } catch (nextError) {
      if (nextError instanceof DOMException && nextError.name === "AbortError") return;
      setError(nextError instanceof Error ? nextError.message : "The link could not be shared.");
    }
  }

  async function unlockHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const endpoint = import.meta.env.VITE_NEXUS_MEETING_HOST_SESSION_URL as string | undefined;
    if (!endpoint || hostBusy) return;
    setHostBusy(true);
    try {
      const session = await createMeetingHostSession(configuredEndpoint(endpoint), hostPassphrase);
      hostSession.current = session;
      setHostPassphrase("");
      await ensureInvite(session.authorization);
      setHostAccessOpen(false);
      setError(null);
      setStatus("Host access unlocked. Tap Share link.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Host access failed.");
    } finally {
      setHostBusy(false);
    }
  }

  async function joinMeeting() {
    if (joined || !invite) return;
    try {
      let router: MeshMediaRouter;
      router = new MeshMediaRouter({
        onIceCandidate(signal) {
          void signalingRef.current
            ?.sendSignal(signal.peerId, { type: "ice", candidate: signal.candidate })
            .catch((nextError: unknown) => {
              setError(nextError instanceof Error ? nextError.message : "ICE signaling failed.");
            });
        },
        onRemoteTrack(peerId, event) {
          setRemoteStreams((current) => {
            const stream = new MediaStream(current[peerId]?.getTracks() ?? []);
            if (!stream.getTracks().some((track) => track.id === event.track.id)) {
              stream.addTrack(event.track);
            }
            return { ...current, [peerId]: stream };
          });
        },
        onConnectionState(peerId, state) {
          setStatus(`${shortParticipant(peerId)} · ${state}`);
        },
        onNegotiationNeeded(peerId) {
          void router
            .createOffer(peerId)
            .then((description) =>
              signalingRef.current?.sendSignal(peerId, { type: "offer", description }),
            )
            .catch((nextError: unknown) => {
              setError(nextError instanceof Error ? nextError.message : "Negotiation failed.");
            });
        },
      });
      const iceServers: RTCIceServer[] = [];
      const stun = stunIceServer(import.meta.env.VITE_NEXUS_STUN_URLS as string | undefined);
      if (stun) iceServers.push(stun);
      const turnEndpoint = import.meta.env.VITE_NEXUS_TURN_CREDENTIAL_URL as string | undefined;
      if (turnEndpoint) {
        iceServers.push(
          turnIceServer(
            await fetchTurnCredential(
              configuredEndpoint(turnEndpoint),
              `Bearer ${invite.accessToken}`,
            ),
          ),
        );
      }
      await router.join({
        callId: invite.roomId,
        localPeerId: participantId.current,
        iceServers,
      });
      routerRef.current = router;
      let signaling: MeetingSignalingClient;
      const signalingEndpoint = import.meta.env.VITE_NEXUS_MEETING_SIGNAL_URL as string | undefined;
      if (!signalingEndpoint) throw new Error("Meeting signaling is not configured.");
      signaling = new MeetingSignalingClient({
        endpoint: configuredEndpoint(signalingEndpoint),
        invite,
        participantId: participantId.current,
        events: {
          onReady(existing) {
            setParticipants([participantId.current, ...existing]);
            for (const peerId of existing) void router.addParticipant({ peerId });
          },
          onParticipantJoined(peerId) {
            setParticipants((current) => [...new Set([...current, peerId])]);
            void router.addParticipant({ peerId });
          },
          onParticipantLeft(peerId) {
            setParticipants((current) => current.filter((id) => id !== peerId));
            setRemoteStreams((current) => {
              const next = { ...current };
              delete next[peerId];
              return next;
            });
            remoteDescriptions.current.delete(peerId);
            pendingIce.current.delete(peerId);
            void router.removeParticipant(peerId);
          },
          onSignal(from, signal) {
            void receiveSignal(router, signaling, from, signal);
          },
          onError(message) {
            setError(message);
          },
          onDisconnected() {
            setError("Meeting disconnected. Leave and rejoin.");
          },
        },
      });
      signalingRef.current = signaling;
      await signaling.connect();
      setJoined(true);
      setError(null);
      setStatus("Connected · media is off");
    } catch (nextError) {
      signalingRef.current?.leave();
      signalingRef.current = null;
      await routerRef.current?.leave();
      routerRef.current = null;
      setError(nextError instanceof Error ? nextError.message : "Could not join the meeting.");
    }
  }

  async function receiveSignal(
    router: MeshMediaRouter,
    signaling: MeetingSignalingClient,
    from: string,
    signal: MeetingSignal,
  ) {
    try {
      await router.addParticipant({ peerId: from });
      if (signal.type === "ice") {
        if (!remoteDescriptions.current.has(from)) {
          const pending = pendingIce.current.get(from) ?? [];
          pending.push(signal.candidate);
          pendingIce.current.set(from, pending);
          return;
        }
        await router.receiveIceCandidate(from, signal.candidate);
        return;
      }
      if (signal.type === "leave") {
        await router.removeParticipant(from);
        return;
      }
      await router.receiveDescription(from, signal.description);
      remoteDescriptions.current.add(from);
      for (const candidate of pendingIce.current.get(from) ?? []) {
        await router.receiveIceCandidate(from, candidate);
      }
      pendingIce.current.delete(from);
      if (signal.type === "offer") {
        const answer = router.localDescription(from);
        if (!answer) throw new Error("The call answer could not be created.");
        await signaling.sendSignal(from, { type: "answer", description: answer });
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Meeting signaling failed.");
    }
  }

  async function toggleMicrophone() {
    try {
      if (!joined) await joinMeeting();
      const router = routerRef.current;
      if (!router) return;
      if (microphoneActive) await router.setTrack("microphone", null);
      else await router.startMicrophone();
      setMicrophoneActive(!microphoneActive);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Microphone could not start.");
    }
  }

  async function toggleCamera() {
    try {
      if (!joined) await joinMeeting();
      const router = routerRef.current;
      if (!router) return;
      if (cameraActive) await router.setTrack("camera", null);
      else await router.startCamera();
      setCameraActive(!cameraActive);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Camera could not start.");
    }
  }

  async function leaveMeeting() {
    signalingRef.current?.leave();
    signalingRef.current = null;
    await routerRef.current?.leave();
    routerRef.current = null;
    pendingIce.current.clear();
    remoteDescriptions.current.clear();
    setJoined(false);
    setMicrophoneActive(false);
    setCameraActive(false);
    setParticipants([]);
    setRemoteStreams({});
    setStatus(`Ready for ${invite?.roomName ?? "the meeting"}`);
  }

  return (
    <main className="meeting-page">
      <header>
        <div className="meeting-page-mark">N</div>
        <div>
          <span>Private phone meeting</span>
          <h1>{invite?.roomName ?? "Start a meeting"}</h1>
        </div>
        <button type="button" onClick={() => void shareMeeting()}>
          <Share2 size={17} /> Share link
        </button>
      </header>

      <section className="meeting-page-status" aria-live="polite">
        <Link size={18} aria-hidden="true" />
        <div>
          <strong>{status}</strong>
          <span>
            {error ??
              (invite
                ? `Link expires ${new Date(invite.expiresAt).toLocaleString()}`
                : "Only people with your link can enter. Up to six participants.")}
          </span>
        </div>
      </section>

      {hostAccessOpen && (
        <form className="meeting-page-host" onSubmit={(event) => void unlockHost(event)}>
          <label htmlFor="meeting-page-host-secret">Private host passphrase</label>
          <div>
            <input
              id="meeting-page-host-secret"
              type="password"
              autoComplete="current-password"
              minLength={32}
              maxLength={256}
              value={hostPassphrase}
              onChange={(event) => setHostPassphrase(event.target.value)}
              required
            />
            <button type="submit" disabled={hostBusy}>
              {hostBusy ? "Unlocking…" : "Unlock"}
            </button>
          </div>
          <span>The passphrase stays in this tab and never appears in the shared link.</span>
        </form>
      )}

      <section className="meeting-page-stage" aria-label="Meeting participants">
        {Object.entries(remoteStreams).map(([peerId, stream]) => (
          <div className="meeting-page-tile" key={peerId}>
            {/* biome-ignore lint/a11y/useMediaCaption: live WebRTC stream */}
            <video
              ref={(element) => {
                if (element && element.srcObject !== stream) element.srcObject = stream;
              }}
              autoPlay
              playsInline
              aria-label={`Remote participant ${shortParticipant(peerId)}`}
            />
            <span>{shortParticipant(peerId)}</span>
          </div>
        ))}
        {Object.keys(remoteStreams).length === 0 && (
          <div className="meeting-page-empty">
            <Users size={30} aria-hidden="true" />
            <strong>
              {joined ? "Waiting for friends…" : invite ? "Ready to join" : "Create a link"}
            </strong>
            <span>
              {joined
                ? `${participants.length} of 6 participants`
                : invite
                  ? "Your microphone and camera start off."
                  : "Unlock hosting, then share the link."}
            </span>
          </div>
        )}
      </section>

      <section className="meeting-page-controls" aria-label="Meeting controls">
        <button
          type="button"
          className={microphoneActive ? "active" : ""}
          onClick={() => void toggleMicrophone()}
          disabled={!invite}
          aria-pressed={microphoneActive}
        >
          <Mic size={18} /> {microphoneActive ? "Mute" : "Mic"}
        </button>
        <button
          type="button"
          className={cameraActive ? "active" : ""}
          onClick={() => void toggleCamera()}
          disabled={!invite}
          aria-pressed={cameraActive}
        >
          <Camera size={18} /> {cameraActive ? "Stop video" : "Camera"}
        </button>
        <button
          type="button"
          className={joined ? "leave" : "join"}
          onClick={() => void (joined ? leaveMeeting() : joinMeeting())}
          disabled={!invite}
        >
          {joined ? <PhoneOff size={18} /> : <Signal size={18} />}
          {joined ? "Leave" : "Join"}
        </button>
      </section>
    </main>
  );
}
