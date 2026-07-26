import { base64UrlToBytes, bytesToBase64Url } from "@nexus/protocol";
import type { MeetingInvite } from "./meeting-links";

export type MeetingSignal =
  | { type: "offer"; description: RTCSessionDescriptionInit }
  | { type: "answer"; description: RTCSessionDescriptionInit }
  | { type: "ice"; candidate: RTCIceCandidateInit }
  | { type: "leave" };

export interface MeetingSignalingEvents {
  onReady(participants: string[]): void;
  onParticipantJoined(participantId: string): void;
  onParticipantLeft(participantId: string): void;
  onSignal(from: string, signal: MeetingSignal): void;
  onError(message: string): void;
  onDisconnected(): void;
}

interface EncryptedMeetingSignal {
  version: 1;
  sequence: number;
  sentAt: number;
  signal: MeetingSignal;
}

type MeetingServerFrame =
  | { type: "ready"; participants: string[] }
  | { type: "participant_joined"; participant_id: string }
  | { type: "participant_left"; participant_id: string }
  | { type: "signal"; from: string; to: string; ciphertext: string }
  | { type: "pong" }
  | { type: "error"; code: string; message: string };

export interface MeetingSignalingOptions {
  endpoint: URL;
  invite: MeetingInvite;
  participantId: string;
  events: MeetingSignalingEvents;
  socketFactory?: (url: string) => WebSocket;
}

const MAX_CLOCK_SKEW_MS = 30_000;
const MAX_SIGNAL_AGE_MS = 5 * 60_000;

export class MeetingSignalingClient {
  private socket: WebSocket | null = null;
  private key: CryptoKey | null = null;
  private sendSequence = 0;
  private readonly receiveSequences = new Map<string, number>();
  private intentionallyClosed = false;

  constructor(private readonly options: MeetingSignalingOptions) {}

  async connect(): Promise<void> {
    if (this.socket) throw new Error("Meeting signaling is already connected.");
    this.key = await importRoomKey(this.options.invite.roomKey);
    const socketUrl = meetingWebSocketUrl(
      this.options.endpoint,
      this.options.invite.roomId,
    ).toString();
    const socket = this.options.socketFactory?.(socketUrl) ?? new WebSocket(socketUrl);
    this.socket = socket;
    this.intentionallyClosed = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Meeting signaling did not connect in time."));
        socket.close();
      }, 10_000);
      socket.addEventListener(
        "open",
        () => {
          socket.send(
            JSON.stringify({
              type: "join",
              access_token: this.options.invite.accessToken,
              participant_id: this.options.participantId,
            }),
          );
        },
        { once: true },
      );
      const onMessage = (event: MessageEvent) => {
        let frame: MeetingServerFrame;
        try {
          frame = JSON.parse(String(event.data)) as MeetingServerFrame;
        } catch {
          clearTimeout(timer);
          reject(new Error("Meeting signaling returned malformed data."));
          socket.close();
          return;
        }
        if (frame.type === "ready") {
          clearTimeout(timer);
          socket.removeEventListener("message", onMessage);
          this.options.events.onReady(frame.participants);
          socket.addEventListener("message", (next) => void this.handleMessage(next));
          resolve();
        } else if (frame.type === "error") {
          clearTimeout(timer);
          socket.removeEventListener("message", onMessage);
          reject(new Error(frame.message));
          socket.close();
        }
      };
      socket.addEventListener("message", onMessage);
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Meeting signaling could not connect."));
        },
        { once: true },
      );
    });

    socket.addEventListener("close", () => {
      this.socket = null;
      if (!this.intentionallyClosed) this.options.events.onDisconnected();
    });
  }

  async sendSignal(recipientId: string, signal: MeetingSignal): Promise<void> {
    const socket = this.requireSocket();
    const key = this.requireKey();
    this.sendSequence += 1;
    const ciphertext = await encryptMeetingSignal(
      key,
      this.options.invite.roomId,
      this.options.participantId,
      recipientId,
      {
        version: 1,
        sequence: this.sendSequence,
        sentAt: Date.now(),
        signal,
      },
    );
    socket.send(
      JSON.stringify({
        type: "signal",
        to: recipientId,
        ciphertext,
      }),
    );
  }

  leave(): void {
    this.intentionallyClosed = true;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "leave" }));
    }
    this.socket?.close(1000, "Meeting left");
    this.socket = null;
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    let frame: MeetingServerFrame;
    try {
      frame = JSON.parse(String(event.data)) as MeetingServerFrame;
    } catch {
      this.options.events.onError("Meeting signaling returned malformed data.");
      return;
    }
    switch (frame.type) {
      case "participant_joined":
        if (frame.participant_id !== this.options.participantId) {
          this.options.events.onParticipantJoined(frame.participant_id);
        }
        return;
      case "participant_left":
        this.options.events.onParticipantLeft(frame.participant_id);
        return;
      case "signal": {
        if (frame.to !== this.options.participantId) return;
        try {
          const decrypted = await decryptMeetingSignal(
            this.requireKey(),
            this.options.invite.roomId,
            frame.from,
            frame.to,
            frame.ciphertext,
          );
          const previousSequence = this.receiveSequences.get(frame.from) ?? 0;
          if (decrypted.sequence <= previousSequence) {
            throw new Error("Meeting signal replayed.");
          }
          this.receiveSequences.set(frame.from, decrypted.sequence);
          this.options.events.onSignal(frame.from, decrypted.signal);
        } catch {
          this.options.events.onError("A meeting signal could not be authenticated.");
        }
        return;
      }
      case "error":
        this.options.events.onError(frame.message);
        return;
      default:
        return;
    }
  }

  private requireSocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Meeting signaling is not connected.");
    }
    return this.socket;
  }

  private requireKey(): CryptoKey {
    if (!this.key) throw new Error("Meeting encryption is not initialized.");
    return this.key;
  }
}

