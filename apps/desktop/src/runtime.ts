import {
  createFreenetClientRuntime,
  type FreenetRuntimeConfig,
  type FreenetRuntimeEnvironment,
  installRecoveredLinkedDevice,
  type ModerationState,
  type NexusClientRuntime,
  parseFreenetRuntimeConfig,
} from "@nexus/app-runtime";
import {
  type DeviceSecretStore,
  type LocalDeviceState,
  loadOrCreateDeviceState,
} from "@nexus/device";
import type { MessageOperation } from "@nexus/protocol";
import type { RetryQueueStore } from "@nexus/sync-engine";
import { invoke } from "@tauri-apps/api/core";

export const MODERATION_AUDIT_KEY = "nexus-moderation-audit-v1";
export const isTauri = "__TAURI_INTERNALS__" in window;

function viteRuntimeEnvironment(): FreenetRuntimeEnvironment {
  const params = new URLSearchParams(window.location.search);
  const selectedNode = params.get("node") === "a" ? "a" : "b";
  const nodeUrl =
    selectedNode === "a"
      ? import.meta.env.VITE_NEXUS_FREENET_WS_URL_A
      : import.meta.env.VITE_NEXUS_FREENET_WS_URL_B;
  return {
    websocketUrl: nodeUrl || import.meta.env.VITE_NEXUS_FREENET_WS_URL,
    contractInstanceId: import.meta.env.VITE_NEXUS_CONTRACT_INSTANCE_ID,
    contractCodeHash: import.meta.env.VITE_NEXUS_CONTRACT_CODE_HASH,
    bridgeUrl: import.meta.env.VITE_NEXUS_BRIDGE_URL,
    bridgeToken: import.meta.env.VITE_NEXUS_BRIDGE_TOKEN,
    peer: selectedNode,
    displayName:
      params.get("identity") || import.meta.env.VITE_NEXUS_DISPLAY_NAME || "Desktop user",
    channelId: import.meta.env.VITE_NEXUS_CHANNEL_ID,
    authToken: import.meta.env.VITE_NEXUS_AUTH_TOKEN,
  };
}

async function loadDesktopRuntimeConfig(): Promise<FreenetRuntimeConfig | null> {
  const fromVite = parseFreenetRuntimeConfig(viteRuntimeEnvironment());
  if (fromVite) return fromVite;
  if (!isTauri) return null;
  const fromTauri = await invoke<FreenetRuntimeEnvironment | null>("phase1_runtime_config");
  return fromTauri ? parseFreenetRuntimeConfig(fromTauri) : null;
}

export function desktopDeviceStore(): DeviceSecretStore {
  return {
    async load(profile) {
      return invoke<string | null>("load_identity_secret", { profile });
    },
    async save(profile, payload) {
      await invoke("store_identity_secret", { profile, payload });
    },
  };
}

async function loadOrCreateDesktopDevice(displayName: string): Promise<LocalDeviceState> {
  return loadOrCreateDeviceState(desktopDeviceStore(), "primary-device-v1", displayName);
}

export function desktopPreviewDeviceStore(): DeviceSecretStore {
  return {
    async load(profile) {
      return window.localStorage.getItem(profile);
    },
    async save(profile, payload) {
      window.localStorage.setItem(profile, payload);
    },
  };
}

function desktopRetryStore(): RetryQueueStore {
  function profile(channelId: string, identityId: string) {
    return `outbox-${channelId}-${identityId.slice(0, 12)}`;
  }
  return {
    async load(channelId, identityId) {
      const stored = await invoke<string | null>("load_identity_secret", {
        profile: profile(channelId, identityId),
      });
      return stored ? (JSON.parse(stored) as MessageOperation[]) : [];
    },
    async save(channelId, identityId, operations) {
      await invoke("store_identity_secret", {
        profile: profile(channelId, identityId),
        payload: JSON.stringify(operations),
      });
    },
  };
}

export async function createDesktopRuntime(): Promise<NexusClientRuntime | null> {
  const freenetConfig = await loadDesktopRuntimeConfig();
  if (freenetConfig) {
    const device = isTauri
      ? await loadOrCreateDesktopDevice(freenetConfig.displayName)
      : await loadOrCreateDeviceState(
          desktopPreviewDeviceStore(),
          `nexus-desktop-preview-device-v1:${freenetConfig.peer}:${freenetConfig.displayName}`,
          freenetConfig.displayName,
        );
    const runtime = await createFreenetClientRuntime(
      freenetConfig,
      device.identity,
      isTauri ? desktopRetryStore() : undefined,
      device,
    );
    const storedAudit = window.localStorage.getItem(MODERATION_AUDIT_KEY);
    if (storedAudit && runtime.authority) {
      try {
        await runtime.authority.restoreModeration(JSON.parse(storedAudit) as ModerationState);
      } catch (error) {
        console.warn("Ignoring an unreadable local moderation audit", error);
      }
    }
    return runtime;
  }
  if (!import.meta.env.DEV) return null;
  const { createTwoPeerPrototype } = await import("@nexus/test-utilities");
  const simulation = await createTwoPeerPrototype();
  return {
    mode: "simulation",
    channelId: simulation.channelId,
    identities: simulation.identities,
    sessions: simulation.sessions,
    attachments: simulation.attachments,
    setOnline: simulation.setOnline,
    stop: simulation.stop,
  };
}

export async function installDesktopRecovery(payload: string, passphrase: string): Promise<void> {
  const config = await loadDesktopRuntimeConfig();
  if (!config) {
    throw new Error("Recovery installation requires a configured Freenet runtime.");
  }
  const store = isTauri ? desktopDeviceStore() : desktopPreviewDeviceStore();
  const profile = isTauri
    ? "primary-device-v1"
    : `nexus-desktop-preview-device-v1:${config.peer}:${config.displayName}`;
  await installRecoveredLinkedDevice(payload, passphrase, store, profile);
}
