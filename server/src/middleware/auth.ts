import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getSetting } from "../services/settingsStore.js";
import { getSessionUser, type SessionUser } from "../services/auth.js";
import { checkRateLimit, recordFailure } from "../services/rateLimiter.js";
import { hostPatternProblem, matchesBypassFilter, parseBypassFilter, type FilterEntry } from "../services/networkAddress.js";
import { log } from "../services/logger.js";

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

/** The `localNetworks` setting as ranges, parsed again only when the text changes. Empty: the built-in private ranges apply. */
let localNetworksText = "";
let localNetworksParsed: FilterEntry[] = [];

function configuredLocalNetworks(): FilterEntry[] | null {
  const text = (getSetting("localNetworks") ?? "").trim();
  if (text !== localNetworksText) {
    localNetworksText = text;
    localNetworksParsed = parseBypassFilter(text).filter((entry) => entry.kind !== "name");
    if (text && localNetworksParsed.length === 0) log.warn("[auth] the Local networks setting holds no usable address or range: no request counts as local until it is fixed");
  }
  return text ? localNetworksParsed : null;
}

/**
 * Whether the address counts as the home network: the ranges the admin listed in `localNetworks`, else the private ranges.
 * A list that holds nothing usable means no address is local (it does not fall back to the wider built-in ranges).
 */
function isPrivateAddress(addr: string): boolean {
  const configured = configuredLocalNetworks();
  if (configured) return matchesBypassFilter(addr, configured);
  return isBuiltInPrivateAddress(addr);
}

function isBuiltInPrivateAddress(addr: string): boolean {
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
  // The proxy in front (nginx on loopback or the docker network) is trusted by the built-in private ranges, not by the Local
  // networks list: that list says which VISITORS are local, and the proxy's own address need not be on it.
  if (realIp && isBuiltInPrivateAddress(peer)) return realIp.trim();
  return peer;
}

/**
 * Whether the request comes from the local network, for the "disabled for local addresses" setting.
 * The client address must be private, and when a proxy in front forwarded the request the whole
 * X-Forwarded-For chain must be private too: a reverse proxy on the LAN would otherwise make every
 * visitor from the internet look local.
 */
export function isLocalRequest(req: Request): boolean {
  if (!isPrivateAddress(clientIp(req))) return false;
  const forwarded = req.header("X-Forwarded-For");
  if (forwarded && forwarded.split(",").some((address) => !isPrivateAddress(address.trim()))) return false;
  // Other headers proxies and CDNs use to name the visitor: one that names an address from outside the home network says so.
  for (const name of CLIENT_ADDRESS_HEADERS) {
    const value = req.header(name);
    if (value && value.split(",").some((address) => address.trim() && !isPrivateAddress(address.trim()))) return false;
  }
  return true;
}

const CLIENT_ADDRESS_HEADERS = ["CF-Connecting-IP", "True-Client-IP", "X-Client-IP", "X-Original-Forwarded-For"];

/** Headers a reverse proxy in front adds. Seen on a request let in by "disabled for local addresses" with no chain of client addresses, they mean a proxy hid where the visitor came from. */
const PROXY_HINT_HEADERS = ["Forwarded", "X-Forwarded-Host", "CF-Connecting-IP", "True-Client-IP", "CF-Ray", "X-Forwarded-Server"];

/** What was seen on requests let in without a login in the last day; read by the Health report. In memory only: it restarts empty. */
const OBSERVATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_OBSERVATIONS = 200;
const proxiedAt: number[] = [];
const refusedAt: number[] = [];
let lastHostRefused = "";
const hostsLogged = new Set<string>();

function remember(list: number[]): void {
  const now = Date.now();
  list.push(now);
  while (list.length > MAX_OBSERVATIONS || (list.length > 0 && list[0] < now - OBSERVATION_WINDOW_MS)) list.shift();
}

