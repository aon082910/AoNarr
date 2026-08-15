import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, downloadFile, uploadFormFile } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { MediaItem, MediaType, Tag } from "../types.js";

export default function Library() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [filter, setFilter] = useState<MediaType | "all">("all");
  const [tagFilter, setTagFilter] = useState<number | "all">("all");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [tagToApply, setTagToApply] = useState<number | "">("");
  const [importingCsv, setImportingCsv] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { auth } = useAuth();
  const mediaTypes = useMediaTypes().filter((t) => auth.isAdmin || auth.user?.allowedTypes.includes(t.key));
  const labelFor = (key: string) => mediaTypes.find((t) => t.key === key)?.label ?? key;

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter !== "all") params.set("type", filter);
    if (tagFilter !== "all") params.set("tagId", String(tagFilter));
    const qs = params.toString();
    api
      .get<MediaItem[]>(`/media${qs ? `?${qs}` : ""}`)
      .then((data) => {
        setItems(data);
        setSelected(new Set());
      })
      .finally(() => setLoading(false));
  }

  useEffect(load, [filter, tagFilter]);
  useEffect(() => {
    if (auth.isAdmin) api.get<Tag[]>("/tags").then(setTags);
  }, [auth.isAdmin]);

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
    const qs = filter !== "all" ? `?type=${filter}` : "";
    await downloadFile(`/media/export.csv${qs}`, "aonarr-library.csv");
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

  return (
    <div>
      <h1>Library</h1>
      <div style={{ marginBottom: 16, display: "flex", gap: 10 }}>
        <select value={filter} onChange={(e) => setFilter(e.target.value as any)} style={{ maxWidth: 220 }}>
          <option value="all">All types</option>
          {mediaTypes.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        {tags.length > 0 && (
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
            style={{ maxWidth: 220 }}
          >
            <option value="all">All tags</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
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
      {!loading && items.length === 0 && (
        <p className="empty">Nothing here yet. Add media from the "Add Media" tab.</p>
      )}

      <div className="grid">
        {items.map((item) => (
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
                {item.monitored ? "" : " · unmonitored"}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
