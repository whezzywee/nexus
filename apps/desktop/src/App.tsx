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
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  Bell,
  Camera,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Download,
  Gauge,
  Hash,
  Headphones,
  Inbox,
  Menu,
  Mic,
  MonitorUp,
  Paperclip,
  PhoneOff,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Signal,
  SlidersHorizontal,
  UserPlus,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Message } from "./Message";
import {
  notificationPermissionGranted,
  requestNotificationAccess,
  sendDesktopNotification,
} from "./notifications";
import {
  createDesktopRuntime,
  installDesktopRecovery,
  isTauri,
  MODERATION_AUDIT_KEY,
} from "./runtime";

const emptySnapshot: ChatSnapshot = {
  messages: [],
  status: "connecting",
  queuedCount: 0,
};
type NodeLifecycleState =
  | "not_installed"
  | "installing"
  | "stopped"
  | "starting"
  | "connecting"
  | "ready"
  | "degraded"
  | "restarting"
  | "failed"
  | "stopping";

interface ManagedNodeStatus {
  state: NodeLifecycleState;
  version: string;
  installed: boolean;
  verified: boolean;
  websocketUrl: string;
  wsApiPort: number;
  processId?: number;
  restartAttempt: number;
  lastError?: string;
}

interface ManagedNodeDiagnostics {
  schemaVersion: 1;
  generatedAtUnixMs: number;
  status: ManagedNodeStatus;
  recentLog: string[];
}

