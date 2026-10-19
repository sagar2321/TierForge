import { z } from "zod";

export interface EnrichRequest {
  store_id: string;
  store_name: string;
  address: string;
  city: string;
  state: string;
}

export interface EnrichMetrics {
  estimated_monthly_footfall: number;
  estimated_monthly_revenue: number;
  store_size_sqft: number;
}

/** Every way a call can end, classified once so callers never inspect raw HTTP. */
export type EnrichOutcome =
  | { kind: "success"; metrics: EnrichMetrics }
  | { kind: "rate_limited"; status: 429; detail: string }
  | { kind: "server_error"; status: number; detail: string } // retryable
  | { kind: "client_error"; status: number; detail: string } // not retryable
  | { kind: "network_error"; detail: string } // retryable
  | { kind: "invalid_response"; detail: string } // retryable (could be a proxy glitch)
  | { kind: "hard_timeout"; detail: string };

export const isRetryable = (o: EnrichOutcome): boolean => o.kind !== "success" && o.kind !== "client_error";

const responseSchema = z.object({
  store_id: z.string(),
  estimated_monthly_footfall: z.number().int().nonnegative(),
  estimated_monthly_revenue: z.number().nonnegative(),
  store_size_sqft: z.number().int().nonnegative(),
});

export interface EnrichmentClient {
  enrich(req: EnrichRequest, signal?: AbortSignal): Promise<EnrichOutcome>;
}

export class HttpEnrichmentClient implements EnrichmentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly hardTimeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async enrich(req: EnrichRequest, signal?: AbortSignal): Promise<EnrichOutcome> {
    const timeout = AbortSignal.timeout(this.hardTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/enrich`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: combined,
      });
    } catch (err) {
      if (timeout.aborted) return { kind: "hard_timeout", detail: `No response after ${this.hardTimeoutMs}ms` };
      return { kind: "network_error", detail: (err as Error).message };
    }

    if (res.status === 429) return { kind: "rate_limited", status: 429, detail: await safeText(res) };
    if (res.status >= 500) return { kind: "server_error", status: res.status, detail: await safeText(res) };
    if (!res.ok) return { kind: "client_error", status: res.status, detail: await safeText(res) };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: "invalid_response", detail: "Response body is not JSON" };
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) return { kind: "invalid_response", detail: parsed.error.issues[0]?.message ?? "bad shape" };
    if (parsed.data.store_id !== req.store_id) {
      return { kind: "invalid_response", detail: `Response for ${parsed.data.store_id}, expected ${req.store_id}` };
    }
    const { store_id: _ignored, ...metrics } = parsed.data;
    return { kind: "success", metrics };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
