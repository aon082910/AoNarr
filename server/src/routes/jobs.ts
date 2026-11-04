import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { cancelJob, listJobRuns, listJobs, runJobNow, setJobEnabled, updateJobSchedule } from "../services/jobRegistry.js";

export const jobsRouter = Router();
jobsRouter.use(requireAdmin);

jobsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(listJobs());
  })
);

jobsRouter.get(
  "/:key/runs",
  asyncHandler(async (req, res) => {
    if (!listJobs().some((j) => j.key === req.params.key)) throw new HttpError(404, "Unknown job");
    const rows = await listJobRuns(req.params.key, 30);
    res.json(
      rows.map((r) => ({ id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, error: r.error, durationMs: r.duration_ms }))
    );
  })
);

jobsRouter.post(
  "/:key/run",
  asyncHandler(async (req, res) => {
    const result = runJobNow(req.params.key);
    if (result === "unknown") throw new HttpError(404, "Unknown job");
    if (result === "stopped") throw new HttpError(409, "Scheduled jobs are stopped for a shutdown or restore");
    if (result === "already-running") {
      res.status(202).json({ started: false, reason: "already-running" });
      return;
    }
    res.status(202).json({ started: true });
  })
);

jobsRouter.post(
  "/:key/cancel",
  asyncHandler(async (req, res) => {
    const cancelled = cancelJob(req.params.key);
    res.json({ cancelled });
  })
);

/** Switches a job on or off (its schedule is kept); the queue poll cannot be switched off. */
jobsRouter.patch(
  "/:key/enabled",
  asyncHandler(async (req, res) => {
    if (typeof req.body?.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    const result = setJobEnabled(req.params.key, req.body.enabled);
    if (!result.ok) throw new HttpError(result.error === "Unknown job" ? 404 : 409, result.error ?? "Cannot change this job");
    res.status(204).send();
  })
);

jobsRouter.patch(
  "/:key/schedule",
  asyncHandler(async (req, res) => {
    const schedule = req.body?.schedule;
    if (!schedule || typeof schedule !== "string") throw new HttpError(400, "schedule is required");
    const result = updateJobSchedule(req.params.key, schedule);
    if (!result.ok) throw new HttpError(400, result.error ?? "Invalid schedule");
    res.status(204).send();
  })
);
