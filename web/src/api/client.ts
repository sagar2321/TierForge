import type { FailureRow, Job, ScoringConfig, ScoringSummary, StorePage, Tier } from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details: string[] = [],
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`, body?.details ?? []);
  }
  return body as T;
}

const json = (method: string, data: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(data),
});

export const api = {
  latestJob: () => request<Job | null>("/jobs/latest"),
  job: (id: string) => request<Job>(`/jobs/${id}`),
  uploadStores: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<Job>("/jobs", { method: "POST", body: form });
  },
  cancelJob: (id: string) => request<Job>(`/jobs/${id}/cancel`, { method: "POST" }),
  failures: (id: string) => request<FailureRow[]>(`/jobs/${id}/failures?limit=200`),
  latestScoring: (id: string) => request<ScoringSummary | null>(`/jobs/${id}/scoring`),
  runScoring: (id: string, cfg: ScoringConfig) => request<ScoringSummary>(`/jobs/${id}/scoring`, json("POST", cfg)),
  stores: (id: string, q: { tier?: Tier; search?: string; page: number; pageSize: number }) => {
    const p = new URLSearchParams({ page: String(q.page), pageSize: String(q.pageSize) });
    if (q.tier) p.set("tier", q.tier);
    if (q.search) p.set("search", q.search);
    return request<StorePage>(`/jobs/${id}/stores?${p}`);
  },
};
