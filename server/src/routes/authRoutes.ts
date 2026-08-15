import { Router } from "express";
import { db } from "../db/client.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { createSession, destroySession, verifyPassword } from "../services/auth.js";
import { logAuditEvent } from "../services/audit.js";
import { checkRateLimit, recordFailure, recordSuccess } from "../services/rateLimiter.js";

export const authRouter = Router();

/** Public — no session/API key required yet, since this is how a restricted user gets one. */
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