export function App() {
  const [runtime, setRuntime] = useState<NexusClientRuntime | null>(null);
  const [runtimeState, setRuntimeState] = useState<"loading" | "ready" | "missing" | "failed">(
    "loading",
  );
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [managedNode, setManagedNode] = useState<ManagedNodeStatus | null>(null);
  const [nodeAction, setNodeAction] = useState<"idle" | "installing" | "starting">("idle");
  const [activePeer, setActivePeer] = useState(0);
  const [snapshot, setSnapshot] = useState<ChatSnapshot>(emptySnapshot);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<PreparedAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentProgress, setAttachmentProgress] = useState<string | null>(null);
  const [attachmentTransfers, setAttachmentTransfers] = useState<Record<string, string>>({});
  const [online, setOnline] = useState(true);
  const [membersVisible, setMembersVisible] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [notificationState, setNotificationState] = useState<
    "off" | "on" | "denied" | "unavailable"
  >("off");
  const messagesEnd = useRef<HTMLDivElement>(null);
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
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<string | null>(null);
  const [nodePortDraft, setNodePortDraft] = useState("7520");
  const activeRuntimeIdentity = runtime?.identities[activePeer] ?? runtime?.identities[0];
  const reliability = useReliabilityReporting({
    surface: "desktop",
    endpoint: import.meta.env.VITE_NEXUS_RELIABILITY_ENDPOINT,
    connected: snapshot.status === "connected",
    storage: window.localStorage,
  });
  const recovery = useRecoveryWorkflow({
    identity: activeRuntimeIdentity,
    async install(payload, passphrase) {
      await installDesktopRecovery(payload, passphrase);
      window.location.reload();
    },
  });

  useEffect(() => {
    let active = true;
    void createDesktopRuntime()
      .then((created) => {
        if (!active) return;
        if (!created) {
          if (isTauri) {
            void invoke<ManagedNodeStatus>("managed_node_status")
              .then((status) => {
                if (active) {
                  setManagedNode(status);
                  setNodePortDraft(status.wsApiPort.toString());
                }
              })
              .catch((error: unknown) => {
                if (active) {
                  setRuntimeError(
                    error instanceof Error ? error.message : "Could not inspect managed Core",
                  );
                }
              });
          }
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
    if (!isTauri || runtimeState !== "missing" || !managedNode) return;
    if (
      !["installing", "starting", "connecting", "restarting", "stopping"].includes(
        managedNode.state,
      )
    ) {
      return;
    }
    const poll = window.setInterval(() => {
      void invoke<ManagedNodeStatus>("managed_node_status").then(setManagedNode);
    }, 500);
    return () => window.clearInterval(poll);
  }, [managedNode, runtimeState]);

  useEffect(() => {
    if (!runtime) return;
    knownAcceptedMessages.current = null;
    const session = runtime.sessions[activePeer] ?? runtime.sessions[0];
    return session?.subscribe(setSnapshot);
  }, [runtime, activePeer]);

  useEffect(
    () =>
      runtime?.authority?.subscribe((next) => {
        setAuthority(next);
        window.localStorage.setItem(MODERATION_AUDIT_KEY, JSON.stringify(next.moderation));
      }),
    [runtime],
  );

  useEffect(() => {
    const saved = window.localStorage.getItem("nexus-notifications-v1") === "on";
    void notificationPermissionGranted()
      .then((granted) => setNotificationState(saved && granted ? "on" : "off"))
      .catch(() => setNotificationState("unavailable"));
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
      const copy = messageNotificationCopy(
        message,
        runtime.identities.find((identity) => identity.identityId === message.authorId)
          ?.displayName ?? message.authorId.slice(0, 7),
        "campfire",
      );
      void sendDesktopNotification(copy.title, copy.body, message.operationId).catch(() =>
        setNotificationState("unavailable"),
      );
    }
  }, [notificationState, runtime, snapshot.messages]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
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
      (authorId) => names.get(authorId) ?? authorId.slice(0, 7),
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
    try {
      if (await requestNotificationAccess()) {
        window.localStorage.setItem("nexus-notifications-v1", "on");
        setNotificationState("on");
      } else {
        setNotificationState("denied");
      }
    } catch {
      setNotificationState("unavailable");
    }
  }

  async function sendDraft() {
    if (!runtime || (!draft.trim() && !attachment)) return;
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
        composerInput.current.style.height = "32px";
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
      const url = URL.createObjectURL(
        new Blob([Uint8Array.from(resolved.bytes)], {
          type: resolved.manifest.mediaType,
        }),
      );
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
      if (microphoneActive) await router.setTrack("microphone", null);
      else await router.startMicrophone(microphoneId || undefined);
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
      if (cameraActive) await router.setTrack("camera", null);
      else await router.startCamera(cameraId || undefined);
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
      if (screenActive) await router.setTrack("screen", null);
      else await router.startScreenShare();
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

  async function exportDiagnostics() {
    setDiagnosticsStatus("Preparing diagnostics…");
    try {
      const node = isTauri
        ? await invoke<ManagedNodeDiagnostics>("export_managed_node_diagnostics")
        : {
            schemaVersion: 1 as const,
            generatedAtUnixMs: Date.now(),
            status: managedNode,
            recentLog: [],
          };
      const bundle = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        client: {
          product: productBrand.name,
          runtimeMode: runtime?.mode ?? "not-connected",
          connectionStatus: snapshot.status,
          queuedOperations: snapshot.queuedCount,
          messagesInLocalView: snapshot.messages.length,
          notifications: notificationState,
        },
        managedNode: node,
        privacy: {
          excludes: [
            "message contents",
            "identity keys",
            "bridge tokens",
            "authorization headers",
            "attachment contents",
          ],
        },
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `nexus-diagnostics-${Date.now()}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setDiagnosticsStatus("Diagnostics exported");
    } catch (error) {
      setDiagnosticsStatus(error instanceof Error ? error.message : "Diagnostics export failed");
    }
  }

  async function saveManagedNodePort() {
    const port = Number(nodePortDraft);
    if (!Number.isInteger(port)) {
      setDiagnosticsStatus("Enter a whole-number port");
      return;
    }
    setDiagnosticsStatus("Checking port…");
    try {
      const status = await invoke<ManagedNodeStatus>("set_managed_node_port", { port });
      setManagedNode(status);
      setNodePortDraft(status.wsApiPort.toString());
      setDiagnosticsStatus(`Managed node port set to ${status.wsApiPort}`);
    } catch (error) {
      setDiagnosticsStatus(error instanceof Error ? error.message : String(error));
    }
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

  async function installAndStartNode() {
    setNodeAction("installing");
    setRuntimeError(null);
    try {
      const installed = await invoke<ManagedNodeStatus>("install_managed_node");
      setManagedNode(installed);
      setNodeAction("starting");
      setManagedNode(await invoke<ManagedNodeStatus>("start_managed_node"));
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setNodeAction("idle");
    }
  }

  async function startNode() {
    setNodeAction("starting");
    setRuntimeError(null);
    try {
      setManagedNode(await invoke<ManagedNodeStatus>("start_managed_node"));
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setNodeAction("idle");
    }
  }

  if (runtimeState !== "ready" || !runtime) {
    const nodeBusy =
      nodeAction !== "idle" ||
      Boolean(
        managedNode &&
          ["installing", "starting", "connecting", "restarting", "stopping"].includes(
            managedNode.state,
          ),
      );
    const nodeReady = managedNode?.state === "ready";
    return (
      <main className="desktop-setup">
        <div className="nexus-logo">N</div>
        <p>
          {runtimeState === "loading"
            ? "Connecting"
            : nodeReady
              ? `Freenet Core ${managedNode.version} ready`
              : "Local Freenet runtime required"}
        </p>
        <h1>
          {runtimeState === "loading"
            ? `Starting ${productBrand.name} Desktop…`
            : nodeReady
              ? "Your managed node is running."
              : `Bring ${productBrand.name} online with a verified local node.`}
        </h1>
        <span>
          {runtimeError ??
            (nodeReady
              ? "Core is supervised by Nexus. Configure a published Nexus message contract to enter the client."
              : (managedNode?.lastError ??
                "Nexus downloads the pinned Core release, verifies its SHA-256 digest, and keeps it on loopback."))}
        </span>
        {isTauri && managedNode && !nodeReady && (
          <div className="setup-actions">
            <label className="setup-port-setting">
              Local API port
              <input
                type="number"
                min="1024"
                max="65535"
                value={nodePortDraft}
                disabled={nodeBusy}
                onChange={(event) => setNodePortDraft(event.target.value)}
              />
              <button type="button" disabled={nodeBusy} onClick={() => void saveManagedNodePort()}>
                Save
              </button>
            </label>
            {!managedNode.installed ? (
              <button type="button" disabled={nodeBusy} onClick={() => void installAndStartNode()}>
                <Download size={17} />
                {nodeAction === "installing" ? "Verifying download…" : "Install & start Core"}
              </button>
            ) : (
              <button type="button" disabled={nodeBusy} onClick={() => void startNode()}>
                <Wifi size={17} />
                {nodeBusy ? `Core is ${managedNode.state}…` : "Start verified Core"}
              </button>
            )}
            <small>
              {managedNode.verified
                ? "Pinned release digest verified"
                : `State: ${managedNode.state}`}
            </small>
          </div>
        )}
      </main>
    );
  }

  const connected = runtime.mode === "simulation" ? online : snapshot.status === "connected";
  const activeIdentity = runtime.identities[activePeer] ?? runtime.identities[0];

  return (
    <div className={`desktop-shell ${membersVisible ? "" : "members-hidden"}`}>
      <a className="skip-link" href="#primary-conversation">
        Skip to conversation
      </a>
      <aside className="community-rail" aria-label="Communities">
        <button type="button" className="rail-brand" aria-label={productBrand.name}>
          N
        </button>
        <div className="rail-rule" />
        <button type="button" className="rail-community active">
          <span>O</span>
          <i className="rail-active-indicator" />
        </button>
        <button type="button" className="rail-community ember">
          <span>E</span>
        </button>
        <button type="button" className="rail-community field">
          <span>F</span>
        </button>
        <button type="button" className="rail-add" aria-label="Add a community">
          <Plus size={20} />
        </button>
        <div className="rail-spacer" />
        <button type="button" className="rail-utility" aria-label="Help">
          <CircleHelp size={19} />
        </button>
        <button type="button" className="rail-utility" aria-label="Settings">
          <Settings size={19} />
        </button>
      </aside>

      <aside className="channel-sidebar" aria-label="Community navigation">
        <div className="workspace-switcher">
          <div>
            <span className="workspace-kicker">Community</span>
            <strong>Orbit House</strong>
          </div>
          <ChevronDown size={17} />
        </div>
        <button type="button" className="search-shortcut" onClick={openSearch}>
          <Search size={15} />
          <span>Find anything</span>
          <kbd>Ctrl K</kbd>
        </button>
        <nav className="sidebar-nav">
          <button type="button">
            <Inbox size={17} /> Inbox <span>4</span>
          </button>
          <button type="button">
            <Users size={17} /> People
          </button>
        </nav>
        <div className="sidebar-section">
          <header>
            <span>
              <ChevronDown size={13} /> Conversations
            </span>
            <Plus size={14} />
          </header>
          <button type="button" className="channel active">
            <Hash size={17} /> campfire <b>3</b>
          </button>
          <button type="button" className="channel">
            <Hash size={17} /> build-log
          </button>
          <button type="button" className="channel">
            <Hash size={17} /> weekend-plans
          </button>
          <button type="button" className="channel">
            <Hash size={17} /> music-desk
          </button>
        </div>
        <div className="sidebar-section">
          <header>
            <span>
              <ChevronDown size={13} /> Voice rooms
            </span>
            <Plus size={14} />
          </header>
          <button
            type="button"
            className="voice-room"
            onClick={() => void (callJoined ? leaveCall() : joinCall())}
          >
            <Signal size={16} />
            <span>
              <strong>The observatory</strong>
              <small>Mara, Jin</small>
            </span>
            <ChevronRight size={15} />
          </button>
          <button type="button" className="channel">
            <Headphones size={17} /> Focus room
          </button>
        </div>
        <div className="sidebar-spacer" />
        <section className="contribution-card">
          <header>
            <span>
              <Activity size={14} /> Freenet contribution
            </span>
            <b>Balanced</b>
          </header>
          <div className="rate-row">
            <span>
              <Download size={13} /> 184 KB/s
            </span>
            <span>12 contracts</span>
          </div>
          <div className="meter">
            <i className="meter-fill" />
          </div>
        </section>
        <section className="account-bar">
          <div className="person-avatar person-mara">M</div>
          <div>
            <strong>{activeIdentity?.displayName ?? "Loading"}</strong>
            <span>{snapshot.status}</span>
          </div>
          <button type="button" className="quiet-button" aria-label="Mute microphone">
            <Mic size={15} />
          </button>
          <button type="button" className="quiet-button" aria-label="Audio settings">
            <SlidersHorizontal size={15} />
          </button>
        </section>
      </aside>

      <main id="primary-conversation" className="conversation" tabIndex={-1}>
        <header className="conversation-header">
          <div className="title-block">
            <Hash className="title-block-icon" size={19} />
            <div>
              <strong>campfire</strong>
              <span>Ideas, updates, and questionable plans.</span>
            </div>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className={`quiet-button ${notificationState === "on" ? "selected" : ""}`}
              aria-label={
                notificationState === "on"
                  ? "Disable notifications"
                  : notificationState === "denied"
                    ? "Notifications blocked in system settings"
                    : notificationState === "unavailable"
                      ? "Notifications unavailable"
                      : "Enable notifications"
              }
              title={
                notificationState === "denied"
                  ? "Notifications are blocked in system settings"
                  : notificationState === "unavailable"
                    ? "Notifications are unavailable"
                    : undefined
              }
              aria-pressed={notificationState === "on"}
              onClick={() => void toggleNotifications()}
            >
              <Bell size={17} />
            </button>
            <button type="button" className="quiet-button" aria-label="Invite people">
              <UserPlus size={17} />
            </button>
            <button
              type="button"
              className={`quiet-button ${membersVisible ? "selected" : ""}`}
              aria-label="Toggle member panel"
              onClick={() => setMembersVisible((visible) => !visible)}
            >
              <Users size={17} />
            </button>
            <button
              type="button"
              className="header-search"
              onClick={openSearch}
              aria-label="Search campfire"
            >
              <Search size={15} />
              <span>Search campfire</span>
              <kbd>Ctrl F</kbd>
            </button>
          </div>
        </header>

        <div className="conversation-body">
          {searchOpen && (
            <section className="desktop-search-panel" aria-label="Search this conversation">
              <Search size={16} aria-hidden="true" />
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
          {!connected && (
            <div className="network-banner">
              <WifiOff size={15} />
              <span>
                {runtime.mode === "freenet"
                  ? "Freenet connection interrupted. New messages stay queued on this device."
                  : "Offline. New messages stay queued on this device."}
              </span>
              {runtime.mode === "simulation" && (
                <button type="button" onClick={toggleNetwork}>
                  Reconnect
                </button>
              )}
            </div>
          )}

          <section className="message-scroll" aria-live="polite">
            <div className="conversation-hero">
              <div className="hero-hash">
                <Hash size={24} />
              </div>
              <div>
                <p>Text channel</p>
                <h1># campfire</h1>
                <span>This is the start of #campfire.</span>
              </div>
            </div>
            <div className="date-rule">
              <span>Sunday, July 26</span>
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
            <div ref={messagesEnd} />
          </section>
        </div>

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
            <Mic size={15} />
          </button>
          <button
            type="button"
            className={cameraActive ? "active" : ""}
            onClick={() => void toggleCamera()}
            aria-pressed={cameraActive}
            aria-label="Toggle camera"
          >
            <Camera size={15} />
          </button>
          <button
            type="button"
            className={screenActive ? "active" : ""}
            onClick={() => void toggleScreen()}
            aria-pressed={screenActive}
            aria-label="Toggle screen share"
          >
            <MonitorUp size={15} />
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
            {callJoined ? <PhoneOff size={15} /> : <Signal size={15} />}
            {callJoined ? "Leave" : "Join"}
          </button>
        </section>

        <form className="desktop-composer" onSubmit={submit}>
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
            className="quiet-button add-attachment"
            aria-label="Attach file"
            onClick={() => attachmentInput.current?.click()}
          >
            <Plus size={19} />
          </button>
          <label>
            <span className="sr-only">Message campfire</span>
            <textarea
              ref={composerInput}
              rows={1}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                resizeComposer(event.currentTarget, 96);
              }}
              onKeyDown={handleComposerKeyDown}
              placeholder={`Message #campfire as ${activeIdentity?.displayName ?? "…"}`}
              maxLength={8000}
            />
          </label>
          <button
            type="button"
            className="quiet-button"
            aria-label="Attach"
            onClick={() => attachmentInput.current?.click()}
          >
            <Paperclip size={18} />
          </button>
          <button
            type="submit"
            className="composer-send"
            aria-label="Send message"
            disabled={!draft.trim() && !attachment}
          >
            <Send size={17} />
          </button>
        </form>
      </main>

      {membersVisible && (
        <aside className="member-panel" aria-label="People and network status">
          <header>
            <span>People — 8</span>
            <button type="button" className="quiet-button" aria-label="Member panel options">
              <Menu size={16} />
            </button>
          </header>
          <p className="member-group">In voice — 2</p>
          <div className="member">
            <div className="person-avatar person-mara">M</div>
            <div>
              <strong>Mara</strong>
              <span>Sharing a window</span>
            </div>
            <Signal size={14} className="member-signal" />
          </div>
          <div className="member">
            <div className="person-avatar person-jin">J</div>
            <div>
              <strong>Jin</strong>
              <span>Listening</span>
            </div>
            <Mic size={14} className="member-signal" />
          </div>
          <p className="member-group">Online — 4</p>
          <div className="member">
            <div className="person-avatar person-theo">T</div>
            <div>
              <strong>Theo</strong>
              <span>Building something</span>
            </div>
            <i className="presence online" />
          </div>
          <div className="member">
            <div className="person-avatar person-anya">A</div>
            <div>
              <strong>Anya</strong>
              <span>Reviewing</span>
            </div>
            <i className="presence online" />
          </div>
          <div className="member">
            <div className="person-avatar person-sam">S</div>
            <div>
              <strong>Sam</strong>
              <span>Idle</span>
            </div>
            <i className="presence idle" />
          </div>
          <p className="member-group">Network</p>
          <section className="network-card">
            <div className="network-card-title">
              <div className="network-icon">
                {connected ? <Wifi size={16} /> : <WifiOff size={16} />}
              </div>
              <div>
                <strong>
                  {connected
                    ? runtime.mode === "freenet"
                      ? "Freenet live"
                      : "Development mesh"
                    : "Offline"}
                </strong>
                <span>
                  {connected
                    ? runtime.mode === "freenet"
                      ? "Core subscription active"
                      : "2 simulated peers"
                    : `${snapshot.queuedCount} queued operations`}
                </span>
              </div>
            </div>
            <dl>
              <div>
                <dt>Node</dt>
                <dd>{runtime.mode === "freenet" ? "Local Core" : "Simulation"}</dd>
              </div>
              <div>
                <dt>Contract</dt>
                <dd>{connected ? "Subscribed" : "Disconnected"}</dd>
              </div>
              <div>
                <dt>Latency</dt>
                <dd>{runtime.mode === "freenet" ? "Live" : "45–65 ms"}</dd>
              </div>
            </dl>
            {runtime.mode === "simulation" && (
              <button type="button" onClick={toggleNetwork}>
                <Gauge size={14} /> {online ? "Test offline queue" : "Restore network"}
              </button>
            )}
            <button type="button" onClick={() => void exportDiagnostics()}>
              <Download size={14} /> Export diagnostics
            </button>
            <details className="reliability-tools">
              <ReliabilityControls state={reliability} />
            </details>
            {isTauri && managedNode && (
              <label className="node-port-setting">
                Local API port
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  value={nodePortDraft}
                  disabled={managedNode.processId !== undefined}
                  onChange={(event) => setNodePortDraft(event.target.value)}
                />
                <button
                  type="button"
                  disabled={managedNode.processId !== undefined}
                  onClick={() => void saveManagedNodePort()}
                >
                  Save port
                </button>
              </label>
            )}
            {diagnosticsStatus && <span aria-live="polite">{diagnosticsStatus}</span>}
          </section>
          {authority && (
            <section className="authority-card">
              <strong>Private epoch {authority.encryptionEpoch ?? "locked"}</strong>
              <span>
                Community epoch {authority.community.epoch} ·{" "}
                {authority.authorized ? "device authorized" : "awaiting authorization"}
              </span>
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
            </section>
          )}
          <div className="peer-picker">
            <span>{runtime.mode === "freenet" ? "Local identity" : "Development identity"}</span>
            {runtime.identities.map((identity, index) => (
              <button
                type="button"
                key={identity.identityId}
                className={activePeer === index ? "active" : ""}
                onClick={() => setActivePeer(index)}
              >
                {identity.displayName}
              </button>
            ))}
          </div>
          <div className="member-spacer" />
          <div className="security-note">
            <ShieldCheck className="security-note-icon" size={16} />
            <span>
              Every message is signed before the{" "}
              {runtime.mode === "freenet" ? "Freenet" : "simulated"} contract accepts it.
            </span>
          </div>
        </aside>
      )}
    </div>
  );
}
