export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Process-wide pacing limiter. Hands out evenly spaced slots (1/rate apart) so we
 * never burst, which matters because the upstream uses a fixed 1-second window.
 *
 * A single instance is shared by every worker (and would be shared by every job if
 * multiple jobs ran), so the upstream limit is honoured globally.
 * `penalize()` pushes all future slots back when the upstream returns 429.
 */
export class RateLimiter {
  private readonly intervalMs: number;
  private nextSlotAt = 0;

  constructor(
    ratePerSecond: number,
    private readonly clock: Clock = systemClock,
  ) {
    if (ratePerSecond <= 0) throw new Error("ratePerSecond must be > 0");
    this.intervalMs = 1000 / ratePerSecond;
  }

  /** Resolves when the caller may issue one request. Slot reservation is synchronous, so it is race-free. */
  async acquire(): Promise<void> {
    const now = this.clock.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + this.intervalMs;
    const wait = slot - now;
    if (wait > 0) await this.clock.sleep(wait);
  }

  penalize(ms: number): void {
    this.nextSlotAt = Math.max(this.nextSlotAt, this.clock.now() + ms);
  }
}
