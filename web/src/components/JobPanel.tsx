import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import type { Job } from "../api/types";

const fmt = new Intl.NumberFormat();

export function JobPanel({ job }: { job: Job }) {
  const qc = useQueryClient();
  const [showFailures, setShowFailures] = useState(false);
  const { counts, total_stores: total } = job;
  const done = counts.succeeded + counts.failed;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const cancel = useMutation({ mutationFn: () => api.cancelJob(job.id), onSuccess: () => qc.invalidateQueries() });
  const failures = useQuery({
    queryKey: ["failures", job.id, counts.failed],
    queryFn: () => api.failures(job.id),
    enabled: showFailures && counts.failed > 0,
  });

  const retries = Object.entries(job.attempts).filter(([k]) => k !== "success");

  return (
    <section className="card">
      <div className="card-head">
        <h2><span className="step">02</span> Enrichment job</h2>
        <span className={`badge status-${job.status}`}>{job.status}</span>
      </div>
      <p className="muted small">
        {job.file_name} · started {new Date(job.created_at).toLocaleString()}
      </p>

      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress-ok" style={{ width: `${(counts.succeeded / total) * 100}%` }} />
        <div className="progress-fail" style={{ width: `${(counts.failed / total) * 100}%` }} />
      </div>

      <div className="stats">
        <Stat label="Enriched" value={counts.succeeded} tone="ok" />
        <Stat label="Failed" value={counts.failed} tone="fail" />
        <Stat label="Pending" value={counts.pending} />
        <Stat label="In flight" value={counts.in_flight} />
        <Stat label="Total" value={total} />
      </div>

      {job.failure_reason && (
        <div className="alert" role="alert">
          <strong>Job {job.status}:</strong> {job.failure_reason}
        </div>
      )}

      {retries.length > 0 && (
        <p className="muted small mono">
          Upstream events: {retries.map(([k, v]) => `${k.replace(/_/g, " ")} ×${fmt.format(v)}`).join(" · ")}
        </p>
      )}

      <div className="row">
        {job.status === "running" && (
          <button className="btn ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            Cancel job
          </button>
        )}
        {counts.failed > 0 && (
          <button className="btn ghost" onClick={() => setShowFailures((s) => !s)}>
            {showFailures ? "Hide" : "Show"} failed stores ({counts.failed})
          </button>
        )}
      </div>

      {showFailures && failures.data && (
        <table className="table compact">
          <thead>
            <tr><th>Store</th><th>Attempts</th><th>Reason</th></tr>
          </thead>
          <tbody>
            {failures.data.map((f) => (
              <tr key={f.store_id}>
                <td><span className="mono">{f.store_id}</span> {f.store_name}</td>
                <td className="num">{f.attempts}{f.rate_limited ? ` (+${f.rate_limited} throttled)` : ""}</td>
                <td className="mono small">{f.last_error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "fail" }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <div className="stat-value">{fmt.format(value)}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
