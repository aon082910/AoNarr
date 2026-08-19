import { Router } from "express";
import { db } from "../db/client.js";
import { userFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { requireAdmin } from "../middleware/auth.js";
import { hashPassword, listActiveSessions } from "../services/auth.js";
import { isValidMediaType } from "../services/mediaTypes.js";
import { CONTENT_RATING_ORDER } from "../services/contentRatings.js";
import { logAuditEvent } from "../services/audit.js";

export const usersRouter = Router();
usersRouter.use(requireAdmin);

function getAllowedTypes(userId: number): string[] {
  return (
    db.prepare("SELECT media_type FROM user_library_access WHERE user_id = ?").all(userId) as {
      media_type: string;
    }[]
  ).map((r) => r.media_type);
}

usersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db.prepare("SELECT * FROM users ORDER BY username").all() as any[];
    res.json(rows.map((r) => ({ ...userFromRow(r), allowedTypes: getAllowedTypes(r.id) })));
  })
);

usersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.username || !b.password) throw new HttpError(400, "username and password are required");
    const allowedTypes: string[] = Array.isArray(b.allowedTypes) ? b.allowedTypes : [];
    for (const t of allowedTypes) {
      if (!isValidMediaType(t)) throw new HttpError(400, `Unknown media type "${t}"`);
    }

    if (b.maxContentRating && !CONTENT_RATING_ORDER.includes(b.maxContentRating)) {
      throw new HttpError(400, `Unknown content rating "${b.maxContentRating}"`);
    }

    let result;
    try {
      result = db
        .prepare(
          "INSERT INTO users (username, password_hash, max_pending_requests, auto_approve, max_content_rating) VALUES (?, ?, ?, ?, ?)"
        )
        .run(b.username, hashPassword(b.password), b.maxPendingRequests ?? null, b.autoApprove ? 1 : 0, b.maxContentRating ?? null);
    } catch {
      throw new HttpError(409, "Username already exists");
    }

    const userId = Number(result.lastInsertRowid);
    const insertAccess = db.prepare("INSERT INTO user_library_access (user_id, media_type) VALUES (?, ?)");
    for (const t of allowedTypes) insertAccess.run(userId, t);
    logAuditEvent(null, "admin", "user_created", b.username);

    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    res.status(201).json({ ...userFromRow(row), allowedTypes: getAllowedTypes(userId) });
  })
);

usersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
    if (!existing) throw new HttpError(404, "User not found");

    const b = req.body ?? {};
    if (b.password) {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(b.password), req.params.id);
      // A password reset should invalidate any session issued under the old password — otherwise
      // a compromised account stays logged in elsewhere even after the admin "fixes" it.
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(req.params.id);
      logAuditEvent(null, "admin", "user_password_reset", (existing as any).username);
    }
    if (b.maxPendingRequests !== undefined) {
      db.prepare("UPDATE users SET max_pending_requests = ? WHERE id = ?").run(
        b.maxPendingRequests === null ? null : Number(b.maxPendingRequests),
        req.params.id
      );
    }
    if (b.autoApprove !== undefined) {
      db.prepare("UPDATE users SET auto_approve = ? WHERE id = ?").run(b.autoApprove ? 1 : 0, req.params.id);
    }
    if (b.maxContentRating !== undefined) {
      if (b.maxContentRating !== null && !CONTENT_RATING_ORDER.includes(b.maxContentRating)) {
        throw new HttpError(400, `Unknown content rating "${b.maxContentRating}"`);
      }
      db.prepare("UPDATE users SET max_content_rating = ? WHERE id = ?").run(b.maxContentRating, req.params.id);
    }
    if (Array.isArray(b.allowedTypes)) {
      for (const t of b.allowedTypes) {
        if (!isValidMediaType(t)) throw new HttpError(400, `Unknown media type "${t}"`);
      }
      db.prepare("DELETE FROM user_library_access WHERE user_id = ?").run(req.params.id);
      const insertAccess = db.prepare("INSERT INTO user_library_access (user_id, media_type) VALUES (?, ?)");
      for (const t of b.allowedTypes) insertAccess.run(req.params.id, t);
    }

    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
    res.json({ ...userFromRow(row), allowedTypes: getAllowedTypes(Number(req.params.id)) });
  })
);

/** GET /api/users/sessions — every active household-user session, for the admin session-management screen. */
usersRouter.get(
  "/sessions",
  asyncHandler(async (_req, res) => {
    res.json(listActiveSessions());
  })
);

/** DELETE /api/users/sessions/:token — force-log-out one session. */
usersRouter.delete(
  "/sessions/:token",
  asyncHandler(async (req, res) => {
    const result = db.prepare("DELETE FROM sessions WHERE token = ?").run(req.params.token);
    if (result.changes === 0) throw new HttpError(404, "Session not found");
    res.status(204).send();
  })
);

usersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = db.prepare("SELECT username FROM users WHERE id = ?").get(req.params.id) as
      | { username: string }
      | undefined;
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(req.params.id);
    const result = db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "User not found");
    if (existing) logAuditEvent(null, "admin", "user_deleted", existing.username);
    res.status(204).send();
  })
);
