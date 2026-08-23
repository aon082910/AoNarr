import crypto from "node:crypto";
import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// In-memory only — a pending login is a few-minute window between "password verified" and "TOTP
// code entered", not worth persisting across a restart (the user just logs in again).
const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000;
const pendingLogins = new Map<string, { userId: number; expires: number }>();

export function createPendingLogin(userId: number): string {
  const token = crypto.randomBytes(24).toString("hex");
  pendingLogins.set(token, { userId, expires: Date.now() + PENDING_LOGIN_TTL_MS });
  return token;
}

export function consumePendingLogin(token: string): number | null {
  const entry = pendingLogins.get(token);
  pendingLogins.delete(token);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.userId;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(userId: number, userAgent?: string | null): Promise<{ token: string; expiresAt: string }> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db
    .prepare(`INSERT INTO sessions (token, user_id, expires_at, last_used_at, user_agent) VALUES (?, ?, ?, ${nowExpr(db)}, ?)`)
    .run(token, userId, expiresAt, userAgent ?? null);
  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export interface SessionSummary {
  token: string;
  userId: number;
  username: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  userAgent: string | null;
}

/** Lists every active (non-expired) session across all users, newest activity first, for the admin session-management screen. */
export async function listActiveSessions(): Promise<SessionSummary[]> {
  const rows = (await db
    .prepare(
      `SELECT s.token, s.user_id, u.username, s.created_at, s.expires_at, s.last_used_at, s.user_agent
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > ${nowExpr(db)}
       ORDER BY s.last_used_at DESC NULLS LAST, s.created_at DESC`
    )
    .all()) as any[];
  return rows.map((r) => ({
    token: r.token,
    userId: r.user_id,
    username: r.username,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    userAgent: r.user_agent,
  }));
}

export interface SessionUser {
  id: number;
  username: string;
  role: string;
  allowedTypes: string[];
  maxPendingRequests: number | null;
  autoApprove: boolean;
  maxContentRating: string | null;
  totpEnabled: boolean;
}

export async function getSessionUser(token: string): Promise<SessionUser | null> {
  const session = (await db.prepare("SELECT * FROM sessions WHERE token = ?").get(token)) as
    | { user_id: number; expires_at: string }
    | undefined;
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }

  await db.prepare(`UPDATE sessions SET last_used_at = ${nowExpr(db)} WHERE token = ?`).run(token);

  const user = (await db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id)) as
    | {
        id: number;
        username: string;
        role: string;
        max_pending_requests: number | null;
        auto_approve: number;
        max_content_rating: string | null;
        totp_enabled: number;
      }
    | undefined;
  if (!user) return null;

  const allowedTypes = (
    (await db.prepare("SELECT media_type FROM user_library_access WHERE user_id = ?").all(user.id)) as { media_type: string }[]
  ).map((r) => r.media_type);

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    allowedTypes,
    maxPendingRequests: user.max_pending_requests,
    autoApprove: !!user.auto_approve,
    maxContentRating: user.max_content_rating,
    totpEnabled: !!user.totp_enabled,
  };
}
