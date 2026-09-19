import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { useCustomizableLayout } from "../hooks/useCustomizableLayout.js";
import type { MediaItem } from "../types.js";
import { formatBytes } from "../utils/format.js";
import { SlidersIcon } from "../components/NavIcons.js";
import { ArrowUpIcon, ArrowDownIcon, ArrowRightIcon } from "../components/ActionIcons.js";
import { PageToolbar, ToolbarButton } from "../components/PageToolbar.js";

interface RecentlyWatchedEntry {
  mediaItemId: number;
  type: string;
  label: string;
  watchedAt: string;
}

interface RecentlyChangedEntry {
  timestamp: string;
  eventType: string;
  mediaItemId: number;
  title: string;
  type: string;
  detail: string | null;
}

const RECENT_EVENT_LABELS: Record<string, string> = {
  grabbed: "Grabbed",
  imported: "Imported",
  failed: "Failed",
  auto_archived: "Auto-archived",
  subtitleDownloaded: "Subtitle downloaded",
};

interface UpcomingEntry {
  // For a "kind: event" row, mediaItemId is actually the custom_calendar_events row's own id, not
  // a real media item — see server/src/routes/wanted.ts's customEvents query. Never navigate to
  // /media/:id using it without checking kind first.
  mediaItemId: number;
  mediaTitle: string;
  type: string;
  kind?: "media" | "event";
  label: string;
  date: string;
  hasFile: 0 | 1;
}

interface HealthSummary {
  configWarnings: { key: string; message: string }[];
  indexers: { id: number; name: string; ok: boolean; error?: string }[];
  downloadClients: { id: number; name: string; ok: boolean; error?: string }[];
  diskWarnings: { rootFolderId: number; path: string; percentFree: number; freeGb?: number; minFreeSpaceGb?: number | null }[];
}

// Local dates — `toISOString()` would roll "today" over to tomorrow for an evening west of UTC
// and drop anything airing today from the Upcoming widget.
function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayIso(): string {
  return localIso(new Date());
}

function addDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localIso(d);
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const mediaTypes = useMediaTypes();
  const labelFor = (key: string) => mediaTypes.find((t) => t.key === key)?.label ?? key;

  const [recentlyAdded, setRecentlyAdded] = useState<MediaItem[]>([]);
  const [recentlyChanged, setRecentlyChanged] = useState<RecentlyChangedEntry[]>([]);
  const [recentlyWatched, setRecentlyWatched] = useState<RecentlyWatchedEntry[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [librarySizes, setLibrarySizes] = useState<Record<string, number>>({});
  const [libraryCounts, setLibraryCounts] = useState<Record<string, number>>({});
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    Promise.all([
      api.get<MediaItem[]>("/dashboard/recently-added"),
      api.get<RecentlyChangedEntry[]>("/dashboard/recent"),
      api.get<RecentlyWatchedEntry[]>("/dashboard/recently-watched"),
      auth.isAdmin
        ? api.get<UpcomingEntry[]>(`/wanted/calendar?start=${todayIso()}&end=${addDaysIso(14)}`)
        : Promise.resolve([]),
      api.get<Record<string, number>>("/dashboard/library-sizes"),
      api.get<Record<string, number>>("/dashboard/library-counts"),
    ])
      .then(([added, changed, watched, cal, sizes, counts]) => {
        setRecentlyAdded(added);
        setRecentlyChanged(changed);
        setRecentlyWatched(watched);
        setUpcoming(cal);
        setLibrarySizes(sizes);
        setLibraryCounts(counts);
      })
      // Without this, one failed request left every widget rendering as legitimately empty
      // ("Nothing added yet.", 0 items) with no indication anything actually failed.
      .catch((e) => setLoadError((e as Error).message))
      .finally(() => setLoading(false));

    // Surfaces the same checks the System page computes on demand, right where an admin will
    // actually see them without having to think to go look — Radarr shows health warnings as a
    // banner near the top of its own dashboard for the same reason.
    if (auth.isAdmin) {
      api.get<HealthSummary>("/system/health").then(setHealth).catch(() => setHealth(null));
    }
  }, [auth.isAdmin]);

  const healthMessages: string[] = health
    ? [
        ...health.configWarnings.map((w) => w.message),
        ...health.indexers.filter((i) => !i.ok).map((i) => `Indexer "${i.name}" is unreachable`),
        ...health.downloadClients.filter((c) => !c.ok).map((c) => `Download client "${c.name}" is unreachable`),
        ...health.diskWarnings.map((d) =>
          d.minFreeSpaceGb != null && d.freeGb != null && d.freeGb < d.minFreeSpaceGb
            ? `"${d.path}" is below its configured minimum free space (${d.freeGb}GB free, minimum ${d.minFreeSpaceGb}GB)`
            : `"${d.path}" is low on disk space (${d.percentFree}% free)`
        ),
      ]
    : [];

  const totalSize = Object.values(librarySizes).reduce((sum, n) => sum + n, 0);
  const totalCount = Object.values(libraryCounts).reduce((sum, n) => sum + n, 0);

  const [customizing, setCustomizing] = useState(false);

  const widgetDefs: { key: string; label: string; render: () => ReactNode }[] = [
    {
      key: "librarySize",
      label: "Library Size",
      render: () => (
        <>
          <h2>Library Size</h2>
          <p style={{ color: "var(--muted)" }}>
            {totalCount} item(s) across every library · {formatBytes(totalSize)} total on disk
          </p>
          <table>
            <thead>
              <tr>
                <th>Library</th>
                <th>Items</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(libraryCounts).map((type) => (
                <tr key={type}>
                  <td>{labelFor(type)}</td>
                  <td>{libraryCounts[type]}</td>
                  <td>{formatBytes(librarySizes[type] ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ),
    },
    {
      key: "recentlyAdded",
      label: "Recently Added",
      render: () => (
        <>
          <h2>Recently Added</h2>
          {recentlyAdded.length === 0 && <p className="empty">Nothing added yet.</p>}
          {recentlyAdded.length > 0 && (
            <div className="grid">
              {recentlyAdded.map((item) => (
                <div key={item.id} className="card" onClick={() => navigate(`/media/${item.id}`)}>
                  <div
                    className="poster"
                    style={item.posterUrl ? { backgroundImage: `url(${item.posterUrl})` } : undefined}
                  >
                    {!item.posterUrl && "No poster"}
                  </div>
                  <div className="meta">
                    <div className="title">{item.title}</div>
                    <div className="sub">
                      {item.year ?? ""} · {labelFor(item.type)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ),
    },
    {
      key: "recentlyWatched",
      label: "Recently Watched",
      render: () =>
        recentlyWatched.length > 0 ? (
          <>
            <h2>Recently Watched</h2>
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Watched</th>
                </tr>
              </thead>
              <tbody>
                {recentlyWatched.map((entry, idx) => (
                  <tr key={idx} onClick={() => navigate(`/media/${entry.mediaItemId}`)} style={{ cursor: "pointer" }}>
                    <td>{entry.label}</td>
                    <td>{labelFor(entry.type)}</td>
                    <td>{new Date(entry.watchedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null,
    },
    {
      key: "recentlyChanged",
      label: "Recently Changed",
      render: () =>
        recentlyChanged.length > 0 ? (
          <>
            <h2>Recently Changed</h2>
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Event</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {recentlyChanged.map((entry, idx) => (
                  <tr key={idx} onClick={() => navigate(`/media/${entry.mediaItemId}`)} style={{ cursor: "pointer" }}>
                    <td>
                      {entry.title}
                      {entry.detail ? ` — ${entry.detail}` : ""}
                    </td>
                    <td>{labelFor(entry.type)}</td>
                    <td>{RECENT_EVENT_LABELS[entry.eventType] ?? entry.eventType}</td>
                    <td>{new Date(entry.timestamp).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null,
    },
    ...(auth.isAdmin
      ? [
          {
            key: "upcoming",
            label: "Upcoming (next 14 days)",
            render: () => (
              <>
                <h2>Upcoming (next 14 days)</h2>
                {upcoming.length === 0 && <p className="empty">Nothing scheduled in the next two weeks.</p>}
                {upcoming.length > 0 && (
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Title</th>
                        <th>Type</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {upcoming.map((entry, idx) => (
                        <tr
                          key={idx}
                          onClick={() => entry.kind !== "event" && navigate(`/media/${entry.mediaItemId}`)}
                          style={{ cursor: entry.kind === "event" ? "default" : "pointer" }}
                        >
                          <td>{entry.date}</td>
                          <td>
                            {entry.mediaTitle} — {entry.label}
                          </td>
                          <td>{entry.kind === "event" ? "Custom date" : labelFor(entry.type)}</td>
                          <td>
                            <span className={`badge ${entry.hasFile ? "ok" : ""}`}>{entry.hasFile ? "Downloaded" : "Missing"}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            ),
          },
        ]
      : []),
  ];

  const { orderedItems, visibleItems, hidden, moveUp, moveDown, toggleHidden, setSize, sizeOf } = useCustomizableLayout(
    "aonarr_dashboard_widgets",
    widgetDefs.map((w) => ({ key: w.key, label: w.label }))
  );
  const widgetByKey = new Map(widgetDefs.map((w) => [w.key, w]));

  return (
    <div>
      <h1>Dashboard</h1>
      <PageToolbar
        left={
          <ToolbarButton
            icon={<SlidersIcon />}
            label={customizing ? "Done" : "Customize"}
            onClick={() => setCustomizing((v) => !v)}
            title={customizing ? "Done customizing" : "Customize layout"}
          />
        }
      />

      {customizing && (
        <div className="form-panel" style={{ maxWidth: 480, marginBottom: 20 }}>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
            Reorder, hide, or resize widgets — saved on this device. Two half-width widgets sit
            side by side; a full-width one takes the whole row.
          </p>
          {orderedItems.map((item, idx) => (
            <div key={item.key} className="toolbar" style={{ justifyContent: "space-between", marginBottom: 4 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, color: hidden.has(item.key) ? "var(--muted)" : "var(--text)" }}>
                <input type="checkbox" checked={!hidden.has(item.key)} onChange={() => toggleHidden(item.key)} />
                {item.label}
              </label>
              <div style={{ display: "flex", gap: 4 }}>
                <select
                  value={sizeOf(item.key)}
                  onChange={(e) => setSize(item.key, e.target.value as "full" | "half")}
                  style={{ height: 28, padding: "0 24px 0 8px", fontSize: "0.8rem" }}
                >
                  <option value="full">Full width</option>
                  <option value="half">Half width</option>
                </select>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => moveUp(item.key)}
                  disabled={idx === 0}
                  title="Move up"
                  aria-label={`Move ${item.label} up`}
                >
                  <ArrowUpIcon />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => moveDown(item.key)}
                  disabled={idx === orderedItems.length - 1}
                  title="Move down"
                  aria-label={`Move ${item.label} down`}
                >
                  <ArrowDownIcon />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {loadError && (
        <div className="form-panel" style={{ borderColor: "var(--danger)", marginBottom: 16 }}>
          <strong style={{ color: "var(--danger)" }}>Couldn't load the dashboard</strong>
          <p style={{ margin: "6px 0 0", fontSize: "0.85rem" }}>{loadError}</p>
        </div>
      )}

      {healthMessages.length > 0 && (
        <div className="form-panel" style={{ borderColor: "var(--danger)", marginBottom: 16 }}>
          <strong style={{ color: "var(--danger)" }}>Health issues</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {healthMessages.map((m, idx) => (
              <li key={idx} style={{ fontSize: "0.85rem" }}>
                {m}
              </li>
            ))}
          </ul>
          <button type="button" className="icon-button" style={{ marginTop: 8 }} onClick={() => navigate("/system")} title="View System" aria-label="View System">
            <ArrowRightIcon />
          </button>
        </div>
      )}

      {loading && <p className="empty">Loading...</p>}
      {!loading && (
        <div className="dashboard-grid">
          {visibleItems.map((item) => (
            <div key={item.key} className={sizeOf(item.key) === "half" ? "dashboard-widget-half" : "dashboard-widget-full"}>
              {widgetByKey.get(item.key)?.render()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
