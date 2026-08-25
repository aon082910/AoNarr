import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getSetting } from "../services/settingsStore.js";
import { getSessionUser, type SessionUser } from "../services/auth.js";
import { checkRateLimit, recordFailure, recordSuccess } from "../services/rateLimiter.js";

/** Same-length check first (timingSafeEqual throws on mismatched lengths — that's a length leak,
 * not a content one, and the expected key's length is fixed/public anyway), then a constant-time
 * byte comparison so a wrong-but-close guess doesn't take measurably longer to reject. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export interface AuthContext {
  isAdmin: boolean;
  user?: SessionUser;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Two credential types are accepted: the instance-wide admin API key (`X-Api-Key`, same as every
 * Starr app), or a per-user session token (`X-Session-Token`) — issued to any logged-in user,
 * admin or a restricted household account created in Settings → Users; `req.auth.isAdmin` reflects
 * the underlying user's role either way. Whichever is present and valid populates `req.auth`;
 * routes that need admin-only access additionally apply `requireAdmin`.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (
    req.path === "/health" ||
    req.path === "/auth/login" ||
    req.path === "/auth/login/totp" ||
    req.path === "/auth/setup" ||
    req.path === "/auth/setup-status" ||
    req.path === "/metrics" ||
    req.path === "/calendar.ics" ||
    req.path === "/theme.css" ||
    req.path === "/webhooks/media-server" ||
    req.path.startsWith("/share/") ||
    req.path.startsWith("/iptv/m3u/") ||
    req.path.startsWith("/iptv/stream/")
  ) {
    next();
    return;
  }

  const rateLimitKey = `authkey:${req.ip}`;
  const rateLimit = checkRateLimit(rateLimitKey);
  if (!rateLimit.allowed) {
    res.status(429).json({ error: "Too many failed attempts. Try again later.", retryAfterSeconds: rateLimit.retryAfterSeconds });
    return;
  }

  const expectedApiKey = getSetting("apiKey");
  const providedApiKey = (req.header("X-Api-Key") ?? (req.query.apikey as string | undefined)) ?? "";
  if (expectedApiKey && providedApiKey && safeEqual(providedApiKey, expectedApiKey)) {
    recordSuccess(rateLimitKey);
    req.auth = { isAdmin: true };
    next();
    return;
  }

  // Query-param fallback for both credential types exists for the same reason: an EventSource (the
  // Activity page's live-queue stream, see routes/activity.ts's /stream) can't set a custom header
  // on its request, so the browser client has to put the credential in the URL instead.
  const sessionToken = req.header("X-Session-Token") ?? (req.query.sessionToken as string | undefined);
  if (sessionToken) {
    const user = await getSessionUser(sessionToken);
    if (user) {
      recordSuccess(rateLimitKey);
      req.auth = { isAdmin: user.role === "admin", user };
      next();
      return;
    }
  }

  // Only count it as a failed *credential-guessing* attempt when credentials were actually
  // supplied — an unauthenticated client hitting the API with no header at all (e.g. a stray
  // request) shouldn't burn down the same attempt budget as a wrong API key.
  if (providedApiKey || sessionToken) recordFailure(rateLimitKey);
  res.status(401).json({ error: "Invalid or missing credentials" });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
