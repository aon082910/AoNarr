import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
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

export default function EpisodeDetail() {
  const { mediaId, episodeId } = useParams<{ mediaId: string; episodeId: string }>();
  const navigate = useNavigate();
  const { auth } = useAuth();
  const isAdmin = auth.isAdmin;

  const [episode, setEpisode] = useState<EpisodeDetailResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [browsePath, setBrowsePath] = useState("");
  const [browseEntries, setBrowseEntries] = useState<BrowseEntry[]>([]);
  const [importingPath, setImportingPath] = useState<string | null>(null);

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

  async function browse(nextPath: string) {
    const res = await api.get<{ path: string; entries: BrowseEntry[] }>(`/import/browse?path=${encodeURIComponent(nextPath)}`);
    setBrowsePath(res.path);
    setBrowseEntries(res.entries);
  }

  function toggleImport() {
    const next = !showImport;
    setShowImport(next);
    if (next) browse("");
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
            <td>{episode.monitored ? "Yes" : "No"}</td>
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
            {showImport ? "Hide manual import" : "Manual Import"}
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
        <>
          <h2>Manual Import</h2>
          <div className="form-panel">
            <p style={{ color: "var(--muted)", fontSize: "0.82rem", marginTop: 0 }}>
              Browsing downloads: /{browsePath || ""}
            </p>
            {browsePath && (
              <button type="button" className="secondary" onClick={() => browse(browsePath.split("/").slice(0, -1).join("/"))}>
                Up
              </button>
            )}
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {browseEntries.map((e) => (
                  <tr key={e.path}>
                    <td>{e.isDirectory ? "📁 " : ""}{e.name}</td>
                    <td>{e.size ? `${(e.size / 1e6).toFixed(1)} MB` : "-"}</td>
                    <td>
                      {e.isDirectory && (
                        <button type="button" className="secondary" onClick={() => browse(e.path)}>
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
                    <td colSpan={3} className="empty">
                      Empty.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {results && (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Title</th>
              <th>Size</th>
              <th>Seeders</th>
              <th>Quality</th>
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
            {results.map((r, i) => (
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
      )}
    </div>
  );
}
