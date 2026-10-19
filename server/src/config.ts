import "dotenv/config";
import { z } from "zod";

/**
 * All tunables live here so resilience behaviour can be reasoned about (and
 * changed) in one place. Defaults are chosen against the simulator contract:
 * 5 req/s global limit, ~0.2-0.5s normal latency, 45-60s hangs.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().default("postgres://tierforge:tierforge@localhost:5432/tierforge"),
  ENRICHMENT_API_URL: z.string().url().default("http://localhost:8000"),

  /** Client-side rate. Kept below the upstream 5 rps to absorb timer jitter. */
  ENRICH_RATE_PER_SECOND: z.coerce.number().positive().default(4.5),
  /** Max calls whose worker is actively waiting. Hung calls are detached, so this stays small. */
  ENRICH_CONCURRENCY: z.coerce.number().int().positive().default(6),
  /** After this, the worker gives up waiting, reschedules the store and moves on. */
  ENRICH_SOFT_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
  /** Detached call is aborted after this; a success before then is still accepted. */
  ENRICH_HARD_TIMEOUT_MS: z.coerce.number().int().positive().default(75_000),
  /** DB lease: if a worker/process dies, the reaper reclaims the store after this. */
  ENRICH_LEASE_MS: z.coerce.number().int().positive().default(15_000),
  /** Attempts per store before it is marked permanently failed (429s are not counted). */
  ENRICH_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
  ENRICH_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(500),
  ENRICH_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(30_000),
  /** Circuit breaker: job fails if >= ratio of the last N outcomes were failures. */
  BREAKER_WINDOW: z.coerce.number().int().positive().default(60),
  BREAKER_FAILURE_RATIO: z.coerce.number().min(0).max(1).default(0.9),

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  MAX_STORES_PER_JOB: z.coerce.number().int().positive().default(100_000),
});

export type AppConfig = z.infer<typeof schema>;
export const config: AppConfig = schema.parse(process.env);
