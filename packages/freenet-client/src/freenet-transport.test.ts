import { describe, expect, it } from "vitest";

import { FreenetContractTransport } from "./freenet-transport";

describe("FreenetContractTransport", () => {
  it("accepts an instance-only Freenet contract key", () => {
    expect(
      () =>
        new FreenetContractTransport({
          websocketUrl: new URL("ws://127.0.0.1:50509/v1/contract/command"),
          contractInstanceId: "H8Xb5RstK955gw3AnTojRDPwm3hfvesFMsvAKCYLeYm5",
          contractCodeHash: "DNCJzd2jmmqb7Ya7wcGhzQ2FQER9VmL55wWzkS5b1e67",
        }),
    ).not.toThrow();
  });
});
