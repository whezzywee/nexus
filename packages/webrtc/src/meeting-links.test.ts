import { describe, expect, it, vi } from "vitest";
import { stunIceServer } from "./index";
import {
  buildMeetingUrl,
  createMeetingHostSession,
  createMeetingInvite,
  MEETING_FRAGMENT_KEY,
  type MeetingInvite,
  parseMeetingUrl,
} from "./meeting-links";

const now = 1_800_000_000_000;
const invite: MeetingInvite = {
  version: 1,
  roomId: "01MEETINGROOM",
  roomName: "The observatory",
  accessToken: "v1.eyJyb29tIjoiMDEifQ.signature",
  roomKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  expiresAt: now + 3_600_000,
};

describe("meeting links", () => {
  it("keeps the invitation in the fragment and round-trips unicode names", () => {
    const link = buildMeetingUrl(
      new URL("https://meet.nexus.example/app?private=discarded#old"),
      { ...invite, roomName: "Café planning" },
      now,
    );

    expect(link.search).toBe("");
    expect(link.hash).toContain(MEETING_FRAGMENT_KEY);
    expect(link.href).not.toContain(invite.accessToken);
    expect(parseMeetingUrl(link, now)).toEqual({ ...invite, roomName: "Café planning" });
  });

  it("rejects expired, malformed, and insecure public links", () => {
    expect(() =>
      buildMeetingUrl(new URL("http://meet.example"), { ...invite, expiresAt: now - 1 }, now),
    ).toThrow();
    expect(() => parseMeetingUrl(new URL("https://meet.example/#nexus-meeting=%%%"), now)).toThrow(
      "malformed",
    );
    expect(() => buildMeetingUrl(new URL("http://meet.example"), invite, now)).toThrow("HTTPS");
  });

  it("allows loopback links for development", () => {
    expect(buildMeetingUrl(new URL("http://127.0.0.1:5173"), invite, now).origin).toBe(
      "http://127.0.0.1:5173",
    );
  });

  it("mints a bounded gateway invitation", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          roomId: invite.roomId,
          roomName: invite.roomName,
          accessToken: invite.accessToken,
          expiresAt: invite.expiresAt,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      createMeetingInvite(
        new URL("https://gateway.example/nexus/v1/meeting-invites"),
        "Bearer host-token",
        invite,
        now,
      ),
    ).resolves.toEqual({
      ...invite,
      roomKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer host-token" }),
      }),
    );
    fetcher.mockRestore();
  });

  it("exchanges a host passphrase for a short-lived meeting authorization", async () => {
    const passphrase = "host-passphrase-that-is-long-enough-123";
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: invite.accessToken,
          expiresAt: now + 15 * 60_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      createMeetingHostSession(
        new URL("https://gateway.example/nexus/v1/meeting-host-sessions"),
        passphrase,
        now,
      ),
    ).resolves.toEqual({
      authorization: `Bearer ${invite.accessToken}`,
      expiresAt: now + 15 * 60_000,
    });
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: "POST",
        headers: { authorization: `Nexus-Host ${passphrase}` },
      }),
    );
    fetcher.mockRestore();
  });
});

describe("STUN configuration", () => {
  it("accepts bounded comma-separated STUN URLs", () => {
    expect(stunIceServer("stun:stun.cloudflare.com:3478, stuns:stun.example.test:5349")).toEqual({
      urls: ["stun:stun.cloudflare.com:3478", "stuns:stun.example.test:5349"],
    });
    expect(stunIceServer("")).toBeNull();
    expect(() => stunIceServer("turn:relay.example.test:3478")).toThrow("STUN configuration");
  });
});
