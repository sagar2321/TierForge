# TierForge - Resilient Bulk Store Scoring & Tiering

Upload a CSV of stores. A job enriches each store through a slow, rate-limited, flaky API, then scores and tiers it (Large / Medium / Small) using weights you set.

**Stack:** React 18 + TypeScript (Vite, TanStack Query) · Node 20+ + Express + TypeScript · PostgreSQL 16 · Vitest

```
tierforge/
├── server/                 Express API + job engine
│   ├── src/domain/         pure logic: CSV validation, scoring/tiering
│   ├── src/enrichment/     HTTP client, rate limiter, backoff, circuit breaker
│   ├── src/jobs/           engine (workers, leases, reaper), repository (SQL), scoring service
│   ├── src/routes/         HTTP layer (validation + error mapping only)
│   ├── src/db/migrations/  schema
│   └── test/               unit tests
├── web/                    React UI
├── enrichment_simulator/   provided simulator (unmodified)
├── sample-data/            provided stores_5000.csv
└── docker-compose.yml      Postgres
```
<img width="1456" height="892" alt="image" src="https://github.com/user-attachments/assets/000a55c9-3550-424e-b244-470b1b0d89f1" />

---

## Running it

Prerequisites: Node ≥ 20, Python ≥ 3.10, and Docker (for Postgres) or a local Postgres.

```bash
# 1. Postgres (localhost:5432, db/user/password = tierforge)
docker compose up -d

# 2. Enrichment simulator (terminal 1)
cd enrichment_simulator
pip install -r requirements.txt
uvicorn main:app --port 8000

# 3. API (terminal 2) — migrations run automatically on startup
cd server
cp .env.example .env        # defaults work with docker-compose
npm install
npm run dev                 # http://localhost:4000

# 4. UI (terminal 3)
cd web
npm install
npm run dev                 # http://localhost:5173 (proxies /api to :4000)
```

Open http://localhost:5173 and upload `sample-data/stores_5000.csv`.

> **Throughput:** the upstream allows 5 req/s, so 5,000 stores take at least 1,000 s. With retries, expect about **20 minutes**. You can score while the job runs; scores cover the stores enriched so far.

### Tests

```bash
cd server && npm test
```

41 unit tests cover the scoring formula (including the worked example from the brief), tier boundaries, config validation, backoff/jitter, the rate limiter, the circuit breaker, HTTP outcome classification and CSV validation.

---

## How it works

```text
          ┌──────────── slow, unreliable ─────────────┐   ┌──── fast, deterministic ────┐
CSV ──▶ jobs + job_stores ──▶ workers ──▶ Enrichment API     enrichment_results ──▶ scoring ──▶ store_scores
        (units of work)     claim/lease    (rate-limited)  ─▶ (raw metrics)           (pure fn)   (latest run)
                                                              enrichment_attempts (audit)
```

### 1. Enrichment and scoring are separate
- Enrichment writes raw metrics to `enrichment_results`. Nothing else.
- Scoring (`POST /api/jobs/:id/scoring`) reads only `enrichment_results` and runs a **pure function** (`domain/scoring.ts`). It never calls the API.
- 5,000 stores score in tens of milliseconds. Each run is recorded in `scoring_runs` (config history). `store_scores` is replaced inside one transaction, so readers never see a half-finished run. An advisory lock serialises concurrent re-runs.

### 2. The job state lives in Postgres
Each store is one row in `job_stores` with `status`, `attempts`, `next_attempt_at` and a **lease** (`lease_token`, `lease_expires_at`). The engine itself is just a pool of stateless workers:

1. **Claim** with `UPDATE … WHERE (…) = (SELECT … FOR UPDATE SKIP LOCKED)`. Two workers (or processes) can never claim the same store, and they never block each other.
2. **Pace** through one shared `RateLimiter`. It hands out evenly spaced slots (4.5/s by default) instead of bursts, because the upstream counts requests in fixed 1-second windows. In testing this produced **zero 429s**.
3. **Call** with two timeouts (see below).
4. **Commit** the outcome.

### 3. Failure handling

| Failure | Behaviour |
|---|---|
| **500 / network error / bad response** | Retried with exponential backoff and full jitter (500 ms base, 30 s cap). After `ENRICH_MAX_ATTEMPTS` (6) the store is marked `failed` and the last error is kept as the reason. |
| **429** | Every worker pauses (`limiter.penalize`). The attempt is **refunded**: throttling is a pacing issue, not the store's fault. Throttles are counted separately in `rate_limited`. |
| **4xx** | Not retryable. The store fails immediately. |
| **Hung call (45–60 s)** | **Soft timeout (8 s):** the worker stops waiting, logs a `soft_timeout` attempt, reschedules the store and moves on. The original HTTP call keeps running in the background until the **hard timeout (75 s)**. |
| **Late answer from an abandoned call** | Accepted. The data is valid because results are deterministic. `commitSuccess` is idempotent: `enrichment_results` has a primary key with `ON CONFLICT DO NOTHING`, and the status only changes `WHERE status <> 'succeeded'`. The first answer wins (logged as `success` or `late_success`). Any later answer is logged as `duplicate` and changes nothing. **Nothing is ever counted twice.** |
| **Worker or process dies** | Its leases expire after 15 s. A reaper (every 2 s) puts those stores back to `pending`, or `failed` if they're out of attempts. |
| **The whole run is broken** (upstream down, wrong URL) | A **circuit breaker** keeps a sliding window of the last 60 call outcomes. If ≥ 90% failed, the job ends in the terminal `failed` state with a clear reason, e.g. *"Systemic failure: 60 of the last 60 enrichment calls failed (most common: network_error)"*. The simulator's normal ~12% failure rate doesn't come close. |

