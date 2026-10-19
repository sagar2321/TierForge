/**
 * Exponential backoff with "full jitter" (AWS architecture blog): a random delay in
 * [0, min(cap, base * 2^(attempt-1))]. Jitter de-synchronises retries so failed
 * calls don't stampede the rate-limited upstream together.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { baseMs: number; maxMs: number },
  random: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(attempt));
  const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** (n - 1));
  return Math.floor(random() * ceiling);
}
