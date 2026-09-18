import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";
import MonitorToggle from "../components/MonitorToggle.js";
import { useAuth } from "../context/AuthContext.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import type { MediaInfo, SearchResult, Track } from "../types.js";
import { formatMediaInfo } from "../utils/format.js";
import {
  SearchIcon,
  DownloadIcon,
  CpuIcon,
  AlertTriangleIcon,
  ShareIcon,
  RotateCcwIcon,
  CalendarIcon,
  LayersIcon,
  HardDriveIcon,
  GlobeIcon,
  ListIcon,
  UserIcon,
} from "../components/NavIcons.js";
import { ArrowLeftIcon, FolderIcon } from "../components/ActionIcons.js";
import { PageToolbar, ToolbarButton, ToolbarSeparator } from "../components/PageToolbar.js";
import { notify } from "../utils/notify.js";
import { confirmDialog } from "../utils/confirmDialog.js";
import { promptDialog } from "../utils/promptDialog.js";

interface SeriesSibling {
  id: number;
  mediaItemId: number;
  title: string;
  seriesPosition: number | null;
  posterUrl: string | null;
  hasFile: 0 | 1;
  parentTitle: string;
}

interface NarratorSibling {
  id: number;
  mediaItemId: number;
  title: string;
  posterUrl: string | null;
  hasFile: 0 | 1;
  parentTitle: string;
}

interface SubItemDetailResponse {
  id: number;
  mediaItemId: number;
  title: string;
  releaseDate: string | null;
  externalId: string | null;
  externalProvider: string | null;
  monitored: 0 | 1;
  hasFile: 0 | 1;
  quality: string | null;
  filePath: string | null;
  mediaInfo: MediaInfo | null;
  posterUrl: string | null;
  seriesName: string | null;
  seriesPosition: number | null;
  narrator: string | null;
  parent: { id: number; title: string; type: string } | null;
  series: SeriesSibling[];
  byNarrator: NarratorSibling[];
}

