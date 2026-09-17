import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";
import MonitorToggle from "../components/MonitorToggle.js";
import { useAuth } from "../context/AuthContext.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import type { MediaInfo, SearchResult } from "../types.js";
import { formatMediaInfo } from "../utils/format.js";

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

  function load() {
    api.get<EpisodeDetailResponse>(`/media/${mediaId}/episodes/${episodeId}`).then(setEpisode);
  }
  useEffect(load, [mediaId, episodeId]);

  async function toggleMonitored() {
    if (!episode) return;
    const updated = await api.patch<EpisodeDetailResponse>(`/media/${mediaId}/episodes/${episodeId}`, {
      monitored: episode.monitored ? 0 : 1,
    });
    setEpisode({ ...episode, monitored: updated.monitored });
  }

  async function markAsMissing() {
    if (!episode) return;
    if (
      !confirm(
        "Mark this episode as missing? Only do this if you already removed the file from disk yourself — this just resets AoNarr's own record so it gets searched for again; it doesn't touch any file."
      )
    )
      return;
    const updated = await api.patch<EpisodeDetailResponse>(`/media/${mediaId}/episodes/${episodeId}`, {
      hasFile: 0,
      filePath: null,
      quality: null,
    });
    setEpisode({ ...episode, hasFile: updated.hasFile, filePath: updated.filePath, quality: updated.quality });
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
      alert(`Imported ${entry.name}`);
      setShowImport(false);
      load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setImportingPath(null);
    }
  }

  /** Same reasoning as MediaDetail.tsx's own aiIdentifyFile — a text suggestion for a human to
   * read, never an automatic match. */
  async function aiIdentifyFile(entry: BrowseEntry) {
    setAiIdentifying(entry.path);
    try {
      const result = await api.post<{ guess: string }>("/import/ai-identify", { sourcePath: entry.path, mediaType: episode?.parent?.type ?? "series" });
      setAiGuesses((prev) => ({ ...prev, [entry.path]: result.guess }));
    } catch (e) {
      setAiGuesses((prev) => ({ ...prev, [entry.path]: `Error: ${(e as Error).message}` }));
    } finally {
      setAiIdentifying(null);
    }
  }

  async function runSearch() {
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      const res = await api.get<SearchResult[]>(`/search/${mediaId}?episodeId=${episodeId}`);
      setResults(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }

  async function grab(result: SearchResult) {
    const clients = await api.get<{ id: number }[]>("/download-clients");
    if (clients.length === 0) {
      alert("Add a download client first.");
      return;
    }
    await api.post(`/search/${mediaId}/grab`, {
      downloadUrl: result.downloadUrl,
      indexerId: result.indexerId,
      title: result.title,
      size: result.size,
      downloadClientId: clients[0].id,
      episodeId: Number(episodeId),
    });
    alert(`Sent "${result.title}" to download client.`);
    load();
  }

  if (!episode) return <p className="empty">Loading...</p>;

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

      <table style={{ maxWidth: 640 }}>
        <tbody>
          <tr>
            <th>Air date</th>
            <td>{episode.airDate ?? "-"}</td>
          </tr>
          <tr>
            <th>Status</th>
            <td>
              <span className={`badge ${episode.hasFile ? "ok" : ""}`}>{episode.hasFile ? "Downloaded" : "Missing"}</span>
            </td>
          </tr>
          <tr>
            <th>Monitored</th>
            <td>
              <MonitorToggle monitored={!!episode.monitored} onToggle={toggleMonitored} />
            </td>
          </tr>
          {episode.quality && (
            <tr>
              <th>Quality</th>
              <td>{episode.quality}</td>
            </tr>
          )}
          {formatMediaInfo(episode.mediaInfo) && (
            <tr>
              <th>File info</th>
              <td>{formatMediaInfo(episode.mediaInfo)}</td>
            </tr>
          )}
          {episode.filePath && (
            <tr>
              <th>Path</th>
              <td style={{ wordBreak: "break-all" }}>{episode.filePath}</td>
            </tr>
          )}
        </tbody>
      </table>

      {episode.overview && (
        <>
          <h2>Overview</h2>
          <p>{episode.overview}</p>
        </>
      )}

      {isAdmin && (
        <div className="toolbar" style={{ marginTop: 16 }}>
          <button className="secondary" onClick={toggleMonitored}>
            {episode.monitored ? "Unmonitor" : "Monitor"}
          </button>
          <button onClick={runSearch} disabled={searching}>
            {searching ? "Searching..." : "Search"}
          </button>
          <button className="secondary" onClick={toggleImport}>
            Manual Import
          </button>
          {!!episode.hasFile && (
            <button className="danger" onClick={markAsMissing} title="Removed the file yourself? This resets AoNarr's record so it searches for it again.">
              Mark as missing
            </button>
          )}
          <button className="secondary" onClick={() => navigate(-1)}>
            Back to show
          </button>
        </div>
      )}

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {showImport && (
        <Modal title="Manual Import" onClose={() => setShowImport(false)} maxWidth={720}>
          <p style={{ color: "var(--muted)", fontSize: "0.82rem", marginTop: 0, marginBottom: 4 }}>
            Browsing {browseAnyFolder ? browsePath : `downloads: /${browsePath || ""}`}
          </p>
          <div className="toolbar" style={{ marginBottom: 8, gap: 8 }}>
            {browseAnyFolder ? (
              <button type="button" className="secondary" onClick={backToDownloads}>
                Back to downloads folder
              </button>
            ) : (
              <>
                <input
                  value={customFolderInput}
                  onChange={(e) => setCustomFolderInput(e.target.value)}
                  placeholder="/path/to/any/folder"
                  style={{ flex: 1, minWidth: 200 }}
                />
                <button type="button" className="secondary" onClick={goToCustomFolder} disabled={!customFolderInput.trim()}>
                  Browse this folder
                </button>
              </>
            )}
            {(browseAnyFolder ? browseParent != null : !!browsePath) && (
              <button
                type="button"
                className="secondary"
                onClick={() => (browseAnyFolder ? browse(browseParent ?? "/", true) : browse(browsePath.split("/").slice(0, -1).join("/")))}
              >
                Up
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
                          className="secondary"
                          disabled={aiIdentifying === e.path}
                          onClick={() => aiIdentifyFile(e)}
                          title="Grab a frame (video) or read embedded tags (audio) and ask the configured AI provider what this is"
                        >
                          {aiIdentifying === e.path ? "Asking..." : "🤖 Identify"}
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
                      <button type="button" className="secondary" onClick={() => browse(e.path, browseAnyFolder)}>
                        Open
                      </button>
                    )}
                    {e.isMediaFile && (
                      <button onClick={() => manualImport(e)} disabled={importingPath === e.path}>
                        {importingPath === e.path ? "Importing..." : "Import"}
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
                    <button className="secondary" onClick={() => grab(r)}>
                      Grab
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
