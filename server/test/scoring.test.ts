import { describe, expect, it } from "vitest";
import { scoreStore, scoringConfigSchema, tierFor, type ScoringConfig } from "../src/domain/scoring.js";

// Worked example from the brief.
const cfg: ScoringConfig = {
  metrics: {
    footfall: { threshold: 15_000, weight: 50 },
    revenue: { threshold: 150_000, weight: 30 },
    size: { threshold: 8_000, weight: 20 },
  },
  tiers: { large: 70, medium: 40 },
};

describe("scoreStore + tierFor (worked example)", () => {
  it.each([
    ["A", { footfall: 40_000, revenue: 400_000, size: 18_000 }, 100, "Large"],
    ["B", { footfall: 20_000, revenue: 100_000, size: 5_000 }, 50, "Medium"],
    ["C", { footfall: 2_000, revenue: 20_000, size: 9_000 }, 20, "Small"],
  ] as const)("store %s scores %d and is %s", (_n, metrics, score, tier) => {
    expect(scoreStore(metrics, cfg)).toBe(score);
    expect(tierFor(scoreStore(metrics, cfg), cfg.tiers)).toBe(tier);
  });

  it("treats a value exactly at the bar as clearing it", () => {
    expect(scoreStore({ footfall: 15_000, revenue: 0, size: 0 }, cfg)).toBe(50);
  });

  it("scores 0 when no bar is cleared", () => {
    expect(scoreStore({ footfall: 0, revenue: 0, size: 0 }, cfg)).toBe(0);
  });

  it("avoids float artifacts at tier boundaries", () => {
    const thirds: ScoringConfig = {
      metrics: {
        footfall: { threshold: 0, weight: 33.3 },
        revenue: { threshold: 0, weight: 33.3 },
        size: { threshold: 0, weight: 33.4 },
      },
      tiers: { large: 100, medium: 50 },
    };
    expect(tierFor(scoreStore({ footfall: 1, revenue: 1, size: 1 }, thirds), thirds.tiers)).toBe("Large");
  });
});

describe("tier boundaries", () => {
  it.each([
    [70, "Large"],
    [69.99, "Medium"],
    [40, "Medium"],
    [39.99, "Small"],
    [0, "Small"],
    [100, "Large"],
  ] as const)("score %d -> %s", (score, tier) => {
    expect(tierFor(score, { large: 70, medium: 40 })).toBe(tier);
  });
});

describe("scoringConfigSchema", () => {
  it("accepts the worked example", () => {
    expect(scoringConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it("rejects weights that don't sum to 100", () => {
    const bad = { ...cfg, metrics: { ...cfg.metrics, size: { threshold: 8000, weight: 10 } } };
    const r = scoringConfigSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/sum to 100/);
  });

  it("rejects large <= medium", () => {
    expect(scoringConfigSchema.safeParse({ ...cfg, tiers: { large: 40, medium: 40 } }).success).toBe(false);
  });

  it("rejects negative thresholds and weights over 100", () => {
    const neg = { ...cfg, metrics: { ...cfg.metrics, footfall: { threshold: -1, weight: 50 } } };
    expect(scoringConfigSchema.safeParse(neg).success).toBe(false);
  });
});