export function openAccessObservations(): { proxiedWithoutChain: number; hostRefused: number; lastHostRefused: string } {
  const cutoff = Date.now() - OBSERVATION_WINDOW_MS;
  return {
    proxiedWithoutChain: proxiedAt.filter((at) => at >= cutoff).length,
    hostRefused: refusedAt.filter((at) => at >= cutoff).length,
    lastHostRefused,
  };
}

/** A Host header as plain text for a message: it comes from whoever sent the request, so only host-name characters stay. */
function hostForMessage(req: Request): string {
  return (req.header("Host") ?? "").replace(/[^A-Za-z0-9.:\-[\]*_]/g, "").slice(0, 100);
}

function noteOpenAccess(req: Request): void {
  const forwarded = req.header("X-Forwarded-For") ?? "";
  // The bundled nginx always appends the address it saw, so a chain with a single entry comes from the nginx alone.
  const chain = forwarded.split(",").filter((entry) => entry.trim()).length;
  if (chain <= 1 && PROXY_HINT_HEADERS.some((name) => req.header(name))) remember(proxiedAt);
}

/** Host names that always count as the home network's own: an address, "localhost", a name with no dot, or a LAN suffix. */
const LOCAL_HOST_SUFFIXES = [".local", ".lan", ".home", ".internal", ".home.arpa", ".localdomain", ".localhost", ".fritz.box", ".intranet", ".corp", ".private", ".ts.net"];

