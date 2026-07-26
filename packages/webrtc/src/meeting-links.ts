import { base64UrlToBytes, bytesToBase64Url } from "@nexus/protocol";

export const MEETING_LINK_VERSION = 1;
export const MEETING_FRAGMENT_KEY = "nexus-meeting";

export interface MeetingInvite {
  version: typeof MEETING_LINK_VERSION;
  roomId: string;
  roomName: string;
  accessToken: string;
  roomKey: string;
  expiresAt: number;
}

interface MeetingInviteResponse {
  roomId: string;
  roomName: string;
  accessToken: string;
  expiresAt: number;
}

interface MeetingHostSessionResponse {
  accessToken: string;
  expiresAt: number;
}

export interface MeetingHostSession {
  authorization: string;
  expiresAt: number;
}

const roomIdPattern = /^[A-Za-z0-9_-]{8,64}$/;
const accessTokenPattern = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const roomKeyPattern = /^[A-Za-z0-9_-]{43}$/;

export function validateMeetingInvite(invite: MeetingInvite, now = Date.now()): MeetingInvite {
  if (invite.version !== MEETING_LINK_VERSION) {
    throw new Error("This meeting link uses an unsupported version.");
  }
  if (!roomIdPattern.test(invite.roomId)) {
    throw new Error("The meeting room identifier is invalid.");
  }
  const roomName = invite.roomName.trim();
  if (!roomName || roomName.length > 80) {
    throw new Error("The meeting room name is invalid.");
  }
  if (invite.accessToken.length > 4096 || !accessTokenPattern.test(invite.accessToken)) {
    throw new Error("The meeting invitation is invalid.");
  }
  if (!roomKeyPattern.test(invite.roomKey) || base64UrlToBytes(invite.roomKey).byteLength !== 32) {
    throw new Error("The meeting encryption key is invalid.");
  }
  if (
    !Number.isSafeInteger(invite.expiresAt) ||
    invite.expiresAt <= now ||
    invite.expiresAt > now + 7 * 24 * 60 * 60_000
  ) {
    throw new Error("The meeting link has expired or has an invalid lifetime.");
  }
  return { ...invite, roomName };
}

export function buildMeetingUrl(baseUrl: URL, invite: MeetingInvite, now = Date.now()): URL {
  const validated = validateMeetingInvite(invite, now);
  requireShareableWebOrigin(baseUrl);
  const result = new URL(baseUrl);
  result.search = "";
  result.hash = new URLSearchParams({
    [MEETING_FRAGMENT_KEY]: encodeInvite(validated),
  }).toString();
  return result;
}

export function parseMeetingUrl(url: URL, now = Date.now()): MeetingInvite | null {
  const encoded = new URLSearchParams(url.hash.replace(/^#/, "")).get(MEETING_FRAGMENT_KEY);
  if (!encoded) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  } catch {
    throw new Error("The meeting link is malformed.");
  }
  if (!isMeetingInvite(payload)) {
    throw new Error("The meeting link is malformed.");
  }
  return validateMeetingInvite(payload, now);
}

export async function createMeetingInvite(
  endpoint: URL,
  authorization: string,
  room: { roomId: string; roomName: string },
  now = Date.now(),
): Promise<MeetingInvite> {
  requireGatewayEndpoint(endpoint);
  if (!authorization.trim()) {
    throw new Error("Meeting invitation authorization is unavailable.");
  }
  if (
    !roomIdPattern.test(room.roomId) ||
    !room.roomName.trim() ||
    room.roomName.trim().length > 80
  ) {
    throw new Error("The meeting room is invalid.");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      roomId: room.roomId,
      roomName: room.roomName.trim(),
    }),
  });
  if (!response.ok) {
    throw new Error(`Meeting invitation request failed (${response.status}).`);
  }
  const payload = (await response.json()) as MeetingInviteResponse;
  return validateMeetingInvite(
    {
      version: MEETING_LINK_VERSION,
      roomId: payload.roomId,
      roomName: payload.roomName,
      accessToken: payload.accessToken,
      roomKey: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))),
      expiresAt: payload.expiresAt,
    },
    now,
  );
}

export async function createMeetingHostSession(
  endpoint: URL,
  passphrase: string,
  now = Date.now(),
): Promise<MeetingHostSession> {
  requireGatewayEndpoint(endpoint);
  const secret = passphrase.trim();
  if (secret.length < 32 || secret.length > 256) {
    throw new Error("The host passphrase must contain between 32 and 256 characters.");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Nexus-Host ${secret}`,
    },
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "The host passphrase is incorrect."
        : `Meeting host access failed (${response.status}).`,
    );
  }
  const payload = (await response.json()) as MeetingHostSessionResponse;
  if (
    !accessTokenPattern.test(payload.accessToken) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= now + 30_000 ||
    payload.expiresAt > now + 60 * 60_000
  ) {
    throw new Error("The meeting host session is invalid or not short-lived.");
  }
  return {
    authorization: `Bearer ${payload.accessToken}`,
    expiresAt: payload.expiresAt,
  };
}

function encodeInvite(invite: MeetingInvite): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(invite)));
}

function isMeetingInvite(value: unknown): value is MeetingInvite {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === MEETING_LINK_VERSION &&
    typeof candidate.roomId === "string" &&
    typeof candidate.roomName === "string" &&
    typeof candidate.accessToken === "string" &&
    typeof candidate.roomKey === "string" &&
    typeof candidate.expiresAt === "number"
  );
}

function requireShareableWebOrigin(url: URL): void {
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname.toLowerCase() === "localhost")
    )
  ) {
    throw new Error("Meeting links require HTTPS or a loopback development address.");
  }
}

function requireGatewayEndpoint(url: URL): void {
  requireShareableWebOrigin(url);
  if (url.username || url.password) {
    throw new Error("Meeting invitation endpoints cannot contain URL credentials.");
  }
}