export function meetingWebSocketUrl(endpoint: URL, roomId: string): URL {
  const result = new URL(endpoint);
  if (result.protocol === "https:") result.protocol = "wss:";
  else if (
    (result.protocol === "http:" || result.protocol === "ws:") &&
    (result.hostname === "127.0.0.1" || result.hostname.toLowerCase() === "localhost")
  ) {
    result.protocol = "ws:";
  } else if (result.protocol !== "wss:") {
    throw new Error("Meeting signaling requires WSS or a loopback WS address.");
  }
  result.username = "";
  result.password = "";
  result.search = "";
  result.hash = "";
  result.pathname = `${result.pathname.replace(/\/$/, "")}/${encodeURIComponent(roomId)}`;
  return result;
}

export async function importRoomKey(encoded: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(encoded);
  if (bytes.byteLength !== 32) throw new Error("Meeting room key must contain 32 bytes.");
  return crypto.subtle.importKey("raw", Uint8Array.from(bytes), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptMeetingSignal(
  key: CryptoKey,
  roomId: string,
  senderId: string,
  recipientId: string,
  payload: EncryptedMeetingSignal,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: associatedData(roomId, senderId, recipientId),
      },
      key,
      plaintext,
    ),
  );
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv);
  combined.set(ciphertext, iv.byteLength);
  return bytesToBase64Url(combined);
}

async function decryptMeetingSignal(
  key: CryptoKey,
  roomId: string,
  senderId: string,
  recipientId: string,
  encoded: string,
  now = Date.now(),
): Promise<EncryptedMeetingSignal> {
  const combined = base64UrlToBytes(encoded);
  if (combined.byteLength < 29 || combined.byteLength > 64 * 1024) {
    throw new Error("Meeting ciphertext is invalid.");
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: combined.slice(0, 12),
      additionalData: associatedData(roomId, senderId, recipientId),
    },
    key,
    combined.slice(12),
  );
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as EncryptedMeetingSignal;
  if (
    payload.version !== 1 ||
    !Number.isSafeInteger(payload.sequence) ||
    payload.sequence < 1 ||
    !Number.isSafeInteger(payload.sentAt) ||
    payload.sentAt < now - MAX_SIGNAL_AGE_MS ||
    payload.sentAt > now + MAX_CLOCK_SKEW_MS ||
    !validMeetingSignal(payload.signal)
  ) {
    throw new Error("Meeting signal payload is invalid.");
  }
  return payload;
}

function associatedData(roomId: string, senderId: string, recipientId: string): ArrayBuffer {
  return new TextEncoder().encode(`nexus:meeting-signal:v1\0${roomId}\0${senderId}\0${recipientId}`)
    .buffer;
}

function validMeetingSignal(value: unknown): value is MeetingSignal {
  if (!value || typeof value !== "object") return false;
  const signal = value as Record<string, unknown>;
  if (signal.type === "leave") return true;
  if (signal.type === "ice")
    return Boolean(signal.candidate && typeof signal.candidate === "object");
  if (signal.type === "offer" || signal.type === "answer") {
    const description = signal.description as Record<string, unknown> | undefined;
    return description?.type === signal.type && typeof description.sdp === "string";
  }
  return false;
}
