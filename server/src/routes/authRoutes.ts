import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { clientIp } from "../middleware/auth.js";
import {
  consumePendingLogin,
  createPendingLogin,
  createSession,
  destroySession,
  hashPassword,
  verifyPassword,
} from "../services/auth.js";
import { logAuditEvent } from "../services/audit.js";
import { checkRateLimit, recordFailure, recordSuccess } from "../services/rateLimiter.js";
import { buildOtpauthUrl, generateBase32Secret, verifyTotp } from "../services/totp.js";
import { streamFileWithRangeSupport } from "../services/rangeStream.js";

export const authRouter = Router();

const AVATAR_DIR = path.join(config.configDir, "avatars");
const AVATAR_EXTENSION_BY_MIMETYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype in AVATAR_EXTENSION_BY_MIMETYPE),
});

/** Public — lets the web UI decide whether to show "create admin account" or the normal login form. */
authRouter.get(
  "/setup-status",
  asyncHandler(async (_req, res) => {
    const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
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
    const existingAdmin = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (existingAdmin) throw new HttpError(403, "An admin account already exists");

    const { username, password } = req.body ?? {};
    if (!username || typeof username !== "string" || username.trim().length < 1) {
      throw new HttpError(400, "username is required");
    }
    if (!password || typeof password !== "string" || password.length < 8) {
      throw new HttpError(400, "password must be at least 8 characters");
    }

    const passwordHash = hashPassword(password);
    const result = await db
      .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
      .run(username.trim(), passwordHash);
    const userId = Number(result.lastInsertRowid);

    logAuditEvent(userId, username.trim(), "admin_account_created");

    const session = await createSession(userId, req.header("User-Agent"));
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

    const rateLimitKey = `login:${clientIp(req)}`;
    const rateLimit = checkRateLimit(rateLimitKey);
    if (!rateLimit.allowed) {
      res.status(429).json({ error: "Too many failed attempts. Try again later.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }

    const user = (await db.prepare("SELECT * FROM users WHERE username = ?").get(username)) as
      | { id: number; username: string; password_hash: string; role: string; totp_enabled: number }
      | undefined;
    if (!user || !verifyPassword(password, user.password_hash)) {
      recordFailure(rateLimitKey);
      logAuditEvent(user?.id ?? null, username, "login_failed");
      throw new HttpError(401, "Invalid username or password");
    }
    recordSuccess(rateLimitKey);

    if (user.totp_enabled) {
      res.json({ totpRequired: true, pendingToken: createPendingLogin(user.id) });
      return;
    }

    logAuditEvent(user.id, user.username, "login");
    const allowedTypes = (
      (await db.prepare("SELECT media_type FROM user_library_access WHERE user_id = ?").all(user.id)) as {
        media_type: string;
      }[]
    ).map((r) => r.media_type);

    const session = await createSession(user.id, req.header("User-Agent"));
    res.json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: user.id, username: user.username, role: user.role, allowedTypes },
    });
  })
);

/** Public — second step of login for an account with TOTP enabled; the pendingToken from /login
 * proves the password already checked out, so this only needs to check the 6-digit code. */
authRouter.post(
  "/login/totp",
  asyncHandler(async (req, res) => {
    const { pendingToken, code } = req.body ?? {};
    if (!pendingToken || !code) throw new HttpError(400, "pendingToken and code are required");

    const rateLimitKey = `logintotp:${clientIp(req)}`;
    const rateLimit = checkRateLimit(rateLimitKey);
    if (!rateLimit.allowed) {
      res.status(429).json({ error: "Too many failed attempts. Try again later.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }

    const userId = consumePendingLogin(pendingToken);
    const user = userId
      ? ((await db.prepare("SELECT * FROM users WHERE id = ?").get(userId)) as
          | { id: number; username: string; role: string; totp_secret: string | null }
          | undefined)
      : undefined;
    if (!user || !user.totp_secret || !verifyTotp(user.totp_secret, code)) {
      recordFailure(rateLimitKey);
      throw new HttpError(401, "Invalid or expired code — log in again");
    }
    recordSuccess(rateLimitKey);
    logAuditEvent(user.id, user.username, "login");

    const allowedTypes = (
      (await db.prepare("SELECT media_type FROM user_library_access WHERE user_id = ?").all(user.id)) as {
        media_type: string;
      }[]
    ).map((r) => r.media_type);

    const session = await createSession(user.id, req.header("User-Agent"));
    res.json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: user.id, username: user.username, role: user.role, allowedTypes },
    });
  })
);

/** Self-service two-factor for the currently logged-in account (household or admin-via-session —
 * not the legacy API-key admin, which has its own instance-wide TOTP under Settings). */
authRouter.post(
  "/totp/setup",
  asyncHandler(async (req, res) => {
    if (!req.auth?.user) throw new HttpError(401, "Not authenticated");
    const user = (await db.prepare("SELECT totp_secret, totp_enabled FROM users WHERE id = ?").get(req.auth.user.id)) as
      | { totp_secret: string | null; totp_enabled: number }
      | undefined;
    // Re-keying an already-enabled account needs proof of the *current* second factor first — a
    // session-token-only compromise (XSS, a leaked/shared token) could otherwise silently swap in
    // the attacker's own authenticator as the account's 2FA, invisibly to the real owner, since
    // "2FA enabled" in the UI wouldn't change. First-time setup has no prior secret to prove.
    if (user?.totp_enabled && (!user.totp_secret || !verifyTotp(user.totp_secret, req.body?.code ?? ""))) {
      throw new HttpError(400, "Enter your current 2FA code to set up a new one");
    }
    const secret = generateBase32Secret();
    await db.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(secret, req.auth.user.id);
    res.json({ secret, otpauthUrl: buildOtpauthUrl(secret, req.auth.user.username) });
  })
);

