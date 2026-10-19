import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { parseStoresCsv } from "../domain/csv.js";
import { scoringConfigSchema, TIERS } from "../domain/scoring.js";
import type { JobEngine } from "../jobs/engine.js";
import * as repo from "../jobs/repository.js";
import { getLatestScoring, listStores, runScoring } from "../jobs/scoringService.js";
import { HttpError } from "./errors.js";

const uuid = z.string().uuid();
const asyncH =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function jobsRouter(engine: JobEngine, cfg: Pick<AppConfig, "MAX_UPLOAD_BYTES" | "MAX_STORES_PER_JOB">) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: cfg.MAX_UPLOAD_BYTES, files: 1 } });

  async function loadJob(id: string | undefined) {
    const parsed = uuid.safeParse(id);
    if (!parsed.success) throw new HttpError(400, "Invalid job id");
    const job = await repo.getJob(parsed.data);
    if (!job) throw new HttpError(404, "Job not found");
    return job;
  }

  async function jobView(job: repo.JobRow) {
    const [counts, attempts] = await Promise.all([repo.getStatusCounts(job.id), repo.getAttemptStats(job.id)]);
    return { ...job, counts, attempts };
  }

  router.post(
    "/",
    upload.single("file"),
    asyncH(async (req, res) => {
      if (!req.file) throw new HttpError(400, "Attach a CSV file in the 'file' field.");
      const parsed = parseStoresCsv(req.file.buffer, cfg.MAX_STORES_PER_JOB);
      if (!parsed.ok) throw new HttpError(422, "CSV validation failed", parsed.errors);
      try {
        const job = await repo.createJob(req.file.originalname, parsed.rows);
        engine.start(job.id);
        res.status(201).json(await jobView(job));
      } catch (err) {
        if (err instanceof repo.ActiveJobExistsError) throw new HttpError(409, err.message);
        throw err;
      }
    }),
  );

  router.get(
    "/latest",
    asyncH(async (_req, res) => {
      const job = await repo.getLatestJob();
      res.json(job ? await jobView(job) : null);
    }),
  );

  router.get(
    "/:id",
    asyncH(async (req, res) => {
      res.json(await jobView(await loadJob(req.params.id)));
    }),
  );

  router.post(
    "/:id/cancel",
    asyncH(async (req, res) => {
      const job = await loadJob(req.params.id);
      if (job.status !== "running") throw new HttpError(409, `Job is already ${job.status}`);
      await engine.cancel(job.id);
      res.json(await jobView((await repo.getJob(job.id))!));
    }),
  );

  router.get(
    "/:id/failures",
    asyncH(async (req, res) => {
      const job = await loadJob(req.params.id);
      const q = z
        .object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) })
        .parse(req.query);
      res.json(await repo.listFailures(job.id, q.limit, q.offset));
    }),
  );

  router.post(
    "/:id/scoring",
    asyncH(async (req, res) => {
      const job = await loadJob(req.params.id);
      const parsed = scoringConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(422, "Invalid scoring configuration", parsed.error.issues.map((i) => i.message));
      }
      res.json(await runScoring(job.id, parsed.data));
    }),
  );

  router.get(
    "/:id/scoring",
    asyncH(async (req, res) => {
      const job = await loadJob(req.params.id);
      res.json(await getLatestScoring(job.id));
    }),
  );

  router.get(
    "/:id/stores",
    asyncH(async (req, res) => {
      const job = await loadJob(req.params.id);
      const q = z
        .object({
          tier: z.enum(TIERS).optional(),
          search: z.string().trim().max(100).optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);
      res.json(await listStores(job.id, q));
    }),
  );

  return router;
}
