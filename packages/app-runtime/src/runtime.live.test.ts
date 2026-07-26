import { prepareAttachment } from "@nexus/attachments";
import { describe, expect, it } from "vitest";

import { createFreenetClientRuntime, PHASE1_CHANNEL_ID } from "./index";

declare const process: {
  env: Record<string, string | undefined>;
};

const peerA = process.env.NEXUS_LIVE_PEER_A;
const peerB = process.env.NEXUS_LIVE_PEER_B;
const contractInstanceId = process.env.NEXUS_LIVE_CONTRACT_INSTANCE_ID;
const contractCodeHash = process.env.NEXUS_LIVE_CONTRACT_CODE_HASH;
const bridgeUrl = process.env.NEXUS_LIVE_BRIDGE_URL;
const bridgeToken = process.env.NEXUS_LIVE_BRIDGE_TOKEN;

function liveSettings() {
  if (!peerA || !peerB || !contractInstanceId || !contractCodeHash || !bridgeUrl || !bridgeToken) {
    throw new Error("Live Freenet runtime settings are unavailable");
  }
  return { peerA, peerB, contractInstanceId, contractCodeHash, bridgeUrl, bridgeToken };
}

async function waitUntil(check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the live Freenet message");
}

async function withDeadline<T>(label: string, promise: Promise<T>, timeoutMs = 20_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Timed out during ${label}`)), timeoutMs);
    }),
  ]);
}

describe.skipIf(
  !peerA || !peerB || !contractInstanceId || !contractCodeHash || !bridgeUrl || !bridgeToken,
)("live Freenet app runtime", () => {
  it("exchanges a signed message between two configured client sessions", async () => {
    const settings = liveSettings();
    const first = await withDeadline(
      "peer A startup",
      createFreenetClientRuntime({
        websocketUrl: settings.peerA,
        contractInstanceId: settings.contractInstanceId,
        contractCodeHash: settings.contractCodeHash,
        bridgeUrl: settings.bridgeUrl,
        bridgeToken: settings.bridgeToken,
        peer: "a",
        displayName: "Live test A",
        channelId: PHASE1_CHANNEL_ID,
      }),
    );
    const second = await withDeadline(
      "peer B startup",
      createFreenetClientRuntime({
        websocketUrl: settings.peerB,
        contractInstanceId: settings.contractInstanceId,
        contractCodeHash: settings.contractCodeHash,
        bridgeUrl: settings.bridgeUrl,
        bridgeToken: settings.bridgeToken,
        peer: "b",
        displayName: "Live test B",
        channelId: PHASE1_CHANNEL_ID,
      }),
    );
    const content = `phase-1-live-${Date.now()}`;
    const firstSession = first.sessions[0];
    const secondSession = second.sessions[0];
    if (!firstSession || !secondSession) {
      throw new Error("Live Freenet runtime did not create both sessions");
    }

    try {
      const submission = firstSession.send(content);
      await waitUntil(
        () => firstSession.snapshot().messages.some((message) => message.content === content),
        5_000,
      );
      const outbound = firstSession
        .snapshot()
        .messages.find((message) => message.content === content);
      if (process.env.NEXUS_LIVE_PRINT_OPERATION === "1") {
        console.info(JSON.stringify(outbound));
      }
      await withDeadline("message submission", submission, 40_000);
      await waitUntil(() =>
        secondSession.snapshot().messages.some((message) => message.content === content),
      );
      expect(secondSession.snapshot().messages.some((message) => message.content === content)).toBe(
        true,
      );

      if (!first.attachments || !second.attachments) {
        throw new Error("Live Freenet runtime did not expose its attachment transport");
      }
      const attachmentBytes = new TextEncoder().encode(`live attachment ${Date.now()}`);
      const prepared = await prepareAttachment(
        attachmentBytes,
        "live-attachment.txt",
        "text/plain",
      );
      await withDeadline(
        "attachment publication",
        first.attachments.publish(prepared, firstSession.identity, first.channelId),
        90_000,
      );
      await firstSession.send("Live attachment", {
        attachmentReferences: [prepared.reference],
      });
      await waitUntil(() =>
        secondSession
          .snapshot()
          .messages.some((message) => message.attachmentReferences.includes(prepared.reference)),
      );
      const downloaded = await withDeadline(
        "attachment download",
        second.attachments.fetch(prepared.reference),
        90_000,
      );
      expect(downloaded.bytes).toEqual(attachmentBytes);
    } finally {
      await withDeadline("client shutdown", Promise.all([first.stop(), second.stop()]), 5_000);
    }
  }, 240_000);
});
