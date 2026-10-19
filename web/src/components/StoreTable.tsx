import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { api } from "../api/client";
import { TIERS, type Job, type Tier } from "../api/types";

const PAGE_SIZE = 25;
const num = new Intl.NumberFormat();
const money = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export function StoreTable({ job }: { job: Job }) {
  const [tier, setTier] = useState<Tier | undefined>();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const deferredSearch = useDeferredValue(search.trim());

  const stores = useQuery({
    queryKey: ["stores", job.id, tier, deferredSearch, page, job.counts.succeeded],
    queryFn: () => api.stores(job.id, { tier, search: deferredSearch || undefined, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  const data = stores.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <section className="card wide">
      <div className="card-head">
        <h2><span className="step">04</span> Stores</h2>
        <div className="row">
          <div className="segmented" role="group" aria-label="Filter by tier">
            {[undefined, ...TIERS].map((t) => (
              <button
                key={t ?? "all"}
                className={tier === t ? "active" : ""}
                onClick={() => {
                  setTier(t);
                  setPage(1);
                }}
              >
                {t ?? "All"}
              </button>
            ))}
          </div>
          <input
            className="input"
            placeholder="Search name, id, city"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Store</th><th>City</th>
              <th className="num">Footfall</th><th className="num">Revenue</th><th className="num">Size (sqft)</th>
              <th className="num">Score</th><th>Tier</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((s) => (
              <tr key={s.store_id}>
                <td>
                  <div>{s.store_name}</div>
                  <div className="mono small muted">{s.store_id}</div>
                </td>
                <td>{s.city}</td>
                <td className="num">{s.footfall != null ? num.format(s.footfall) : "—"}</td>
                <td className="num">{s.revenue != null ? money.format(s.revenue) : "—"}</td>
                <td className="num">{s.size_sqft != null ? num.format(s.size_sqft) : "—"}</td>
                <td className="num">{s.score != null ? `${s.score}%` : "—"}</td>
                <td>
                  {s.tier ? (
                    <span className={`badge tier-${s.tier.toLowerCase()}`}>{s.tier}</span>
                  ) : (
                    <span className="muted small" title={s.last_error ?? undefined}>{s.status === "succeeded" ? "unscored" : s.status}</span>
                  )}
                </td>
              </tr>
            ))}
            {data && data.items.length === 0 && (
              <tr><td colSpan={7} className="muted center">No stores match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="row pager">
        <span className="muted small">{data ? `${num.format(data.total)} stores` : "Loading…"}</span>
        <button className="btn ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
        <span className="small">{page} / {pages}</span>
        <button className="btn ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    </section>
  );
}