export default function SubItemDetail() {
  const { mediaId, subItemId } = useParams<{ mediaId: string; subItemId: string }>();
  const navigate = useNavigate();
  const { auth } = useAuth();
  const isAdmin = auth.isAdmin;
  const mediaTypes = useMediaTypes();

  const [subItem, setSubItem] = useState<SubItemDetailResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const { sortRows: sortSearchResults, sortableHeader: searchResultHeader } = useSortableTable<SearchResult, "title" | "size" | "seeders" | "quality">(
    "seeders",
    "desc"
  );
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const [scanningIsbn, setScanningIsbn] = useState(false);
  const [sendingToKindle, setSendingToKindle] = useState(false);
  const [convertingM4b, setConvertingM4b] = useState(false);

  // Navigating between sibling sub-items (a series/narrator sibling link, or browser Back/Forward)
  // reuses this mounted component — without a request-ordering guard, a slower response for a
  // previous sub-item could land after a newer one and overwrite it. The search-results modal isn't
  // itself a blocking overlay here, so it also needs to reset on id change, or a stale result list
  // stays visible (and grabbable) against whatever sub-item is now showing.
  const loadRequestRef = useRef(0);
  function load() {
    const requestId = ++loadRequestRef.current;
    setSubItem(null);
    api.get<SubItemDetailResponse>(`/media/${mediaId}/subitems/${subItemId}`).then((data) => {
      if (loadRequestRef.current === requestId) setSubItem(data);
    });
  }
  useEffect(load, [mediaId, subItemId]);
  useEffect(() => {
    setResults(null);
    setError(null);
    setSearching(false);
  }, [mediaId, subItemId]);

  const typeInfo = subItem ? mediaTypes.find((t) => t.key === subItem.parent?.type) : undefined;
  const childLabel = typeInfo?.childLabel ?? "Item";

  useEffect(() => {
    if (!typeInfo?.multiFilePerChild || !subItemId) return;
    setLoadingTracks(true);
    api
      .get<Track[]>(`/media/subitems/${subItemId}/tracks`)
      .then(setTracks)
      .finally(() => setLoadingTracks(false));
  }, [typeInfo?.multiFilePerChild, mediaId, subItemId]);

  async function fetchTracks() {
    setLoadingTracks(true);
    try {
      const rows = await api.post<Track[]>(`/media/subitems/${subItemId}/tracks/fetch`);
      setTracks(rows);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setLoadingTracks(false);
    }
  }

  async function toggleMonitored() {
    if (!subItem) return;
    const updated = await api.patch<SubItemDetailResponse>(`/media/${mediaId}/subitems/${subItemId}`, {
      monitored: subItem.monitored ? 0 : 1,
    });
    setSubItem({ ...subItem, monitored: updated.monitored });
  }

  async function markAsMissing() {
    if (!subItem) return;
    if (
      !(await confirmDialog({
        title: "Mark as missing",
        message: "Mark as missing? Only do this if you already removed the file from disk yourself — this just resets AoNarr's own record so it gets searched for again; it doesn't touch any file.",
      }))
    )
      return;
    const updated = await api.patch<SubItemDetailResponse>(`/media/${mediaId}/subitems/${subItemId}`, {
      hasFile: 0,
      filePath: null,
      quality: null,
    });
    setSubItem({ ...subItem, hasFile: updated.hasFile, filePath: updated.filePath, quality: updated.quality });
  }

  const searchRequestRef = useRef(0);
  async function runSearch() {
    const requestId = ++searchRequestRef.current;
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      const res = await api.get<SearchResult[]>(`/search/${mediaId}?subItemId=${subItemId}`);
      if (searchRequestRef.current !== requestId) return;
      setResults(res);
    } catch (e) {
      if (searchRequestRef.current !== requestId) return;
      setError((e as Error).message);
    } finally {
      if (searchRequestRef.current === requestId) setSearching(false);
    }
  }

  async function grab(result: SearchResult) {
    try {
      await api.post(`/search/${mediaId}/grab`, {
        downloadUrl: result.downloadUrl,
        indexerId: result.indexerId,
        title: result.title,
        size: result.size,
        protocol: result.protocol,
        subItemId: Number(subItemId),
      });
      notify.success(`Sent "${result.title}" to download client.`);
      load();
    } catch (e) {
      notify.error(`Grab failed: ${(e as Error).message}`);
    }
  }

  async function downloadVideo() {
    if (!subItem) return;
    try {
      await api.post(`/media/subitems/${subItem.id}/download`, {});
      notify.success(`Sent "${subItem.title}" to yt-dlp.`);
      load();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function scanIsbn() {
    if (!subItem) return;
    setScanningIsbn(true);
    try {
      const result = await api.post<{ found: boolean; isbn?: string; matched?: boolean; subItem?: SubItemDetailResponse }>(
        `/media/${mediaId}/subitems/${subItemId}/scan-isbn`,
        {}
      );
      if (!result.found) {
        notify.info("No ISBN found in this file's first/last 15 pages (or its EPUB metadata).");
      } else if (!result.matched) {
        notify.info(`Found ISBN ${result.isbn}, but couldn't find a matching book on Open Library.`);
      } else {
        notify.success(`Found ISBN ${result.isbn} — matched and updated from Open Library.`);
        // The scan-isbn response is a bare sub_items row (no `parent`) — merge onto the existing
        // state rather than replacing it wholesale, or the breadcrumb and this very button (which
        // depends on subItem.parent.type) would disappear the instant a scan succeeds.
        if (result.subItem) setSubItem({ ...subItem, ...result.subItem, parent: subItem.parent, series: subItem.series });
      }
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setScanningIsbn(false);
    }
  }

  async function sendToKindle() {
    if (!subItem) return;
    setSendingToKindle(true);
    try {
      await api.post(`/media/${mediaId}/subitems/${subItemId}/send-to-kindle`, {});
      notify.success(`Sent "${subItem.title}" to your Kindle.`);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSendingToKindle(false);
    }
  }

  async function convertToM4b() {
    if (!subItem) return;
    if (
      !(await confirmDialog({
        title: "Convert to M4B",
        message: "Merge every downloaded track into one chapterized M4B? The original per-track files will be deleted once the merge succeeds. This can take a while for a long book.",
        danger: true,
      }))
    )
      return;
    setConvertingM4b(true);
    try {
      await api.post(`/media/${mediaId}/subitems/${subItemId}/convert-to-m4b`, {});
      notify.success("Merged into one M4B.");
      load();
      const rows = await api.get<Track[]>(`/media/subitems/${subItemId}/tracks`);
      setTracks(rows);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setConvertingM4b(false);
    }
  }

  async function editCover() {
    if (!subItem) return;
    const url = await promptDialog({
      title: "Cover art",
      label: "Cover art URL",
      defaultValue: subItem.posterUrl ?? "",
      placeholder: "Leave blank to remove",
    });
    if (url === null) return;
    try {
      const updated = await api.patch<SubItemDetailResponse>(`/media/${mediaId}/subitems/${subItemId}`, {
        posterUrl: url.trim() || null,
      });
      setSubItem({ ...subItem, posterUrl: updated.posterUrl });
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function editSeries() {
    if (!subItem) return;
    const result = await promptDialog({
      title: "Series",
      fields: [
        { key: "name", label: "Series name", defaultValue: subItem.seriesName ?? "", placeholder: "Leave blank to remove from a series" },
        {
          key: "position",
          label: "Position in series",
          defaultValue: subItem.seriesPosition != null ? String(subItem.seriesPosition) : "",
          placeholder: 'e.g. "1", "2.5" for an interstitial — leave blank for none',
        },
      ],
      confirmLabel: "Save",
    });
    if (!result) return;
    const name = result.name;
    const position: number | null = name.trim() ? (result.position.trim() ? Number(result.position.trim()) : null) : null;
    try {
      await api.patch(`/media/${mediaId}/subitems/${subItemId}`, { seriesName: name.trim() || null, seriesPosition: position });
      load();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function editNarrator() {
    if (!subItem) return;
    const name = await promptDialog({ title: "Narrator", label: "Narrator", defaultValue: subItem.narrator ?? "", placeholder: "Leave blank to clear" });
    if (name === null) return;
    try {
      await api.patch(`/media/${mediaId}/subitems/${subItemId}`, { narrator: name.trim() || null });
      load();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  if (!subItem) return <p className="empty">Loading...</p>;

  const isYoutubeVideo = subItem.parent?.type === "video" && subItem.externalProvider === "youtube";
  const trackHave = tracks?.filter((t) => t.hasFile).length ?? 0;

  return (
    <div>
      {subItem.parent && (
        <p style={{ color: "var(--muted)" }}>
          <Link to={`/media/${subItem.parent.id}`}>{subItem.parent.title}</Link> / {childLabel}
        </p>
      )}
      <h1>{subItem.title}</h1>

      {isAdmin && (
        <PageToolbar
          left={
            <>
              {isYoutubeVideo ? (
                <ToolbarButton icon={<DownloadIcon />} label="Download" onClick={downloadVideo} title="Download" />
              ) : (
                <ToolbarButton
                  icon={<SearchIcon />}
                  label={searching ? "Searching..." : "Search"}
                  onClick={runSearch}
                  disabled={searching}
                  title={searching ? "Searching..." : "Search"}
                />
              )}
              {subItem.parent?.type === "author" && !!subItem.hasFile && (
                <ToolbarButton
                  icon={<CpuIcon />}
                  label={scanningIsbn ? "Scanning..." : "Scan ISBN"}
                  onClick={scanIsbn}
                  disabled={scanningIsbn}
                  title={scanningIsbn ? "Scanning..." : "Scan for ISBN — scans the file's first and last 15 pages (PDF) or its EPUB metadata for an ISBN, then matches it via Open Library"}
                />
              )}
              {!!subItem.hasFile && subItem.parent?.type !== "audiobook" && (
                <ToolbarButton
                  icon={<ShareIcon />}
                  label={sendingToKindle ? "Sending..." : "Send to Kindle"}
                  onClick={sendToKindle}
                  disabled={sendingToKindle}
                  title={sendingToKindle ? "Sending..." : "Send to Kindle — emails this file to your Kindle's Send to Kindle address (set in Settings → General)"}
                />
              )}
              {!!subItem.hasFile && (
                <>
                  <ToolbarSeparator />
                  <ToolbarButton
                    icon={<AlertTriangleIcon />}
                    label="Mark as Missing"
                    onClick={markAsMissing}
                    danger
                    title="Mark as missing — removed the file yourself? This resets AoNarr's record so it searches for it again."
                  />
                </>
              )}
              <ToolbarSeparator />
              <ToolbarButton icon={<ArrowLeftIcon />} label="Back" onClick={() => navigate(-1)} title={`Back to ${subItem.parent?.title ?? "parent"}`} />
            </>
          }
        />
      )}

      <div
        onClick={() => isAdmin && editCover()}
        title={isAdmin ? "Click to add/change cover art" : undefined}
        style={{
          width: 120,
          height: 120,
          borderRadius: 6,
          overflow: "hidden",
          background: "var(--panel-2, rgba(255,255,255,0.06))",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: isAdmin ? "pointer" : "default",
          marginBottom: 16,
        }}
      >
        {subItem.posterUrl ? (
          <img src={subItem.posterUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <span style={{ color: "var(--muted)" }}>{isAdmin ? "Add cover" : "No cover"}</span>
        )}
      </div>

      <div className="detail-pills">
        <span className="pill">
          <MonitorToggle monitored={!!subItem.monitored} onToggle={toggleMonitored} />
          {subItem.monitored ? "Monitored" : "Unmonitored"}
        </span>
        <span className="pill">
          <CalendarIcon />
          {subItem.releaseDate ?? "Unknown release date"}
        </span>
        <span className={`badge ${subItem.hasFile ? "ok" : ""}`}>{subItem.hasFile ? "Downloaded" : "Missing"}</span>
        {subItem.quality && (
          <span className="pill">
            <LayersIcon />
            {subItem.quality}
          </span>
        )}
        {formatMediaInfo(subItem.mediaInfo) && (
          <span className="pill">
            <HardDriveIcon />
            {formatMediaInfo(subItem.mediaInfo)}
          </span>
        )}
        {subItem.filePath && (
          <span className="pill" style={{ whiteSpace: "normal", wordBreak: "break-all" }}>
            <FolderIcon />
            {subItem.filePath}
          </span>
        )}
        {subItem.externalId && (
          <span className="pill">
            <GlobeIcon />
            {subItem.externalProvider}: {subItem.externalId}
          </span>
        )}
        {(subItem.seriesName || isAdmin) && (
          <span
            className="pill"
            onClick={() => isAdmin && editSeries()}
            title={isAdmin ? "Click to set/change this item's series" : undefined}
            style={{ cursor: isAdmin ? "pointer" : "default" }}
          >
            <ListIcon />
            {subItem.seriesName
              ? `${subItem.seriesName}${subItem.seriesPosition != null ? ` #${subItem.seriesPosition}` : ""}`
              : isAdmin
                ? "Not part of a series — click to set one"
                : "-"}
          </span>
        )}
        {subItem.parent?.type === "audiobook" && (subItem.narrator || isAdmin) && (
          <span
            className="pill"
            onClick={() => isAdmin && editNarrator()}
            title={isAdmin ? "Click to set/change this audiobook's narrator" : undefined}
            style={{ cursor: isAdmin ? "pointer" : "default" }}
          >
            <UserIcon />
            {subItem.narrator ?? (isAdmin ? "Not set — click to add" : "-")}
          </span>
        )}
      </div>

      {subItem.series.length > 0 && (
        <>
          {(() => {
            // Readarr-style "incomplete series" flag — an integer position with a gap between the
            // lowest and highest known position (e.g. have #1, #2, #4 — missing #3) most often
            // means a book hasn't been added/matched yet, not that #3 never existed. Purely
            // informational (positions can legitimately be non-integer for interstitials/novellas,
            // which are excluded from the gap check rather than treated as real "missing" slots).
            const positions = [...subItem.series.map((s) => s.seriesPosition), subItem.seriesPosition].filter(
              (p): p is number => p != null && Number.isInteger(p)
            );
            if (positions.length < 2) return null;
            const min = Math.min(...positions);
            const max = Math.max(...positions);
            const have = new Set(positions);
            const missing: number[] = [];
            for (let i = min; i <= max; i++) if (!have.has(i)) missing.push(i);
            if (missing.length === 0) return null;
            return (
              <span className="badge danger" title={`Positions present in this series: ${min}-${max}`}>
                Incomplete series — missing #{missing.join(", #")}
              </span>
            );
          })()}
          <h2>{subItem.seriesName}</h2>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>Other books in this series.</p>
          <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 8, marginBottom: 12 }}>
            {subItem.series.map((s) => (
              <div key={s.id} style={{ flex: "0 0 120px", textAlign: "center" }}>
                <Link to={`/media/${s.mediaItemId}/item/${s.id}`}>
                  <div
                    className="poster"
                    style={{
                      width: 120,
                      height: 180,
                      ...(s.posterUrl
                        ? { backgroundImage: `url(${s.posterUrl})`, backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" }
                        : {}),
                    }}
                  >
                    {!s.posterUrl && "No cover"}
                  </div>
                  <div style={{ fontSize: "0.8rem", marginTop: 4, color: "var(--text)" }}>
                    {s.seriesPosition != null ? `#${s.seriesPosition} — ` : ""}
                    {s.title}
                  </div>
                </Link>
                <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>{s.parentTitle}</div>
                <span className={`badge ${s.hasFile ? "ok" : ""}`} style={{ marginTop: 2, display: "inline-block" }}>
                  {s.hasFile ? "Downloaded" : "Missing"}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {subItem.byNarrator.length > 0 && (
        <>
          <h2>Narrated by {subItem.narrator}</h2>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>Other audiobooks narrated by the same person.</p>
          <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 8, marginBottom: 12 }}>
            {subItem.byNarrator.map((s) => (
              <div key={s.id} style={{ flex: "0 0 120px", textAlign: "center" }}>
                <Link to={`/media/${s.mediaItemId}/item/${s.id}`}>
                  <div
                    className="poster"
                    style={{
                      width: 120,
                      height: 180,
                      ...(s.posterUrl
                        ? { backgroundImage: `url(${s.posterUrl})`, backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" }
                        : {}),
                    }}
                  >
                    {!s.posterUrl && "No cover"}
                  </div>
                  <div style={{ fontSize: "0.8rem", marginTop: 4, color: "var(--text)" }}>{s.title}</div>
                </Link>
                <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>{s.parentTitle}</div>
                <span className={`badge ${s.hasFile ? "ok" : ""}`} style={{ marginTop: 2, display: "inline-block" }}>
                  {s.hasFile ? "Downloaded" : "Missing"}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {results && (
        <Modal title="Search results" onClose={() => setResults(null)} maxWidth={800}>
          <table>
            <thead>
              <tr>
                {searchResultHeader("title", "Title")}
                {searchResultHeader("size", "Size")}
                {searchResultHeader("seeders", "Seeders")}
                {searchResultHeader("quality", "Quality")}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {results.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    No results.
                  </td>
                </tr>
              )}
              {sortSearchResults(results, (a, b, key) => {
                if (key === "title") return a.title.localeCompare(b.title);
                if (key === "size") return a.size - b.size;
                if (key === "seeders") return (a.seeders ?? -1) - (b.seeders ?? -1);
                return (a.parsedQuality ?? "").localeCompare(b.parsedQuality ?? "");
              }).map((r, i) => (
                <tr key={i}>
                  <td>{r.title}</td>
                  <td>{(r.size / 1e9).toFixed(2)} GB</td>
                  <td>{r.seeders ?? "-"}</td>
                  <td>{r.parsedQuality ?? "-"}</td>
                  <td>
                    <button type="button" className="icon-button" onClick={() => grab(r)} title="Grab" aria-label="Grab">
                      <DownloadIcon />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}

      {typeInfo?.multiFilePerChild && (
        <>
          {tracks && (
            <div className="detail-pills" style={{ marginTop: 16 }}>
              <span className="badge ok">{trackHave} have</span>
              <span className="badge">{tracks.length} total</span>
            </div>
          )}
          <h2>Tracks</h2>
          {isAdmin && subItem.parent?.type === "audiobook" && trackHave >= 2 && (
            <button className="secondary" onClick={convertToM4b} disabled={convertingM4b} style={{ marginBottom: 8 }}>
              {convertingM4b ? "Converting... (this can take a while)" : "Convert to chapterized M4B"}
            </button>
          )}
          {loadingTracks && <p className="empty">Loading...</p>}
          {!loadingTracks && (!tracks || tracks.length === 0) && (
            <>
              <p className="empty">No track data available.</p>
              {isAdmin && subItem.externalId && (
                <button type="button" className="icon-button" onClick={fetchTracks} title="Fetch tracks" aria-label="Fetch tracks">
                  <RotateCcwIcon />
                </button>
              )}
            </>
          )}
          {!loadingTracks && tracks && tracks.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Title</th>
                  <th>Duration</th>
                  <th>File</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((t) => (
                  <tr key={t.id} onClick={() => navigate(`/media/${mediaId}/item/${subItemId}/track/${t.id}`)} style={{ cursor: "pointer" }}>
                    <td>{t.trackNumber}</td>
                    <td>{t.title}</td>
                    <td>
                      {t.durationSeconds
                        ? `${Math.floor(t.durationSeconds / 60)}:${String(t.durationSeconds % 60).padStart(2, "0")}`
                        : "-"}
                    </td>
                    <td>
                      <span className={`badge ${t.hasFile ? "ok" : ""}`}>{t.hasFile ? "Downloaded" : "Missing"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
