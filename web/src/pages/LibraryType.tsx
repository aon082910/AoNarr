import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, downloadFile, uploadFormFile } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { LibraryGroup, MediaItem, RootFolder, Tag } from "../types.js";
import { formatBytes } from "../utils/format.js";
import DropdownMenu from "../components/DropdownMenu.js";
import Modal from "../components/Modal.js";

type SortKey = "title" | "year" | "added" | "status" | "monitored" | "quality" | "contentRating";
type ViewMode = "poster" | "list";
type PosterSize = "small" | "medium" | "large";
type StatusFilter = "all" | "monitored" | "unmonitored" | "missing" | "downloaded";

const POSTER_SIZE_PX: Record<PosterSize, number> = { small: 120, medium: 160, large: 220 };

// "Title" is always shown (the primary column/label) — everything here is optional and
// user-toggleable, for both the list view's columns and the extra info line under each poster.
type ExtraField = "year" | "status" | "monitored" | "quality" | "contentRating" | "added";
const EXTRA_FIELD_LABELS: Record<ExtraField, string> = {
  year: "Year",
  status: "Status",
  monitored: "Monitored",
  quality: "Quality",
  contentRating: "Content rating",
  added: "Added",
};
const DEFAULT_LIST_COLUMNS: ExtraField[] = ["year", "status", "monitored"];
const DEFAULT_POSTER_FIELDS: ExtraField[] = ["year", "status", "monitored"];

function loadFieldSet(key: string, fallback: ExtraField[]): Set<ExtraField> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set(fallback);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? new Set(parsed) : new Set(fallback);
  } catch {
    return new Set(fallback);
  }
}

