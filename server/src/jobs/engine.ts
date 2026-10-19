import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import { backoffDelayMs } from "../enrichment/backoff.js";
import { CircuitBreaker } from "../enrichment/circuitBreaker.js";
import { isRetryable, type EnrichmentClient, type EnrichOutcome } from "../enrichment/client.js";
import { RateLimiter, systemClock } from "../enrichment/rateLimiter.js";
import * as repo from "./repository.js";

type EngineConfig = Pick<
  AppConfig,
  | "ENRICH_CONCURRENCY"
  | "ENRICH_SOFT_TIMEOUT_MS"
  | "ENRICH_LEASE_MS"
  | "ENRICH_MAX_ATTEMPTS"
  | "ENRICH_BACKOFF_BASE_MS"
  | "ENRICH_BACKOFF_MAX_MS"
  | "BREAKER_WINDOW"
  | "BREAKER_FAILURE_RATIO"
>;

const IDLE_POLL_MS = 250;
const REAPER_INTERVAL_MS = 2_000;
const RATE_LIMIT_PENALTY_MS = 1_000;

interface RunState {
  jobId: string;
  stopped: boolean;
  breaker: CircuitBreaker;
  /** Detached calls abandoned on soft timeout; awaited only for clean shutdown. */
  detached: Set<Promise<void>>;
  done: Promise<void>;
}

/**
 * The job engine. Units of work live in Postgres (job_stores); the engine is a
 * stateless pool of workers that claim, call, and commit. Because all state is in
 * the DB, a crashed process can be restarted and `resumeRunningJobs()` continues
 * exactly where it left off (expired leases are reclaimed by the reaper).
 *
 * Timeout model:
 *  - soft timeout: worker stops waiting, reschedules the store (counted attempt)
 *    and moves on. The HTTP call keeps running "detached".
 *  - hard timeout: the detached call is aborted.
 *  - a late success from a detached call is still committed idempotently.
 *  - DB lease: covers the case where the worker itself dies.
 */
export class JobEngine {
  private readonly runs = new Map<string, RunState>();

  constructor(
    private readonly client: EnrichmentClient,
    /** Shared across all runs so the upstream limit is global. */
    private readonly limiter: RateLimiter,
    private readonly cfg: EngineConfig,
  ) {}

  isRunning(jobId: string): boolean {
    return this.runs.has(jobId);
  }

  start(jobId: string): void {
    if (this.runs.has(jobId)) return;
    const state: RunState = {
      jobId,
      stopped: false,
      breaker: new CircuitBreaker(this.cfg.BREAKER_WINDOW, this.cfg.BREAKER_FAILURE_RATIO),
      detached: new Set(),
      done: Promise.resolve(),
    };
    this.runs.set(jobId, state);
    state.done = this.run(state).finally(() => this.runs.delete(jobId));
    logger.info({ jobId }, "job started");
  }

  async resumeRunningJobs(): Promise<void> {
    for (const job of await repo.findRunningJobs()) {
      logger.info({ jobId: job.id }, "resuming job after restart");
      this.start(job.id);
    }
  }

  async cancel(jobId: string): Promise<boolean> {
    const finished = await repo.finishJob(jobId, "cancelled", "Cancelled by user");
    const state = this.runs.get(jobId);
    if (state) state.stopped = true;
    return finished;
  }

  /** Graceful shutdown: stop claiming; leases on in-flight work expire and are reclaimed on next boot. */
  async shutdown(): Promise<void> {
    for (const s of this.runs.values()) s.stopped = true;
    await Promise.all([...this.runs.values()].map((s) => s.done));
  }

  /** Test helper: resolves when the run (and any detached calls) have settled. */
  async waitFor(jobId: string): Promise<void> {
    const s = this.runs.get(jobId);
    if (!s) return;
    await s.done;
    await Promise.all(s.detached);
  }

  private async run(state: RunState): Promise<void> {
    const reaper = setInterval(() => {
      repo
        .reclaimExpiredLeases(state.jobId, this.cfg.ENRICH_MAX_ATTEMPTS)
        .then((n) => n > 0 && logger.warn({ jobId: state.jobId, reclaimed: n }, "reclaimed expired leases"))
        .catch((err) => logger.error(err, "reaper failed"));
    }, REAPER_INTERVAL_MS);
    try {
      const workers = Array.from({ length: this.cfg.ENRICH_CONCURRENCY }, (_, i) => this.worker(state, i));
      await Promise.all(workers);
      await this.finalize(state);
    } catch (err) {
      logger.error({ err, jobId: state.jobId }, "job engine crashed");
      await repo.finishJob(state.jobId, "failed", `Internal error: ${(err as Error).message}`).catch(() => {});
    } finally {
      clearInterval(reaper);
    }
  }

  private async worker(state: RunState, workerId: number): Promise<void> {
    while (!state.stopped) {
      if (state.breaker.tripped) return;

      const store = await repo.claimNextStore(state.jobId, this.cfg.ENRICH_LEASE_MS);
      if (!store) {
        if (await this.isDrained(state.jobId)) return;
        await systemClock.sleep(await this.idleDelay(state.jobId));
        continue;
      }
      // Pace *after* claiming so idle workers never hold a rate slot; lease (15s) >> max slot wait.
      await this.limiter.acquire();
      if (state.stopped) {
        await repo.releaseUnattempted(store);
        return;
      }
      await this.process(state, store, workerId);
    }
  }

