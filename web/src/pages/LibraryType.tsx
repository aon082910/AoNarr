import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, downloadFile, uploadFormFile } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { LibraryGroup, MediaItem, Tag } from "../types.js";
import { formatBytes } from "../utils/format.js";
import DropdownMenu from "../components/DropdownMenu.js";

type SortKey = "title" | "year" | "added" | "status";
type ViewMode = "poster" | "list";
type PosterSize = "small" | "medium" | "large";
type StatusFilter = "all" | "monitored" | "unmonitored" | "missing" | "downloaded";

const POSTER_SIZE_PX: Record<PosterSize, number> = { small: 120, medium: 160, large: 220 };

interface GroupDetail {
  group: LibraryGroup;
  breadcrumb: LibraryGroup[];
  isDeepestLevel: boolean;
  nextKind: string | null;
}

const KIND_LABEL: Record<string, string> = {
  system: "System",
  maker: "Maker",
  site: "Site",
  creator: "Creator",
  series: "Series",
};

/**
 * Handles both the flat library types (no groupLevels — behaves exactly like the old single-level
 * page) and the nested ones (ROMs/Adult/Online Videos/Courses): at any level short of the deepest
 * group kind, this renders a browse-groups grid instead of items; once at (or for flat types,
 * always at) the deepest level it renders the item grid with the usual sort/filter/view controls.
 */
