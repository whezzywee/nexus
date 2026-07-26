export interface InvitationRateStatus {
  remaining: number;
  retryAfterSeconds: number;
}

export class InvitationAttemptLimiter {
  private readonly attempts: number[] = [];
  private readonly duplicateAttempts = new Map<string, number>();

  constructor(
    private readonly maximumAttempts = 5,
    private readonly windowMs = 10 * 60_000,
    private readonly duplicateCooldownMs = 30_000,
  ) {}

  consume(fingerprint: string, now = Date.now()): InvitationRateStatus {
    this.prune(now);
    const previousDuplicate = this.duplicateAttempts.get(fingerprint);
    if (previousDuplicate !== undefined && now - previousDuplicate < this.duplicateCooldownMs) {
      const retryAfterSeconds = Math.ceil(
        (this.duplicateCooldownMs - (now - previousDuplicate)) / 1_000,
      );
      throw new Error(`This invitation was just attempted. Try again in ${retryAfterSeconds}s.`);
    }
    if (this.attempts.length >= this.maximumAttempts) {
      const retryAfterSeconds = Math.ceil(
        (this.windowMs - (now - (this.attempts[0] ?? now))) / 1_000,
      );
      throw new Error(`Invitation limit reached. Try again in ${retryAfterSeconds}s.`);
    }

    this.attempts.push(now);
    this.duplicateAttempts.set(fingerprint, now);
    return this.status(now);
  }

  status(now = Date.now()): InvitationRateStatus {
    this.prune(now);
    return {
      remaining: Math.max(0, this.maximumAttempts - this.attempts.length),
      retryAfterSeconds:
        this.attempts.length >= this.maximumAttempts
          ? Math.ceil((this.windowMs - (now - (this.attempts[0] ?? now))) / 1_000)
          : 0,
    };
  }

  private prune(now: number) {
    while (this.attempts.length > 0 && now - (this.attempts[0] ?? now) >= this.windowMs) {
      this.attempts.shift();
    }
    for (const [fingerprint, attemptedAt] of this.duplicateAttempts) {
      if (now - attemptedAt >= this.duplicateCooldownMs) {
        this.duplicateAttempts.delete(fingerprint);
      }
    }
  }
}
