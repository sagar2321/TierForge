import { useQuery } from "@tanstack/react-query";
import { api } from "./api/client";
import { JobPanel } from "./components/JobPanel";
import { ScoringPanel } from "./components/ScoringPanel";
import { StoreTable } from "./components/StoreTable";
import { UploadPanel } from "./components/UploadPanel";

export function App() {
  const latest = useQuery({
    queryKey: ["job", "latest"],
    queryFn: api.latestJob,
    // Poll while a job is running; stop once it reaches a terminal state.
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1500 : false),
  });
  const job = latest.data ?? null;

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <span className="brand-mark" aria-hidden>◆</span>
          <h1>TierForge</h1>
        </div>
        <p className="tagline">Bulk store enrichment, scoring &amp; tiering</p>
      </header>

      <main className="grid">
        <UploadPanel disabled={job?.status === "running"} />
        {latest.isLoading && <section className="card">Loading…</section>}
        {latest.isError && <section className="card error">Could not reach the API. Is the server running?</section>}
        {job && (
          <>
            <JobPanel job={job} />
            <ScoringPanel job={job} />
            <StoreTable job={job} />
          </>
        )}
      </main>
    </div>
  );
}
