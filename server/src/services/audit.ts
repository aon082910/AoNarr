import { db } from "../db/client.js";

export function logAuditEvent(userId: number | null, username: string, eventType: string, detail?: string): void {
  db.prepare("INSERT INTO audit_log (user_id, username, event_type, detail) VALUES (?, ?, ?, ?)").run(
    userId,
    username,
    eventType,
    detail ?? null
  );
}
