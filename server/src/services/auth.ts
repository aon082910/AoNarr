import crypto from "node:crypto";
import { db } from "../db/client.js";

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

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function createSession(userId: number, userAgent?: string | null): { token: string; expiresAt: string } {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at, last_used_at, user_agent) VALUES (?, ?, ?, datetime('now'), ?)"
  ).run(token, userId, expiresAt, userAgent ?? null);
  return { token, expiresAt };
}

export function destroySession(token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
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
export function listActiveSessions(): SessionSummary[] {
  const rows = db
    .prepare(
      `SELECT s.token, s.user_id, u.username, s.created_at, s.expires_at, s.last_used_at, s.user_agent
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > datetime('now')
       ORDER BY s.last_used_at DESC NULLS LAST, s.created_at DESC`
    )
    .all() as any[];
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
}

export function getSessionUser(token: string): SessionUser | null {
  const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token) as
    | { user_id: number; expires_at: string }
    | undefined;
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }

  db.prepare("UPDATE sessions SET last_used_at = datetime('now') WHERE token = ?").run(token);

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) as
    | {
        id: number;
        username: string;
        role: string;
        max_pending_requests: number | null;
        auto_approve: number;
        max_content_rating: string | null;
      }
    | undefined;
  if (!user) return null;

  const allowedTypes = (
    db.prepare("SELECT media_type FROM user_library_access WHERE user_id = ?").all(user.id) as { media_type: string }[]
  ).map((r) => r.media_type);

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    allowedTypes,
    maxPendingRequests: user.max_pending_requests,
    autoApprove: !!user.auto_approve,
    maxContentRating: user.max_content_rating,
  };
}
