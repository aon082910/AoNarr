import crypto from "node:crypto";
import { Router } from "express";
import { db } from "../db/index.js";
import { inviteFromRow, userFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { requireAdmin } from "../middleware/auth.js";
import { isValidMediaType } from "../services/mediaTypes.js";
import { CONTENT_RATING_ORDER } from "../services/contentRatings.js";
import { hashPassword, createSession } from "../services/auth.js";
import { logAuditEvent } from "../services/audit.js";

/**
 * Admin-side invite management, mounted at /api/users/invites — pre-configure the libraries/
 * content rating/role a new household member gets, generate a one-time signup link, and share it
 * instead of typing their username/password in for them. Wizarr's core idea, scoped to AoNarr's
 * own accounts rather than a cross-server orchestrator.
 */
export const userInvitesRouter = Router();
userInvitesRouter.use(requireAdmin);

userInvitesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM user_invites ORDER BY created_at DESC").all();
    res.json(rows.map(inviteFromRow));
  })
);

userInvitesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const allowedTypes: string[] = Array.isArray(b.allowedTypes) ? b.allowedTypes : [];
    for (const t of allowedTypes) {
      if (!isValidMediaType(t)) throw new HttpError(400, `Unknown media type "${t}"`);
    }
    if (b.maxContentRating && !CONTENT_RATING_ORDER.includes(b.maxContentRating)) {
      throw new HttpError(400, `Unknown content rating "${b.maxContentRating}"`);
    }
    const role = b.role === "admin" ? "admin" : "user";
    const expiresAt: string | null = b.expiresInDays ? new Date(Date.now() + b.expiresInDays * 24 * 60 * 60 * 1000).toISOString() : null;

    const token = crypto.randomBytes(20).toString("hex");
    const result = await db
      .prepare("INSERT INTO user_invites (token, allowed_types, max_content_rating, role, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(token, JSON.stringify(allowedTypes), b.maxContentRating ?? null, role, expiresAt);

    const row = await db.prepare("SELECT * FROM user_invites WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(inviteFromRow(row));
  })
);

userInvitesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM user_invites WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Invite not found");
    res.status(204).send();
  })
);

/**
 * Public redemption endpoints, mounted at /api/invite (see middleware/auth.ts's /invite/
 * exemption — same unauthenticated-public-link pattern as share links). GET previews a token
 * without exposing anything sensitive; POST actually creates the account.
 */
export const inviteAcceptRouter = Router();

async function loadValidInvite(token: string): Promise<any> {
  const row = (await db.prepare("SELECT * FROM user_invites WHERE token = ?").get(token)) as any;
  if (!row) throw new HttpError(404, "This invite link isn't valid");
  if (row.used_at) throw new HttpError(410, "This invite link has already been used");
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) throw new HttpError(410, "This invite link has expired");
  return row;
}

inviteAcceptRouter.get(
  "/:token",
  asyncHandler(async (req, res) => {
    const row = await loadValidInvite(req.params.token);
    res.json({
      valid: true,
      allowedTypes: row.allowed_types ? JSON.parse(row.allowed_types) : [],
      role: row.role,
    });
  })
);

inviteAcceptRouter.post(
  "/:token",
  asyncHandler(async (req, res) => {
    const row = await loadValidInvite(req.params.token);
    const b = req.body ?? {};
    if (!b.username || !b.password) throw new HttpError(400, "username and password are required");
    if (String(b.password).length < 8) throw new HttpError(400, "Password must be at least 8 characters");

    const allowedTypes: string[] = row.allowed_types ? JSON.parse(row.allowed_types) : [];
    let result;
    try {
      result = await db
        .prepare("INSERT INTO users (username, password_hash, role, max_content_rating) VALUES (?, ?, ?, ?)")
        .run(b.username, hashPassword(b.password), row.role, row.max_content_rating);
    } catch {
      throw new HttpError(409, "That username is already taken");
    }
    const userId = Number(result.lastInsertRowid);
    for (const t of allowedTypes) {
      await db.prepare("INSERT INTO user_library_access (user_id, media_type) VALUES (?, ?)").run(userId, t);
    }
    await db.prepare("UPDATE user_invites SET used_at = ?, used_by_user_id = ? WHERE id = ?").run(new Date().toISOString(), userId, row.id);
    logAuditEvent(null, "admin", "user_created_via_invite", b.username);

    const session = await createSession(userId, req.header("User-Agent"));
    const userRow = await db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    res.status(201).json({ token: session.token, user: userFromRow(userRow) });
  })
);
