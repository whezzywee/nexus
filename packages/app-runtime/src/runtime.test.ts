import { describe, expect, it } from "vitest";
import { PHASE1_CHANNEL_ID, parseFreenetRuntimeConfig } from "./index";

describe("Freenet runtime configuration", () => {
  it("returns null when no real transport is configured", () => {
    expect(parseFreenetRuntimeConfig({})).toBeNull();
  });

  it("normalizes a complete configuration", () => {
    expect(
      parseFreenetRuntimeConfig({
        websocketUrl: "ws://127.0.0.1:7509/v1/contract/command?encodingProtocol=native",
        contractInstanceId: "contract-instance",
        contractCodeHash: "contract-code",
        displayName: " Mara ",
      }),
    ).toEqual({
      websocketUrl: "ws://127.0.0.1:7509/v1/contract/command",
      contractInstanceId: "contract-instance",
      contractCodeHash: "contract-code",
      peer: "b",
      displayName: "Mara",
      channelId: PHASE1_CHANNEL_ID,
    });
  });

  it("rejects partial or non-WebSocket configuration", () => {
    expect(() =>
      parseFreenetRuntimeConfig({
        websocketUrl: "ws://127.0.0.1:7509/v1/contract/command",
      }),
    ).toThrow(/requires a contract instance ID and contract code hash/);
    expect(() =>
      parseFreenetRuntimeConfig({
        websocketUrl: "https://gateway.invalid",
        contractInstanceId: "contract-instance",
        contractCodeHash: "contract-code",
      }),
    ).toThrow(/must use ws/);
  });
});
