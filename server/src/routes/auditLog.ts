import { Router } from "express";
import { db } from "../db/index.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";

export const auditLogRouter = Router();
auditLogRouter.use(requireAdmin);

auditLogRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 100));
    const offset = (page - 1) * pageSize;

    const total = ((await db.prepare("SELECT COUNT(*) AS c FROM audit_log").get()) as { c: number }).c;
    // Postgres folds unquoted identifiers to lowercase (so `AS userId` comes back as `userid`,
    // not `userId`) — SQLite has no such folding, so this only surfaces once a query actually runs
    // against Postgres. Every camelCase alias needs quoting to survive both dialects.
    const rows = await db
      .prepare(
        `SELECT id, user_id AS "userId", username, event_type AS "eventType", detail, created_at AS "createdAt"
         FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(pageSize, offset);
    res.json({ rows, total: Number(total), page, pageSize, totalPages: Math.max(1, Math.ceil(Number(total) / pageSize)) });
  })
);
