import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import { PageToolbar, ToolbarButton } from "../components/PageToolbar.js";
import { XIcon } from "../components/ActionIcons.js";
import Pagination, { DEFAULT_PAGE_SIZE_OPTIONS } from "../components/Pagination.js";

interface HistoryRow {
  id: number;
  mediaItemId: number;
  eventType: string;
  data: string | null;
  createdAt: string;
  mediaTitle: string;
  mediaType: string;
}

interface HistoryResponse {
  items: HistoryRow[];
  total: number;
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
  const [data, setData] = useState<HistoryResponse | null>(null);
  // Remembered across visits (Radarr keeps its own list filters sticky per-page too) — otherwise
  // every trip back to History resets to "All events/All libraries" even right after narrowing
  // down to track one specific failure.
  const [eventType, setEventType] = useState(() => localStorage.getItem("aonarr_history_eventType") ?? "all");
  const [mediaType, setMediaType] = useState(() => localStorage.getItem("aonarr_history_mediaType") ?? "all");
  const [since, setSince] = useState(() => localStorage.getItem("aonarr_history_since") ?? "");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(() => Number(localStorage.getItem("aonarr_history_page_size")) || 100);

  function load() {
    const params = new URLSearchParams();
    if (eventType !== "all") params.set("eventType", eventType);
    if (mediaType !== "all") params.set("mediaType", mediaType);
    if (since) params.set("since", since);
    params.set("limit", String(pageSize));
    params.set("offset", String((page - 1) * pageSize));
    api.get<HistoryResponse>(`/activity/history?${params.toString()}`).then(setData);
  }

  useEffect(load, [eventType, mediaType, since, page, pageSize]);
  useEffect(() => localStorage.setItem("aonarr_history_eventType", eventType), [eventType]);
  useEffect(() => localStorage.setItem("aonarr_history_mediaType", mediaType), [mediaType]);
  useEffect(() => localStorage.setItem("aonarr_history_since", since), [since]);
  useEffect(() => localStorage.setItem("aonarr_history_page_size", String(pageSize)), [pageSize]);
  // A changed filter narrows/changes the result set entirely — staying on page 4 of the old results
  // would otherwise show a confusing empty or wrong page (matches LibraryType.tsx's own convention).
  useEffect(() => setPage(1), [eventType, mediaType, since]);

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));

  return (
    <div>
      <h1>History</h1>
      <p style={{ color: "var(--muted)" }}>Every grab, import, and failure across the whole library, newest first.</p>
      <PageToolbar
        right={
          <>
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
              <ToolbarButton
                icon={<XIcon />}
                label="Clear Filters"
                onClick={() => {
                  setEventType("all");
                  setMediaType("all");
                  setSince("");
                }}
              />
            )}
          </>
        }
      />

      {!data && <p className="empty">Loading...</p>}
      {data && data.items.length === 0 && <p className="empty">Nothing here yet.</p>}
      {data && data.items.length > 0 && (
        <>
          <HistoryTable rows={data.items} />
          <Pagination
            page={page}
            totalPages={totalPages}
            total={data.total}
            pageSize={pageSize}
            hasPrev={page > 1}
            hasNext={page < totalPages}
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

function HistoryTable({ rows }: { rows: HistoryRow[] }) {
  const { sortRows, sortableHeader } = useSortableTable<HistoryRow, "event" | "media" | "date">("date", "desc");
  const sorted = sortRows(rows, (a, b, key) => {
    if (key === "event") return (EVENT_TYPE_LABELS[a.eventType] ?? a.eventType).localeCompare(EVENT_TYPE_LABELS[b.eventType] ?? b.eventType);
    if (key === "media") return a.mediaTitle.localeCompare(b.mediaTitle);
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
  return (
    <table>
      <thead>
        <tr>
          {sortableHeader("event", "Event")}
          {sortableHeader("media", "Media")}
          <th>Detail</th>
          {sortableHeader("date", "Date")}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
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
  );
}