authRouter.post(
  "/totp/verify",
  asyncHandler(async (req, res) => {
    if (!req.auth?.user) throw new HttpError(401, "Not authenticated");
    const user = (await db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(req.auth.user.id)) as
      | { totp_secret: string | null }
      | undefined;
    if (!user?.totp_secret) throw new HttpError(400, "No pending TOTP setup — call /totp/setup first");
    if (!verifyTotp(user.totp_secret, req.body?.code ?? "")) throw new HttpError(400, "Invalid code");
    await db.prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?").run(req.auth.user.id);
    res.status(204).send();
  })
);

authRouter.post(
  "/totp/disable",
  asyncHandler(async (req, res) => {
    if (!req.auth?.user) throw new HttpError(401, "Not authenticated");
    const user = (await db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(req.auth.user.id)) as
      | { totp_secret: string | null }
      | undefined;
    // The client already collects and sends a code for this (Account.tsx's "Enter a code to
    // disable it") — it just wasn't being checked, so a hijacked session token alone could strip
    // 2FA from an account, defeating the point of 2FA surviving a token-only compromise.
    if (!user?.totp_secret || !verifyTotp(user.totp_secret, req.body?.code ?? "")) {
      throw new HttpError(400, "Invalid code");
    }
    await db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?").run(req.auth.user.id);
    res.status(204).send();
  })
);

/** Self-service profile fields — display name, bio, and a free-form list of social/website links.
 * Deliberately NOT username/password here: those stay admin-managed via PATCH /api/users/:id (a
 * household account can't rename or re-key itself), same boundary the TOTP routes above already
 * draw between "manage my own account" and "manage the account." */
authRouter.patch(
  "/me",
  asyncHandler(async (req, res) => {
    if (!req.auth?.user) throw new HttpError(401, "Not authenticated");
    const b = req.body ?? {};
    const socialLinks = Array.isArray(b.socialLinks)
      ? b.socialLinks
          .filter((l: any) => l && typeof l.label === "string" && typeof l.url === "string" && l.label.trim() && l.url.trim())
          .map((l: any) => ({ label: l.label.trim(), url: l.url.trim() }))
      : [];
    await db
      .prepare("UPDATE users SET display_name = ?, bio = ?, social_links = ? WHERE id = ?")
      .run(b.displayName?.trim() || null, b.bio?.trim() || null, JSON.stringify(socialLinks), req.auth.user.id);
    res.status(204).send();
  })
);

authRouter.post(
  "/me/avatar",
  avatarUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.auth?.user) throw new HttpError(401, "Not authenticated");
    if (!req.file) throw new HttpError(400, "file is required (multipart form field \"file\"), and must be a JPEG/PNG/WebP/GIF image");

    const ext = AVATAR_EXTENSION_BY_MIMETYPE[req.file.mimetype];
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    // Clears out a previous avatar under any of the other extensions first — otherwise switching
    // from a .png to a .jpg avatar would leave the old .png sitting on disk forever, orphaned once
    // avatar_path below points at the new file instead.
    for (const oldExt of Object.values(AVATAR_EXTENSION_BY_MIMETYPE)) {
      try {
        fs.unlinkSync(path.join(AVATAR_DIR, `user-${req.auth.user.id}${oldExt}`));
      } catch {
        // no existing avatar with this extension, nothing to clean up
      }
    }
    const fileName = `user-${req.auth.user.id}${ext}`;
    fs.writeFileSync(path.join(AVATAR_DIR, fileName), req.file.buffer);
    await db.prepare("UPDATE users SET avatar_path = ? WHERE id = ?").run(fileName, req.auth.user.id);
    res.json({ avatarPath: fileName });
  })
);

/** Not gated to "only the logged-in user's own id" — every account in a household can see every
 * other account's display name/avatar already (Users.tsx lists them all for an admin, and a
 * shared-library household has no real privacy boundary between its own members), so there's
 * nothing an avatar image itself would leak that isn't already visible elsewhere. Still requires
 * *some* valid session/API key, same as every other route under /auth and /api. */
authRouter.get(
  "/me/avatar/:userId",
  asyncHandler(async (req, res) => {
    const user = (await db.prepare("SELECT avatar_path FROM users WHERE id = ?").get(req.params.userId)) as { avatar_path: string | null } | undefined;
    if (!user?.avatar_path) throw new HttpError(404, "No avatar set");
    streamFileWithRangeSupport(req, res, path.join(AVATAR_DIR, user.avatar_path));
  })
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = req.header("X-Session-Token");
    if (token) await destroySession(token);
    if (req.auth?.user) logAuditEvent(req.auth.user.id, req.auth.user.username, "logout");
    res.status(204).send();
  })
);

authRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    if (req.auth?.user) {
      res.json({ isAdmin: req.auth.isAdmin, user: req.auth.user });
      return;
    }
    if (req.auth?.isAdmin) {
      res.json({ isAdmin: true });
      return;
    }
    throw new HttpError(401, "Not authenticated");
  })
);
