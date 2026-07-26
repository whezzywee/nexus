import {
  type AttachmentRepository,
  type AttachmentTransferOptions,
  type PreparedAttachment,
  restoreAttachment,
  signAttachmentIndexOperation,
  verifyAttachmentIndexOperation,
} from "@nexus/attachments";
import type { LocalDeviceState } from "@nexus/device";
import { FreenetBridgeTransport, FreenetContractTransport } from "@nexus/freenet-client";
import { createLocalIdentity, type LocalIdentity } from "@nexus/identity";
import { ChatSession, type RetryQueueStore } from "@nexus/sync-engine";
import { ulid } from "ulid";
import { FreenetAuthorityController } from "./authority";

export type { ModerationAction, ModerationState } from "@nexus/moderation";
export type { AuthoritySnapshot, DeviceInvite, ModerationRequest } from "./authority";
export {
  acceptedMessageIds,
  findNewRemoteMessages,
  type MessageNotificationCopy,
  messageNotificationCopy,
  searchDisplayMessages,
} from "./experience";
export { InvitationAttemptLimiter, type InvitationRateStatus } from "./invite-limits";
export {
  createRecoveryFile,
  installRecoveredLinkedDevice,
  type RecoveryRehearsal,
  rehearseRecoveryFile,
} from "./recovery";
export {
  type ReliabilityCategory,
  type ReliabilityEvent,
  ReliabilityReporter,
  type ReliabilityReporterOptions,
  type ReliabilityStore,
} from "./reliability";

export const PHASE1_CHANNEL_ID = "01K10KJ6P20S58KQBV5P4E3T9Z";

export interface FreenetRuntimeConfig {
  websocketUrl?: string;
  contractInstanceId: string;
  contractCodeHash: string;
  bridgeUrl?: string;
  bridgeToken?: string;
  peer: "a" | "b";
  displayName: string;
  channelId: string;
  authToken?: string;
}

export interface FreenetRuntimeEnvironment {
  websocketUrl?: string;
  contractInstanceId?: string;
  contractCodeHash?: string;
  bridgeUrl?: string;
  bridgeToken?: string;
  peer?: "a" | "b";
  displayName?: string;
  channelId?: string;
  authToken?: string;
}

export interface NexusClientRuntime {
  readonly mode: "freenet" | "simulation";
  readonly channelId: string;
  readonly identities: LocalIdentity[];
  readonly devices?: LocalDeviceState[];
  readonly attachments?: AttachmentRepository;
  readonly authority?: FreenetAuthorityController;
  readonly sessions: ChatSession[];
  setOnline?(online: boolean): void;
  stop(): Promise<void>;
}

export function parseFreenetRuntimeConfig(
  environment: FreenetRuntimeEnvironment,
): FreenetRuntimeConfig | null {
  const websocketUrl = environment.websocketUrl?.trim();
  const contractInstanceId = environment.contractInstanceId?.trim();
  const contractCodeHash = environment.contractCodeHash?.trim();
  const bridgeUrl = environment.bridgeUrl?.trim();
  const bridgeToken = environment.bridgeToken?.trim();
  const hasAnyFreenetSetting = Boolean(
    websocketUrl ||
      contractInstanceId ||
      contractCodeHash ||
      bridgeUrl ||
      bridgeToken ||
      environment.authToken,
  );

  if (!hasAnyFreenetSetting) {
    return null;
  }
  if (!contractInstanceId || !contractCodeHash) {
    throw new Error(
      "Freenet runtime configuration requires a contract instance ID and contract code hash",
    );
  }
  if (!bridgeUrl && !websocketUrl) {
    throw new Error("Freenet runtime configuration requires a native bridge or websocket URL");
  }
  if (bridgeUrl && !bridgeToken) {
    throw new Error("Freenet native bridge configuration requires an access token");
  }

  let parsedWebsocketUrl: string | undefined;
  if (websocketUrl) {
    const parsedUrl = new URL(websocketUrl);
    if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
      throw new Error("Freenet runtime websocket URL must use ws:// or wss://");
    }
    // The SDK owns wire-protocol negotiation and appends FlatBuffers itself.
    parsedUrl.searchParams.delete("encodingProtocol");
    parsedWebsocketUrl = parsedUrl.toString();
  }

  let parsedBridgeUrl: string | undefined;
  if (bridgeUrl) {
    const parsedUrl = new URL(bridgeUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Freenet native bridge URL must use http:// or https://");
    }
    parsedBridgeUrl = parsedUrl.toString();
  }

  return {
    ...(parsedWebsocketUrl ? { websocketUrl: parsedWebsocketUrl } : {}),
    contractInstanceId,
    contractCodeHash,
    ...(parsedBridgeUrl ? { bridgeUrl: parsedBridgeUrl } : {}),
    ...(bridgeToken ? { bridgeToken } : {}),
    peer: environment.peer ?? "b",
    displayName: environment.displayName?.trim() || "Nexus user",
    channelId: environment.channelId?.trim() || PHASE1_CHANNEL_ID,
    ...(environment.authToken ? { authToken: environment.authToken } : {}),
  };
}

