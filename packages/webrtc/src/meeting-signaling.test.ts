import { describe, expect, it } from "vitest";
import { meetingWebSocketUrl } from "./meeting-signaling";

describe("meeting signaling", () => {
  it("derives a room websocket without placing the capability in its URL", () => {
    expect(
      meetingWebSocketUrl(
        new URL("https://gateway.example/nexus/v1/meetings?token=discarded"),
        "01MEETINGROOM",
      ).toString(),
    ).toBe("wss://gateway.example/nexus/v1/meetings/01MEETINGROOM");
  });

  it("allows loopback development and rejects public plaintext signaling", () => {
    expect(
      meetingWebSocketUrl(new URL("http://127.0.0.1:8787/nexus/v1/meetings"), "01MEETINGROOM")
        .protocol,
    ).toBe("ws:");
    expect(() =>
      meetingWebSocketUrl(new URL("http://gateway.example/nexus/v1/meetings"), "01MEETINGROOM"),
    ).toThrow("WSS");
  });
});
