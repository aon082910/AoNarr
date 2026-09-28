import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { listBackgroundJobs } from "../services/backgroundJobs.js";

export const backgroundJobsRouter = Router();
backgroundJobsRouter.use(requireAdmin);

/** Polled by the client's minimizable progress widget to show live Scan & Import / Match All
 * Providers progress from any page, instead of the old fire-and-forget "check the Logs page later"
 * experience — see services/backgroundJobs.ts. */
backgroundJobsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(listBackgroundJobs());
  })
);
