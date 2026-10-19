import { pool, withTransaction } from "../db/pool.js";
import { scoreStore, tierFor, TIERS, type ScoringConfig, type Tier } from "../domain/scoring.js";

export interface TierBreakdown {
  Large: number;
  Medium: number;
  Small: number;
}

export interface ScoringSummary {
  scoringRunId: string;
  config: ScoringConfig;
  scored: number;
  breakdown: TierBreakdown;
  createdAt: Date;
}

/**
 * Scores every successfully enriched store of a job. Reads only enrichment_results
 * (never the upstream API), so it's fast and safe to re-run at any time. The swap of
 * store_scores happens in one transaction, so readers never see a half-applied run.
 */
export async function runScoring(jobId: string, cfg: ScoringConfig): Promise<ScoringSummary> {
  return withTransaction(async (tx) => {
    // Serialise concurrent re-runs for the same job.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [jobId]);

    const { rows } = await tx.query<{ store_id: string; footfall: number; revenue: number; size: number }>(
      `SELECT store_id, estimated_monthly_footfall AS footfall, estimated_monthly_revenue AS revenue,
              store_size_sqft AS size
         FROM enrichment_results WHERE job_id = $1`,
      [jobId],
    );

    const ids: string[] = [];
    const scores: number[] = [];
    const tiers: Tier[] = [];
    const breakdown: TierBreakdown = { Large: 0, Medium: 0, Small: 0 };
    for (const r of rows) {
      const score = scoreStore(r, cfg);
      const tier = tierFor(score, cfg.tiers);
      ids.push(r.store_id);
      scores.push(score);
      tiers.push(tier);
      breakdown[tier]++;
    }

    const { rows: runRows } = await tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO scoring_runs (job_id, config, scored) VALUES ($1, $2, $3) RETURNING id, created_at`,
      [jobId, JSON.stringify(cfg), rows.length],
    );
    const run = runRows[0]!;
    await tx.query(`DELETE FROM store_scores WHERE job_id = $1`, [jobId]);
    await tx.query(
      `INSERT INTO store_scores (job_id, store_id, scoring_run_id, score, tier)
       SELECT $1, s.id, $2, s.score, s.tier FROM unnest($3::text[], $4::numeric[], $5::text[]) AS s(id, score, tier)`,
      [jobId, run.id, ids, scores, tiers],
    );
    return { scoringRunId: run.id, config: cfg, scored: rows.length, breakdown, createdAt: run.created_at };
  });
}

export async function getLatestScoring(jobId: string): Promise<ScoringSummary | null> {
  const { rows } = await pool.query<{ id: string; config: ScoringConfig; scored: number; created_at: Date }>(
    `SELECT id, config, scored, created_at FROM scoring_runs WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [jobId],
  );
  const run = rows[0];
  if (!run) return null;
  const { rows: counts } = await pool.query<{ tier: Tier; n: number }>(
    `SELECT tier, count(*) AS n FROM store_scores WHERE job_id = $1 GROUP BY tier`,
    [jobId],
  );
  const breakdown: TierBreakdown = { Large: 0, Medium: 0, Small: 0 };
  for (const c of counts) breakdown[c.tier] = c.n;
  return { scoringRunId: run.id, config: run.config, scored: run.scored, breakdown, createdAt: run.created_at };
}

export interface StoreListQuery {
  tier?: Tier;
  search?: string;
  page: number;
  pageSize: number;
}

export async function listStores(jobId: string, q: StoreListQuery) {
  const params: unknown[] = [jobId];
  const where = ["s.job_id = $1"];
  if (q.tier && (TIERS as readonly string[]).includes(q.tier)) {
    params.push(q.tier);
    where.push(`sc.tier = $${params.length}`);
  }
  if (q.search) {
    params.push(`%${q.search.replace(/[%_\\]/g, "\\$&")}%`);
    where.push(`(s.store_name ILIKE $${params.length} OR s.store_id ILIKE $${params.length} OR s.city ILIKE $${params.length})`);
  }
  const whereSql = where.join(" AND ");
  const from = `FROM job_stores s
    LEFT JOIN enrichment_results r ON r.job_id = s.job_id AND r.store_id = s.store_id
    LEFT JOIN store_scores sc ON sc.job_id = s.job_id AND sc.store_id = s.store_id`;

  const [{ rows: items }, { rows: total }] = await Promise.all([
    pool.query(
      `SELECT s.store_id, s.store_name, s.city, s.state, s.status, s.last_error,
              r.estimated_monthly_footfall AS footfall, r.estimated_monthly_revenue AS revenue,
              r.store_size_sqft AS size_sqft, sc.score, sc.tier
         ${from} WHERE ${whereSql}
        ORDER BY sc.score DESC NULLS LAST, s.store_id
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    pool.query<{ n: number }>(`SELECT count(*) AS n ${from} WHERE ${whereSql}`, params),
  ]);
  return { items, total: total[0]?.n ?? 0, page: q.page, pageSize: q.pageSize };
}
