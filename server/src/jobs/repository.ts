import { randomUUID } from "node:crypto";
import { pool, withTransaction, type Queryable } from "../db/pool.js";
import type { StoreRow } from "../domain/csv.js";
import type { EnrichMetrics } from "../enrichment/client.js";

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface JobRow {
  id: string;
  file_name: string;
  status: JobStatus;
  total_stores: number;
  failure_reason: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export interface ClaimedStore {
  job_id: string;
  store_id: string;
  store_name: string;
  address: string;
  city: string;
  state: string;
  attempts: number;
  lease_token: string;
}

export class ActiveJobExistsError extends Error {
  constructor() {
    super("Another enrichment job is already running. Wait for it to finish or cancel it.");
  }
}

/** Creates the job and all its units of work atomically (one round-trip for the rows). */
export async function createJob(fileName: string, rows: StoreRow[]): Promise<JobRow> {
  try {
    return await withTransaction(async (tx) => {
      const { rows: jobRows } = await tx.query<JobRow>(
        `INSERT INTO jobs (file_name, total_stores) VALUES ($1, $2) RETURNING *`,
        [fileName, rows.length],
      );
      const job = jobRows[0]!;
      const col = (k: keyof StoreRow) => rows.map((r) => r[k]);
      await tx.query(
        `INSERT INTO job_stores (job_id, store_id, store_name, address, city, state, country)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])`,
        [job.id, col("store_id"), col("store_name"), col("address"), col("city"), col("state"), col("country")],
      );
      return job;
    });
  } catch (err) {
    if ((err as { code?: string; constraint?: string }).constraint === "jobs_single_active") {
      throw new ActiveJobExistsError();
    }
    throw err;
  }
}

export async function getJob(jobId: string, db: Queryable = pool): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
  return rows[0] ?? null;
}

export async function getLatestJob(): Promise<JobRow | null> {
  const { rows } = await pool.query<JobRow>(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT 1`);
  return rows[0] ?? null;
}

export async function findRunningJobs(): Promise<JobRow[]> {
  const { rows } = await pool.query<JobRow>(`SELECT * FROM jobs WHERE status = 'running'`);
  return rows;
}

/**
 * Atomically claims the next due store. FOR UPDATE SKIP LOCKED means concurrent
 * workers (or processes) never claim the same row, and never block each other.
 */
export async function claimNextStore(jobId: string, leaseMs: number): Promise<ClaimedStore | null> {
  const { rows } = await pool.query<ClaimedStore>(
    `UPDATE job_stores s
        SET status = 'in_flight',
            attempts = s.attempts + 1,
            lease_token = $2,
            lease_expires_at = now() + make_interval(secs => $3::double precision / 1000),
            updated_at = now()
      WHERE (s.job_id, s.store_id) = (
              SELECT job_id, store_id FROM job_stores
               WHERE job_id = $1 AND status = 'pending' AND next_attempt_at <= now()
               ORDER BY next_attempt_at
               LIMIT 1
               FOR UPDATE SKIP LOCKED)
  RETURNING s.job_id, s.store_id, s.store_name, s.address, s.city, s.state, s.attempts, s.lease_token`,
    [jobId, randomUUID(), leaseMs],
  );
  return rows[0] ?? null;
}

export type CommitResult = "success" | "late_success" | "duplicate";

/**
 * Records a successful response. Deliberately NOT guarded by lease token: the
 * upstream is deterministic, so a late answer from a reclaimed attempt is valid
 * data. Idempotency comes from the result PK + the conditional status update, so
 * whichever response lands first wins and later ones are no-ops (never double-counted).
 */
export async function commitSuccess(
  store: ClaimedStore,
  metrics: EnrichMetrics,
  durationMs: number,
): Promise<CommitResult> {
  return withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO enrichment_results (job_id, store_id, estimated_monthly_footfall, estimated_monthly_revenue, store_size_sqft)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (job_id, store_id) DO NOTHING`,
      [
        store.job_id,
        store.store_id,
        metrics.estimated_monthly_footfall,
        metrics.estimated_monthly_revenue,
        metrics.store_size_sqft,
      ],
    );
    const { rowCount } = await tx.query(
      `UPDATE job_stores
          SET status = 'succeeded', lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = now()
        WHERE job_id = $1 AND store_id = $2 AND status <> 'succeeded'`,
      [store.job_id, store.store_id],
    );
    const result: CommitResult = rowCount === 0 ? "duplicate" : "success";
    await insertAttempt(tx, store, result, null, null, durationMs);
    return result;
  });
}

/** Marks a store whose original attempt was abandoned but whose late answer was accepted. */
export async function commitLateSuccess(
  store: ClaimedStore,
  metrics: EnrichMetrics,
  durationMs: number,
): Promise<CommitResult> {
  const result = await commitSuccess(store, metrics, durationMs);
  if (result === "success") {
    await pool.query(
      `UPDATE enrichment_attempts SET outcome = 'late_success'
        WHERE id = (SELECT max(id) FROM enrichment_attempts WHERE job_id = $1 AND store_id = $2 AND lease_token = $3)`,
      [store.job_id, store.store_id, store.lease_token],
    );
    return "late_success";
  }
  return result;
}

/**
 * Releases a store after a failed attempt. Guarded by lease token: if the lease
 * was already reclaimed (by the reaper or a soft timeout) we must not touch the row.
 * Exhausted stores become terminally 'failed' with the last error as the reason.
 */
