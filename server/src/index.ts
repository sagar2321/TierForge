import { createApp } from "./app.js";
import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { HttpEnrichmentClient } from "./enrichment/client.js";
import { RateLimiter } from "./enrichment/rateLimiter.js";
import { JobEngine } from "./jobs/engine.js";
import { logger } from "./logger.js";

async function main() {
  await migrate();

  const engine = new JobEngine(
    new HttpEnrichmentClient(config.ENRICHMENT_API_URL, config.ENRICH_HARD_TIMEOUT_MS),
    new RateLimiter(config.ENRICH_RATE_PER_SECOND),
    config,
  );
  await engine.resumeRunningJobs();

  const server = createApp(engine, config).listen(config.PORT, () =>
    logger.info({ port: config.PORT, upstream: config.ENRICHMENT_API_URL }, "TierForge API listening"),
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close();
    await engine.shutdown();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error(err, "failed to start");
  process.exit(1);
});
