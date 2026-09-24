import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { describeCalendarEntry } from "../utils/calendarDescriptions.js";
import { PlusCircleIcon, ShareIcon, CalendarIcon } from "../components/NavIcons.js";
import { TrashIcon, ChevronLeftIcon, ChevronRightIcon, ArrowRightIcon } from "../components/ActionIcons.js";
import { PageToolbar, ToolbarButton, ToolbarSeparator } from "../components/PageToolbar.js";
import { confirmDialog } from "../utils/confirmDialog.js";

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

/** Local calendar date, not `toISOString()` — that converts to UTC first, which shifts every
 * local-midnight grid cell to the previous day for anyone east of UTC (and "today" to tomorrow
 * for evenings west of it). */
function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
  // Paging months quickly fires overlapping requests; an older one landing last would otherwise
  // fill the current grid with the previous range's entries.
  const loadSeq = useRef(0);

  function load() {
    const seq = ++loadSeq.current;
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
    api.get<CalendarEntry[]>(`/wanted/calendar?start=${start}&end=${end}`).then((res) => {
      if (seq === loadSeq.current) setEntries(res);
    });
  }

  useEffect(load, [mode, viewMonth, daysBack, daysForward]); // eslint-disable-line react-hooks/exhaustive-deps

  async function showSubscribeUrl() {
    const result = await api.get<{ token: string }>("/settings/calendar-token");
    setIcsUrl(`${window.location.origin}/api/calendar.ics?token=${result.token}`);
  }

  async function regenerateIcsToken() {
    if (
      !(await confirmDialog({
        title: "Regenerate calendar feed URL",
        message: "Regenerate the calendar feed URL? Any calendar app already subscribed will stop updating until you re-subscribe with the new URL.",
        danger: true,
      }))
    )
      return;
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
    if (!(await confirmDialog({ title: "Remove custom date", message: "Remove this custom date?" }))) return;
    await api.del(`/calendar-events/${id}`);
    load();
  }

  /** Also drops the selected day — its detail panel only has entries for the grid being shown. */
  function changeMonth(update: (m: Date) => Date) {
    setViewMonth(update);
    setSelectedDay(null);
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
      <PageToolbar
        left={
          <>
            {mode === "month" ? (
              <>
                <ToolbarButton
                  icon={<ChevronLeftIcon />}
                  label="Previous"
                  onClick={() => changeMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                  title="Previous month"
                />
                <strong style={{ minWidth: 140, textAlign: "center" }}>{monthLabel}</strong>
                <ToolbarButton
                  icon={<ChevronRightIcon />}
                  label="Next"
                  onClick={() => changeMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
                  title="Next month"
                />
                <ToolbarButton icon={<CalendarIcon />} label="Today" onClick={() => changeMonth(() => startOfMonth(new Date()))} title="Jump to today" />
              </>
            ) : (
              <>
                <ToolbarButton icon={<ChevronLeftIcon />} label="Earlier" onClick={() => setDaysBack((d) => d + 7)} title="Show earlier" />
                <ToolbarButton icon={<ChevronRightIcon />} label="Later" onClick={() => setDaysForward((d) => d + 14)} title="Show later" />
              </>
            )}
            <ToolbarSeparator />
            <ToolbarButton icon={<PlusCircleIcon />} label="Add custom date" onClick={() => setShowAddEvent((v) => !v)} title="Add custom date" />
          </>
        }
        right={
          <>
            <select value={mode} onChange={(e) => setMode(e.target.value as "month" | "agenda")} style={{ maxWidth: 120 }}>
              <option value="month">Month</option>
              <option value="agenda">Agenda</option>
            </select>
            <ToolbarButton icon={<ShareIcon />} label="Subscribe" onClick={showSubscribeUrl} title="Subscribe from calendar app..." />
          </>
        }
      />

      {showAddEvent && (
        <form className="form-panel" onSubmit={addCustomEvent} style={{ marginBottom: 16 }}>
          <label htmlFor="calendar-title-1">Title</label>
          <input id="calendar-title-1" value={newEventTitle} onChange={(e) => setNewEventTitle(e.target.value)} required placeholder="Release-day watch party" />
          <label htmlFor="calendar-date-2">Date</label>
          <input id="calendar-date-2" type="date" value={newEventDate} onChange={(e) => setNewEventDate(e.target.value)} required />
          <label htmlFor="calendar-note-optional-3">Note (optional)</label>
          <input id="calendar-note-optional-3" value={newEventNote} onChange={(e) => setNewEventNote(e.target.value)} />
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
          <label htmlFor="calendar-feed-url-paste-into-google-apple-outlook-4">Feed URL (paste into Google/Apple/Outlook Calendar's "subscribe by URL")</label>
          <input id="calendar-feed-url-paste-into-google-apple-outlook-4" value={icsUrl} readOnly onFocus={(e) => e.target.select()} />
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
                <button type="button" className="icon-button" onClick={() => navigate(`/calendar/${selectedDay}`)} title="Open day page" aria-label="Open day page">
                  <ArrowRightIcon />
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
                          <span className={`badge ${entry.hasFile ? "ok" : "danger"}`}>{entry.hasFile ? "Downloaded" : "Missing"}</span>
                        )}
                      </td>
                      <td>
                        {entry.kind === "media" ? (
                          <button type="button" className="icon-button" onClick={() => navigate(`/media/${entry.mediaItemId}`)} title="Open" aria-label="Open">
                            <ArrowRightIcon />
                          </button>
                        ) : (
                          <button type="button" className="icon-button danger" onClick={() => deleteCustomEvent(entry.mediaItemId)} title="Remove" aria-label="Remove">
                            <TrashIcon />
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
                            <span className={`badge ${entry.hasFile ? "ok" : "danger"}`}>{entry.hasFile ? "Downloaded" : "Missing"}</span>
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
