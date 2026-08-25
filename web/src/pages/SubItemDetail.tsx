import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { MediaInfo, SearchResult, Track } from "../types.js";
import { formatMediaInfo } from "../utils/format.js";

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
  parent: { id: number; title: string; type: string } | null;
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
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const [scanningIsbn, setScanningIsbn] = useState(false);

  function load() {
    api.get<SubItemDetailResponse>(`/media/${mediaId}/subitems/${subItemId}`).then(setSubItem);
  }
  useEffect(load, [mediaId, subItemId]);

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
      alert((e as Error).message);
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

  async function runSearch() {
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      const res = await api.get<SearchResult[]>(`/search/${mediaId}?subItemId=${subItemId}`);
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
      subItemId: Number(subItemId),
    });
    alert(`Sent "${result.title}" to download client.`);
    load();
  }

  async function downloadVideo() {
    if (!subItem) return;
    try {
      await api.post(`/media/subitems/${subItem.id}/download`, {});
      alert(`Sent "${subItem.title}" to yt-dlp.`);
      load();
    } catch (e) {
      alert((e as Error).message);
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
        alert("No ISBN found in this file's first/last 15 pages (or its EPUB metadata).");
      } else if (!result.matched) {
        alert(`Found ISBN ${result.isbn}, but couldn't find a matching book on Open Library.`);
      } else {
        alert(`Found ISBN ${result.isbn} — matched and updated from Open Library.`);
        // The scan-isbn response is a bare sub_items row (no `parent`) — merge onto the existing
        // state rather than replacing it wholesale, or the breadcrumb and this very button (which
        // depends on subItem.parent.type) would disappear the instant a scan succeeds.
        if (result.subItem) setSubItem({ ...subItem, ...result.subItem, parent: subItem.parent });
      }
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setScanningIsbn(false);
    }
  }

  async function editCover() {
    if (!subItem) return;
    const url = prompt("Cover art URL (leave blank to remove):", subItem.posterUrl ?? "");
    if (url === null) return;
    try {
      const updated = await api.patch<SubItemDetailResponse>(`/media/${mediaId}/subitems/${subItemId}`, {
        posterUrl: url.trim() || null,
      });
      setSubItem({ ...subItem, posterUrl: updated.posterUrl });
    } catch (e) {
      alert((e as Error).message);
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

      <table style={{ maxWidth: 640 }}>
        <tbody>
          <tr>
            <th>Release date</th>
            <td>{subItem.releaseDate ?? "-"}</td>
          </tr>
          <tr>
            <th>Status</th>
            <td>
              <span className={`badge ${subItem.hasFile ? "ok" : ""}`}>{subItem.hasFile ? "Downloaded" : "Missing"}</span>
            </td>
          </tr>
          <tr>
            <th>Monitored</th>
            <td>{subItem.monitored ? "Yes" : "No"}</td>
          </tr>
          {subItem.quality && (
            <tr>
              <th>Quality</th>
              <td>{subItem.quality}</td>
            </tr>
          )}
          {formatMediaInfo(subItem.mediaInfo) && (
            <tr>
              <th>File info</th>
              <td>{formatMediaInfo(subItem.mediaInfo)}</td>
            </tr>
          )}
          {subItem.filePath && (
            <tr>
              <th>Path</th>
              <td style={{ wordBreak: "break-all" }}>{subItem.filePath}</td>
            </tr>
          )}
          {subItem.externalId && (
            <tr>
              <th>External ID</th>
              <td>
                {subItem.externalProvider}: {subItem.externalId}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {isAdmin && (
        <div className="toolbar" style={{ marginTop: 16 }}>
          <button className="secondary" onClick={toggleMonitored}>
            {subItem.monitored ? "Unmonitor" : "Monitor"}
          </button>
          {isYoutubeVideo ? (
            <button onClick={downloadVideo}>Download</button>
          ) : (
            <button onClick={runSearch} disabled={searching}>
              {searching ? "Searching..." : "Search"}
            </button>
          )}
          {subItem.parent?.type === "author" && subItem.hasFile && (
            <button className="secondary" onClick={scanIsbn} disabled={scanningIsbn} title="Scans the file's first and last 15 pages (PDF) or its EPUB metadata for an ISBN, then matches it via Open Library">
              {scanningIsbn ? "Scanning..." : "Scan for ISBN"}
            </button>
          )}
          <button className="secondary" onClick={() => navigate(-1)}>
            Back to {subItem.parent?.title ?? "parent"}
          </button>
        </div>
      )}

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

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

      {typeInfo?.multiFilePerChild && (
        <>
          <p style={{ color: "var(--muted)", marginTop: 16 }}>
            {tracks && (
              <>
                <span className="badge ok">{trackHave} have</span>{" "}
                <span className="badge">{tracks.length} total</span>{" "}
              </>
            )}
          </p>
          <h2>Tracks</h2>
          {loadingTracks && <p className="empty">Loading...</p>}
          {!loadingTracks && (!tracks || tracks.length === 0) && (
            <>
              <p className="empty">No track data available.</p>
              {isAdmin && subItem.externalId && (
                <button className="secondary" onClick={fetchTracks}>
                  Fetch tracks
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
