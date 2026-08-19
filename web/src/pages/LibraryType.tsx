import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, downloadFile, uploadFormFile } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { MediaItem, Tag } from "../types.js";

type SortKey = "title" | "year" | "added" | "status";
type ViewMode = "poster" | "list";
type StatusFilter = "all" | "monitored" | "unmonitored" | "missing" | "downloaded";

export default function LibraryType() {
  const { type = "" } = useParams<{ type: string }>();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagFilter, setTagFilter] = useState<number | "all">("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("added");
  const [viewMode, setViewMode] = useState<ViewMode>(() => (localStorage.getItem("aonarr_library_view") as ViewMode) || "poster");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [tagToApply, setTagToApply] = useState<number | "">("");
  const [importingCsv, setImportingCsv] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { auth } = useAuth();
  const mediaTypes = useMediaTypes();
  const typeInfo = mediaTypes.find((t) => t.key === type);

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("type", type);
    if (tagFilter !== "all") params.set("tagId", String(tagFilter));
    api
      .get<MediaItem[]>(`/media?${params.toString()}`)
      .then((data) => {
        setItems(data);
        setSelected(new Set());
      })
      .finally(() => setLoading(false));
  }

  useEffect(load, [type, tagFilter]);
  useEffect(() => {
    if (auth.isAdmin) api.get<Tag[]>("/tags").then(setTags);
  }, [auth.isAdmin]);
  useEffect(() => {
    localStorage.setItem("aonarr_library_view", viewMode);
  }, [viewMode]);

  function toggleSelect(id: number, e: MouseEvent) {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulkMonitor(monitored: boolean) {
    await api.post("/media/bulk/monitor", { mediaItemIds: Array.from(selected), monitored });
    load();
  }

  async function bulkTag() {
    if (!tagToApply) return;
    await api.post("/media/bulk/tag", { mediaItemIds: Array.from(selected), tagId: tagToApply });
    setTagToApply("");
    alert(`Tagged ${selected.size} item(s).`);
  }

  async function exportCsv() {
    await downloadFile(`/media/export.csv?type=${type}`, `aonarr-${type}.csv`);
  }

  async function importCsv(file: File) {
    setImportingCsv(true);
    try {
      const result = await uploadFormFile<{ updated: number; skipped: number }>("/media/bulk-import.csv", file);
      alert(`Updated ${result.updated} item(s), skipped ${result.skipped} unrecognized row(s).`);
      load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setImportingCsv(false);
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  }

  async function bulkSearch() {
    const targets = Array.from(selected).map((mediaItemId) => ({ mediaItemId }));
    const results = await api.post<{ grabbed: boolean; error?: string }[]>("/search/bulk", { targets });
    const grabbedCount = results.filter((r) => r.grabbed).length;
    alert(`Grabbed ${grabbedCount} of ${results.length} selected item(s).`);
    load();
  }

  const filtered = items.filter((item) => {
    if (statusFilter === "monitored") return item.monitored;
    if (statusFilter === "unmonitored") return !item.monitored;
    if (statusFilter === "missing") return !item.hasFile;
    if (statusFilter === "downloaded") return item.hasFile;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === "title") return a.title.localeCompare(b.title);
    if (sortKey === "year") return (b.year ?? 0) - (a.year ?? 0);
    if (sortKey === "status") return Number(b.hasFile) - Number(a.hasFile);
    return b.id - a.id; // "added" — higher id = more recently added
  });

  if (!typeInfo) return <p className="empty">Unknown library type.</p>;

  return (
    <div>
      <h1>{typeInfo.label}</h1>
      <div style={{ marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} style={{ maxWidth: 160 }}>
          <option value="added">Sort: Recently added</option>
          <option value="title">Sort: Title</option>
          <option value="year">Sort: Year</option>
          <option value="status">Sort: Status</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} style={{ maxWidth: 160 }}>
          <option value="all">All statuses</option>
          <option value="monitored">Monitored</option>
          <option value="unmonitored">Unmonitored</option>
          <option value="downloaded">Downloaded</option>
          <option value="missing">Missing</option>
        </select>
        {tags.length > 0 && (
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
            style={{ maxWidth: 160 }}
          >
            <option value="all">All tags</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <div style={{ display: "flex", gap: 4 }}>
          <button type="button" className={viewMode === "poster" ? "" : "secondary"} onClick={() => setViewMode("poster")}>
            Posters
          </button>
          <button type="button" className={viewMode === "list" ? "" : "secondary"} onClick={() => setViewMode("list")}>
            List
          </button>
        </div>
        {auth.isAdmin && (
          <button className="secondary" onClick={exportCsv}>
            Export CSV
          </button>
        )}
        {auth.isAdmin && (
          <>
            <button className="secondary" onClick={() => csvInputRef.current?.click()} disabled={importingCsv}>
              {importingCsv ? "Importing..." : "Bulk edit via CSV..."}
            </button>
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv"
              style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])}
            />
          </>
        )}
      </div>

      {auth.isAdmin && selected.size > 0 && (
        <div className="form-panel" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <strong>{selected.size} selected</strong>
          <button className="secondary" onClick={() => bulkMonitor(true)}>
            Monitor
          </button>
          <button className="secondary" onClick={() => bulkMonitor(false)}>
            Unmonitor
          </button>
          <button className="secondary" onClick={bulkSearch}>
            Search selected
          </button>
          {tags.length > 0 && (
            <>
              <select value={tagToApply} onChange={(e) => setTagToApply(e.target.value ? Number(e.target.value) : "")}>
                <option value="">Add tag...</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <button className="secondary" onClick={bulkTag} disabled={!tagToApply}>
                Apply tag
              </button>
            </>
          )}
          <button className="secondary" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {loading && <p className="empty">Loading...</p>}
      {!loading && sorted.length === 0 && (
        <p className="empty">Nothing here yet. Add media from the "Add Media" tab.</p>
      )}

      {viewMode === "poster" ? (
        <div className="grid">
          {sorted.map((item) => (
            <div key={item.id} className="card" onClick={() => navigate(`/media/${item.id}`)} style={{ position: "relative" }}>
              {auth.isAdmin && (
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onClick={(e) => toggleSelect(item.id, e)}
                  onChange={() => {}}
                  style={{ position: "absolute", top: 8, left: 8, width: 18, height: 18, zIndex: 1 }}
                />
              )}
              <div className="poster" style={item.posterUrl ? { backgroundImage: `url(${item.posterUrl})` } : undefined}>
                {!item.posterUrl && "No poster"}
              </div>
              <div className="meta">
                <div className="title">{item.title}</div>
                <div className="sub">
                  {item.year ?? ""}
                  {item.monitored ? "" : " · unmonitored"}
                  {item.hasFile ? " · downloaded" : " · missing"}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              {auth.isAdmin && <th></th>}
              <th>Title</th>
              <th>Year</th>
              <th>Status</th>
              <th>Monitored</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr key={item.id} onClick={() => navigate(`/media/${item.id}`)} style={{ cursor: "pointer" }}>
                {auth.isAdmin && (
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onClick={(e) => toggleSelect(item.id, e)}
                      onChange={() => {}}
                    />
                  </td>
                )}
                <td>{item.title}</td>
                <td>{item.year ?? ""}</td>
                <td>
                  <span className={`badge ${item.hasFile ? "ok" : ""}`}>{item.hasFile ? "Downloaded" : "Missing"}</span>
                </td>
                <td>{item.monitored ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
