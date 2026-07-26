import {
  createFreenetClientRuntime,
  type FreenetRuntimeEnvironment,
  installRecoveredLinkedDevice,
  type ModerationState,
  type NexusClientRuntime,
  parseFreenetRuntimeConfig,
} from "@nexus/app-runtime";
import { type DeviceSecretStore, loadOrCreateDeviceState } from "@nexus/device";

export const MODERATION_AUDIT_KEY = "nexus-moderation-audit-v1";

function webRuntimeEnvironment(): FreenetRuntimeEnvironment {
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
    displayName: params.get("identity") || import.meta.env.VITE_NEXUS_DISPLAY_NAME || "Web user",
    channelId: import.meta.env.VITE_NEXUS_CHANNEL_ID,
    authToken: import.meta.env.VITE_NEXUS_AUTH_TOKEN,
  };
}

export async function createWebRuntime(): Promise<NexusClientRuntime | null> {
  const freenetConfig = parseFreenetRuntimeConfig(webRuntimeEnvironment());
  if (freenetConfig) {
    const profile = `nexus-device-v1:${freenetConfig.peer}:${freenetConfig.displayName}`;
    const store: DeviceSecretStore = {
      async load(key) {
        return window.localStorage.getItem(key);
      },
      async save(key, payload) {
        window.localStorage.setItem(key, payload);
      },
    };
    const device = await loadOrCreateDeviceState(store, profile, freenetConfig.displayName);
    const runtime = await createFreenetClientRuntime(
      freenetConfig,
      device.identity,
      undefined,
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

export async function installWebRecovery(payload: string, passphrase: string): Promise<void> {
  const config = parseFreenetRuntimeConfig(webRuntimeEnvironment());
  if (!config) {
    throw new Error("Recovery installation requires a configured Freenet runtime.");
  }
  const store: DeviceSecretStore = {
    async load(key) {
      return window.localStorage.getItem(key);
    },
    async save(key, nextPayload) {
      window.localStorage.setItem(key, nextPayload);
    },
  };
  await installRecoveredLinkedDevice(
    payload,
    passphrase,
    store,
    `nexus-device-v1:${config.peer}:${config.displayName}`,
  );
}
