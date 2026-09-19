import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import Pagination, { DEFAULT_PAGE_SIZE_OPTIONS } from "../components/Pagination.js";

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
  user_permissions_changed: "Changed user permissions",
  session_revoked: "Force-logged-out a session",
  totp_enabled: "Enabled two-factor authentication",
  totp_disabled: "Disabled two-factor authentication",
  api_key_regenerated: "Regenerated API key",
  backup_downloaded: "Downloaded a database backup",
  indexer_added: "Added indexer",
  indexer_removed: "Removed indexer",
  download_client_added: "Added download client",
  download_client_removed: "Removed download client",
  corrupt_media_recycled: "Recycled flagged corrupt media",
  corrupt_media_dismissed: "Dismissed corrupt media flag",
};

export default function AuditLog() {
  const [data, setData] = useState<AuditLogResponse | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(() => Number(localStorage.getItem("aonarr_auditlog_page_size")) || 100);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<AuditLogResponse>(`/audit-log?page=${page}&pageSize=${pageSize}`)
      .then(setData)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [page, pageSize]);

  useEffect(() => {
    localStorage.setItem("aonarr_auditlog_page_size", String(pageSize));
  }, [pageSize]);

  const { sortRows, sortableHeader } = useSortableTable<AuditEntry, "when" | "user" | "event" | "detail">("when", "desc");
  const sorted = data
    ? sortRows(data.rows, (a, b, key) => {
        if (key === "when") return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
        if (key === "user") return a.username.localeCompare(b.username);
        if (key === "event") return (EVENT_LABELS[a.eventType] ?? a.eventType).localeCompare(EVENT_LABELS[b.eventType] ?? b.eventType);
        return (a.detail ?? "").localeCompare(b.detail ?? "");
      })
    : [];

  if (loading && !data) return <p className="empty">Loading...</p>;
  if (error && !data) return <p style={{ color: "var(--danger)" }}>{error}</p>;
  if (!data) return null;

  return (
    <div>
      <h1>Audit Log</h1>
      <p style={{ color: "var(--muted)" }}>
        Logins, requests, account/permission changes, media add/delete/rematch actions, and
        security-sensitive config changes (2FA, API key, indexers, download clients, backups)
        across every household account — most recent first. {data.total} event
        {data.total === 1 ? "" : "s"} total.
      </p>
      {error && <p style={{ color: "var(--danger)" }}>{error} — showing the last page that loaded successfully.</p>}
      {data.rows.length === 0 && <p className="empty">Nothing logged yet.</p>}
      {data.rows.length > 0 && (
        <>
          <table>
            <thead>
              <tr>
                {sortableHeader("when", "When")}
                {sortableHeader("user", "User")}
                {sortableHeader("event", "Event")}
                {sortableHeader("detail", "Detail")}
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => (
                <tr key={e.id}>
                  <td>{e.createdAt}</td>
                  <td>{e.username}</td>
                  <td>{EVENT_LABELS[e.eventType] ?? e.eventType}</td>
                  <td>{e.detail ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            pageSize={pageSize}
            hasPrev={page > 1}
            hasNext={page < data.totalPages}
            onPrev={() => setPage((p) => p - 1)}
            onNext={() => setPage((p) => p + 1)}
            onPageSizeChange={(n) => {
              setPageSize(n);
              setPage(1);
            }}
            pageSizeOptions={DEFAULT_PAGE_SIZE_OPTIONS}
          />
        </>
      )}
    </div>
  );
}
