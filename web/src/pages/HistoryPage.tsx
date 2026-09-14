import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";

interface HistoryRow {
  id: number;
  mediaItemId: number;
  eventType: string;
  data: string | null;
  createdAt: string;
  mediaTitle: string;
  mediaType: string;
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  grabbed: "Grabbed",
  imported: "Imported",
  failed: "Failed",
  subtitleDownloaded: "Subtitle downloaded",
};

function eventDetail(row: HistoryRow): string {
  try {
    const parsed = row.data ? JSON.parse(row.data) : null;
    return parsed?.title ?? parsed?.fileName ?? parsed?.reason ?? "—";
  } catch {
    return "—";
  }
}

/** Radarr/Sonarr-style global History page — every grab/import/failure event across the whole
 * library, filterable by event type/library type/date, instead of only the per-item History tab
 * (MediaDetail.tsx) or the unfiltered dashboard Timeline widget (Activity.tsx). */
export default function HistoryPage() {
  const mediaTypes = useMediaTypes();
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  // Remembered across visits (Radarr keeps its own list filters sticky per-page too) — otherwise
  // every trip back to History resets to "All events/All libraries" even right after narrowing
  // down to track one specific failure.
  const [eventType, setEventType] = useState(() => localStorage.getItem("aonarr_history_eventType") ?? "all");
  const [mediaType, setMediaType] = useState(() => localStorage.getItem("aonarr_history_mediaType") ?? "all");
  const [since, setSince] = useState(() => localStorage.getItem("aonarr_history_since") ?? "");

  function load() {
    const params = new URLSearchParams();
    if (eventType !== "all") params.set("eventType", eventType);
    if (mediaType !== "all") params.set("mediaType", mediaType);
    if (since) params.set("since", since);
    api.get<HistoryRow[]>(`/activity/history?${params.toString()}`).then(setRows);
  }

  useEffect(load, [eventType, mediaType, since]);
  useEffect(() => localStorage.setItem("aonarr_history_eventType", eventType), [eventType]);
  useEffect(() => localStorage.setItem("aonarr_history_mediaType", mediaType), [mediaType]);
  useEffect(() => localStorage.setItem("aonarr_history_since", since), [since]);

  return (
    <div>
      <h1>History</h1>
      <p style={{ color: "var(--muted)" }}>Every grab, import, and failure across the whole library, newest first.</p>
      <div className="toolbar" style={{ marginBottom: 16 }}>
        <select value={eventType} onChange={(e) => setEventType(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="all">All events</option>
          {Object.entries(EVENT_TYPE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select value={mediaType} onChange={(e) => setMediaType(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="all">All libraries</option>
          {mediaTypes.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        <input type="date" value={since} onChange={(e) => setSince(e.target.value)} title="Only show events on or after this date" />
        {(eventType !== "all" || mediaType !== "all" || since) && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setEventType("all");
              setMediaType("all");
              setSince("");
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {!rows && <p className="empty">Loading...</p>}
      {rows && rows.length === 0 && <p className="empty">Nothing here yet.</p>}
      {rows && rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Media</th>
              <th>Detail</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <span className={`badge ${r.eventType === "failed" ? "danger" : r.eventType === "imported" ? "ok" : ""}`}>
                    {EVENT_TYPE_LABELS[r.eventType] ?? r.eventType}
                  </span>
                </td>
                <td>
                  <Link to={`/media/${r.mediaItemId}`}>{r.mediaTitle}</Link>
                </td>
                <td>{eventDetail(r)}</td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows && rows.length === 500 && (
        <p className="empty">Showing the 500 most recent matching events — narrow the filters above to see further back.</p>
      )}
    </div>
  );
}
