/**
 * Detects a systemically broken run (upstream down, wrong URL, every call 500ing).
 * Keeps a sliding window of the last N outcomes; once the window is full and the
 * failure ratio reaches the threshold, it trips permanently for this job.
 *
 * Per-store attempt caps already stop individual stores looping forever; the
 * breaker stops the *job* from burning through all 5,000 stores x N attempts when
 * nothing can possibly succeed.
 */
export class CircuitBreaker {
  private readonly window: boolean[] = [];
  private failures = 0;
  private readonly reasons = new Map<string, number>();
  private trippedReason: string | null = null;

  constructor(
    private readonly size: number,
    private readonly failureRatio: number,
  ) {}

  record(success: boolean, reason?: string): void {
    if (this.trippedReason) return;
    this.window.push(success);
    if (!success) {
      this.failures++;
      if (reason) this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1);
    }
    if (this.window.length > this.size) {
      const dropped = this.window.shift();
      if (dropped === false) this.failures--;
    }
    if (this.window.length === this.size && this.failures / this.size >= this.failureRatio) {
      const top = [...this.reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
      this.trippedReason =
        `Systemic failure: ${this.failures} of the last ${this.size} enrichment calls failed ` +
        `(most common: ${top}). Job stopped to avoid retrying indefinitely.`;
    }
  }

  get tripped(): string | null {
    return this.trippedReason;
  }
}
