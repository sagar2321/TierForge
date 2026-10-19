import { describe, expect, it, vi } from "vitest";
import { backoffDelayMs } from "../src/enrichment/backoff.js";
import { CircuitBreaker } from "../src/enrichment/circuitBreaker.js";
import { HttpEnrichmentClient, isRetryable } from "../src/enrichment/client.js";
import { RateLimiter, type Clock } from "../src/enrichment/rateLimiter.js";

describe("backoffDelayMs", () => {
  const opts = { baseMs: 500, maxMs: 30_000 };

  it("grows exponentially (upper bound with random=~1)", () => {
    const max = () => 0.999999;
    expect(backoffDelayMs(1, opts, max)).toBe(499);
    expect(backoffDelayMs(2, opts, max)).toBe(999);
    expect(backoffDelayMs(3, opts, max)).toBe(1999);
  });

  it("is capped", () => {
    expect(backoffDelayMs(20, opts, () => 0.999999)).toBe(29_999);
  });

  it("uses full jitter in [0, ceiling)", () => {
    expect(backoffDelayMs(4, opts, () => 0)).toBe(0);
    expect(backoffDelayMs(4, opts, () => 0.5)).toBe(2000);
  });

  it("treats attempt < 1 as the first attempt", () => {
    expect(backoffDelayMs(0, opts, () => 0.999999)).toBe(499);
  });
});

describe("RateLimiter", () => {
  function fakeClock() {
    let t = 0;
    const sleeps: number[] = [];
    const clock: Clock = {
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    };
    return { clock, sleeps, advance: (ms: number) => (t += ms) };
  }

  it("spaces concurrent acquisitions evenly (no bursts)", async () => {
    const { clock, sleeps } = fakeClock();
    const rl = new RateLimiter(5, clock);
    await Promise.all(Array.from({ length: 5 }, () => rl.acquire()));
    expect(sleeps).toEqual([200, 400, 600, 800]);
  });

  it("does not wait when idle long enough", async () => {
    const { clock, sleeps, advance } = fakeClock();
    const rl = new RateLimiter(5, clock);
    await rl.acquire();
    advance(1000);
    await rl.acquire();
    expect(sleeps).toEqual([]);
  });

  it("penalize pushes the next slot back", async () => {
    const { clock, sleeps } = fakeClock();
    const rl = new RateLimiter(5, clock);
    rl.penalize(1000);
    await rl.acquire();
    expect(sleeps).toEqual([1000]);
  });
});

describe("CircuitBreaker", () => {
  it("does not trip before the window is full", () => {
    const b = new CircuitBreaker(10, 0.9);
    for (let i = 0; i < 9; i++) b.record(false, "server_error");
    expect(b.tripped).toBeNull();
  });

  it("trips when the failure ratio is reached and names the top cause", () => {
    const b = new CircuitBreaker(10, 0.9);
    b.record(true);
    for (let i = 0; i < 9; i++) b.record(false, "network_error");
    expect(b.tripped).toMatch(/9 of the last 10.*network_error/);
  });

  it("tolerates the normal ~12% failure rate of the simulator", () => {
    const b = new CircuitBreaker(60, 0.9);
    for (let i = 0; i < 1000; i++) b.record(i % 8 !== 0, "server_error");
    expect(b.tripped).toBeNull();
  });

  it("slides: old failures fall out of the window", () => {
    const b = new CircuitBreaker(10, 0.9);
    for (let i = 0; i < 8; i++) b.record(false, "x");
    for (let i = 0; i < 10; i++) b.record(true);
    for (let i = 0; i < 5; i++) b.record(false, "x");
    expect(b.tripped).toBeNull();
  });
});

describe("HttpEnrichmentClient classification", () => {
  const req = { store_id: "ST1", store_name: "n", address: "a", city: "c", state: "s" };
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("parses success", async () => {
    const c = new HttpEnrichmentClient("http://x", 1000, respond(200, {
      store_id: "ST1", estimated_monthly_footfall: 1, estimated_monthly_revenue: 2.5, store_size_sqft: 3,
    }));
    expect(await c.enrich(req)).toEqual({
      kind: "success",
      metrics: { estimated_monthly_footfall: 1, estimated_monthly_revenue: 2.5, store_size_sqft: 3 },
    });
  });

  it.each([
    [429, "rate_limited", true],
    [500, "server_error", true],
    [503, "server_error", true],
    [422, "client_error", false],
  ] as const)("HTTP %d -> %s (retryable=%s)", async (status, kind, retryable) => {
    const out = await new HttpEnrichmentClient("http://x", 1000, respond(status, "err")).enrich(req);
    expect(out.kind).toBe(kind);
    expect(isRetryable(out)).toBe(retryable);
  });

  it("rejects a response for a different store", async () => {
    const c = new HttpEnrichmentClient("http://x", 1000, respond(200, {
      store_id: "OTHER", estimated_monthly_footfall: 1, estimated_monthly_revenue: 2, store_size_sqft: 3,
    }));
    expect((await c.enrich(req)).kind).toBe("invalid_response");
  });

  it("classifies network errors", async () => {
    const f = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect((await new HttpEnrichmentClient("http://x", 1000, f).enrich(req)).kind).toBe("network_error");
  });

  it("hard-times-out a hung call", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    expect((await new HttpEnrichmentClient("http://x", 30, hang).enrich(req)).kind).toBe("hard_timeout");
  });
});
