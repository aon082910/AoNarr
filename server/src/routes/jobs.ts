import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { cancelJob, listJobs, runJobNow, updateJobSchedule } from "../services/jobRegistry.js";

export const jobsRouter = Router();
jobsRouter.use(requireAdmin);

jobsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(listJobs());
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
