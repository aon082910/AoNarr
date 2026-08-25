import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { describeCalendarEntry } from "../utils/calendarDescriptions.js";

interface CalendarEntry {
  mediaItemId: number;
  mediaTitle: string;
  type: string;
  episodeId: number | null;
  subItemId: number | null;
  label: string;
  date: string;
  hasFile: 0 | 1;
  kind: "media" | "event";
}

/** A single day's full detail — a real bookmarkable/shareable route (`/calendar/:date`), unlike
 * the month view's click-to-expand inline panel, which only exists while that page's own component
 * state is alive. Every entry's "what's happening" description comes from the same
 * describeCalendarEntry() the month view uses, so the two stay consistent. */
export default function CalendarDay() {
  const { date = "" } = useParams<{ date: string }>();
  const navigate = useNavigate();
  const mediaTypes = useMediaTypes();
  const [entries, setEntries] = useState<CalendarEntry[] | null>(null);

  useEffect(() => {
    setEntries(null);
    api.get<CalendarEntry[]>(`/wanted/calendar?start=${date}&end=${date}`).then(setEntries);
  }, [date]);

  const parsed = new Date(`${date}T00:00:00`);
  const formatted = Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  function labelFor(type: string): string {
    return mediaTypes.find((t) => t.key === type)?.label ?? type;
  }

  async function deleteCustomEvent(id: number) {
    if (!confirm("Remove this custom date?")) return;
    await api.del(`/calendar-events/${id}`);
    setEntries((prev) => prev?.filter((e) => !(e.kind === "event" && e.mediaItemId === id)) ?? null);
  }

  return (
    <div>
      <p>
        <button className="secondary" onClick={() => navigate("/calendar")}>
          ← Back to calendar
        </button>
      </p>
      <h1>{formatted}</h1>

      {!entries && <p className="empty">Loading...</p>}
      {entries && entries.length === 0 && <p className="empty">Nothing scheduled for this date.</p>}
      {entries && entries.length > 0 && (
        <div className="grid" style={{ gridTemplateColumns: "1fr" }}>
          {entries.map((entry, idx) => (
            <div
              key={idx}
              className="form-panel"
              style={{ maxWidth: "none", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: "1.05rem" }}>{entry.mediaTitle}</div>
                <div style={{ color: "var(--muted)", marginTop: 2 }}>{describeCalendarEntry(entry)}</div>
                {entry.kind === "media" && (
                  <div style={{ marginTop: 6 }}>
                    <span className="badge">{labelFor(entry.type)}</span>{" "}
                    <span className={`badge ${entry.hasFile ? "ok" : "danger"}`}>{entry.hasFile ? "Downloaded" : "Missing"}</span>
                  </div>
                )}
              </div>
              {entry.kind === "media" ? (
                <button onClick={() => navigate(`/media/${entry.mediaItemId}`)}>Open</button>
              ) : (
                <button className="danger" onClick={() => deleteCustomEvent(entry.mediaItemId)}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
