import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { TIERS, type Job, type ScoringConfig } from "../api/types";

const DEFAULT_CONFIG: ScoringConfig = {
  metrics: {
    footfall: { threshold: 15_000, weight: 50 },
    revenue: { threshold: 150_000, weight: 30 },
    size: { threshold: 8_000, weight: 20 },
  },
  tiers: { large: 70, medium: 40 },
};

const METRIC_LABELS = {
  footfall: "Monthly footfall",
  revenue: "Monthly revenue",
  size: "Store size (sqft)",
} as const;
type MetricKey = keyof typeof METRIC_LABELS;

export function ScoringPanel({ job }: { job: Job }) {
  const qc = useQueryClient();
  const latest = useQuery({ queryKey: ["scoring", job.id], queryFn: () => api.latestScoring(job.id) });
  const [cfg, setCfg] = useState<ScoringConfig>(DEFAULT_CONFIG);

  // Seed the form with the last submitted config for this job.
  useEffect(() => {
    if (latest.data) setCfg(latest.data.config);
  }, [latest.data]);

  const run = useMutation({
    mutationFn: (c: ScoringConfig) => api.runScoring(job.id, c),
    onSuccess: (data) => {
      qc.setQueryData(["scoring", job.id], data);
      return qc.invalidateQueries({ queryKey: ["stores", job.id] });
    },
  });

  const weightSum = (Object.keys(METRIC_LABELS) as MetricKey[]).reduce((s, k) => s + cfg.metrics[k].weight, 0);
  const sumOk = Math.abs(weightSum - 100) < 0.001;
  const tiersOk = cfg.tiers.large > cfg.tiers.medium;
  const setMetric = (k: MetricKey, field: "threshold" | "weight", v: number) =>
    setCfg((c) => ({ ...c, metrics: { ...c.metrics, [k]: { ...c.metrics[k], [field]: v } } }));

  const err = run.error instanceof ApiError ? run.error : null;
  const summary = run.data ?? latest.data;
  const enriched = job.counts.succeeded;

  return (
    <section className="card">
      <h2><span className="step">03</span> Scoring &amp; tiering</h2>
      <p className="muted small">
        A store earns a metric's weight when it meets or exceeds the bar. Runs on already-enriched data only — safe to
        re-run any time.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate(cfg);
        }}
      >
        <table className="table form-table">
          <thead>
            <tr><th>Metric</th><th>Bar (min. value)</th><th>Weight %</th></tr>
          </thead>
          <tbody>
            {(Object.keys(METRIC_LABELS) as MetricKey[]).map((k) => (
              <tr key={k}>
                <td>{METRIC_LABELS[k]}</td>
                <td>
                  <NumberInput value={cfg.metrics[k].threshold} min={0} onChange={(v) => setMetric(k, "threshold", v)} label={`${k} bar`} />
                </td>
                <td>
                  <NumberInput value={cfg.metrics[k].weight} min={0} max={100} onChange={(v) => setMetric(k, "weight", v)} label={`${k} weight`} />
                </td>
              </tr>
            ))}
            <tr className={sumOk ? "" : "invalid"}>
              <td colSpan={2} className="right">Total weight</td>
              <td className="num">{weightSum}%{!sumOk && " — must be 100%"}</td>
            </tr>
          </tbody>
        </table>

        <div className="row tiers-row">
          <label>
            Large ≥
            <NumberInput value={cfg.tiers.large} min={0} max={100} onChange={(v) => setCfg((c) => ({ ...c, tiers: { ...c.tiers, large: v } }))} label="large threshold" />%
          </label>
          <label>
            Medium ≥
            <NumberInput value={cfg.tiers.medium} min={0} max={100} onChange={(v) => setCfg((c) => ({ ...c, tiers: { ...c.tiers, medium: v } }))} label="medium threshold" />%
          </label>
          <span className="muted small">else Small</span>
        </div>
        {!tiersOk && <p className="invalid-text small">Large threshold must be above Medium.</p>}

        <div className="row">
          <button className="btn primary" disabled={!sumOk || !tiersOk || run.isPending || enriched === 0}>
            {run.isPending ? "Scoring…" : summary ? "Re-score stores" : "Score stores"}
          </button>
          {enriched === 0 && <span className="muted small">Waiting for enriched stores…</span>}
          {job.status === "running" && enriched > 0 && (
            <span className="muted small">Job still running — scores cover the {enriched} stores enriched so far.</span>
          )}
        </div>
        {err && (
          <div className="alert" role="alert">
            <strong>{err.message}</strong>
            {err.details.map((d) => <div key={d}>{d}</div>)}
          </div>
        )}
      </form>

      {summary && (
        <div className="tiers">
          {TIERS.map((t) => (
            <div key={t} className={`tier-tile tier-${t.toLowerCase()}`}>
              <div className="stat-value">{summary.breakdown[t].toLocaleString()}</div>
              <div className="stat-label">{t}</div>
            </div>
          ))}
          <p className="muted small full">
            {summary.scored.toLocaleString()} stores scored · {new Date(summary.createdAt).toLocaleTimeString()}
          </p>
        </div>
      )}
    </section>
  );
}

function NumberInput(props: { value: number; onChange: (v: number) => void; min?: number; max?: number; label: string }) {
  return (
    <input
      type="number"
      className="input"
      aria-label={props.label}
      value={Number.isFinite(props.value) ? props.value : ""}
      min={props.min}
      max={props.max}
      step="any"
      onChange={(e) => props.onChange(e.target.value === "" ? NaN : Number(e.target.value))}
    />
  );
}
