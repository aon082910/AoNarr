import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";

interface CalendarEntry {
  mediaItemId: number;
  mediaTitle: string;
  type: string;
  episodeId: number | null;
  subItemId: number | null;
  label: string;
  date: string;
  hasFile: 0 | 1;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function Calendar() {
  const [entries, setEntries] = useState<CalendarEntry[] | null>(null);
  const [daysBack, setDaysBack] = useState(7);
  const [daysForward, setDaysForward] = useState(21);
  const [icsUrl, setIcsUrl] = useState<string | null>(null);

  useEffect(() => {
    const start = new Date();
    start.setDate(start.getDate() - daysBack);
    const end = new Date();
    end.setDate(end.getDate() + daysForward);
    api
      .get<CalendarEntry[]>(`/wanted/calendar?start=${toIsoDate(start)}&end=${toIsoDate(end)}`)
      .then(setEntries);
  }, [daysBack, daysForward]);

  async function showSubscribeUrl() {
    const result = await api.get<{ token: string }>("/settings/calendar-token");
    setIcsUrl(`${window.location.origin}/api/calendar.ics?token=${result.token}`);
  }

  async function regenerateIcsToken() {
    if (!confirm("Regenerate the calendar feed URL? Any calendar app already subscribed will stop updating until you re-subscribe with the new URL.")) return;
    const result = await api.post<{ token: string }>("/settings/calendar-token/regenerate", {});
    setIcsUrl(`${window.location.origin}/api/calendar.ics?token=${result.token}`);
  }

  if (!entries) return <p className="empty">Loading...</p>;

  const grouped = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const day = entry.date.slice(0, 10);
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day)!.push(entry);
  }
  const days = Array.from(grouped.keys()).sort();
  const today = toIsoDate(new Date());

  return (
    <div>
      <h1>Calendar</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button className="secondary" onClick={() => setDaysBack((d) => d + 7)}>
          Show earlier
        </button>
        <button className="secondary" onClick={() => setDaysForward((d) => d + 14)}>
          Show later
        </button>
        <button className="secondary" onClick={showSubscribeUrl}>
          Subscribe from calendar app...
        </button>
      </div>

      {icsUrl && (
        <div className="form-panel" style={{ marginBottom: 16 }}>
          <label>Feed URL (paste into Google/Apple/Outlook Calendar's "subscribe by URL")</label>
          <input value={icsUrl} readOnly onFocus={(e) => e.target.select()} />
          <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
            Includes a dedicated token, not your API key — anyone with this URL can see release
            dates and titles, nothing more.
          </p>
          <button type="button" className="danger" onClick={regenerateIcsToken}>
            Regenerate URL
          </button>
        </div>
      )}

      {days.length === 0 && <p className="empty">Nothing scheduled in this range.</p>}

      {days.map((day) => (
        <div key={day} style={{ marginBottom: 20 }}>
          <h2 style={{ color: day === today ? "var(--accent)" : undefined }}>
            {day}
            {day === today ? " (today)" : ""}
          </h2>
          <table>
            <thead>
              <tr>
                <th>Media</th>
                <th>Item</th>
                <th>File</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {grouped.get(day)!.map((entry, idx) => (
                <tr key={idx}>
                  <td>{entry.mediaTitle}</td>
                  <td>{entry.label}</td>
                  <td>
                    <span className={`badge ${entry.hasFile ? "ok" : ""}`}>{entry.hasFile ? "Downloaded" : "Missing"}</span>
                  </td>
                  <td>
                    <Link to={`/media/${entry.mediaItemId}`}>
                      <button className="secondary">Open</button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
