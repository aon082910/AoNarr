import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
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

interface CustomEvent {
  id: number;
  title: string;
  date: string;
  note: string | null;
  createdAt: string;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function gridBounds(monthDate: Date): { gridStart: Date; gridEnd: Date } {
  const monthStart = startOfMonth(monthDate);
  const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const gridEnd = new Date(monthEnd);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));
  return { gridStart, gridEnd };
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function Calendar() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"month" | "agenda">("month");
  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(new Date()));
  const [entries, setEntries] = useState<CalendarEntry[] | null>(null);
  const [daysBack, setDaysBack] = useState(7);
  const [daysForward, setDaysForward] = useState(21);
  const [icsUrl, setIcsUrl] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [newEventTitle, setNewEventTitle] = useState("");
  const [newEventDate, setNewEventDate] = useState("");
  const [newEventNote, setNewEventNote] = useState("");

  function load() {
    let start: string, end: string;
    if (mode === "month") {
      const { gridStart, gridEnd } = gridBounds(viewMonth);
      start = toIsoDate(gridStart);
      end = toIsoDate(gridEnd);
    } else {
      const s = new Date();
      s.setDate(s.getDate() - daysBack);
      const e = new Date();
      e.setDate(e.getDate() + daysForward);
      start = toIsoDate(s);
      end = toIsoDate(e);
    }
    api.get<CalendarEntry[]>(`/wanted/calendar?start=${start}&end=${end}`).then(setEntries);
  }

  useEffect(load, [mode, viewMonth, daysBack, daysForward]); // eslint-disable-line react-hooks/exhaustive-deps

  async function showSubscribeUrl() {
    const result = await api.get<{ token: string }>("/settings/calendar-token");
    setIcsUrl(`${window.location.origin}/api/calendar.ics?token=${result.token}`);
  }

  async function regenerateIcsToken() {
    if (!confirm("Regenerate the calendar feed URL? Any calendar app already subscribed will stop updating until you re-subscribe with the new URL.")) return;
    const result = await api.post<{ token: string }>("/settings/calendar-token/regenerate", {});
    setIcsUrl(`${window.location.origin}/api/calendar.ics?token=${result.token}`);
  }

  async function addCustomEvent(e: React.FormEvent) {
    e.preventDefault();
    if (!newEventTitle.trim() || !newEventDate) return;
    await api.post("/calendar-events", { title: newEventTitle.trim(), date: newEventDate, note: newEventNote || null });
    setNewEventTitle("");
    setNewEventDate("");
    setNewEventNote("");
    setShowAddEvent(false);
    load();
  }

  async function deleteCustomEvent(id: number) {
    if (!confirm("Remove this custom date?")) return;
    await api.del(`/calendar-events/${id}`);
    load();
  }

  function openEntry(entry: CalendarEntry) {
    if (entry.kind === "media") navigate(`/media/${entry.mediaItemId}`);
  }

  if (!entries) return <p className="empty">Loading...</p>;

  const grouped = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const day = entry.date.slice(0, 10);
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day)!.push(entry);
  }
  const today = toIsoDate(new Date());

  const { gridStart, gridEnd } = gridBounds(viewMonth);
  const gridDays: Date[] = [];
  for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) gridDays.push(new Date(d));

  const monthLabel = viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div>
      <h1>Calendar</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <select value={mode} onChange={(e) => setMode(e.target.value as "month" | "agenda")} style={{ maxWidth: 120 }}>
          <option value="month">Month</option>
          <option value="agenda">Agenda</option>
        </select>
        {mode === "month" ? (
          <>
            <button className="secondary" onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>
              ◂ Prev
            </button>
            <strong style={{ minWidth: 140, textAlign: "center" }}>{monthLabel}</strong>
            <button className="secondary" onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>
              Next ▸
            </button>
            <button className="secondary" onClick={() => setViewMonth(startOfMonth(new Date()))}>
              Today
            </button>
          </>
        ) : (
          <>
            <button className="secondary" onClick={() => setDaysBack((d) => d + 7)}>
              Show earlier
            </button>
            <button className="secondary" onClick={() => setDaysForward((d) => d + 14)}>
              Show later
            </button>
          </>
        )}
        <button className="secondary" onClick={() => setShowAddEvent((v) => !v)}>
          + Add custom date
        </button>
        <button className="secondary" onClick={showSubscribeUrl}>
          Subscribe from calendar app...
        </button>
      </div>

      {showAddEvent && (
        <form className="form-panel" onSubmit={addCustomEvent} style={{ marginBottom: 16 }}>
          <label>Title</label>
          <input value={newEventTitle} onChange={(e) => setNewEventTitle(e.target.value)} required placeholder="Release-day watch party" />
          <label>Date</label>
          <input type="date" value={newEventDate} onChange={(e) => setNewEventDate(e.target.value)} required />
          <label>Note (optional)</label>
          <input value={newEventNote} onChange={(e) => setNewEventNote(e.target.value)} />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="submit">Add</button>
            <button type="button" className="secondary" onClick={() => setShowAddEvent(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

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

      {mode === "month" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
            {WEEKDAY_LABELS.map((w) => (
              <div key={w} style={{ textAlign: "center", color: "var(--muted)", fontSize: "0.8rem", fontWeight: 600 }}>
                {w}
              </div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
            {gridDays.map((d) => {
              const iso = toIsoDate(d);
              const dayEntries = grouped.get(iso) ?? [];
              const inMonth = d.getMonth() === viewMonth.getMonth();
              const isToday = iso === today;
              const shown = dayEntries.slice(0, 3);
              const overflow = dayEntries.length - shown.length;
              return (
                <div
                  key={iso}
                  onClick={() => setSelectedDay(iso === selectedDay ? null : iso)}
                  style={{
                    minHeight: 90,
                    padding: 4,
                    borderRadius: 6,
                    border: `1px solid ${isToday ? "var(--accent)" : "var(--border)"}`,
                    opacity: inMonth ? 1 : 0.4,
                    cursor: "pointer",
                    background: selectedDay === iso ? "var(--panel)" : undefined,
                  }}
                >
                  <div style={{ fontSize: "0.8rem", color: isToday ? "var(--accent)" : "var(--muted)", fontWeight: isToday ? 700 : 400 }}>
                    {d.getDate()}
                  </div>
                  {shown.map((entry, idx) => (
                    <div
                      key={idx}
                      onClick={(e) => {
                        e.stopPropagation();
                        openEntry(entry);
                      }}
                      title={`${entry.mediaTitle}${entry.kind === "media" ? " — " + entry.label : ""}`}
                      className={`badge ${entry.kind === "event" ? "" : entry.hasFile ? "ok" : "danger"}`}
                      style={{
                        display: "block",
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: "0.7rem",
                        cursor: entry.kind === "media" ? "pointer" : "default",
                      }}
                    >
                      {entry.kind === "event" ? "📌 " : ""}
                      {entry.mediaTitle}
                    </div>
                  ))}
                  {overflow > 0 && <div style={{ fontSize: "0.7rem", color: "var(--muted)" }}>+{overflow} more</div>}
                </div>
              );
            })}
          </div>

          {selectedDay && (
            <div className="form-panel" style={{ marginTop: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ marginTop: 0 }}>{selectedDay}</h2>
                <button className="secondary" onClick={() => navigate(`/calendar/${selectedDay}`)}>
                  Open day page
                </button>
              </div>
              {(grouped.get(selectedDay) ?? []).length === 0 && <p className="empty">Nothing scheduled.</p>}
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>What's happening</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(grouped.get(selectedDay) ?? []).map((entry, idx) => (
                    <tr key={idx}>
                      <td>{entry.mediaTitle}</td>
                      <td>{describeCalendarEntry(entry)}</td>
                      <td>
                        {entry.kind === "event" ? (
                          <span className="badge">Custom date</span>
                        ) : (
                          <span className={`badge ${entry.hasFile ? "ok" : ""}`}>{entry.hasFile ? "Downloaded" : "Missing"}</span>
                        )}
                      </td>
                      <td>
                        {entry.kind === "media" ? (
                          <button className="secondary" onClick={() => navigate(`/media/${entry.mediaItemId}`)}>
                            Open
                          </button>
                        ) : (
                          <button className="danger" onClick={() => deleteCustomEvent(entry.mediaItemId)}>
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {mode === "agenda" && (
        <>
          {Array.from(grouped.keys()).sort().length === 0 && <p className="empty">Nothing scheduled in this range.</p>}
          {Array.from(grouped.keys())
            .sort()
            .map((day) => (
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
                          {entry.kind === "event" ? (
                            <span className="badge">Custom date</span>
                          ) : (
                            <span className={`badge ${entry.hasFile ? "ok" : ""}`}>{entry.hasFile ? "Downloaded" : "Missing"}</span>
                          )}
                        </td>
                        <td>
                          {entry.kind === "media" ? (
                            <button className="secondary" onClick={() => navigate(`/media/${entry.mediaItemId}`)}>
                              Open
                            </button>
                          ) : (
                            <button className="danger" onClick={() => deleteCustomEvent(entry.mediaItemId)}>
                              Remove
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </>
      )}
    </div>
  );
}
