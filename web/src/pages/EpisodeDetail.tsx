import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";
import MonitorToggle from "../components/MonitorToggle.js";
import { useAuth } from "../context/AuthContext.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import type { MediaInfo, SearchResult } from "../types.js";
import { formatMediaInfo } from "../utils/format.js";
import { SearchIcon, InboxIcon, AlertTriangleIcon, DownloadIcon, CpuIcon, CalendarIcon, LayersIcon, HardDriveIcon } from "../components/NavIcons.js";
import { ArrowLeftIcon, ArrowUpIcon, FolderIcon } from "../components/ActionIcons.js";
import { PageToolbar, ToolbarButton, ToolbarSeparator } from "../components/PageToolbar.js";
import { notify } from "../utils/notify.js";
import { confirmDialog } from "../utils/confirmDialog.js";

interface EpisodeDetailResponse {
  id: number;
  mediaItemId: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDate: string | null;
  overview: string | null;
  monitored: 0 | 1;
  hasFile: 0 | 1;
  quality: string | null;
  filePath: string | null;
  mediaInfo: MediaInfo | null;
  parent: { id: number; title: string; type: string } | null;
}

interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isMediaFile: boolean;
  size: number | null;
}

interface BrowseResponse {
  path: string;
  anyFolder?: boolean;
  parent?: string | null;
  entries: BrowseEntry[];
}

