import { describe, expect, it } from "vitest";
import { InvitationAttemptLimiter } from "./invite-limits";

describe("invitation attempt limiter", () => {
  it("blocks rapid duplicate invitations with a useful retry message", () => {
    const limiter = new InvitationAttemptLimiter();
    expect(limiter.consume("identity:device", 1_000).remaining).toBe(4);
    expect(() => limiter.consume("identity:device", 2_000)).toThrow(/Try again in 29s/);
  });

  it("bounds attempts and recovers when the rolling window expires", () => {
    const limiter = new InvitationAttemptLimiter(2, 10_000, 100);
    limiter.consume("first", 1_000);
    limiter.consume("second", 2_000);
    expect(() => limiter.consume("third", 3_000)).toThrow(/Try again in 8s/);
    expect(limiter.consume("third", 11_001).remaining).toBe(0);
    expect(limiter.consume("fourth", 12_001).remaining).toBe(0);
  });
});