All failure reasons are visible in the UI ("Show failed stores") and through `GET /api/jobs/:id/failures`. Every upstream call is recorded in `enrichment_attempts` (outcome, HTTP status, detail, duration) for debugging.

### 4. Bonus items
- **Resume after a restart: done.** All state is in the database, so on startup `resumeRunningJobs()` picks up any `running` job, and the reaper reclaims its expired leases. Tested by hard-killing (`kill -9`) the server mid-job: it resumed and finished 150/150 with no duplicate results.
- **One shared rate limit across jobs: halfway there.** The `RateLimiter` is a single process-wide instance and the engine keeps a map of runs, so lifting the one-active-job index would mostly work within one process. A rate limit shared across *multiple processes* would need Redis or a Postgres-backed token bucket. Not done.

### 5. Data model

| Table | Purpose |
|---|---|
| `jobs` | One upload. `status`: `running`/`completed`/`failed`/`cancelled`, plus `failure_reason`. A partial unique index enforces **one running job** at the database level. |
| `job_stores` | Unit of work: the input row plus status, attempts, throttle count, backoff schedule, lease and last error. |
| `enrichment_results` | Raw metrics. Primary key (job, store), so at most one result per store. |
| `enrichment_attempts` | Append-only audit of every upstream call. |
| `scoring_runs` | Every scoring configuration submitted, with its timestamp. |
| `store_scores` | Score and tier from the latest run, indexed by tier for the dashboard filter. |

### API

| Method | Path | |
|---|---|---|
| POST | `/api/jobs` | multipart `file`: validates the CSV and starts a job (422 with details, 409 if a job is already running) |
| GET | `/api/jobs/latest`, `/api/jobs/:id` | job, counts by status, attempt outcome stats |
| POST | `/api/jobs/:id/cancel` | cancels a running job |
| GET | `/api/jobs/:id/failures` | failed stores with reasons |
| POST / GET | `/api/jobs/:id/scoring` | run scoring / latest config and tier breakdown |
| GET | `/api/jobs/:id/stores?tier=&search=&page=&pageSize=` | paginated store list |

### Scoring rules
- A store clears a bar when `value >= threshold` (the boundary counts).
- Score = sum of the weights of the bars it clears.
- Tier: `score >= large` → Large, else `score >= medium` → Medium, else Small.
- Weights must add up to 100 (±0.001 for float tolerance), and `large > medium`. This is checked in both the UI and the API.
- Scores are rounded to 2 decimal places so float noise (69.999…) can't push a store across a tier boundary.

---

## Known limitations and shortcuts
- **Single API instance assumed for rate limiting.** Leasing and claiming are already safe across multiple processes, but the rate limiter is in-memory.
- **Late answers after the hard timeout (75 s) are lost.** The call has been aborted by then. That store has long since been retried, so it only matters when the upstream hangs longer than documented.
- **A late success can turn a `failed` store into `succeeded`.** This is intentional (valid data wins), but job counts can shift slightly in the minute after a job finishes.
- **Polling, not push.** The UI polls every 1.5 s while a job runs. Server-sent events would be better at scale.
- **Whole-file CSV validation in memory.** Fine for the 10 MB / 100k-row limits. Very large files would need streaming.
- **No auth or multi-tenancy.** Out of scope.
- **Tests are unit-level.** The engine was verified end-to-end against the real simulator (400 stores: 400/400 enriched, 0 × 429, 3 late successes, 2 duplicates ignored; simulator-down run tripped the circuit breaker; `kill -9` mid-job resumed cleanly). A Testcontainers-based integration suite would be the next addition.

## Configuration (`server/.env`)
All resilience settings are documented in `server/src/config.ts`: `ENRICH_RATE_PER_SECOND`, `ENRICH_CONCURRENCY`, `ENRICH_SOFT_TIMEOUT_MS`, `ENRICH_HARD_TIMEOUT_MS`, `ENRICH_LEASE_MS`, `ENRICH_MAX_ATTEMPTS`, `ENRICH_BACKOFF_BASE_MS`, `ENRICH_BACKOFF_MAX_MS`, `BREAKER_WINDOW`, `BREAKER_FAILURE_RATIO`.
