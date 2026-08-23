import { db } from "../db/index.js";
import { log } from "./logger.js";

/** Fire-and-forget, same as every existing call site already effectively treated this as (nobody
 * awaited the old synchronous better-sqlite3 call either) — keeps `logAuditEvent`'s signature
 * synchronous so none of its ~20+ call sites across the app need to change while this file moves
 * to the async db interface. An audit-log write failing is logged, not thrown, since it shouldn't
 * ever be the reason a real action (a login, a delete) fails. */
export function logAuditEvent(userId: number | null, username: string, eventType: string, detail?: string): void {
  db.prepare("INSERT INTO audit_log (user_id, username, event_type, detail) VALUES (?, ?, ?, ?)")
    .run(userId, username, eventType, detail ?? null)
    .catch((err) => log.error(`[audit] failed to record "${eventType}":`, (err as Error).message));
}

/** Most admin-only routes have no per-request user identity when hit with a bare API key (no
 * session token) — that request still did something worth logging, just not attributable to a
 * specific household account, so it's recorded as "admin" the same way requests.ts's approve/
 * reject actions already were before this helper existed. */
export function auditActor(req: import("express").Request): { userId: number | null; username: string } {
  return req.auth?.user ? { userId: req.auth.user.id, username: req.auth.user.username } : { userId: null, username: "admin" };
}