export async function releaseForRetry(
  store: ClaimedStore,
  opts: { error: string; delayMs: number; maxAttempts: number; refundAttempt: boolean },
): Promise<"retry" | "failed" | "lease_lost"> {
  const { rows } = await pool.query<{ status: string }>(
    `UPDATE job_stores
        SET attempts = attempts - $4::int,
            rate_limited = rate_limited + $4::int,
            status = CASE WHEN attempts - $4::int >= $5 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = now() + make_interval(secs => $6::double precision / 1000),
            lease_token = NULL, lease_expires_at = NULL,
            last_error = $3, updated_at = now()
      WHERE job_id = $1 AND store_id = $2 AND lease_token = $7 AND status = 'in_flight'
  RETURNING status`,
    [
      store.job_id,
      store.store_id,
      opts.error,
      opts.refundAttempt ? 1 : 0,
      opts.maxAttempts,
      opts.delayMs,
      store.lease_token,
    ],
  );
  const row = rows[0];
  if (!row) return "lease_lost";
  return row.status === "failed" ? "failed" : "retry";
}

/** Gives a claimed store back without counting an attempt (no call was made). */
export async function releaseUnattempted(store: ClaimedStore): Promise<void> {
  await pool.query(
    `UPDATE job_stores SET status = 'pending', attempts = attempts - 1, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE job_id = $1 AND store_id = $2 AND lease_token = $3 AND status = 'in_flight'`,
    [store.job_id, store.store_id, store.lease_token],
  );
}

/** Store failed for a non-retryable reason (e.g. 4xx): fail immediately. */
export async function failPermanently(store: ClaimedStore, error: string): Promise<void> {
  await pool.query(
    `UPDATE job_stores SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, last_error = $3, updated_at = now()
      WHERE job_id = $1 AND store_id = $2 AND lease_token = $4 AND status = 'in_flight'`,
    [store.job_id, store.store_id, error, store.lease_token],
  );
}

export async function recordAttempt(
  store: ClaimedStore,
  outcome: string,
  httpStatus: number | null,
  detail: string | null,
  durationMs: number,
): Promise<void> {
  await insertAttempt(pool, store, outcome, httpStatus, detail, durationMs);
}

async function insertAttempt(
  db: Queryable,
  store: ClaimedStore,
  outcome: string,
  httpStatus: number | null,
  detail: string | null,
  durationMs: number,
): Promise<void> {
  await db.query(
    `INSERT INTO enrichment_attempts (job_id, store_id, lease_token, outcome, http_status, detail, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [store.job_id, store.store_id, store.lease_token, outcome, httpStatus, detail, Math.round(durationMs)],
  );
}

/** Reclaims stores whose lease expired (worker crashed / process restarted). */
export async function reclaimExpiredLeases(jobId: string, maxAttempts: number): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE job_stores
        SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
            lease_token = NULL, lease_expires_at = NULL, next_attempt_at = now(),
            last_error = 'Lease expired: worker stopped responding', updated_at = now()
      WHERE job_id = $1 AND status = 'in_flight' AND lease_expires_at < now()`,
    [jobId, maxAttempts],
  );
  return rowCount ?? 0;
}

export interface StatusCounts {
  pending: number;
  in_flight: number;
  succeeded: number;
  failed: number;
}

export async function getStatusCounts(jobId: string): Promise<StatusCounts> {
  const { rows } = await pool.query<StatusCounts>(
    `SELECT count(*) FILTER (WHERE status = 'pending')   AS pending,
            count(*) FILTER (WHERE status = 'in_flight') AS in_flight,
            count(*) FILTER (WHERE status = 'succeeded') AS succeeded,
            count(*) FILTER (WHERE status = 'failed')    AS failed
       FROM job_stores WHERE job_id = $1`,
    [jobId],
  );
  return rows[0]!;
}

/** Earliest time a pending store becomes due (null if none pending). */
export async function nextDueAt(jobId: string): Promise<Date | null> {
  const { rows } = await pool.query<{ at: Date | null }>(
    `SELECT min(next_attempt_at) AS at FROM job_stores WHERE job_id = $1 AND status = 'pending'`,
    [jobId],
  );
  return rows[0]?.at ?? null;
}

export async function finishJob(
  jobId: string,
  status: Exclude<JobStatus, "running">,
  failureReason: string | null = null,
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE jobs SET status = $2, failure_reason = $3, finished_at = now() WHERE id = $1 AND status = 'running'`,
      [jobId, status, failureReason],
    );
    if (!rowCount) return false;
    // A stopped job has no owner for its leases: hand them back so counts are honest
    // (late responses can still land, since commitSuccess is not lease-guarded).
    await tx.query(
      `UPDATE job_stores SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE job_id = $1 AND status = 'in_flight'`,
      [jobId],
    );
    return true;
  });
}

export async function getAttemptStats(jobId: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ outcome: string; n: number }>(
    `SELECT outcome, count(*) AS n FROM enrichment_attempts WHERE job_id = $1 GROUP BY outcome`,
    [jobId],
  );
  return Object.fromEntries(rows.map((r) => [r.outcome, r.n]));
}

export async function listFailures(jobId: string, limit: number, offset: number) {
  const { rows } = await pool.query<{
    store_id: string;
    store_name: string;
    attempts: number;
    rate_limited: number;
    last_error: string | null;
  }>(
    `SELECT store_id, store_name, attempts, rate_limited, last_error FROM job_stores
      WHERE job_id = $1 AND status = 'failed' ORDER BY store_id LIMIT $2 OFFSET $3`,
    [jobId, limit, offset],
  );
  return rows;
}
