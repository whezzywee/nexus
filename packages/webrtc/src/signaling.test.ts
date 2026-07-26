import { createLocalIdentity } from "@nexus/identity";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import {
  CallSignalInbox,
  fetchTurnCredential,
  signCallSignalEnvelope,
  turnIceServer,
  type UnsignedCallSignalEnvelope,
} from "./index";

describe("call signaling envelope", () => {
  it("accepts a signed recipient envelope and rejects replay and expiry", async () => {
    const sender = await createLocalIdentity("Mara");
    const callId = ulid();
    const recipientDeviceId = ulid();
    const now = Date.now();
    const unsigned: UnsignedCallSignalEnvelope = {
      version: 2,
      signalId: ulid(),
      callId,
      callEpoch: 2,
      senderIdentityId: sender.identityId,
      senderDeviceId: sender.deviceId,
      recipientDeviceId,
      sequence: 1,
      expiresAt: now + 30_000,
      type: "offer",
      ciphertext: "opaque-recipient-encrypted-offer",
    };
    const envelope = await signCallSignalEnvelope(sender, unsigned);
    const inbox = new CallSignalInbox(callId, 2, recipientDeviceId);

    await inbox.accept(envelope, now);
    await expect(inbox.accept(envelope, now)).rejects.toThrow(/replayed/);
    await expect(
      new CallSignalInbox(callId, 2, recipientDeviceId).accept(envelope, now + 31_000),
    ).rejects.toThrow(/expiry/);
  });
});

describe("short-lived TURN credentials", () => {
  it("accepts a bounded REST credential and rejects long-lived responses", async () => {
    const now = Date.now();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          urls: ["turns:relay.example:5349"],
          username: "expiry:identity",
          credential: "temporary-secret",
          expiresAt: now + 5 * 60_000,
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const credential = await fetchTurnCredential(
        new URL("https://relay.example/credentials"),
        undefined,
        now,
      );
      expect(turnIceServer(credential)).toMatchObject({
        urls: ["turns:relay.example:5349"],
        username: "expiry:identity",
      });

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            ...credential,
            expiresAt: now + 2 * 60 * 60_000,
          }),
          { status: 200 },
        )) as typeof fetch;
      await expect(
        fetchTurnCredential(new URL("https://relay.example/credentials"), undefined, now),
      ).rejects.toThrow(/short-lived/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
