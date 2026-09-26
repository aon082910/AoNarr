import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getSetting } from "../services/settingsStore.js";
import { getSessionUser, type SessionUser } from "../services/auth.js";
import { checkRateLimit, recordFailure } from "../services/rateLimiter.js";

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

/** How a request authenticated — kept so it can be checked again later (a stream ticket redeemed,
 * a long-lived stream still open) rather than trusted for as long as the connection lives. */
type Credential = { kind: "open" } | { kind: "apiKey"; key: string } | { kind: "session"; token: string };

const requestCredentials = new WeakMap<Request, Credential>();

/** Who `credential` authenticates as right now, or null once it no longer does (session revoked or
 * expired, user deleted or password reset, API key regenerated, authentication re-enabled). */
async function resolveCredential(credential: Credential): Promise<AuthContext | null> {
  if (credential.kind === "open") return getSetting("authRequired") === "0" ? { isAdmin: true } : null;
  if (credential.kind === "apiKey") {
    const expectedApiKey = getSetting("apiKey");
    return expectedApiKey && safeEqual(credential.key, expectedApiKey) ? { isAdmin: true } : null;
  }
  const user = await getSessionUser(credential.token);
  return user ? { isAdmin: user.role === "admin", user } : null;
}

/** The long-lived Server-Sent-Events routes (Activity queue, System live logs). */
const STREAM_PATHS = new Set(["/activity/stream", "/system/logs/stream"]);
const STREAM_TICKET_TTL_MS = 60_000;
const STREAM_REVALIDATE_MS = 30_000;
const streamTickets = new Map<string, { credential: Credential; expiresAt: number }>();

function isStreamRequest(req: Request): boolean {
  return req.method === "GET" && STREAM_PATHS.has(req.path);
}

/**
 * An EventSource can't send the X-Api-Key/X-Session-Token headers, and a credential in its URL ends
 * up in every proxy access log (the bundled nginx logs the full query string to `docker logs`). So
 * the browser trades its header credential for this short-lived, single-use ticket and opens the
 * stream with `?ticket=` instead. The ticket carries the caller's own credential, so it grants no
 * more than that credential does and stops working the moment it's revoked. Null when the request
 * wasn't authenticated through requireAuth.
 */
export function mintStreamTicket(req: Request): { ticket: string; expiresAt: string } | null {
  const credential = requestCredentials.get(req);
  if (!credential) return null;
  const now = Date.now();
  for (const [ticket, entry] of streamTickets) {
    if (entry.expiresAt <= now) streamTickets.delete(ticket);
  }
  const ticket = crypto.randomBytes(32).toString("hex");
  const expiresAt = now + STREAM_TICKET_TTL_MS;
  streamTickets.set(ticket, { credential, expiresAt });
  return { ticket, expiresAt: new Date(expiresAt).toISOString() };
}

function redeemStreamTicket(ticket: string): Credential | null {
  const entry = streamTickets.get(ticket);
  streamTickets.delete(ticket);
  return entry && entry.expiresAt > Date.now() ? entry.credential : null;
}

/** A stream is authenticated once, at connect, and then held open indefinitely — so its credential
 * is re-checked on a timer and the connection dropped once it no longer authenticates (or no longer
 * as an admin), instead of streaming on to a revoked session or a rotated API key. */
function closeStreamWhenRevoked(res: Response, credential: Credential, wasAdmin: boolean): void {
  const timer = setInterval(() => {
    resolveCredential(credential).then(
      (auth) => {
        if (auth && (auth.isAdmin || !wasAdmin)) return;
        clearInterval(timer);
        res.destroy();
      },
      () => {
        // a transient DB error isn't a revocation — the next check decides
      }
    );
  }, STREAM_REVALIDATE_MS);
  res.on("close", () => clearInterval(timer));
}

function accept(req: Request, res: Response, next: NextFunction, credential: Credential, auth: AuthContext): void {
  req.auth = auth;
  requestCredentials.set(req, credential);
  if (isStreamRequest(req)) closeStreamWhenRevoked(res, credential, auth.isAdmin);
  next();
}

/** routes/remoteInstances.ts's artwork relay, loaded by <img>/CSS backgrounds that can't send the
 * credential headers — public like the /media/local-artwork/ route it fronts on the remote. */
const REMOTE_ARTWORK_RELAY_PATH = /^\/remote-instances\/\d{1,9}\/local-artwork\/[A-Za-z0-9_-]+$/;

/**
 * Two credential types are accepted: the instance-wide admin API key (`X-Api-Key`, same as every
 * Starr app), or a per-user session token (`X-Session-Token`) — issued to any logged-in user,
 * admin or a restricted household account created in Settings → Users; `req.auth.isAdmin` reflects
 * the underlying user's role either way. Whichever is present and valid populates `req.auth`;
 * routes that need admin-only access additionally apply `requireAdmin`. Both travel as headers
 * only; the SSE streams, which can't send headers, take a stream ticket (see mintStreamTicket).
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
    req.path.startsWith("/media/local-artwork/") ||
    (req.method === "GET" && REMOTE_ARTWORK_RELAY_PATH.test(req.path)) ||
    req.path.startsWith("/invite/")
  ) {
    next();
    return;
  }

  // Radarr-style "Authentication Required: Disabled" — opt-in, for a trusted private network
  // only. Every request is treated as admin; the API key/session checks below never even run.
  if (getSetting("authRequired") === "0") {
    accept(req, res, next, { kind: "open" }, { isAdmin: true });
    return;
  }

  const expectedApiKey = getSetting("apiKey");
  const providedApiKey = req.header("X-Api-Key") ?? "";
  if (expectedApiKey && providedApiKey && safeEqual(providedApiKey, expectedApiKey)) {
    accept(req, res, next, { kind: "apiKey", key: providedApiKey }, { isAdmin: true });
    return;
  }

  const sessionToken = req.header("X-Session-Token");
  if (sessionToken) {
    const user = await getSessionUser(sessionToken);
    if (user) {
      accept(req, res, next, { kind: "session", token: sessionToken }, { isAdmin: user.role === "admin", user });
      return;
    }
  }

  const ticket = isStreamRequest(req) && typeof req.query.ticket === "string" ? req.query.ticket : "";
  if (ticket) {
    const credential = redeemStreamTicket(ticket);
    const auth = credential ? await resolveCredential(credential) : null;
    if (credential && auth) {
      accept(req, res, next, credential, auth);
      return;
    }
  }

  // The lockout only ever applies to a request that FAILED to authenticate — valid credentials are
  // checked first. The bucket is per client IP, and behind a second reverse proxy (SWAG, NPM,
  // Traefik, a Cloudflare tunnel) every client shares one IP, so checking the lockout first let ten
  // junk requests from anyone 429 every real user's valid session for 15 minutes, on repeat. An API
  // key or session token is far too long to brute-force, so validating it before the lockout
  // gives nothing away.
  const rateLimitKey = `authkey:${clientIp(req)}`;
  const rateLimit = checkRateLimit(rateLimitKey);
  if (!rateLimit.allowed) {
    res.status(429).json({ error: "Too many failed attempts. Try again later.", retryAfterSeconds: rateLimit.retryAfterSeconds });
    return;
  }

  // Only count it as a failed *credential-guessing* attempt when credentials were actually
  // supplied — an unauthenticated client hitting the API with no header at all (e.g. a stray
  // request) shouldn't burn down the same attempt budget as a wrong API key.
  if (providedApiKey || sessionToken || ticket) recordFailure(rateLimitKey);
  res.status(401).json({ error: "Invalid or missing credentials" });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
