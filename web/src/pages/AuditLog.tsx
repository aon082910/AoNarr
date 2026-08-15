import { useEffect, useState } from "react";
import { api } from "../api/client.js";

interface AuditEntry {
  id: number;
  userId: number | null;
  username: string;
  eventType: string;
  detail: string | null;
  createdAt: string;
}

const EVENT_LABELS: Record<string, string> = {
  login: "Logged in",
  login_failed: "Failed login attempt",
  logout: "Logged out",
  request_submitted: "Submitted request",
  request_auto_approved: "Request auto-approved",
  request_approved: "Approved request",
  request_rejected: "Rejected request",
  user_created: "Created user",
  user_deleted: "Deleted user",
};

export default function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<AuditEntry[]>("/audit-log")
      .then(setEntries)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="empty">Loading...</p>;

  return (
    <div>
      <h1>Audit Log</h1>
      <p style={{ color: "var(--muted)" }}>
        Logins, requests, and account changes across every household account — most recent first,
        capped at the last 500 events.
      </p>
      {entries.length === 0 && <p className="empty">Nothing logged yet.</p>}
      {entries.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>User</th>
              <th>Event</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{e.createdAt}</td>
                <td>{e.username}</td>
                <td>{EVENT_LABELS[e.eventType] ?? e.eventType}</td>
                <td>{e.detail ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
