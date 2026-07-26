import {
  type AuthoritySnapshot,
  acceptedMessageIds,
  type DeviceInvite,
  findNewRemoteMessages,
  type ModerationAction,
  messageNotificationCopy,
  type NexusClientRuntime,
  searchDisplayMessages,
} from "@nexus/app-runtime";
import { type PreparedAttachment, prepareAttachment } from "@nexus/attachments";
import { productBrand } from "@nexus/branding";
import {
  AuthorityControls,
  ReliabilityControls,
  resizeComposer,
  useRecoveryWorkflow,
  useReliabilityReporting,
} from "@nexus/client-react";
import type { DisplayMessage } from "@nexus/protocol";
import type { ChatSnapshot } from "@nexus/sync-engine";
import { fetchTurnCredential, MeshMediaRouter, turnIceServer } from "@nexus/webrtc";
import {
  Bell,
  Camera,
  ChevronDown,
  Compass,
  Hash,
  Home,
  Menu,
  MessageCircle,
  Mic,
  MonitorUp,
  Paperclip,
  PhoneOff,
  Search,
  Send,
  Signal,
  Users,
  WifiOff,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Message } from "./Message";
import { createWebRuntime, installWebRecovery, MODERATION_AUDIT_KEY } from "./runtime";

const emptySnapshot: ChatSnapshot = {
  messages: [],
  status: "connecting",
  queuedCount: 0,
};
function shortIdentity(identityId: string): string {
  return identityId.slice(0, 7);
}

