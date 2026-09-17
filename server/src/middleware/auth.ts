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

function isPrivateAddress(addr: string): boolean {
  const ip = addr.replace(/^::ffff:/, "");
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^f[cd][0-9a-f]{2}:/i.test(ip)
  );
}

/**
 * The address to key rate limits on. Every shipped deployment puts nginx in front of this
 * process (combined image: same container; split images: docker network), and it sets
 * `X-Real-IP` to the real client — `req.ip` would otherwise be the proxy's own address for every
 * request, collapsing all users into one shared lockout bucket (10 bad API-key attempts from one
 * stranger would 429 the real admin too). Only honored when the direct peer is a private/loopback
 * address, so an X-Real-IP header arriving straight from the internet can't spoof the key.
 */
export function clientIp(req: Request): string {
  const peer = req.socket.remoteAddress ?? req.ip ?? "unknown";
  const realIp = req.header("X-Real-IP");
  if (realIp && isPrivateAddress(peer)) return realIp.trim();
  return peer;
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
    req.path === "/webhooks/overseerr" ||
    req.path === "/discord/interactions" ||
    req.path.startsWith("/share/") ||
    req.path.startsWith("/iptv/m3u/") ||
    req.path.startsWith("/iptv/stream/") ||
    req.path.startsWith("/opds") ||
    req.path.startsWith("/invite/")
  ) {
    next();
    return;
  }

  // Radarr-style "Authentication Required: Disabled" — opt-in, for a trusted private network
  // only. Every request is treated as admin; the API key/session checks below never even run.
  if (getSetting("authRequired") === "0") {
    req.auth = { isAdmin: true };
    next();
    return;
  }

  const rateLimitKey = `authkey:${clientIp(req)}`;
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
