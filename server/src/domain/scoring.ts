import { z } from "zod";

/** Pure, deterministic scoring. No I/O: it only sees already-fetched metrics. */

export const METRICS = ["footfall", "revenue", "size"] as const;
export type MetricKey = (typeof METRICS)[number];
export const TIERS = ["Large", "Medium", "Small"] as const;
export type Tier = (typeof TIERS)[number];

export interface StoreMetrics {
  footfall: number;
  revenue: number;
  size: number;
}

const metricRule = z.object({
  /** Minimum value that counts as "clearing the bar" (inclusive). */
  threshold: z.number().finite().nonnegative(),
  /** Percentage points awarded for clearing the bar. */
  weight: z.number().finite().min(0).max(100),
});

export const scoringConfigSchema = z
  .object({
    metrics: z.object({ footfall: metricRule, revenue: metricRule, size: metricRule }),
    tiers: z.object({
      large: z.number().finite().min(0).max(100),
      medium: z.number().finite().min(0).max(100),
    }),
  })
  .superRefine((cfg, ctx) => {
    const sum = METRICS.reduce((acc, m) => acc + cfg.metrics[m].weight, 0);
    // Tolerate float noise from UI sliders (e.g. 33.3 + 33.3 + 33.4).
    if (Math.abs(sum - 100) > 0.001) {
      ctx.addIssue({ code: "custom", path: ["metrics"], message: `Weights must sum to 100% (got ${sum}%)` });
    }
    if (cfg.tiers.large <= cfg.tiers.medium) {
      ctx.addIssue({
        code: "custom",
        path: ["tiers", "large"],
        message: "Large threshold must be greater than Medium threshold",
      });
    }
  });

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;

/** Sum of weights for every bar the store clears. Always within [0, 100]. */
export function scoreStore(metrics: StoreMetrics, cfg: ScoringConfig): number {
  let score = 0;
  for (const key of METRICS) {
    const rule = cfg.metrics[key];
    if (metrics[key] >= rule.threshold) score += rule.weight;
  }
  // Round to 2dp to avoid float artifacts (e.g. 69.99999) flipping a tier boundary.
  return Math.round(score * 100) / 100;
}

/** Tier boundaries are inclusive: score === large threshold is Large. */
export function tierFor(score: number, tiers: ScoringConfig["tiers"]): Tier {
  if (score >= tiers.large) return "Large";
  if (score >= tiers.medium) return "Medium";
  return "Small";
}
