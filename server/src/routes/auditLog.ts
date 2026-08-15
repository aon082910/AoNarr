import { Router } from "express";
import { db } from "../db/client.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";

export const auditLogRouter = Router();
auditLogRouter.use(requireAdmin);

auditLogRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT id, user_id AS userId, username, event_type AS eventType, detail, created_at AS createdAt
         FROM audit_log ORDER BY created_at DESC LIMIT 500`
      )
      .all();
    res.json(rows);
  })
);