function isPlainLocalHost(host: string): boolean {
  if (!host) return false;
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (host === "localhost" || !host.includes(".")) return true;
  return LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function hostOfUrlSetting(value: string | null): string {
  if (!value) return "";
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Whether the Host header names this server in a way a passwordless visit may use. A page on another site can make a visitor's
 * browser send requests to the home server's address under the attacker's own domain name once the name's DNS answer is
 * switched ("DNS rebinding"); the browser then treats them as the attacker's site, and a request let in by "no login" or
 * "disabled for local addresses" would give that page the whole API. Such a request carries the attacker's name in Host. Allowed:
 * an address, "localhost", a short name or LAN suffix, the host of `externalUrl`, the hosts in `allowedHosts` (wildcards allowed)
 * and the hosts of the allowed CORS origins. A visit with a valid API key or session is not affected.
 */
export function hostAllowedForOpenAccess(req: Request): boolean {
  const raw = (req.header("Host") ?? "").trim();
  // A real Host is a short "name" or "name:port"; anything else (userinfo, a path, a very long value) is refused, never parsed.
  if (!raw || raw.length > 255 || /[\s@/\\?#]/.test(raw)) return false;
  let host: string;
  try {
    host = new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (isPlainLocalHost(host)) return true;
  const external = hostOfUrlSetting(getSetting("externalUrl"));
  if (external && host === external) return true;
  return matchesBypassFilter(host, allowedHostPatterns());
}

/** The patterns from `allowedHosts` and the CORS origins, parsed again only when the text changes. A pattern that is too loose (a bare "*", "*.com") is left out. */
let allowedHostText: string | null = null;
let allowedHostEntries: FilterEntry[] = [];

function allowedHostPatterns(): FilterEntry[] {
  const listed = (getSetting("allowedHosts") ?? "")
    .split(/[,;\s]+/)
    .map((item) => item.trim().toLowerCase().replace(/:\d+$/, ""))
    .filter(Boolean);
  const cors = `${getSetting("corsAllowedOrigins") ?? ""},${process.env.AONARR_CORS_ALLOWED_ORIGINS ?? ""}`
    .split(/[,;\s]+/)
    .map((item) => hostOfUrlSetting(item.trim()))
    .filter(Boolean);
  const text = [...listed, ...cors].filter((pattern) => !hostPatternProblem(pattern)).join(",");
  if (text !== allowedHostText) {
    allowedHostText = text;
    allowedHostEntries = parseBypassFilter(text);
  }
  return allowedHostEntries;
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
type Credential = { kind: "open"; local?: boolean } | { kind: "apiKey"; key: string } | { kind: "session"; token: string };

const requestCredentials = new WeakMap<Request, Credential>();

/** Who `credential` authenticates as right now, or null once it no longer does (session revoked or
 * expired, user deleted or password reset, API key regenerated, authentication re-enabled). */
async function resolveCredential(credential: Credential): Promise<AuthContext | null> {
  if (credential.kind === "open") {
    const mode = getSetting("authRequired");
    return mode === "0" || (mode === "local" && credential.local) ? { isAdmin: true } : null;
  }
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
  return authenticate(req, res, next, true);
}

/** requireAuth without the list of open /api paths: the Starr-compatible surface has paths of its own
 * (a Starr app's /health answers with the app's health, so it must not be open), and only /ping is. */
export async function requireAuthStrict(req: Request, res: Response, next: NextFunction) {
  return authenticate(req, res, next, false);
}

/**
 * Whether a request to this /api path (as req.path sees it under the /api mount: "/auth/login") needs no credential at
 * all. Some of these carry a token of their own (a feed, a webhook, a share link) that the route checks. The generated
 * OpenAPI document (openapi.ts) asks this too, with route templates ("/share/:token"), so those paths are marked open there.
 */
export function isOpenApiPath(method: string, path: string): boolean {
  return (
    path === "/health" ||
    path === "/auth/login" ||
    path === "/auth/login/totp" ||
    path === "/auth/setup" ||
    path === "/auth/setup-status" ||
    path === "/metrics" ||
    path === "/calendar.ics" ||
    path === "/theme.css" ||
    path === "/webhooks/media-server" ||
    path === "/webhooks/overseerr" ||
    path === "/discord/interactions" ||
    path.startsWith("/share/") ||
    path.startsWith("/iptv/m3u/") ||
    path.startsWith("/iptv/stream/") ||
    path.startsWith("/opds") ||
    path.startsWith("/media/local-artwork/") ||
    (method === "GET" && REMOTE_ARTWORK_RELAY_PATH.test(path)) ||
    path.startsWith("/invite/")
  );
}

async function authenticate(req: Request, res: Response, next: NextFunction, openPaths: boolean) {
  if (openPaths && isOpenApiPath(req.method, req.path)) {
    next();
    return;
  }

  // Radarr-style "Authentication Required: Disabled" — opt-in, for a trusted private network
  // only. Every request is treated as admin; the API key/session checks below never even run.
  const authMode = getSetting("authRequired");
  let hostRefused = false;
  if (authMode === "0") {
    if (hostAllowedForOpenAccess(req)) {
      noteOpenAccess(req);
      accept(req, res, next, { kind: "open" }, { isAdmin: true });
      return;
    }
    hostRefused = true;
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

  // "Disabled for local addresses": a request from the home network needs no login, one from outside still does.
  // A credential that was sent and is valid came first above, so a household account that logged in keeps its own role.
  if (authMode === "local" && isLocalRequest(req)) {
    if (hostAllowedForOpenAccess(req)) {
      noteOpenAccess(req);
      accept(req, res, next, { kind: "open", local: true }, { isAdmin: true });
      return;
    }
    hostRefused = true;
  }
  if (hostRefused) {
    remember(refusedAt);
    lastHostRefused = hostForMessage(req);
    if (!hostsLogged.has(lastHostRefused) && hostsLogged.size < 50) {
      hostsLogged.add(lastHostRefused);
      log.warn(`[auth] a login-free visit under the host name "${lastHostRefused}" was refused: add it under Allowed host names in Settings if it is yours`);
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
  res
    .status(401)
    .json({
      error: hostRefused
        ? `Invalid or missing credentials. This host name ("${hostForMessage(req)}") is not one the no-login setting accepts: add it under Allowed host names in Settings, or use the server's address.`
        : "Invalid or missing credentials",
    });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
