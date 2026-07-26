import { describe, expect, it, vi } from "vitest";
import {
  MeetingSignalingClient,
  type MeetingSignalingEvents,
  meetingWebSocketUrl,
} from "./meeting-signaling";

class FakeMeetingSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: string[] = [];

  open() {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(frame: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

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

  it("serializes inbound frames before asynchronous signal processing", async () => {
    const socket = new FakeMeetingSocket();
    let socketCreated!: () => void;
    const socketObserved = new Promise<void>((resolve) => {
      socketCreated = resolve;
    });
    const events: MeetingSignalingEvents = {
      onReady: vi.fn(),
      onParticipantJoined: vi.fn(),
      onParticipantLeft: vi.fn(),
      onSignal: vi.fn(),
      onError: vi.fn(),
      onDisconnected: vi.fn(),
    };
    const client = new MeetingSignalingClient({
      endpoint: new URL("https://gateway.example/nexus/v1/meetings"),
      invite: {
        version: 1,
        roomId: "01MEETINGROOM",
        roomName: "Friends meeting",
        accessToken: "v1.test.signature",
        roomKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        expiresAt: Date.now() + 60_000,
      },
      participantId: "phone-local",
      events,
      socketFactory: () => {
        socketCreated();
        return socket as unknown as WebSocket;
      },
    });

    const connected = client.connect();
    await socketObserved;
    socket.open();
    socket.message({ type: "ready", participants: [] });
    await connected;

    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstObserved = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const handled: string[] = [];
    const internals = client as unknown as {
      handleMessage(event: MessageEvent): Promise<void>;
    };
    internals.handleMessage = async (event) => {
      const frame = JSON.parse(String(event.data)) as { marker: string };
      handled.push(`start:${frame.marker}`);
      if (frame.marker === "first") {
        firstStarted();
        await firstPaused;
      }
      handled.push(`finish:${frame.marker}`);
    };

    socket.message({ marker: "first" });
    await firstObserved;
    socket.message({ marker: "second" });
    await Promise.resolve();
    expect(handled).toEqual(["start:first"]);

    releaseFirst();
    await vi.waitFor(() => {
      expect(handled).toEqual(["start:first", "finish:first", "start:second", "finish:second"]);
    });
  });

  it("serializes encryption so signal sequence and wire order cannot diverge", async () => {
    const socket = new FakeMeetingSocket();
    let socketCreated!: () => void;
    const socketObserved = new Promise<void>((resolve) => {
      socketCreated = resolve;
    });
    const client = new MeetingSignalingClient({
      endpoint: new URL("https://gateway.example/nexus/v1/meetings"),
      invite: {
        version: 1,
        roomId: "01MEETINGROOM",
        roomName: "Friends meeting",
        accessToken: "v1.test.signature",
        roomKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        expiresAt: Date.now() + 60_000,
      },
      participantId: "phone-local",
      events: {
        onReady: vi.fn(),
        onParticipantJoined: vi.fn(),
        onParticipantLeft: vi.fn(),
        onSignal: vi.fn(),
        onError: vi.fn(),
        onDisconnected: vi.fn(),
      },
      socketFactory: () => {
        socketCreated();
        return socket as unknown as WebSocket;
      },
    });

    const connected = client.connect();
    await socketObserved;
    socket.open();
    socket.message({ type: "ready", participants: [] });
    await connected;

    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstObserved = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const sent: string[] = [];
    const internals = client as unknown as {
      encryptAndSend(recipientId: string, signal: { type: "leave" }): Promise<void>;
    };
    internals.encryptAndSend = async (recipientId) => {
      sent.push(`start:${recipientId}`);
      if (recipientId === "phone-first") {
        firstStarted();
        await firstPaused;
      }
      sent.push(`finish:${recipientId}`);
    };

    const first = client.sendSignal("phone-first", { type: "leave" });
    await firstObserved;
    const second = client.sendSignal("phone-second", { type: "leave" });
    await Promise.resolve();
    expect(sent).toEqual(["start:phone-first"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(sent).toEqual([
      "start:phone-first",
      "finish:phone-first",
      "start:phone-second",
      "finish:phone-second",
    ]);
  });
});