export default function LibraryType() {
  const { type = "", groupId } = useParams<{ type: string; groupId?: string }>();
  const navigate = useNavigate();
  const { auth } = useAuth();
  const mediaTypes = useMediaTypes();
  const typeInfo = mediaTypes.find((t) => t.key === type);
  const groupLevels = typeInfo?.groupLevels ?? [];
  const isGrouped = groupLevels.length > 0;

  const [groupDetail, setGroupDetail] = useState<GroupDetail | null>(null);
  const [childGroups, setChildGroups] = useState<LibraryGroup[]>([]);
  const [ungroupedCount, setUngroupedCount] = useState(0);

  const currentKind = groupDetail ? groupDetail.group.kind : groupLevels[0];
  const nextKind = groupDetail ? groupDetail.nextKind : groupLevels[1] ?? (groupLevels.length === 1 ? null : groupLevels[0]);
  const atGroupBrowseLevel = isGrouped && (!groupId || !groupDetail?.isDeepestLevel);

  useEffect(() => {
    if (!isGrouped) return;
    if (groupId) {
      api.get<GroupDetail>(`/library-groups/${groupId}`).then((detail) => {
        setGroupDetail(detail);
        if (!detail.isDeepestLevel) {
          api.get<LibraryGroup[]>(`/library-groups?mediaType=${type}&parentId=${groupId}`).then(setChildGroups);
        }
      });
    } else {
      setGroupDetail(null);
      api.get<LibraryGroup[]>(`/library-groups?mediaType=${type}`).then(setChildGroups);
      api.get<MediaItem[]>(`/media?type=${type}&groupId=none`).then((rows) => setUngroupedCount(rows.length));
    }
  }, [isGrouped, type, groupId]);

  async function addGroup() {
    const kind = groupId ? groupDetail?.nextKind ?? groupLevels[0] : groupLevels[0];
    const name = prompt(`New ${KIND_LABEL[kind ?? ""] ?? kind}:`);
    if (!name?.trim()) return;
    await api.post("/library-groups", { mediaType: type, kind, name: name.trim(), parentGroupId: groupId ?? null });
    if (groupId) {
      api.get<LibraryGroup[]>(`/library-groups?mediaType=${type}&parentId=${groupId}`).then(setChildGroups);
    } else {
      api.get<LibraryGroup[]>(`/library-groups?mediaType=${type}`).then(setChildGroups);
    }
  }

  async function deleteGroup(g: LibraryGroup, e: MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Delete "${g.name}"? Items directly inside will become ungrouped, not deleted.`)) return;
    await api.del(`/library-groups/${g.id}`);
    setChildGroups((prev) => prev.filter((c) => c.id !== g.id));
  }

  if (!typeInfo) return <p className="empty">Loading...</p>;

  if (atGroupBrowseLevel) {
    return (
      <div>
        <h1>{typeInfo.label}</h1>
        {groupDetail && (
          <p style={{ color: "var(--muted)" }}>
            <Link to={`/library/${type}`}>{typeInfo.label}</Link>
            {groupDetail.breadcrumb.map((b) => (
              <span key={b.id}>
                {" / "}
                <Link to={`/library/${type}/g/${b.id}`}>{b.name}</Link>
              </span>
            ))}
          </p>
        )}
        <p style={{ color: "var(--muted)" }}>
          {KIND_LABEL[currentKind ?? ""] ?? currentKind}{groupDetail ? ` — browse by ${KIND_LABEL[nextKind ?? ""] ?? nextKind}` : ""}
        </p>

        {auth.isAdmin && (
          <button type="button" onClick={addGroup} style={{ marginBottom: 16 }}>
            + Add {KIND_LABEL[(groupId ? groupDetail?.nextKind : groupLevels[0]) ?? ""] ?? "group"}
          </button>
        )}

        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
          {childGroups.map((g) => (
            <div
              key={g.id}
              className="card"
              onClick={() => navigate(`/library/${type}/g/${g.id}`)}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20, cursor: "pointer", position: "relative" }}
            >
              <div style={{ fontWeight: 600 }}>{g.name}</div>
              {auth.isAdmin && (
                <button
                  type="button"
                  className="danger"
                  style={{ position: "absolute", top: 4, right: 4, padding: "1px 6px", fontSize: "0.7rem" }}
                  onClick={(e) => deleteGroup(g, e)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        {childGroups.length === 0 && <p className="empty">Nothing here yet.</p>}

        {!groupId && ungroupedCount > 0 && (
          <p style={{ marginTop: 16 }}>
            <Link to={`/library/${type}/ungrouped`}>{ungroupedCount} ungrouped item(s) →</Link>
          </p>
        )}
      </div>
    );
  }

  return <LibraryItemGrid type={type} typeLabel={typeInfo.label} groupId={groupId} groupDetail={groupDetail} />;
}

export function LibraryItemGrid({
  type,
  typeLabel,
  groupId,
  groupDetail,
}: {
  type: string;
  typeLabel: string;
  groupId?: string;
  groupDetail: GroupDetail | null;
}) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [typeSize, setTypeSize] = useState<number | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagFilter, setTagFilter] = useState<number | "all">("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("added");
  const [viewMode, setViewMode] = useState<ViewMode>(() => (localStorage.getItem("aonarr_library_view") as ViewMode) || "poster");
  const [posterSize, setPosterSize] = useState<PosterSize>(() => (localStorage.getItem("aonarr_library_poster_size") as PosterSize) || "medium");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [tagToApply, setTagToApply] = useState<number | "">("");
  const [importingCsv, setImportingCsv] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { auth } = useAuth();

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("type", type);
    if (groupId) params.set("groupId", groupId);
    if (tagFilter !== "all") params.set("tagId", String(tagFilter));
    api
      .get<MediaItem[]>(`/media?${params.toString()}`)
      .then((data) => {
        setItems(data);
        setSelected(new Set());
      })
      .finally(() => setLoading(false));
  }

  useEffect(load, [type, groupId, tagFilter]);
  useEffect(() => {
    api.get<Record<string, number>>("/dashboard/library-sizes").then((sizes) => setTypeSize(sizes[type] ?? 0));
  }, [type]);
  useEffect(() => {
    if (auth.isAdmin) api.get<Tag[]>("/tags").then(setTags);
  }, [auth.isAdmin]);
  useEffect(() => {
    localStorage.setItem("aonarr_library_view", viewMode);
  }, [viewMode]);
  useEffect(() => {
    localStorage.setItem("aonarr_library_poster_size", posterSize);
  }, [posterSize]);

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

  async function exportMetadata(format: "nfo" | "json" | "plexmatch") {
    await downloadFile(`/media/export-bulk.zip?type=${type}&format=${format}`, `aonarr-${type}-metadata.zip`);
  }

  async function exportCalibre() {
    await downloadFile(`/media/export-calibre.zip?type=${type}`, `aonarr-${type}-calibre.zip`);
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

  async function scanAndImport() {
    setScanning(true);
    try {
      const result = await api.post<{ matched: number; created: number; skipped: number; unsupported?: string }>(
        `/media/scan-import?type=${type}`,
        {}
      );
      if (result.unsupported) {
        alert(result.unsupported);
      } else {
        alert(`Scan complete: matched ${result.matched} existing item(s), created ${result.created} new item(s), skipped ${result.skipped} file(s).`);
        load();
      }
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function refreshLibrary() {
    setRefreshing(true);
    try {
      const result = await api.post<{ updated: number; failed: number }>(`/media/refresh?type=${type}`, {});
      alert(`Refreshed ${result.updated} item(s), ${result.failed} not found/failed.`);
      load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  async function quickAdd() {
    const title = prompt(`Title for the new ${typeLabel.replace(/ — Ungrouped$/, "")} item:`);
    if (!title?.trim()) return;
    await api.post("/media", {
      type,
      title: title.trim(),
      groupId: groupId && groupId !== "none" ? Number(groupId) : null,
    });
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
    return b.id - a.id;
  });

  return (
    <div>
      <h1>{typeLabel}</h1>
      {typeSize !== null && <p style={{ color: "var(--muted)" }}>{formatBytes(typeSize)} on disk</p>}
      {groupDetail && (
        <p style={{ color: "var(--muted)" }}>
          <Link to={`/library/${type}`}>{typeLabel}</Link>
          {groupDetail.breadcrumb.map((b) => (
            <span key={b.id}>
              {" / "}
              <Link to={`/library/${type}/g/${b.id}`}>{b.name}</Link>
            </span>
          ))}
        </p>
      )}
      <div className="toolbar" style={{ marginBottom: 10 }}>
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
      </div>

      <div className="toolbar" style={{ marginBottom: 16 }}>
        <DropdownMenu label={`View: ${viewMode === "poster" ? "Posters" : "List"}`}>
          <button type="button" onClick={() => setViewMode("poster")}>
            {viewMode === "poster" ? "✓ " : ""}Posters
          </button>
          <button type="button" onClick={() => setViewMode("list")}>
            {viewMode === "list" ? "✓ " : ""}List
          </button>
        </DropdownMenu>
        {viewMode === "poster" && (
          <select value={posterSize} onChange={(e) => setPosterSize(e.target.value as PosterSize)} style={{ maxWidth: 120 }}>
            <option value="small">Small posters</option>
            <option value="medium">Medium posters</option>
            <option value="large">Large posters</option>
          </select>
        )}

        {auth.isAdmin && groupId && (
          <button type="button" onClick={quickAdd}>
            + Add {typeLabel.replace(/ — Ungrouped$/, "")}
          </button>
        )}

        {auth.isAdmin && (
          <DropdownMenu label="Export & Bulk">
            <button type="button" onClick={exportCsv}>
              Export CSV
            </button>
            <button type="button" onClick={() => exportMetadata("nfo")}>
              Export metadata (.nfo)
            </button>
            <button type="button" onClick={() => exportMetadata("json")}>
              Export metadata (JSON)
            </button>
            {["movie", "series", "anime"].includes(type) && (
              <button
                type="button"
                onClick={() => exportMetadata("plexmatch")}
                title="A .plexmatch file per item's own folder — Plex's own match-override format, since Plex doesn't read .nfo sidecars"
              >
                Export for Plex (.plexmatch)
              </button>
            )}
            {["author", "audiobook", "comic", "manga"].includes(type) && (
              <button type="button" onClick={exportCalibre}>
                Export for Calibre
              </button>
            )}
            <div className="dropdown-divider" />
            <button type="button" onClick={() => csvInputRef.current?.click()} disabled={importingCsv}>
              {importingCsv ? "Importing..." : "Bulk edit via CSV..."}
            </button>
          </DropdownMenu>
        )}
        <input
          ref={csvInputRef}
          type="file"
          accept=".csv"
          style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])}
        />

        {auth.isAdmin && (
          <button
            className="select-like"
            onClick={scanAndImport}
            disabled={scanning}
            title="Scan this library's root folder(s) for media already on disk and import it"
          >
            {scanning ? "Scanning..." : "Scan & Import"}
          </button>
        )}
        {auth.isAdmin && (
          <button className="select-like" onClick={refreshLibrary} disabled={refreshing} title="Re-pull overview/poster/year for every item in this library">
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        )}
      </div>

      {auth.isAdmin && selected.size > 0 && (
        <div className="form-panel toolbar">
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
        <div className="grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${POSTER_SIZE_PX[posterSize]}px, 1fr))` }}>
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
