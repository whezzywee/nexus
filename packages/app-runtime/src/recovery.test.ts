import { createLocalIdentity } from "@nexus/identity";
import { describe, expect, it } from "vitest";
import { createRecoveryFile, installRecoveredLinkedDevice, rehearseRecoveryFile } from "./recovery";

describe("recovery workflows", () => {
  it("rehearses without changing the identity and installs a distinct linked device", async () => {
    const identity = await createLocalIdentity("Mara");
    const passphrase = "a long recovery phrase";
    const payload = await createRecoveryFile(identity, passphrase);
    const rehearsal = await rehearseRecoveryFile(payload, passphrase, identity.identityId);
    expect(rehearsal.matchesCurrentIdentity).toBe(true);

    let stored = "";
    const linked = await installRecoveredLinkedDevice(
      payload,
      passphrase,
      {
        async load() {
          return stored || null;
        },
        async save(_profile, value) {
          stored = value;
        },
      },
      "recovered",
    );
    expect(linked.identity.identityId).toBe(identity.identityId);
    expect(linked.identity.deviceId).not.toBe(identity.deviceId);
    expect(stored).toContain(linked.identity.deviceId);
  }, 20_000);

  it("rejects malformed files and incorrect passphrases", async () => {
    const identity = await createLocalIdentity("Mara");
    const payload = await createRecoveryFile(identity, "a long recovery phrase");
    await expect(rehearseRecoveryFile("not-json", "a long recovery phrase", "")).rejects.toThrow(
      "valid JSON",
    );
    await expect(rehearseRecoveryFile(payload, "the wrong passphrase", "")).rejects.toThrow();
  }, 20_000);
});
