import { Router } from "express";
import { db } from "../db/client.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { createSession, destroySession, hashPassword, verifyPassword } from "../services/auth.js";
import { logAuditEvent } from "../services/audit.js";
import { checkRateLimit, recordFailure, recordSuccess } from "../services/rateLimiter.js";

export const authRouter = Router();

/** Public — lets the web UI decide whether to show "create admin account" or the normal login form. */
authRouter.get(
  "/setup-status",
  asyncHandler(async (_req, res) => {
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    res.json({ needsSetup: !admin });
  })
);

/**
 * Public, but only does anything while no admin account exists yet — creates the first admin
 * user and logs them in. Once an admin exists this always 403s, so it can't be used to mint a
 * second admin account without already being authenticated (use Settings → Users for that).
 */
authRouter.post(
  "/setup",
  asyncHandler(async (req, res) => {
    const existingAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (existingAdmin) throw new HttpError(403, "An admin account already exists");

    const { username, password } = req.body ?? {};
    if (!username || typeof username !== "string" || username.trim().length < 1) {
      throw new HttpError(400, "username is required");
    }
    if (!password || typeof password !== "string" || password.length < 8) {
      throw new HttpError(400, "password must be at least 8 characters");
    }

    const passwordHash = hashPassword(password);
    const result = db
      .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
      .run(username.trim(), passwordHash);
    const userId = Number(result.lastInsertRowid);

    logAuditEvent(userId, username.trim(), "admin_account_created");

    const session = createSession(userId, req.header("User-Agent"));
    res.status(201).json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: userId, username: username.trim(), role: "admin", allowedTypes: [] },
    });
  })
);

/** Public — no session/API key required yet, since this is how a user gets one. */
authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) throw new HttpError(400, "username and password are required");

    const rateLimitKey = `login:${req.ip}`;
    const rateLimit = checkRateLimit(rateLimitKey);
    if (!rateLimit.allowed) {
      res.status(429).json({ error: "Too many failed attempts. Try again later.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }

    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
      | { id: number; username: string; password_hash: string; role: string }
      | undefined;
    if (!user || !verifyPassword(password, user.password_hash)) {
      recordFailure(rateLimitKey);
      logAuditEvent(user?.id ?? null, username, "login_failed");
      throw new HttpError(401, "Invalid username or password");
    }
    recordSuccess(rateLimitKey);
    logAuditEvent(user.id, user.username, "login");

    const allowedTypes = (
      db.prepare("SELECT media_type FROM user_library_access WHERE user_id = ?").all(user.id) as {
        media_type: string;
      }[]
    ).map((r) => r.media_type);

    const session = createSession(user.id, req.header("User-Agent"));
    res.json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: user.id, username: user.username, role: user.role, allowedTypes },
    });
  })
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = req.header("X-Session-Token");
    if (token) destroySession(token);
    if (req.auth?.user) logAuditEvent(req.auth.user.id, req.auth.user.username, "logout");
    res.status(204).send();
  })
);

authRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    if (req.auth?.isAdmin) {
      res.json({ isAdmin: true });
      return;
    }
    if (req.auth?.user) {
      res.json({ isAdmin: false, user: req.auth.user });
      return;
    }
    throw new HttpError(401, "Not authenticated");
  })
);
