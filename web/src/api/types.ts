export type JobStatus = "running" | "completed" | "failed" | "cancelled";
export type Tier = "Large" | "Medium" | "Small";
export const TIERS: Tier[] = ["Large", "Medium", "Small"];

export interface Job {
  id: string;
  file_name: string;
  status: JobStatus;
  total_stores: number;
  failure_reason: string | null;
  created_at: string;
  finished_at: string | null;
  counts: { pending: number; in_flight: number; succeeded: number; failed: number };
  attempts: Record<string, number>;
}

export interface FailureRow {
  store_id: string;
  store_name: string;
  attempts: number;
  rate_limited: number;
  last_error: string | null;
}

export interface MetricRule {
  threshold: number;
  weight: number;
}

export interface ScoringConfig {
  metrics: { footfall: MetricRule; revenue: MetricRule; size: MetricRule };
  tiers: { large: number; medium: number };
}

export interface ScoringSummary {
  scoringRunId: string;
  config: ScoringConfig;
  scored: number;
  breakdown: Record<Tier, number>;
  createdAt: string;
}

export interface StoreRow {
  store_id: string;
  store_name: string;
  city: string;
  state: string;
  status: string;
  last_error: string | null;
  footfall: number | null;
  revenue: number | null;
  size_sqft: number | null;
  score: number | null;
  tier: Tier | null;
}

export interface StorePage {
  items: StoreRow[];
  total: number;
  page: number;
  pageSize: number;
}
