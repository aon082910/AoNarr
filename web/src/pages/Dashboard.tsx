import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { MediaItem } from "../types.js";
import { formatBytes } from "../utils/format.js";

interface RecentlyWatchedEntry {
  mediaItemId: number;
  type: string;
  label: string;
  watchedAt: string;
}

interface UpcomingEntry {
  mediaItemId: number;
  mediaTitle: string;
  type: string;
  label: string;
  date: string;
  hasFile: 0 | 1;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const mediaTypes = useMediaTypes();
  const labelFor = (key: string) => mediaTypes.find((t) => t.key === key)?.label ?? key;

  const [recentlyAdded, setRecentlyAdded] = useState<MediaItem[]>([]);
  const [recentlyWatched, setRecentlyWatched] = useState<RecentlyWatchedEntry[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [librarySizes, setLibrarySizes] = useState<Record<string, number>>({});
  const [libraryCounts, setLibraryCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get<MediaItem[]>("/dashboard/recently-added"),
      api.get<RecentlyWatchedEntry[]>("/dashboard/recently-watched"),
      auth.isAdmin
        ? api.get<UpcomingEntry[]>(`/wanted/calendar?start=${todayIso()}&end=${addDaysIso(14)}`)
        : Promise.resolve([]),
      api.get<Record<string, number>>("/dashboard/library-sizes"),
      api.get<Record<string, number>>("/dashboard/library-counts"),
    ])
      .then(([added, watched, cal, sizes, counts]) => {
        setRecentlyAdded(added);
        setRecentlyWatched(watched);
        setUpcoming(cal);
        setLibrarySizes(sizes);
        setLibraryCounts(counts);
      })
      .finally(() => setLoading(false));
  }, [auth.isAdmin]);

  const totalSize = Object.values(librarySizes).reduce((sum, n) => sum + n, 0);
  const totalCount = Object.values(libraryCounts).reduce((sum, n) => sum + n, 0);

  return (
    <div>
      <h1>Dashboard</h1>
      {loading && <p className="empty">Loading...</p>}

      {!loading && (
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
      )}

      {!loading && (
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

          {recentlyWatched.length > 0 && (
            <>
              <h2 style={{ marginTop: 24 }}>Recently Watched</h2>
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
          )}

          {auth.isAdmin && (
            <>
              <h2 style={{ marginTop: 24 }}>Upcoming (next 14 days)</h2>
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
                      <tr key={idx} onClick={() => navigate(`/media/${entry.mediaItemId}`)} style={{ cursor: "pointer" }}>
                        <td>{entry.date}</td>
                        <td>
                          {entry.mediaTitle} — {entry.label}
                        </td>
                        <td>{labelFor(entry.type)}</td>
                        <td>
                          <span className={`badge ${entry.hasFile ? "ok" : ""}`}>{entry.hasFile ? "Downloaded" : "Missing"}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
