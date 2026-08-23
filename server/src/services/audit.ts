import { db } from "../db/client.js";

export function logAuditEvent(userId: number | null, username: string, eventType: string, detail?: string): void {
  db.prepare("INSERT INTO audit_log (user_id, username, event_type, detail) VALUES (?, ?, ?, ?)").run(
    userId,
    username,
    eventType,
    detail ?? null
  );
}

/** Most admin-only routes have no per-request user identity when hit with a bare API key (no
 * session token) — that request still did something worth logging, just not attributable to a
 * specific household account, so it's recorded as "admin" the same way requests.ts's approve/
 * reject actions already were before this helper existed. */
export function auditActor(req: import("express").Request): { userId: number | null; username: string } {
  return req.auth?.user ? { userId: req.auth.user.id, username: req.auth.user.username } : { userId: null, username: "admin" };
}
