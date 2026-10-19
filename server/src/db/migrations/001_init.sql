-- TierForge schema.
-- Slow/unreliable ingestion (job_stores, enrichment_attempts, enrichment_results)
-- is kept strictly separate from fast/deterministic scoring (scoring_runs, store_scores).


CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name       TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  total_stores    INT         NOT NULL,
  failure_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

-- Core scope is "one job at a time": enforced by the database, not by app code.
CREATE UNIQUE INDEX jobs_single_active ON jobs ((true)) WHERE status = 'running';

-- One row per store per job = one unit of work. The lease columns make claiming
-- safe across concurrent workers and across process restarts.
CREATE TABLE job_stores (
  job_id            UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  store_id          TEXT        NOT NULL,
  store_name        TEXT        NOT NULL,
  address           TEXT        NOT NULL,
  city              TEXT        NOT NULL,
  state             TEXT        NOT NULL,
  country           TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_flight', 'succeeded', 'failed')),
  attempts          INT         NOT NULL DEFAULT 0,  -- attempts that count towards the budget
  rate_limited      INT         NOT NULL DEFAULT 0,  -- 429s (not counted against the budget)
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token       UUID,
  lease_expires_at  TIMESTAMPTZ,
  last_error        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, store_id)
);
CREATE INDEX job_stores_claimable ON job_stores (job_id, next_attempt_at) WHERE status = 'pending';
CREATE INDEX job_stores_leases    ON job_stores (lease_expires_at)        WHERE status = 'in_flight';
CREATE INDEX job_stores_status    ON job_stores (job_id, status);

-- Raw enrichment data. PK guarantees at most one result per store per job, so a
-- late duplicate response can never double-count.
CREATE TABLE enrichment_results (
  job_id                      UUID          NOT NULL,
  store_id                    TEXT          NOT NULL,
  estimated_monthly_footfall  INT           NOT NULL,
  estimated_monthly_revenue   NUMERIC(14,2) NOT NULL,
  store_size_sqft             INT           NOT NULL,
  fetched_at                  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, store_id),
  FOREIGN KEY (job_id, store_id) REFERENCES job_stores(job_id, store_id) ON DELETE CASCADE
);

-- Append-only audit of every upstream call: the "why" behind every failure.
CREATE TABLE enrichment_attempts (
  id           BIGSERIAL PRIMARY KEY,
  job_id       UUID        NOT NULL,
  store_id     TEXT        NOT NULL,
  lease_token  UUID        NOT NULL,
  outcome      TEXT        NOT NULL,  -- success | late_success | duplicate | rate_limited | server_error | client_error | network_error | invalid_response | soft_timeout | hard_timeout
  http_status  INT,
  detail       TEXT,
  duration_ms  INT         NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, store_id) REFERENCES job_stores(job_id, store_id) ON DELETE CASCADE
);
CREATE INDEX enrichment_attempts_store ON enrichment_attempts (job_id, store_id);

-- Every scoring submission is recorded (config history); store_scores holds the
-- latest run per job and is replaced atomically on each re-run.
CREATE TABLE scoring_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  config      JSONB       NOT NULL,
  scored      INT         NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scoring_runs_job ON scoring_runs (job_id, created_at DESC);

CREATE TABLE store_scores (
  job_id          UUID         NOT NULL,
  store_id        TEXT         NOT NULL,
  scoring_run_id  UUID         NOT NULL REFERENCES scoring_runs(id) ON DELETE CASCADE,
  score           NUMERIC(5,2) NOT NULL,
  tier            TEXT         NOT NULL CHECK (tier IN ('Large', 'Medium', 'Small')),
  PRIMARY KEY (job_id, store_id),
  FOREIGN KEY (job_id, store_id) REFERENCES enrichment_results(job_id, store_id) ON DELETE CASCADE
);
CREATE INDEX store_scores_tier ON store_scores (job_id, tier);