export default function EpisodeDetail() {
  const { mediaId, episodeId } = useParams<{ mediaId: string; episodeId: string }>();
  const navigate = useNavigate();
  const { auth } = useAuth();
  const isAdmin = auth.isAdmin;

  const [episode, setEpisode] = useState<EpisodeDetailResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const { sortRows: sortSearchResults, sortableHeader: searchResultHeader } = useSortableTable<SearchResult, "title" | "size" | "seeders" | "quality">(
    "seeders",
    "desc"
  );
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [browsePath, setBrowsePath] = useState("");
  const [browseAnyFolder, setBrowseAnyFolder] = useState(false);
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [customFolderInput, setCustomFolderInput] = useState("");
  const [browseEntries, setBrowseEntries] = useState<BrowseEntry[]>([]);
  const [importingPath, setImportingPath] = useState<string | null>(null);
  const [aiGuesses, setAiGuesses] = useState<Record<string, string>>({});
  const [aiIdentifying, setAiIdentifying] = useState<string | null>(null);

  // Navigating between episodes (Prev/Next, or browser Back/Forward) reuses this mounted component
  // — without a request-ordering guard, a slower response for a previous episode could land after a
  // newer one and overwrite it. The search-results and manual-import-browse panels aren't blocking
  // overlays here either, so they also need to reset on id change, or a stale result/file list
  // stays visible (and grabbable/importable) against whatever episode is now showing. load() reads
  // the ids from a ref so a reload issued after a slow import/grab fetches the episode on screen
  // now, not the one its click-time closure captured.
  const loadRequestRef = useRef(0);
  const idsRef = useRef({ mediaId, episodeId });
  idsRef.current = { mediaId, episodeId };
  const [loadError, setLoadError] = useState<string | null>(null);
  function load() {
    const requestId = ++loadRequestRef.current;
    setEpisode(null);
    setLoadError(null);
    api.get<EpisodeDetailResponse>(`/media/${idsRef.current.mediaId}/episodes/${idsRef.current.episodeId}`).then(
      (data) => {
        if (loadRequestRef.current === requestId) setEpisode(data);
      },
      (e) => {
        if (loadRequestRef.current === requestId) setLoadError((e as Error).message);
      }
    );
  }
  /** Applies a post-await update only while that same episode is still the one on screen. */
  function patchEpisode(id: number, update: (prev: EpisodeDetailResponse) => EpisodeDetailResponse) {
    setEpisode((prev) => (prev && prev.id === id ? update(prev) : prev));
  }
  useEffect(load, [mediaId, episodeId]);
  useEffect(() => {
    setResults(null);
    setError(null);
    setSearching(false);
    setShowImport(false);
    setBrowseEntries([]);
    setBrowsePath("");
    setBrowseAnyFolder(false);
    setBrowseParent(null);
    setCustomFolderInput("");
    setAiGuesses({});
  }, [mediaId, episodeId]);

  async function toggleMonitored() {
    if (!episode) return;
    try {
      const updated = await api.patch<EpisodeDetailResponse>(`/media/${mediaId}/episodes/${episodeId}`, {
        monitored: episode.monitored ? 0 : 1,
      });
      patchEpisode(episode.id, (prev) => ({ ...prev, monitored: updated.monitored }));
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function markAsMissing() {
    if (!episode) return;
    if (
      !(await confirmDialog({
        title: "Mark as missing",
        message: "Mark this episode as missing? Only do this if you already removed the file from disk yourself — this just resets AoNarr's own record so it gets searched for again; it doesn't touch any file.",
      }))
    )
      return;
    const updated = await api.patch<EpisodeDetailResponse>(`/media/${mediaId}/episodes/${episodeId}`, {
      hasFile: 0,
      filePath: null,
      quality: null,
    });
    patchEpisode(episode.id, (prev) => ({ ...prev, hasFile: updated.hasFile, filePath: updated.filePath, quality: updated.quality }));
  }

  async function browse(nextPath: string, anyFolderOverride?: boolean) {
    const anyFolder = anyFolderOverride ?? browseAnyFolder;
    const res = await api.get<BrowseResponse>(
      `/import/browse?path=${encodeURIComponent(nextPath)}${anyFolder ? "&anyFolder=1" : ""}`
    );
    setBrowsePath(res.path);
    setBrowseAnyFolder(!!res.anyFolder);
    setBrowseParent(res.parent ?? null);
    setBrowseEntries(res.entries);
  }

  function toggleImport() {
    const next = !showImport;
    setShowImport(next);
    if (next) browse("", false);
  }

  function goToCustomFolder() {
    if (!customFolderInput.trim()) return;
    browse(customFolderInput.trim(), true);
  }

  function backToDownloads() {
    setCustomFolderInput("");
    browse("", false);
  }

  async function manualImport(entry: BrowseEntry) {
    setImportingPath(entry.path);
    try {
      await api.post("/import/manual", { mediaItemId: episode?.mediaItemId, episodeId: Number(episodeId), sourcePath: entry.path });
      notify.success(`Imported ${entry.name}`);
      setShowImport(false);
      load();
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setImportingPath(null);
    }
  }

  /** Same reasoning as MediaDetail.tsx's own aiIdentifyFile — a text suggestion for a human to
   * read, never an automatic match. */
  async function aiIdentifyFile(entry: BrowseEntry) {
    setAiIdentifying(entry.path);
    try {
      const result = await api.post<{ guess: string; usedFrame: boolean; usedTags: boolean }>("/import/ai-identify", {
        sourcePath: entry.path,
        mediaType: episode?.parent?.type ?? "series",
      });
      const source = result.usedFrame ? " (from a video frame)" : result.usedTags ? " (from embedded tags)" : "";
      setAiGuesses((prev) => ({ ...prev, [entry.path]: `${result.guess}${source}` }));
    } catch (e) {
      setAiGuesses((prev) => ({ ...prev, [entry.path]: `Error: ${(e as Error).message}` }));
    } finally {
      setAiIdentifying(null);
    }
  }

  const searchRequestRef = useRef(0);
  async function runSearch() {
    const requestId = ++searchRequestRef.current;
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      const res = await api.get<SearchResult[]>(`/search/${mediaId}?episodeId=${episodeId}`);
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
        episodeId: Number(episodeId),
      });
      notify.success(`Sent "${result.title}" to download client.`);
      load();
    } catch (e) {
      notify.error(`Grab failed: ${(e as Error).message}`);
    }
  }

  if (!episode) return <p className="empty">{loadError ?? "Loading..."}</p>;

  const label = `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`;

  return (
    <div>
      {episode.parent && (
        <p style={{ color: "var(--muted)" }}>
          <Link to={`/media/${episode.parent.id}`}>{episode.parent.title}</Link> / Season {episode.seasonNumber}
        </p>
      )}
      <h1>
        {label} {episode.title ?? <span style={{ color: "var(--muted)", fontStyle: "italic" }}>Episode {episode.episodeNumber}</span>}
      </h1>

      {isAdmin && (
        <PageToolbar
          left={
            <>
              <ToolbarButton
                icon={<SearchIcon />}
                label={searching ? "Searching..." : "Search"}
                onClick={runSearch}
                disabled={searching}
                title={searching ? "Searching..." : "Search"}
              />
              <ToolbarButton icon={<InboxIcon />} label="Manual Import" onClick={toggleImport} title="Manual Import" />
              {!!episode.hasFile && (
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
              <ToolbarButton icon={<ArrowLeftIcon />} label="Back" onClick={() => navigate(-1)} title="Back to show" />
            </>
          }
        />
      )}

      <div className="detail-pills">
        <span className="pill">
          <MonitorToggle monitored={!!episode.monitored} onToggle={toggleMonitored} readOnly={!isAdmin} />
          {episode.monitored ? "Monitored" : "Unmonitored"}
        </span>
        <span className="pill">
          <CalendarIcon />
          {episode.airDate ?? "Unknown air date"}
        </span>
        <span className={`badge ${episode.hasFile ? "ok" : ""}`}>{episode.hasFile ? "Downloaded" : "Missing"}</span>
        {episode.quality && (
          <span className="pill">
            <LayersIcon />
            {episode.quality}
          </span>
        )}
        {formatMediaInfo(episode.mediaInfo) && (
          <span className="pill">
            <HardDriveIcon />
            {formatMediaInfo(episode.mediaInfo)}
          </span>
        )}
        {episode.filePath && (
          <span className="pill" style={{ whiteSpace: "normal", wordBreak: "break-all" }}>
            <FolderIcon />
            {episode.filePath}
          </span>
        )}
      </div>

      {episode.overview && (
        <>
          <h2>Overview</h2>
          <p>{episode.overview}</p>
        </>
      )}

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {showImport && (
        <Modal title="Manual Import" onClose={() => setShowImport(false)} maxWidth={720}>
          <p style={{ color: "var(--muted)", fontSize: "0.82rem", marginTop: 0, marginBottom: 4 }}>
            Browsing {browseAnyFolder ? browsePath : `downloads: /${browsePath || ""}`}
          </p>
          <div className="toolbar" style={{ marginBottom: 8, gap: 8 }}>
            {browseAnyFolder ? (
              <button type="button" className="icon-button" onClick={backToDownloads} title="Back to downloads folder" aria-label="Back to downloads folder">
                <ArrowLeftIcon />
              </button>
            ) : (
              <>
                <input
                  value={customFolderInput}
                  onChange={(e) => setCustomFolderInput(e.target.value)}
                  placeholder="/path/to/any/folder"
                  style={{ flex: 1, minWidth: 200 }}
                />
                <button type="button" className="icon-button" onClick={goToCustomFolder} disabled={!customFolderInput.trim()} title="Browse this folder" aria-label="Browse this folder">
                  <FolderIcon />
                </button>
              </>
            )}
            {(browseAnyFolder ? browseParent != null : !!browsePath) && (
              <button
                type="button"
                className="icon-button"
                onClick={() => (browseAnyFolder ? browse(browseParent ?? "/", true) : browse(browsePath.split("/").slice(0, -1).join("/")))}
                title="Up one folder"
                aria-label="Up one folder"
              >
                <ArrowUpIcon />
              </button>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>AI identify</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {browseEntries.map((e) => (
                <tr key={e.path}>
                  <td>{e.isDirectory ? "📁 " : ""}{e.name}</td>
                  <td>{e.size ? `${(e.size / 1e6).toFixed(1)} MB` : "-"}</td>
                  <td style={{ maxWidth: 200 }}>
                    {e.isMediaFile && (
                      <>
                        <button
                          type="button"
                          className="icon-button"
                          disabled={aiIdentifying === e.path}
                          onClick={() => aiIdentifyFile(e)}
                          title={aiIdentifying === e.path ? "Asking..." : "AI Identify — grab a frame (video) or read embedded tags (audio) and ask the configured AI provider what this is"}
                          aria-label="AI Identify"
                        >
                          <CpuIcon />
                        </button>
                        {aiGuesses[e.path] && (
                          <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 4, wordBreak: "break-word" }}>
                            {aiGuesses[e.path]}
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    {e.isDirectory && (
                      <button type="button" className="icon-button" onClick={() => browse(e.path, browseAnyFolder)} title="Open" aria-label="Open folder">
                        <FolderIcon />
                      </button>
                    )}
                    {e.isMediaFile && (
                      <button type="button" className="icon-button" onClick={() => manualImport(e)} disabled={importingPath === e.path} title={importingPath === e.path ? "Importing..." : "Import"} aria-label="Import">
                        <InboxIcon />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {browseEntries.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    Empty.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Modal>
      )}

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
    </div>
  );
}
