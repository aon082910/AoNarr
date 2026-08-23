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

interface AuditLogResponse {
  rows: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
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
  user_password_reset: "Reset user password",
  admin_account_created: "Created admin account",
  media_added: "Added media",
  media_deleted: "Deleted media",
  media_rematched: "Rematched media",
};

export default function AuditLog() {
  const [data, setData] = useState<AuditLogResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .get<AuditLogResponse>(`/audit-log?page=${page}&pageSize=100`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [page]);

  if (loading && !data) return <p className="empty">Loading...</p>;
  if (!data) return null;

  return (
    <div>
      <h1>Audit Log</h1>
      <p style={{ color: "var(--muted)" }}>
        Logins, requests, account changes, and media add/delete/rematch actions across every
        household account — most recent first. {data.total} event{data.total === 1 ? "" : "s"} total.
      </p>
      {data.rows.length === 0 && <p className="empty">Nothing logged yet.</p>}
      {data.rows.length > 0 && (
        <>
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
              {data.rows.map((e) => (
                <tr key={e.id}>
                  <td>{e.createdAt}</td>
                  <td>{e.username}</td>
                  <td>{EVENT_LABELS[e.eventType] ?? e.eventType}</td>
                  <td>{e.detail ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="toolbar" style={{ marginTop: 12, alignItems: "center" }}>
            <button className="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
              Page {data.page} of {data.totalPages}
            </span>
            <button className="secondary" disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
