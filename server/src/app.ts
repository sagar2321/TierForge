import cors from "cors";
import express from "express";
import type { AppConfig } from "./config.js";
import type { JobEngine } from "./jobs/engine.js";
import { errorHandler } from "./routes/errors.js";
import { jobsRouter } from "./routes/jobs.js";

export function createApp(engine: JobEngine, cfg: AppConfig) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json({ limit: "100kb" }));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api/jobs", jobsRouter(engine, cfg));
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);
  return app;
}