  private async process(state: RunState, store: repo.ClaimedStore, workerId: number): Promise<void> {
    const startedAt = Date.now();
    const call = this.client.enrich({
      store_id: store.store_id,
      store_name: store.store_name,
      address: store.address,
      city: store.city,
      state: store.state,
    });

    let softTimer: NodeJS.Timeout | undefined;
    const soft = new Promise<"soft_timeout">((resolve) => {
      softTimer = setTimeout(() => resolve("soft_timeout"), this.cfg.ENRICH_SOFT_TIMEOUT_MS);
    });
    const first = await Promise.race([call, soft]);
    clearTimeout(softTimer);

    if (first === "soft_timeout") {
      await this.onSoftTimeout(state, store, call, startedAt);
      return;
    }
    await this.onOutcome(state, store, first, Date.now() - startedAt, workerId);
  }

  private async onOutcome(
    state: RunState,
    store: repo.ClaimedStore,
    outcome: EnrichOutcome,
    durationMs: number,
    workerId: number,
  ): Promise<void> {
    if (outcome.kind === "success") {
      await repo.commitSuccess(store, outcome.metrics, durationMs);
      state.breaker.record(true);
      return;
    }

    const status = "status" in outcome ? outcome.status : null;
    await repo.recordAttempt(store, outcome.kind, status, outcome.detail, durationMs);
    state.breaker.record(false, outcome.kind);

    if (!isRetryable(outcome)) {
      await repo.failPermanently(store, `Non-retryable: ${outcome.detail}`);
      return;
    }

    const isRateLimited = outcome.kind === "rate_limited";
    if (isRateLimited) this.limiter.penalize(RATE_LIMIT_PENALTY_MS);
    const delayMs = isRateLimited
      ? RATE_LIMIT_PENALTY_MS
      : backoffDelayMs(store.attempts, { baseMs: this.cfg.ENRICH_BACKOFF_BASE_MS, maxMs: this.cfg.ENRICH_BACKOFF_MAX_MS });

    const result = await repo.releaseForRetry(store, {
      error: `${outcome.kind}: ${outcome.detail}`,
      delayMs,
      maxAttempts: this.cfg.ENRICH_MAX_ATTEMPTS,
      refundAttempt: isRateLimited, // 429 is our pacing problem, not the store's
    });
    if (result === "failed") {
      logger.debug({ workerId, store: store.store_id }, "store exhausted retries");
    }
    this.checkBreaker(state);
  }

  private async onSoftTimeout(
    state: RunState,
    store: repo.ClaimedStore,
    call: Promise<EnrichOutcome>,
    startedAt: number,
  ): Promise<void> {
    const detail = `No response within ${this.cfg.ENRICH_SOFT_TIMEOUT_MS}ms; rescheduled`;
    await repo.recordAttempt(store, "soft_timeout", null, detail, Date.now() - startedAt);
    state.breaker.record(false, "soft_timeout");
    await repo.releaseForRetry(store, {
      error: `soft_timeout: ${detail}`,
      delayMs: backoffDelayMs(store.attempts, {
        baseMs: this.cfg.ENRICH_BACKOFF_BASE_MS,
        maxMs: this.cfg.ENRICH_BACKOFF_MAX_MS,
      }),
      maxAttempts: this.cfg.ENRICH_MAX_ATTEMPTS,
      refundAttempt: false,
    });
    this.checkBreaker(state);

    // Let the original call finish in the background. If it eventually succeeds,
    // commit idempotently; if a retry already succeeded this is a no-op ("duplicate").
    const tracked = call
      .then(async (late) => {
        const ms = Date.now() - startedAt;
        if (late.kind === "success") {
          const result = await repo.commitLateSuccess(store, late.metrics, ms);
          logger.info({ store: store.store_id, result, ms }, "late response arrived");
        } else {
          await repo.recordAttempt(store, `late_${late.kind}`, null, late.detail, ms);
        }
      })
      .catch((err) => logger.error({ err, store: store.store_id }, "late response handling failed"))
      .finally(() => state.detached.delete(tracked));
    state.detached.add(tracked);
  }

  private checkBreaker(state: RunState): void {
    if (state.breaker.tripped && !state.stopped) {
      state.stopped = true;
      logger.error({ jobId: state.jobId, reason: state.breaker.tripped }, "circuit breaker tripped");
    }
  }

  private async isDrained(jobId: string): Promise<boolean> {
    const c = await repo.getStatusCounts(jobId);
    return c.pending === 0 && c.in_flight === 0;
  }

  private async idleDelay(jobId: string): Promise<number> {
    const due = await repo.nextDueAt(jobId);
    if (!due) return IDLE_POLL_MS;
    return Math.min(Math.max(due.getTime() - Date.now(), 25), IDLE_POLL_MS * 4);
  }

  private async finalize(state: RunState): Promise<void> {
    if (state.breaker.tripped) {
      await repo.finishJob(state.jobId, "failed", state.breaker.tripped);
      return;
    }
    if (await this.isDrained(state.jobId)) {
      await repo.finishJob(state.jobId, "completed");
      logger.info({ jobId: state.jobId }, "job completed");
    }
    // Otherwise stopped via cancel/shutdown: status already set (or left 'running' for resume).
  }
}