export async function createFreenetClientRuntime(
  config: FreenetRuntimeConfig,
  identityOverride?: LocalIdentity,
  retryStore?: RetryQueueStore,
  deviceState?: LocalDeviceState,
): Promise<NexusClientRuntime> {
  const identity = identityOverride ?? (await createLocalIdentity(config.displayName));
  const transport =
    config.bridgeUrl && config.bridgeToken
      ? new FreenetBridgeTransport({
          bridgeUrl: new URL(config.bridgeUrl),
          bridgeToken: config.bridgeToken,
          peer: config.peer,
        })
      : new FreenetContractTransport({
          websocketUrl: new URL(
            config.websocketUrl ??
              (() => {
                throw new Error("Freenet websocket URL is missing");
              })(),
          ),
          contractInstanceId: config.contractInstanceId,
          contractCodeHash: config.contractCodeHash,
          ...(config.authToken ? { authToken: config.authToken } : {}),
        });
  const session = new ChatSession(identity, config.channelId, transport, retryStore);
  let authority: FreenetAuthorityController | undefined;

  try {
    await session.start();
    if (transport instanceof FreenetBridgeTransport && deviceState) {
      authority = new FreenetAuthorityController(transport, deviceState, session);
      await authority.start();
    }
  } catch (error) {
    authority?.stop();
    await session.stop();
    throw error;
  }

  return {
    mode: "freenet",
    channelId: config.channelId,
    identities: [identity],
    ...(deviceState ? { devices: [deviceState] } : {}),
    ...(transport instanceof FreenetBridgeTransport
      ? { attachments: new FreenetAttachmentRepository(transport) }
      : {}),
    ...(authority ? { authority } : {}),
    sessions: [session],
    async stop() {
      authority?.stop();
      await session.stop();
    },
  };
}

class FreenetAttachmentRepository implements AttachmentRepository {
  constructor(private readonly transport: FreenetBridgeTransport) {}

  async publish(
    prepared: PreparedAttachment,
    identity: LocalIdentity,
    targetId: string,
    options?: AttachmentTransferOptions,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    const operation = await signAttachmentIndexOperation(identity, {
      protocolVersion: 2,
      operationId: ulid(),
      targetId,
      authorId: identity.identityId,
      authorDeviceId: identity.deviceId,
      actorSequence: identity.nextSequence,
      reference: prepared.reference,
      manifest: prepared.manifest,
      createdAt: new Date().toISOString(),
    });
    const total = prepared.manifest.chunks.length + 1;
    options?.onProgress?.(0, total);
    await this.transport.publishAttachment(prepared, operation, options?.signal);
    options?.signal?.throwIfAborted();
    options?.onProgress?.(total, total);
  }

  async fetch(reference: string, conversationKey?: CryptoKey, options?: AttachmentTransferOptions) {
    options?.signal?.throwIfAborted();
    options?.onProgress?.(0, 1);
    const downloaded = await this.transport.fetchAttachment(reference, options?.signal);
    if (!(await verifyAttachmentIndexOperation(downloaded.operation))) {
      throw new Error("Downloaded attachment index signature is invalid");
    }
    const prepared = {
      reference,
      manifest: downloaded.manifest,
      chunks: downloaded.chunks,
    };
    const bytes = await restoreAttachment(prepared, conversationKey);
    options?.signal?.throwIfAborted();
    options?.onProgress?.(1, 1);
    return { reference, manifest: downloaded.manifest, bytes };
  }
}