export function App() {
  const [runtime, setRuntime] = useState<NexusClientRuntime | null>(null);
  const [runtimeState, setRuntimeState] = useState<"loading" | "ready" | "missing" | "failed">(
    "loading",
  );
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [activePeer, setActivePeer] = useState(0);
  const [snapshot, setSnapshot] = useState<ChatSnapshot>(emptySnapshot);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<PreparedAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentProgress, setAttachmentProgress] = useState<string | null>(null);
  const [attachmentTransfers, setAttachmentTransfers] = useState<Record<string, string>>({});
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [online, setOnline] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [notificationState, setNotificationState] = useState<
    "off" | "on" | "denied" | "unavailable"
  >("off");
  const messageEnd = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const uploadController = useRef<AbortController | null>(null);
  const downloadControllers = useRef(new Map<string, AbortController>());
  const searchInput = useRef<HTMLInputElement>(null);
  const knownAcceptedMessages = useRef<Set<string> | null>(null);
  const callRouter = useRef<MeshMediaRouter | null>(null);
  const [callJoined, setCallJoined] = useState(false);
  const [microphoneActive, setMicrophoneActive] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [screenActive, setScreenActive] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [callRoute, setCallRoute] = useState("Waiting for peers");
  const [mediaDevices, setMediaDevices] = useState<MediaDeviceInfo[]>([]);
  const [microphoneId, setMicrophoneId] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [authority, setAuthority] = useState<AuthoritySnapshot | null>(null);
  const [inviteDraft, setInviteDraft] = useState("");
  const [authorityBusy, setAuthorityBusy] = useState(false);
  const [authorityError, setAuthorityError] = useState<string | null>(null);
  const activeRuntimeIdentity = runtime?.identities[activePeer] ?? runtime?.identities[0];
  const reliability = useReliabilityReporting({
    surface: "web",
    endpoint: import.meta.env.VITE_NEXUS_RELIABILITY_ENDPOINT,
    connected: snapshot.status === "connected",
    storage: window.localStorage,
  });
  const recovery = useRecoveryWorkflow({
    identity: activeRuntimeIdentity,
    async install(payload, passphrase) {
      await installWebRecovery(payload, passphrase);
      window.location.reload();
    },
  });

  useEffect(() => {
    let active = true;
    void createWebRuntime()
      .then((created) => {
        if (!active) return;
        if (!created) {
          setRuntimeState("missing");
          return;
        }
        setRuntime(created);
        setRuntimeState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRuntimeError(error instanceof Error ? error.message : "Freenet runtime failed");
        setRuntimeState("failed");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!runtime) return;
    knownAcceptedMessages.current = null;
    const session = runtime.sessions[activePeer] ?? runtime.sessions[0];
    return session?.subscribe(setSnapshot);
  }, [activePeer, runtime]);

  useEffect(
    () =>
      runtime?.authority?.subscribe((next) => {
        setAuthority(next);
        window.localStorage.setItem(MODERATION_AUDIT_KEY, JSON.stringify(next.moderation));
      }),
    [runtime],
  );

  useEffect(() => {
    if (!("Notification" in window)) {
      setNotificationState("unavailable");
      return;
    }
    const saved = window.localStorage.getItem("nexus-notifications-v1") === "on";
    setNotificationState(saved && Notification.permission === "granted" ? "on" : "off");
  }, []);

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && ["f", "k"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        setSearchOpen(true);
        window.requestAnimationFrame(() => searchInput.current?.focus());
      }
      if (event.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setSearchQuery("");
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [searchOpen]);

  useEffect(() => {
    const acceptedIds = acceptedMessageIds(snapshot.messages);
    const previous = knownAcceptedMessages.current;
    knownAcceptedMessages.current = acceptedIds;
    if (
      !previous ||
      notificationState !== "on" ||
      (document.visibilityState === "visible" && document.hasFocus()) ||
      !runtime
    ) {
      return;
    }

    const ownIdentityIds = new Set(runtime.identities.map((identity) => identity.identityId));
    for (const message of findNewRemoteMessages(snapshot.messages, previous, ownIdentityIds)) {
      const author = runtime.identities.find(
        (identity) => identity.identityId === message.authorId,
      );
      const copy = messageNotificationCopy(
        message,
        author?.displayName ?? shortIdentity(message.authorId),
        "campfire",
      );
      new Notification(copy.title, { body: copy.body, tag: message.operationId });
    }
  }, [notificationState, runtime, snapshot.messages]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const names = useMemo(
    () =>
      new Map(
        runtime?.identities.map((identity) => [identity.identityId, identity.displayName]) ?? [],
      ),
    [runtime],
  );
  const visibleMessages = useMemo(() => {
    const hiddenMessageIds = new Set(authority?.moderation.hiddenMessageIds ?? []);
    return searchDisplayMessages(
      snapshot.messages,
      searchQuery,
      (authorId) => names.get(authorId) ?? shortIdentity(authorId),
    ).filter((message) => !hiddenMessageIds.has(message.messageId));
  }, [authority?.moderation.hiddenMessageIds, names, searchQuery, snapshot.messages]);

  function openSearch() {
    setSearchOpen(true);
    window.requestAnimationFrame(() => searchInput.current?.focus());
  }

  async function toggleNotifications() {
    if (notificationState === "on") {
      window.localStorage.removeItem("nexus-notifications-v1");
      setNotificationState("off");
      return;
    }
    if (!("Notification" in window)) {
      setNotificationState("unavailable");
      return;
    }
    const permission =
      Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission === "granted") {
      window.localStorage.setItem("nexus-notifications-v1", "on");
      setNotificationState("on");
    } else {
      setNotificationState("denied");
    }
  }

  async function sendDraft() {
    if (!runtime || (!draft.trim() && !attachment)) {
      return;
    }
    const selectedAttachment = attachment;
    const session = runtime.sessions[activePeer] ?? runtime.sessions[0];
    if (!session) return;
    try {
      if (selectedAttachment) {
        if (!runtime.attachments) {
          throw new Error("This transport cannot publish attachments");
        }
        const controller = new AbortController();
        uploadController.current = controller;
        await runtime.attachments.publish(selectedAttachment, session.identity, runtime.channelId, {
          signal: controller.signal,
          onProgress: (completed, total) =>
            setAttachmentProgress(`Publishing ${completed}/${total}`),
        });
      }
      const content = draft.trim() || `Attached ${selectedAttachment?.manifest.fileName ?? "file"}`;
      await session.send(content, {
        attachmentReferences: selectedAttachment ? [selectedAttachment.reference] : [],
        private: Boolean(authority?.encryptionEpoch),
      });
      setDraft("");
      setAttachment(null);
      setAttachmentError(null);
      if (composerInput.current) {
        composerInput.current.style.height = "36px";
        composerInput.current.style.overflowY = "hidden";
      }
    } catch (error) {
      setAttachmentError(
        error instanceof DOMException && error.name === "AbortError"
          ? "Transfer cancelled · press Send to resume"
          : error instanceof Error
            ? error.message
            : "Attachment publish failed",
      );
    } finally {
      uploadController.current = null;
      setAttachmentProgress(null);
    }
  }

  async function authorizeInvite() {
    const controller = runtime?.authority;
    if (!controller || !inviteDraft.trim()) return;
    setAuthorityBusy(true);
    setAuthorityError(null);
    try {
      await controller.authorizeInvite(JSON.parse(inviteDraft) as DeviceInvite);
      setInviteDraft("");
    } catch (error) {
      setAuthorityError(error instanceof Error ? error.message : "Device authorization failed");
    } finally {
      setAuthorityBusy(false);
    }
  }

  async function revokeDevice(deviceId: string) {
    const controller = runtime?.authority;
    if (!controller) return;
    setAuthorityBusy(true);
    setAuthorityError(null);
    try {
      await controller.revokeDevice(deviceId);
    } catch (error) {
      setAuthorityError(error instanceof Error ? error.message : "Device revocation failed");
    } finally {
      setAuthorityBusy(false);
    }
  }

  async function promoteAdmin(identityId: string) {
    const controller = runtime?.authority;
    if (!controller) return;
    setAuthorityBusy(true);
    setAuthorityError(null);
    try {
      await controller.setRole(identityId, "admin");
    } catch (error) {
      setAuthorityError(error instanceof Error ? error.message : "Role update failed");
    } finally {
      setAuthorityBusy(false);
    }
  }

  async function transferOwnership(identityId: string) {
    const controller = runtime?.authority;
    if (
      !controller ||
      !window.confirm(
        "Transfer community ownership? Your account will become an admin after this change.",
      )
    ) {
      return;
    }
    setAuthorityBusy(true);
    setAuthorityError(null);
    try {
      await controller.transferOwnership(identityId);
    } catch (error) {
      setAuthorityError(error instanceof Error ? error.message : "Ownership transfer failed");
    } finally {
      setAuthorityBusy(false);
    }
  }

  async function moderateMessage(action: ModerationAction, message: DisplayMessage) {
    const controller = runtime?.authority;
    if (!controller) return;
    if (
      action === "remove" &&
      !window.confirm("Remove this member and revoke all of their active devices?")
    ) {
      return;
    }
    setAuthorityBusy(true);
    setAuthorityError(null);
    try {
      await controller.moderate({
        action,
        targetIdentityId: message.authorId,
        messageId: message.messageId,
        reason:
          action === "hide"
            ? "Hidden from the local timeline"
            : action === "report"
              ? "Reported from the message menu"
              : action === "timeout"
                ? "Fifteen-minute community timeout"
                : "Removed by a community manager",
        ...(action === "timeout" ? { timeoutMinutes: 15 } : {}),
      });
    } catch (error) {
      setAuthorityError(error instanceof Error ? error.message : "Moderation action failed");
    } finally {
      setAuthorityBusy(false);
    }
  }

  async function appealLatestDecision() {
    const controller = runtime?.authority;
    const identity = runtime?.identities[activePeer] ?? runtime?.identities[0];
    if (!controller || !identity) return;
    setAuthorityBusy(true);
    setAuthorityError(null);
    try {
      await controller.moderate({
        action: "appeal",
        targetIdentityId: identity.identityId,
        reason: "Please review the latest moderation decision",
      });
    } catch (error) {
      setAuthorityError(error instanceof Error ? error.message : "Appeal could not be recorded");
    } finally {
      setAuthorityBusy(false);
    }
  }

  async function downloadAttachment(reference: string) {
    const repository = runtime?.attachments;
    if (!repository) return;
    const activeTransfer = downloadControllers.current.get(reference);
    if (activeTransfer) {
      activeTransfer.abort();
      return;
    }
    const controller = new AbortController();
    downloadControllers.current.set(reference, controller);
    try {
      setAttachmentTransfers((current) => ({ ...current, [reference]: "Downloading 0%" }));
      const resolved = await repository.fetch(reference, undefined, {
        signal: controller.signal,
        onProgress: (completed, total) => {
          const percentage = total === 0 ? 0 : Math.round((completed / total) * 100);
          setAttachmentTransfers((current) => ({
            ...current,
            [reference]: `Downloading ${percentage}% · click to cancel`,
          }));
        },
      });
      const blob = new Blob([Uint8Array.from(resolved.bytes)], {
        type: resolved.manifest.mediaType,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = resolved.manifest.fileName;
      link.click();
      URL.revokeObjectURL(url);
      setAttachmentTransfers((current) => ({ ...current, [reference]: "Saved — download again" }));
    } catch (error) {
      setAttachmentTransfers((current) => ({
        ...current,
        [reference]:
          error instanceof DOMException && error.name === "AbortError"
            ? "Cancelled · click to resume"
            : error instanceof Error
              ? `Retry: ${error.message}`
              : "Retry download",
      }));
    } finally {
      downloadControllers.current.delete(reference);
    }
  }

  async function chooseAttachment(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setAttachmentError(null);
    try {
      setAttachment(
        await prepareAttachment(
          new Uint8Array(await file.arrayBuffer()),
          file.name,
          file.type || "application/octet-stream",
        ),
      );
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Could not prepare attachment");
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void sendDraft();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendDraft();
    }
  }

  function toggleNetwork() {
    if (!runtime?.setOnline) return;
    const next = !online;
    runtime.setOnline(next);
    setOnline(next);
  }

  async function joinCall() {
    const activeRuntime = runtime;
    const identity = activeRuntime?.identities[activePeer] ?? activeRuntime?.identities[0];
    if (callJoined || !activeRuntime || !identity) return;
    const router = new MeshMediaRouter({
      onIceCandidate() {},
      onRemoteTrack() {},
      onConnectionState() {},
    });
    const turnEndpoint = import.meta.env.VITE_NEXUS_TURN_CREDENTIAL_URL as string | undefined;
    const iceServers = turnEndpoint
      ? [
          turnIceServer(
            await fetchTurnCredential(
              new URL(turnEndpoint),
              import.meta.env.VITE_NEXUS_TURN_AUTHORIZATION,
            ),
          ),
        ]
      : [];
    await router.join({
      callId: activeRuntime.channelId,
      localPeerId: identity.deviceId,
      iceServers,
    });
    callRouter.current = router;
    if (navigator.mediaDevices?.enumerateDevices) {
      setMediaDevices(await navigator.mediaDevices.enumerateDevices());
    }
    setCallJoined(true);
    setCallError(null);
  }

  async function toggleMicrophone() {
    try {
      if (!callJoined) await joinCall();
      const router = callRouter.current;
      if (!router) return;
      if (microphoneActive) {
        await router.setTrack("microphone", null);
      } else {
        await router.startMicrophone(microphoneId || undefined);
      }
      setMicrophoneActive(!microphoneActive);
      setCallError(null);
    } catch (error) {
      setCallError(error instanceof Error ? error.message : "Microphone could not start");
    }
  }

  async function toggleCamera() {
    try {
      if (!callJoined) await joinCall();
      const router = callRouter.current;
      if (!router) return;
      if (cameraActive) {
        await router.setTrack("camera", null);
      } else {
        await router.startCamera(cameraId || undefined);
      }
      setCameraActive(!cameraActive);
      setCallError(null);
    } catch (error) {
      setCallError(error instanceof Error ? error.message : "Camera could not start");
    }
  }

  async function toggleScreen() {
    try {
      if (!callJoined) await joinCall();
      const router = callRouter.current;
      if (!router) return;
      if (screenActive) {
        await router.setTrack("screen", null);
      } else {
        await router.startScreenShare();
      }
      setScreenActive(!screenActive);
      setCallError(null);
    } catch (error) {
      setCallError(error instanceof Error ? error.message : "Screen sharing could not start");
    }
  }

  async function inspectCallRoute() {
    const diagnostics = await callRouter.current?.diagnostics();
    setCallRoute(
      diagnostics?.length
        ? diagnostics.map((item) => `${item.peerId}: ${item.route}`).join(", ")
        : "Waiting for peers",
    );
  }

  async function leaveCall() {
    await callRouter.current?.leave();
    callRouter.current = null;
    setCallJoined(false);
    setMicrophoneActive(false);
    setCameraActive(false);
    setScreenActive(false);
    setCallRoute("Waiting for peers");
  }

  if (runtimeState !== "ready" || !runtime) {
    return (
      <main className="setup-screen">
        <div className="brand-mark">N</div>
        <p className="eyebrow">
          {runtimeState === "loading" ? "Connecting" : "Secure transport required"}
        </p>
        <h1>
          {runtimeState === "loading"
            ? `Starting ${productBrand.name} Web…`
            : `Connect ${productBrand.name} to a Freenet message contract.`}
        </h1>
        <p>
          {runtimeError ??
            "Run pnpm dev:phase1:web, or configure the bridge/Core URL, contract instance ID, and code hash. Vite uses the explicit simulation only when no real runtime is configured."}
        </p>
      </main>
    );
  }

  const connected = runtime.mode === "simulation" ? online : snapshot.status === "connected";
  const activeIdentity = runtime.identities[activePeer] ?? runtime.identities[0];

  return (
    <div className="web-app">
      <a className="skip-link" href="#primary-conversation">
        Skip to conversation
      </a>
      <header className="mobile-header">
        <button
          type="button"
          className="icon-button"
          aria-label="Open channels"
          onClick={() => setChannelsOpen(true)}
        >
          <Menu size={21} />
        </button>
        <div className="header-title">
          <strong># campfire</strong>
          <span>Orbit House</span>
        </div>
        <button type="button" className="icon-button" aria-label="Search" onClick={openSearch}>
          <Search size={20} />
        </button>
      </header>
      <aside className={`channel-sheet ${channelsOpen ? "channel-sheet-open" : ""}`}>
        <button
          type="button"
          className="sheet-scrim"
          aria-label="Close channels"
          onClick={() => setChannelsOpen(false)}
        />
        <div className="sheet-panel">
          <div className="community-card">
            <div className="community-orbit">O</div>
            <div>
              <strong>Orbit House</strong>
              <span>8 people online</span>
            </div>
            <ChevronDown size={18} />
          </div>
          <p className="section-label">Conversations</p>
          <button type="button" className="channel active">
            <Hash size={18} /> campfire <span>3</span>
          </button>
          <button type="button" className="channel">
            <Hash size={18} /> build-log
          </button>
          <button type="button" className="channel">
            <Hash size={18} /> weekend-plans
          </button>
          <p className="section-label">Voice rooms</p>
          <button
            type="button"
            className="channel"
            onClick={() => void (callJoined ? leaveCall() : joinCall())}
          >
            <Signal size={18} /> The observatory <small>2</small>
          </button>
          <div className="sheet-network">
            <span className={`status-dot ${connected ? "" : "offline"}`} />
            <div>
              <strong>
                {connected
                  ? runtime.mode === "freenet"
                    ? "Freenet live"
                    : "Simulation healthy"
                  : "Working offline"}
              </strong>
              <span>
                {connected
                  ? runtime.mode === "freenet"
                    ? "Core subscription active"
                    : "24 ms · simulation"
                  : "Messages will queue"}
              </span>
            </div>
          </div>
        </div>
      </aside>
      <main id="primary-conversation" className="chat-view" tabIndex={-1}>
        <section className="channel-intro">
          <div className="intro-icon">
            <Hash size={20} />
          </div>
          <div>
            <h1>Campfire</h1>
            <p>A private room for everyone in Orbit House.</p>
          </div>
          <div className="intro-actions">
            <button type="button" onClick={openSearch}>
              <Search size={16} /> Search
            </button>
            <button
              type="button"
              className={notificationState === "on" ? "selected" : ""}
              onClick={() => void toggleNotifications()}
              aria-pressed={notificationState === "on"}
            >
              <Bell size={16} />{" "}
              {notificationState === "on"
                ? "Alerts on"
                : notificationState === "denied"
                  ? "Alerts blocked"
                  : notificationState === "unavailable"
                    ? "Alerts unavailable"
                    : "Alerts"}
            </button>
          </div>
        </section>

        {searchOpen && (
          <section className="search-panel" aria-label="Search this conversation">
            <Search size={17} aria-hidden="true" />
            <input
              ref={searchInput}
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search messages or people"
              aria-label="Search messages or people"
            />
            <span aria-live="polite">
              {searchQuery.trim()
                ? `${visibleMessages.length} result${visibleMessages.length === 1 ? "" : "s"}`
                : `${snapshot.messages.length} messages`}
            </span>
            <button
              type="button"
              onClick={() => {
                setSearchOpen(false);
                setSearchQuery("");
              }}
              aria-label="Close search"
            >
              Close
            </button>
          </section>
        )}

        <div className="prototype-notice">
          <div>
            <span className={`status-dot ${connected ? "" : "offline"}`} />
            <strong>
              {connected
                ? runtime.mode === "freenet"
                  ? "Freenet contract connected"
                  : "Two-peer simulation connected"
                : "Offline queue active"}
            </strong>
          </div>
          {runtime.mode === "simulation" && (
            <button type="button" onClick={toggleNetwork}>
              {online ? "Test offline" : "Reconnect"}
            </button>
          )}
        </div>

        <details className="reliability-panel">
          <ReliabilityControls state={reliability} />
        </details>

        {authority && (
          <details className="authority-panel">
            <summary>
              Private epoch {authority.encryptionEpoch ?? "locked"} · community{" "}
              {authority.community.epoch}
            </summary>
            <AuthorityControls
              authority={authority}
              activeIdentityId={activeIdentity?.identityId}
              inviteDraft={inviteDraft}
              busy={authorityBusy}
              error={authorityError}
              recovery={recovery}
              setInviteDraft={setInviteDraft}
              authorizeInvite={() => void authorizeInvite()}
              promoteAdmin={(identityId) => void promoteAdmin(identityId)}
              transferOwnership={(identityId) => void transferOwnership(identityId)}
              revokeDevice={(deviceId) => void revokeDevice(deviceId)}
              appealLatestDecision={() => void appealLatestDecision()}
            />
          </details>
        )}

        <section className="messages" aria-live="polite">
          <div className="day-divider">
            <span>Today</span>
          </div>
          {visibleMessages.map((message) => (
            <Message
              key={`${message.operationId}:${message.deliveryState}`}
              message={message}
              names={names}
              onDownload={(reference) => void downloadAttachment(reference)}
              onModerate={
                runtime.authority
                  ? (action, selectedMessage) => void moderateMessage(action, selectedMessage)
                  : undefined
              }
              canManage={
                Boolean(authority?.canManage) && message.authorId !== activeIdentity?.identityId
              }
              transferLabels={attachmentTransfers}
            />
          ))}
          {searchQuery.trim() && visibleMessages.length === 0 && (
            <p className="empty-search">No messages match “{searchQuery.trim()}”.</p>
          )}
          <div ref={messageEnd} />
        </section>

        <section className="call-dock" aria-label="Voice call controls">
          <div aria-live="polite">
            <strong>{callJoined ? "In The observatory" : "Voice disconnected"}</strong>
            <span>{callError ?? callRoute}</span>
          </div>
          <button
            type="button"
            className={microphoneActive ? "active" : ""}
            onClick={() => void toggleMicrophone()}
            aria-pressed={microphoneActive}
            aria-label="Toggle microphone"
          >
            <Mic size={16} />
          </button>
          <button
            type="button"
            className={cameraActive ? "active" : ""}
            onClick={() => void toggleCamera()}
            aria-pressed={cameraActive}
            aria-label="Toggle camera"
          >
            <Camera size={16} />
          </button>
          <button
            type="button"
            className={screenActive ? "active" : ""}
            onClick={() => void toggleScreen()}
            aria-pressed={screenActive}
            aria-label="Toggle screen share"
          >
            <MonitorUp size={16} />
          </button>
          <select
            aria-label="Microphone device"
            value={microphoneId}
            onChange={(event) => setMicrophoneId(event.target.value)}
          >
            <option value="">Default mic</option>
            {mediaDevices
              .filter((device) => device.kind === "audioinput")
              .map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${index + 1}`}
                </option>
              ))}
          </select>
          <select
            aria-label="Camera device"
            value={cameraId}
            onChange={(event) => setCameraId(event.target.value)}
          >
            <option value="">Default camera</option>
            {mediaDevices
              .filter((device) => device.kind === "videoinput")
              .map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${index + 1}`}
                </option>
              ))}
          </select>
          <button type="button" onClick={() => void inspectCallRoute()}>
            Route
          </button>
          <button
            type="button"
            className="leave"
            onClick={() => void (callJoined ? leaveCall() : joinCall())}
          >
            {callJoined ? <PhoneOff size={16} /> : <Signal size={16} />}
            {callJoined ? "Leave" : "Join"}
          </button>
        </section>

        <form className="composer" onSubmit={submit}>
          {(attachment || attachmentError) && (
            <div className={`attachment-pill ${attachmentError ? "attachment-error" : ""}`}>
              <Paperclip size={13} />
              <span>{attachmentError ?? attachmentProgress ?? attachment?.manifest.fileName}</span>
              <button
                type="button"
                onClick={() => {
                  if (uploadController.current) {
                    uploadController.current.abort();
                  } else {
                    setAttachment(null);
                    setAttachmentError(null);
                  }
                }}
                aria-label={attachmentProgress ? "Cancel attachment transfer" : "Remove attachment"}
              >
                ×
              </button>
            </div>
          )}
          <input
            ref={attachmentInput}
            className="file-input"
            type="file"
            onChange={(event) => void chooseAttachment(event)}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Attach a file"
            onClick={() => attachmentInput.current?.click()}
          >
            <Paperclip size={20} />
          </button>
          <label>
            <span className="sr-only">Message campfire</span>
            <textarea
              ref={composerInput}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                resizeComposer(event.currentTarget, 104);
              }}
              onKeyDown={handleComposerKeyDown}
              placeholder={`Message as ${activeIdentity?.displayName ?? "…"}`}
              rows={1}
              maxLength={8000}
            />
          </label>
          <button
            type="submit"
            className="send-button"
            aria-label="Send message"
            disabled={!draft.trim() && !attachment}
          >
            <Send size={18} />
          </button>
        </form>

        <fieldset className="peer-switcher">
          <legend>Writing as</legend>
          {runtime.identities.map((identity, index) => (
            <button
              type="button"
              key={identity.identityId}
              className={activePeer === index ? "selected" : ""}
              onClick={() => setActivePeer(index)}
            >
              {identity.displayName}
            </button>
          ))}
        </fieldset>
      </main>
      <nav className="bottom-nav" aria-label="Primary">
        <button type="button" className="active">
          <Home size={21} />
          <span>Home</span>
        </button>
        <button type="button">
          <Compass size={21} />
          <span>Explore</span>
        </button>
        <button type="button">
          <MessageCircle size={21} />
          <span>Chats</span>
        </button>
        <button
          type="button"
          className={notificationState === "on" ? "active" : ""}
          onClick={() => void toggleNotifications()}
          aria-pressed={notificationState === "on"}
        >
          <Bell size={21} />
          <span>
            {notificationState === "on"
              ? "Alerts on"
              : notificationState === "denied"
                ? "Blocked"
                : notificationState === "unavailable"
                  ? "Unavailable"
                  : "Alerts"}
          </span>
        </button>
        <button type="button">
          <Users size={21} />
          <span>You</span>
        </button>
      </nav>
      {!connected && (
        <div className="offline-banner">
          <WifiOff size={15} /> Offline · {snapshot.queuedCount} queued
        </div>
      )}
    </div>
  );
}