function fieldValue(item: MediaItem, field: ExtraField): string {
  if (field === "year") return item.year ? String(item.year) : "";
  if (field === "status") return item.hasFile ? "downloaded" : "missing";
  if (field === "monitored") return item.monitored ? "monitored" : "unmonitored";
  if (field === "quality") return item.quality ?? "";
  if (field === "contentRating") return item.contentRating ?? "";
  if (field === "added") return new Date(item.addedAt).toLocaleDateString();
  return "";
}

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
  const [editingOverview, setEditingOverview] = useState(false);
  const [overviewDraft, setOverviewDraft] = useState("");

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

  async function saveOverview() {
    if (!groupDetail) return;
    const updated = await api.patch<LibraryGroup>(`/library-groups/${groupDetail.group.id}`, {
      name: groupDetail.group.name,
      overview: overviewDraft.trim() || null,
    });
    setGroupDetail({ ...groupDetail, group: { ...groupDetail.group, overview: updated.overview } });
    setEditingOverview(false);
  }

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
        {groupDetail && (groupDetail.group.itemCount ?? 0) > 0 && (
          <p style={{ color: "var(--muted)" }}>
            <span className="badge ok">{groupDetail.group.haveCount} have</span>{" "}
            <span className={`badge ${(groupDetail.group.missingCount ?? 0) > 0 ? "danger" : ""}`}>
              {groupDetail.group.missingCount} missing
            </span>{" "}
            <span className="badge">{groupDetail.group.itemCount} total</span>
          </p>
        )}

        {groupDetail && !editingOverview && (
          <div style={{ marginBottom: 12 }}>
            {groupDetail.group.overview ? (
              <p>{groupDetail.group.overview}</p>
            ) : (
              auth.isAdmin && <p className="empty">No description yet.</p>
            )}
            {auth.isAdmin && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setOverviewDraft(groupDetail.group.overview ?? "");
                  setEditingOverview(true);
                }}
              >
                {groupDetail.group.overview ? "Edit description" : "Add description"}
              </button>
            )}
          </div>
        )}
        {groupDetail && editingOverview && (
          <div className="form-panel" style={{ marginBottom: 12 }}>
            <textarea
              value={overviewDraft}
              onChange={(e) => setOverviewDraft(e.target.value)}
              rows={3}
              style={{ width: "100%", maxWidth: 480 }}
              placeholder={`What is "${groupDetail.group.name}"?`}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" onClick={saveOverview}>
                Save
              </button>
              <button type="button" className="secondary" onClick={() => setEditingOverview(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

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
              <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: 4 }}>
                {(g.itemCount ?? 0) > 0 ? `${g.haveCount}/${g.itemCount}` : "empty"}
              </div>
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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    () => (localStorage.getItem("aonarr_library_status") as StatusFilter) || "all"
  );
  const [sortKey, setSortKey] = useState<SortKey>(() => (localStorage.getItem("aonarr_library_sort") as SortKey) || "added");
  const [viewMode, setViewMode] = useState<ViewMode>(() => (localStorage.getItem("aonarr_library_view") as ViewMode) || "poster");
  const [posterSize, setPosterSize] = useState<PosterSize>(() => (localStorage.getItem("aonarr_library_poster_size") as PosterSize) || "medium");
  const [listColumns, setListColumns] = useState<Set<ExtraField>>(() => loadFieldSet("aonarr_library_columns", DEFAULT_LIST_COLUMNS));
  const [posterFields, setPosterFields] = useState<Set<ExtraField>>(() => loadFieldSet("aonarr_library_poster_fields", DEFAULT_POSTER_FIELDS));
  const [contentRatingFilter, setContentRatingFilter] = useState<string | "all">("all");
  const [loading, setLoading] = useState(true);
  const [mediaServerConfigured, setMediaServerConfigured] = useState(false);
  const [showMediaServerImport, setShowMediaServerImport] = useState(false);
  const [mediaServerImportFolders, setMediaServerImportFolders] = useState<RootFolder[]>([]);
  const [mediaServerImportFolderId, setMediaServerImportFolderId] = useState<number | "">("");
  const [mediaServerImporting, setMediaServerImporting] = useState(false);
  const [showStarrImport, setShowStarrImport] = useState(false);
  const [starrImportFolders, setStarrImportFolders] = useState<RootFolder[]>([]);
  const [starrImportFolderId, setStarrImportFolderId] = useState<number | "">("");
  const [starrUrl, setStarrUrl] = useState("");
  const [starrApiKey, setStarrApiKey] = useState("");
  const [starrImporting, setStarrImporting] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
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
  const mediaServerImportable = type === "movie" || type === "series" || type === "anime";
  useEffect(() => {
    if (auth.isAdmin && mediaServerImportable) {
      api.get<Record<string, string>>("/settings").then((s) => setMediaServerConfigured(!!s.mediaServerType && !!s.mediaServerUrl && !!s.mediaServerToken));
    } else {
      setMediaServerConfigured(false);
    }
  }, [auth.isAdmin, mediaServerImportable]);

  async function openMediaServerImport() {
    const folders = await api.get<RootFolder[]>("/root-folders");
    const forType = folders.filter((f) => f.mediaType === type);
    setMediaServerImportFolders(forType);
    setMediaServerImportFolderId(forType[0]?.id ?? "");
    setShowMediaServerImport(true);
  }

  async function runMediaServerImport() {
    if (!mediaServerImportFolderId) return;
    setMediaServerImporting(true);
    try {
      if (type === "movie") {
        await api.post("/media-server-import/movies", { rootFolderId: mediaServerImportFolderId });
      } else {
        await api.post("/media-server-import/series", { rootFolderId: mediaServerImportFolderId, type });
      }
      alert(
        "Import started in the background — this can take a while for a large library. Check the Logs page for the result, or come back to this list shortly."
      );
      setShowMediaServerImport(false);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setMediaServerImporting(false);
    }
  }

  const starrImportable = type === "movie" || type === "series" || type === "anime";
  const starrAppName = type === "movie" ? "Radarr" : "Sonarr";

  async function openStarrImport() {
    const folders = await api.get<RootFolder[]>("/root-folders");
    const forType = folders.filter((f) => f.mediaType === type);
    setStarrImportFolders(forType);
    setStarrImportFolderId(forType[0]?.id ?? "");
    setShowStarrImport(true);
  }

  async function runStarrImport() {
    if (!starrImportFolderId || !starrUrl.trim() || !starrApiKey.trim()) return;
    setStarrImporting(true);
    try {
      if (type === "movie") {
        await api.post("/starr-import/movies", { url: starrUrl.trim(), apiKey: starrApiKey.trim(), rootFolderId: starrImportFolderId });
      } else {
        await api.post("/starr-import/series", {
          url: starrUrl.trim(),
          apiKey: starrApiKey.trim(),
          rootFolderId: starrImportFolderId,
          type,
        });
      }
      alert(
        "Import started in the background — this can take a while for a large library. Check the Logs page for the result, or come back to this list shortly."
      );
      setShowStarrImport(false);
      setStarrUrl("");
      setStarrApiKey("");
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setStarrImporting(false);
    }
  }

  useEffect(() => {
    localStorage.setItem("aonarr_library_view", viewMode);
  }, [viewMode]);
  useEffect(() => {
    localStorage.setItem("aonarr_library_poster_size", posterSize);
  }, [posterSize]);
  useEffect(() => {
    localStorage.setItem("aonarr_library_sort", sortKey);
  }, [sortKey]);
  useEffect(() => {
    localStorage.setItem("aonarr_library_status", statusFilter);
  }, [statusFilter]);
  useEffect(() => {
    localStorage.setItem("aonarr_library_columns", JSON.stringify(Array.from(listColumns)));
  }, [listColumns]);
  useEffect(() => {
    localStorage.setItem("aonarr_library_poster_fields", JSON.stringify(Array.from(posterFields)));
  }, [posterFields]);

  function toggleListColumn(field: ExtraField) {
    setListColumns((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  }

  function togglePosterField(field: ExtraField) {
    setPosterFields((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  }

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

  // Runs in the background on the server (probing every file with ffprobe can take a while for a
  // real library — long enough to blow past an HTTP/gateway timeout if the request waited for it),
  // so this only confirms it started; check the Logs page for the actual matched/created/skipped
  // counts once it's done, or just come back to this list in a bit.
  async function scanAndImport() {
    setScanning(true);
    try {
      await api.post(`/media/scan-import?type=${type}`, {});
      alert("Scan & import started in the background — this can take a while for a large library. Check the Logs page for the result, or come back to this list shortly.");
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setTimeout(() => setScanning(false), 5000);
    }
  }

  async function refreshLibrary() {
    setRefreshing(true);
    try {
      await api.post(`/media/refresh?type=${type}`, {});
      alert("Refresh started in the background — check the Logs page for the result, or come back to this list shortly.");
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setTimeout(() => setRefreshing(false), 5000);
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

  const haveCount = items.filter((item) => item.hasFile).length;
  const missingCount = items.length - haveCount;

  const contentRatings = Array.from(new Set(items.map((i) => i.contentRating).filter((r): r is string => !!r))).sort();

  const filtered = items.filter((item) => {
    if (statusFilter === "monitored" && !item.monitored) return false;
    if (statusFilter === "unmonitored" && item.monitored) return false;
    if (statusFilter === "missing" && item.hasFile) return false;
    if (statusFilter === "downloaded" && !item.hasFile) return false;
    if (contentRatingFilter !== "all" && item.contentRating !== contentRatingFilter) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === "title") return a.title.localeCompare(b.title);
    if (sortKey === "year") return (b.year ?? 0) - (a.year ?? 0);
    if (sortKey === "status") return Number(b.hasFile) - Number(a.hasFile);
    if (sortKey === "monitored") return Number(b.monitored) - Number(a.monitored);
    if (sortKey === "quality") return (a.quality ?? "").localeCompare(b.quality ?? "");
    if (sortKey === "contentRating") return (a.contentRating ?? "").localeCompare(b.contentRating ?? "");
    return b.id - a.id;
  });

  return (
    <div>
      <h1>{typeLabel}</h1>
      <p style={{ color: "var(--muted)" }}>
        {typeSize !== null && <>{formatBytes(typeSize)} on disk · </>}
        <span className="badge ok">{haveCount} have</span>{" "}
        <span className={`badge ${missingCount > 0 ? "danger" : ""}`}>{missingCount} missing</span>{" "}
        <span className="badge">{items.length} total</span>
      </p>
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
        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} style={{ maxWidth: 210 }}>
          <option value="added">Sort: Recently added</option>
          <option value="title">Sort: Title</option>
          <option value="year">Sort: Year</option>
          <option value="status">Sort: Status</option>
          <option value="monitored">Sort: Monitored</option>
          <option value="quality">Sort: Quality</option>
          <option value="contentRating">Sort: Content rating</option>
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
        {contentRatings.length > 0 && (
          <select value={contentRatingFilter} onChange={(e) => setContentRatingFilter(e.target.value)} style={{ maxWidth: 160 }}>
            <option value="all">All content ratings</option>
            {contentRatings.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
        {viewMode === "poster" && (
          <select value={posterSize} onChange={(e) => setPosterSize(e.target.value as PosterSize)} style={{ maxWidth: 120 }}>
            <option value="small">Small posters</option>
            <option value="medium">Medium posters</option>
            <option value="large">Large posters</option>
          </select>
        )}
        {viewMode === "poster" ? (
          <DropdownMenu label="Poster info">
            {(Object.keys(EXTRA_FIELD_LABELS) as ExtraField[]).map((field) => (
              <label
                key={field}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", cursor: "pointer" }}
                onClick={(e) => e.stopPropagation()}
              >
                <input type="checkbox" checked={posterFields.has(field)} onChange={() => togglePosterField(field)} style={{ width: "auto" }} />
                {EXTRA_FIELD_LABELS[field]}
              </label>
            ))}
          </DropdownMenu>
        ) : (
          <DropdownMenu label="Columns">
            {(Object.keys(EXTRA_FIELD_LABELS) as ExtraField[]).map((field) => (
              <label
                key={field}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", cursor: "pointer" }}
                onClick={(e) => e.stopPropagation()}
              >
                <input type="checkbox" checked={listColumns.has(field)} onChange={() => toggleListColumn(field)} style={{ width: "auto" }} />
                {EXTRA_FIELD_LABELS[field]}
              </label>
            ))}
          </DropdownMenu>
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
        {auth.isAdmin && mediaServerConfigured && (
          <button
            className="select-like"
            onClick={openMediaServerImport}
            title={`Import an already-organized ${typeLabel.toLowerCase()} library straight from your configured Plex/Jellyfin/Emby server, with its real title/year/poster/external-id metadata`}
          >
            Import from Media Server
          </button>
        )}
        {auth.isAdmin && starrImportable && (
          <button
            className="select-like"
            onClick={openStarrImport}
            title={`Migrate an existing ${starrAppName} library straight into AoNarr — real title/year/poster/external-id metadata, matched against anything already here first`}
          >
            Import from {starrAppName}
          </button>
        )}
        {auth.isAdmin && (
          <button
            className={selectMode ? "" : "secondary"}
            onClick={() => {
              setSelectMode((v) => !v);
              setSelected(new Set());
            }}
          >
            {selectMode ? "Done selecting" : "Select"}
          </button>
        )}
        {auth.isAdmin && selectMode && (
          <>
            <button className="secondary" onClick={() => setSelected(new Set(sorted.map((i) => i.id)))}>
              Select all
            </button>
            <button className="secondary" onClick={() => setSelected(new Set())}>
              Select none
            </button>
          </>
        )}
      </div>

      {auth.isAdmin && selectMode && selected.size > 0 && (
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
              {selectMode && (
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
                  {(Object.keys(EXTRA_FIELD_LABELS) as ExtraField[])
                    .filter((f) => posterFields.has(f))
                    .map((f) => (f === "monitored" && item.monitored ? "" : fieldValue(item, f)))
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              {selectMode && <th></th>}
              <th>Title</th>
              {(Object.keys(EXTRA_FIELD_LABELS) as ExtraField[])
                .filter((f) => listColumns.has(f))
                .map((f) => (
                  <th key={f}>{EXTRA_FIELD_LABELS[f]}</th>
                ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr key={item.id} onClick={() => navigate(`/media/${item.id}`)} style={{ cursor: "pointer" }}>
                {selectMode && (
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
                {(Object.keys(EXTRA_FIELD_LABELS) as ExtraField[])
                  .filter((f) => listColumns.has(f))
                  .map((f) =>
                    f === "status" ? (
                      <td key={f}>
                        <span className={`badge ${item.hasFile ? "ok" : ""}`}>{item.hasFile ? "Downloaded" : "Missing"}</span>
                      </td>
                    ) : f === "monitored" ? (
                      <td key={f}>{item.monitored ? "Yes" : "No"}</td>
                    ) : (
                      <td key={f}>{fieldValue(item, f)}</td>
                    )
                  )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showMediaServerImport && (
        <Modal title="Import from Media Server" onClose={() => setShowMediaServerImport(false)} maxWidth={480}>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
            Pulls every {type === "movie" ? "movie" : "show and its episodes"} your configured
            media server has — with real title, year, poster, and external ids{type !== "movie" && ", plus each episode's own file"} — matching against anything already in this library first
            (by path, then external id, then title/year{type !== "movie" && "/season/episode"}) and
            creating a new entry for anything genuinely new. Runs in the background; check the Logs
            page for the result.
          </p>
          {mediaServerImportFolders.length === 0 ? (
            <p className="empty">No root folder configured for this library yet — add one in Settings first.</p>
          ) : (
            <>
              <label>Root folder for newly-created items</label>
              <select
                value={mediaServerImportFolderId}
                onChange={(e) => setMediaServerImportFolderId(e.target.value ? Number(e.target.value) : "")}
              >
                {mediaServerImportFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.path}
                  </option>
                ))}
              </select>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button type="button" onClick={runMediaServerImport} disabled={mediaServerImporting || !mediaServerImportFolderId}>
                  {mediaServerImporting ? "Starting..." : "Start import"}
                </button>
                <button type="button" className="secondary" onClick={() => setShowMediaServerImport(false)}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {showStarrImport && (
        <Modal title={`Import from ${starrAppName}`} onClose={() => setShowStarrImport(false)} maxWidth={480}>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
            Migrates an already-organized {starrAppName} {type === "movie" ? "movie" : "show and episode"}{" "}
            library into AoNarr — pulled from {starrAppName}'s own API with real title/year/poster/external-id
            metadata, matching against anything already in this library first (by path, then external id, then
            title/year{type !== "movie" && "/season/episode"}) and creating a new entry for anything genuinely
            new. The URL and API key are only used for this one import, not saved. Runs in the background; check
            the Logs page for the result.
          </p>
          {starrImportFolders.length === 0 ? (
            <p className="empty">No root folder configured for this library yet — add one in Settings first.</p>
          ) : (
            <>
              <label>{starrAppName} URL</label>
              <input
                type="text"
                value={starrUrl}
                onChange={(e) => setStarrUrl(e.target.value)}
                placeholder={`http://localhost:${type === "movie" ? "7878" : "8989"}`}
              />
              <label>{starrAppName} API key</label>
              <input type="text" value={starrApiKey} onChange={(e) => setStarrApiKey(e.target.value)} placeholder="Settings → General → Security" />
              <label>Root folder for newly-created items</label>
              <select value={starrImportFolderId} onChange={(e) => setStarrImportFolderId(e.target.value ? Number(e.target.value) : "")}>
                {starrImportFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.path}
                  </option>
                ))}
              </select>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button
                  type="button"
                  onClick={runStarrImport}
                  disabled={starrImporting || !starrImportFolderId || !starrUrl.trim() || !starrApiKey.trim()}
                >
                  {starrImporting ? "Starting..." : "Start import"}
                </button>
                <button type="button" className="secondary" onClick={() => setShowStarrImport(false)}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
