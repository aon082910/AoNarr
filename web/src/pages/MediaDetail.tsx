import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, downloadFile } from "../api/client.js";
import GroupPicker from "../components/GroupPicker.js";
import SearchMatchModal, { type MetadataSearchResult } from "../components/SearchMatchModal.js";
import type { LibraryGroup } from "../types.js";
import { useAuth } from "../context/AuthContext.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { Collection, MediaInfo, MediaItem, QualityProfile, RootFolder, SearchResult, Tag } from "../types.js";
import { formatMediaInfo } from "../utils/format.js";
import { useContentRatings } from "../hooks/useContentRatings.js";

/** Maps a recognized external-id provider key to a link builder — unrecognized providers still
 * show as plain text, this is just a convenience for the common ones. */
const EXTERNAL_ID_LINKS: Record<string, (id: string, type: string) => string> = {
  tmdb: (id, type) => `https://www.themoviedb.org/${type === "series" || type === "anime" ? "tv" : "movie"}/${id}`,
  imdb: (id) => `https://www.imdb.com/title/${id}/`,
  tvdb: (id) => `https://thetvdb.com/?id=${id}&tab=series`,
  tvmaze: (id) => `https://www.tvmaze.com/shows/${id}`,
  anilist: (id) => `https://anilist.co/anime/${id}`,
  musicbrainz: (id) => `https://musicbrainz.org/artist/${id}`,
  discogs: (id) => `https://www.discogs.com/artist/${id}`,
  openlibrary: (id) => `https://openlibrary.org${id.startsWith("/") ? id : `/${id}`}`,
  comicvine: (id) => `https://comicvine.gamespot.com/-/${id}/`,
  igdb: (id) => `https://www.igdb.com/games/${id}`,
  trakt: (id, type) => `https://trakt.tv/${type === "series" || type === "anime" ? "shows" : "movies"}/${id}`,
};

interface CastMember {
  personId: number;
  name: string;
  character: string | null;
  photoUrl: string | null;
}

export interface Episode {
  id: number;
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
}

interface SubItem {
  id: number;
  title: string;
  releaseDate: string | null;
  externalId: string | null;
  externalProvider: string | null;
  monitored: 0 | 1;
  hasFile: 0 | 1;
  quality: string | null;
  mediaInfo: MediaInfo | null;
  posterUrl: string | null;
}

type MediaDetailResponse = MediaItem & { children: Episode[] | SubItem[]; tags: Tag[] };

type SearchTarget = { episodeId?: number; subItemId?: number; seasonNumber?: number; label: string } | null;

interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isMediaFile: boolean;
  size: number | null;
}

interface ArtworkOptions {
  posters: string[];
  backgrounds: string[];
  logos: string[];
}

export default function MediaDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { auth } = useAuth();
  const isAdmin = auth.isAdmin;
  const mediaTypes = useMediaTypes();
  const contentRatings = useContentRatings();
  const [item, setItem] = useState<MediaDetailResponse | null>(null);
  const [target, setTarget] = useState<SearchTarget>(null);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showImport, setShowImport] = useState(false);
  const [browsePath, setBrowsePath] = useState("");
  const [showMove, setShowMove] = useState(false);
  const [openSeasons, setOpenSeasons] = useState<Set<number>>(new Set());
  const [seededSeasons, setSeededSeasons] = useState(false);
  const [groupBreadcrumb, setGroupBreadcrumb] = useState<string | null>(null);
  const [pendingGroupId, setPendingGroupId] = useState<number | null>(null);
  const [metadataProviders, setMetadataProviders] = useState<Record<string, string[]>>({});
  const [fetchingProvider, setFetchingProvider] = useState<string | null>(null);
  // Which source ("current" or a provider key) is picked per field in the metadata-merge table —
  // reset whenever a fresh provider is fetched, so a stale pick from a previous item/session
  // doesn't silently carry over to a different field's actual source list.
  const [mergeChoice, setMergeChoice] = useState<{ title: string; year: string; overview: string; posterUrl: string }>({
    title: "current",
    year: "current",
    overview: "current",
    posterUrl: "current",
  });
  const [applyingMerge, setApplyingMerge] = useState(false);
  const [browseEntries, setBrowseEntries] = useState<BrowseEntry[]>([]);
  const [importEpisodeId, setImportEpisodeId] = useState<number | "">("");
  const [importSubItemId, setImportSubItemId] = useState<number | "">("");

  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [rootFolders, setRootFolders] = useState<RootFolder[]>([]);
  const [qualityProfiles, setQualityProfiles] = useState<QualityProfile[]>([]);
  const [externalUrl, setExternalUrl] = useState("");
  const [tagToAdd, setTagToAdd] = useState<number | "">("");

  const [showArtwork, setShowArtwork] = useState(false);
  const [artworkOptions, setArtworkOptions] = useState<ArtworkOptions | null>(null);
  const [loadingArtwork, setLoadingArtwork] = useState(false);
  const [artworkError, setArtworkError] = useState<string | null>(null);

  const [allCollections, setAllCollections] = useState<Collection[]>([]);
  const [collectionToAdd, setCollectionToAdd] = useState<number | "">("");

  const [cast, setCast] = useState<CastMember[] | null>(null);
  const [trailerUrl, setTrailerUrl] = useState<string | null>(null);
  const [watched, setWatched] = useState(false);
  const [watchStateError, setWatchStateError] = useState<string | null>(null);
  const [showSearchMatch, setShowSearchMatch] = useState(false);

  function load() {
    api.get<MediaDetailResponse>(`/media/${id}`).then(setItem);
  }

  useEffect(load, [id]);
  useEffect(() => {
    api
      .get<{ watched: boolean }>(`/media/${id}/watch-state`)
      .then((r) => setWatched(r.watched))
      .catch(() => setWatched(false));
  }, [id]);
  useEffect(() => {
    setCast(null);
    api
      .get<CastMember[]>(`/media/${id}/cast`)
      .then(setCast)
      .catch(() => setCast([]));
  }, [id]);
  useEffect(() => {
    setTrailerUrl(null);
    api
      .get<{ url: string | null }>(`/media/${id}/trailer`)
      .then((r) => setTrailerUrl(r.url))
      .catch(() => setTrailerUrl(null));
  }, [id]);
  useEffect(() => {
    if (isAdmin) api.get<Tag[]>("/tags").then(setAllTags);
    if (isAdmin) api.get<Record<string, string[]>>("/metadata/providers").then(setMetadataProviders);
    if (isAdmin) api.get<RootFolder[]>("/root-folders").then(setRootFolders);
    if (isAdmin) api.get<QualityProfile[]>("/quality-profiles").then(setQualityProfiles);
    if (isAdmin) api.get<Record<string, string>>("/settings").then((s) => setExternalUrl(s.externalUrl ?? ""));
    api.get<Collection[]>("/collections").then(setAllCollections);
  }, [isAdmin]);

  useEffect(() => {
    if (!item?.groupId) {
      setGroupBreadcrumb(null);
      return;
    }
    api
      .get<{ breadcrumb: LibraryGroup[] }>(`/library-groups/${item.groupId}`)
      .then((detail) => setGroupBreadcrumb(detail.breadcrumb.map((g) => g.name).join(" / ")));
  }, [item?.groupId]);

  async function addToCollection() {
    if (!item || !collectionToAdd) return;
    await api.post(`/collections/${collectionToAdd}/items`, { mediaItemId: item.id });
    setCollectionToAdd("");
    alert("Added to collection.");
  }

  async function addTagToItem() {
    if (!item || !tagToAdd) return;
    const updatedTags = await api.post<Tag[]>(`/media/${item.id}/tags`, { tagId: tagToAdd });
    setItem({ ...item, tags: updatedTags });
    setTagToAdd("");
  }

  async function removeTagFromItem(tagId: number) {
    if (!item) return;
    await api.del(`/media/${item.id}/tags/${tagId}`);
    setItem({ ...item, tags: item.tags.filter((t) => t.id !== tagId) });
  }

  async function toggleMonitored() {
    if (!item) return;
    const updated = await api.patch<MediaItem>(`/media/${item.id}`, { monitored: item.monitored ? 0 : 1 });
    setItem({ ...item, monitored: updated.monitored });
  }

  async function toggleProtected() {
    if (!item) return;
    const updated = await api.patch<MediaItem>(`/media/${item.id}`, { protected: item.protected ? 0 : 1 });
    setItem({ ...item, protected: updated.protected });
  }

  async function applyRematch(result: MetadataSearchResult) {
    if (!item) return;
    const updated = await api.post<MediaItem>(`/media/${item.id}/rematch`, {
      title: result.title,
      year: result.year,
      overview: result.overview,
      posterUrl: result.posterUrl,
      externalIds: result.externalIds,
      releaseDate: result.releaseDate,
    });
    setItem({ ...item, title: updated.title, year: updated.year, overview: updated.overview, posterUrl: updated.posterUrl, externalIds: updated.externalIds });
    setShowSearchMatch(false);
  }

  async function toggleWatched() {
    if (!item) return;
    setWatchStateError(null);
    const next = !watched;
    const result = await api.patch<{ watched: boolean; mediaServerError: string | null }>(`/media/${item.id}/watch-state`, {
      watched: next,
    });
    setWatched(result.watched);
    if (result.mediaServerError) setWatchStateError(`Marked in AoNarr, but couldn't update the media server: ${result.mediaServerError}`);
  }

  async function updateContentRating(rating: string | null) {
    if (!item) return;
    const updated = await api.patch<MediaItem>(`/media/${item.id}`, { contentRating: rating });
    setItem({ ...item, contentRating: updated.contentRating });
  }

  async function checkCorrupt() {
    if (!item) return;
    const result = await api.post<{ corrupt: boolean; checked: boolean; reason?: string }>(`/media/${item.id}/check-corrupt`, {});
    if (!result.checked) {
      alert(result.reason ?? "Nothing to check.");
    } else if (result.corrupt) {
      alert("This file failed validation and was moved to the Recycle Bin. Marked missing — it'll be picked up by auto-search again.");
      load();
    } else {
      alert("File looks fine.");
    }
  }

  async function remove() {
    if (!item) return;
    const deleteFiles = confirm(
      `Remove "${item.title}" from AoNarr AND move its file(s) to the Recycle Bin?\n\nCancel, then OK on the next prompt, to untrack only and leave files on disk.`
    );
    if (!deleteFiles && !confirm(`Remove "${item.title}" from AoNarr? This leaves files on disk untouched.`)) return;
    await api.del(`/media/${item.id}${deleteFiles ? "?deleteFiles=1" : ""}`);
    navigate("/");
  }

  async function fetchSupplemental(provider: string) {
    if (!item) return;
    setFetchingProvider(provider);
    try {
      const updated = await api.post<MediaDetailResponse>(`/media/${item.id}/metadata/fetch`, { provider });
      setItem({ ...item, extraMetadata: updated.extraMetadata });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setFetchingProvider(null);
    }
  }

  /** Resolves one merge-table field's currently-picked source ("current" or a provider key) to
   * its actual value, falling back to the item's own value if the picked provider's fetch doesn't
   * have that field populated (e.g. a provider fetched before this field existed in extraMetadata). */
  function mergedValue<K extends "title" | "year" | "overview" | "posterUrl">(item: MediaDetailResponse, field: K, choice: string) {
    if (choice === "current") return item[field];
    const provided = item.extraMetadata[choice]?.[field];
    return provided ?? item[field];
  }

  async function applyMerge() {
    if (!item) return;
    setApplyingMerge(true);
    try {
      const payload = {
        title: mergedValue(item, "title", mergeChoice.title),
        year: mergedValue(item, "year", mergeChoice.year),
        overview: mergedValue(item, "overview", mergeChoice.overview),
        posterUrl: mergedValue(item, "posterUrl", mergeChoice.posterUrl),
      };
      await api.patch(`/media/${item.id}`, payload);
      setItem({ ...item, ...payload });
      setMergeChoice({ title: "current", year: "current", overview: "current", posterUrl: "current" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApplyingMerge(false);
    }
  }

  async function saveGroup() {
    if (!item || !pendingGroupId) return;
    const updated = await api.patch<{ groupId: number | null }>(`/media/${item.id}`, { groupId: pendingGroupId });
    setItem({ ...item, groupId: updated.groupId });
    setShowMove(false);
  }

  useEffect(() => {
    if (seededSeasons || !item || item.type === "movie") return;
    const episodes = item.children as Episode[] | undefined;
    if (!episodes || episodes.length === 0) return;
    setOpenSeasons(new Set(episodes.map((ep) => ep.seasonNumber)));
    setSeededSeasons(true);
  }, [item, seededSeasons]);

  function toggleSeasonOpen(seasonNumber: number) {
    setOpenSeasons((prev) => {
      const next = new Set(prev);
      if (next.has(seasonNumber)) next.delete(seasonNumber);
      else next.add(seasonNumber);
      return next;
    });
  }

  async function toggleSeasonMonitor(seasonNumber: number, monitored: boolean) {
    if (!item) return;
    const updated = await api.patch<Episode[]>(`/media/${item.id}/season/${seasonNumber}/monitor`, { monitored });
    setItem({
      ...item,
      children: (item.children as Episode[]).map((ep) => {
        const replacement = updated.find((u) => u.id === ep.id);
        return replacement ?? ep;
      }),
    });
  }

  async function runSearch(t: SearchTarget) {
    setTarget(t);
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      const params = new URLSearchParams();
      if (t?.episodeId) params.set("episodeId", String(t.episodeId));
      else if (t?.seasonNumber) params.set("seasonNumber", String(t.seasonNumber));
      if (t?.subItemId) params.set("subItemId", String(t.subItemId));
      const qs = params.toString();
      const res = await api.get<SearchResult[]>(`/search/${id}${qs ? `?${qs}` : ""}`);
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
    await api.post(`/search/${id}/grab`, {
      downloadUrl: result.downloadUrl,
      indexerId: result.indexerId,
      title: result.title,
      size: result.size,
      downloadClientId: clients[0].id,
      episodeId: target?.episodeId ?? null,
      subItemId: target?.subItemId ?? null,
      seasonNumber: target?.episodeId ? null : target?.seasonNumber ?? null,
    });
    alert(`Sent "${result.title}" to download client.`);
    load();
  }

  async function downloadVideo(sub: SubItem) {
    try {
      await api.post(`/media/subitems/${sub.id}/download`, {});
      alert(`Sent "${sub.title}" to yt-dlp.`);
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function editSubItemCover(sub: SubItem) {
    if (!item) return;
    const url = prompt(`Cover art URL for "${sub.title}" (leave blank to remove):`, sub.posterUrl ?? "");
    if (url === null) return;
    try {
      await api.patch(`/media/${item.id}/subitems/${sub.id}`, { posterUrl: url.trim() || null });
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function blocklistResult(result: SearchResult) {
    if (!item) return;
    if (!confirm(`Blocklist "${result.title}"? It will never be auto-grabbed or shown as grabbable again for this item.`)) return;
    await api.post("/blocklist", { mediaItemId: item.id, releaseTitle: result.title, indexerId: result.indexerId });
    setResults((prev) => prev && prev.map((r) => (r.title === result.title ? { ...r, blocklisted: true } : r)));
  }

  async function toggleArtwork() {
    if (!item) return;
    const next = !showArtwork;
    setShowArtwork(next);
    if (!next) return;
    setLoadingArtwork(true);
    setArtworkError(null);
    try {
      const options = await api.get<ArtworkOptions>(`/media/${item.id}/artwork`);
      setArtworkOptions(options);
    } catch (e) {
      setArtworkError((e as Error).message);
    } finally {
      setLoadingArtwork(false);
    }
  }

  async function selectArtwork(posterUrl: string) {
    if (!item) return;
    const updated = await api.post<MediaItem>(`/media/${item.id}/artwork/select`, { posterUrl });
    setItem({ ...item, posterUrl: updated.posterUrl });
    setShowArtwork(false);
  }

  async function browse(nextPath: string) {
    const res = await api.get<{ path: string; entries: BrowseEntry[] }>(
      `/import/browse?path=${encodeURIComponent(nextPath)}`
    );
    setBrowsePath(res.path);
    setBrowseEntries(res.entries);
  }

  function toggleImport() {
    const next = !showImport;
    setShowImport(next);
    if (next) browse("");
  }

  async function manualImport(entry: BrowseEntry) {
    if (!item) return;
    try {
      const typeInfo = mediaTypes.find((t) => t.key === item.type);
      await api.post("/import/manual", {
        mediaItemId: item.id,
        episodeId: typeInfo?.shape === "episodic" ? importEpisodeId || null : null,
        subItemId: typeInfo?.shape === "collection" ? importSubItemId || null : null,
        sourcePath: entry.path,
      });
      alert(`Imported ${entry.name}`);
      setShowImport(false);
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  if (!item) return <p className="empty">Loading...</p>;

  const typeInfo = mediaTypes.find((t) => t.key === item.type);
  const shape = typeInfo?.shape;
  const childLabel = typeInfo?.childLabel ?? "Item";

  const rootFolder = rootFolders.find((f) => f.id === item.rootFolderId);
  const qualityProfile = qualityProfiles.find((p) => p.id === item.qualityProfileId);
  let externalIds: Record<string, string> = {};
  try {
    externalIds = item.externalIds ? JSON.parse(item.externalIds) : {};
  } catch {
    // malformed external_ids on an old row — just don't show links rather than crash the page
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
        {item.posterUrl ? (
          <img
            src={item.posterUrl}
            alt=""
            style={{ width: 160, borderRadius: 8, flexShrink: 0, aspectRatio: "2 / 3", objectFit: "cover" }}
          />
        ) : (
          <div className="poster" style={{ width: 160, flexShrink: 0, borderRadius: 8 }}>
            No poster
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: "0 0 4px" }}>{item.title}</h1>
          <p style={{ color: "var(--muted)" }}>
            {item.year ?? ""} · {item.type} · {item.status}
            {isAdmin && (
              <button
                type="button"
                className="secondary"
                style={{ marginLeft: 10, fontSize: "0.8rem" }}
                onClick={async () => {
                  const result = await api.post<{ token: string }>(`/media/${item.id}/share`, {});
                  const url = `${externalUrl || window.location.origin}/share/${result.token}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    alert(`Share link copied to clipboard:\n${url}`);
                  } catch {
                    prompt("Share link (copy manually):", url);
                  }
                }}
              >
                Share
              </button>
            )}
          </p>
          {shape === "single" && (
            <p>
              <span className={`badge ${item.hasFile ? "ok" : ""}`}>{item.hasFile ? "Downloaded" : "Missing"}</span>
              {item.quality && <span className="badge" style={{ marginLeft: 6 }}>{item.quality}</span>}
              {formatMediaInfo(item.mediaInfo) && (
                <span style={{ marginLeft: 8, color: "var(--muted)", fontSize: "0.85rem" }}>{formatMediaInfo(item.mediaInfo)}</span>
              )}
            </p>
          )}
          {item.overview && <p>{item.overview}</p>}
          {trailerUrl && (
            <p>
              <a href={trailerUrl} target="_blank" rel="noreferrer">
                ▶ Watch trailer
              </a>
            </p>
          )}

          {isAdmin && (
            <table style={{ marginTop: 8 }}>
              <tbody>
                <tr>
                  <th>Added</th>
                  <td>{new Date(item.addedAt).toLocaleDateString()}</td>
                </tr>
                {qualityProfile && (
                  <tr>
                    <th>Quality profile</th>
                    <td>{qualityProfile.name}</td>
                  </tr>
                )}
                {rootFolder && (
                  <tr>
                    <th>Root folder</th>
                    <td>{rootFolder.path}</td>
                  </tr>
                )}
                {item.path && (
                  <tr>
                    <th>Path</th>
                    <td style={{ wordBreak: "break-all" }}>{item.path}</td>
                  </tr>
                )}
                {Object.keys(externalIds).length > 0 && (
                  <tr>
                    <th>External IDs</th>
                    <td>
                      {Object.entries(externalIds).map(([provider, providerId], idx) => {
                        const link = EXTERNAL_ID_LINKS[provider]?.(providerId, item.type);
                        return (
                          <span key={provider}>
                            {idx > 0 && " · "}
                            {link ? (
                              <a href={link} target="_blank" rel="noreferrer">
                                {provider}: {providerId}
                              </a>
                            ) : (
                              `${provider}: ${providerId}`
                            )}
                          </span>
                        );
                      })}
                    </td>
                  </tr>
                )}
                {item.tags && item.tags.length > 0 && (
                  <tr>
                    <th>Tags</th>
                    <td>{item.tags.map((t) => t.name).join(", ")}</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {cast && cast.length > 0 && (
        <>
          <h2>Cast</h2>
          <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 8, marginBottom: 12 }}>
            {cast.map((c) => (
              <div
                key={c.personId}
                style={{ flex: "0 0 90px", cursor: "pointer", textAlign: "center" }}
                onClick={() => navigate(`/people/${c.personId}`)}
              >
                <div
                  className="poster"
                  style={{
                    width: 90,
                    height: 120,
                    ...(c.photoUrl ? { backgroundImage: `url(${c.photoUrl})` } : {}),
                  }}
                >
                  {!c.photoUrl && "No photo"}
                </div>
                <div style={{ fontSize: "0.75rem", marginTop: 4 }}>{c.name}</div>
                {c.character && <div style={{ fontSize: "0.7rem", color: "var(--muted)" }}>{c.character}</div>}
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        {item.tags.map((t) =>
          isAdmin ? (
            <span key={t.id} className="badge" style={{ cursor: "pointer" }} onClick={() => removeTagFromItem(t.id)}>
              {t.name} &times;
            </span>
          ) : (
            <span key={t.id} className="badge">
              {t.name}
            </span>
          )
        )}
        {isAdmin && allTags.length > 0 && (
          <>
            <select
              value={tagToAdd}
              onChange={(e) => setTagToAdd(e.target.value ? Number(e.target.value) : "")}
              style={{ maxWidth: 160, display: "inline-block" }}
            >
              <option value="">Add tag...</option>
              {allTags
                .filter((t) => !item.tags.some((it) => it.id === t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
            <button type="button" className="secondary" onClick={addTagToItem} disabled={!tagToAdd}>
              Add
            </button>
          </>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>Content rating:</span>
        {isAdmin ? (
          <select
            value={item.contentRating ?? ""}
            onChange={(e) => updateContentRating(e.target.value || null)}
            style={{ maxWidth: 160, display: "inline-block" }}
          >
            <option value="">Unrated</option>
            {contentRatings.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : (
          <span className="badge">{item.contentRating ?? "Unrated"}</span>
        )}
      </div>

      {allCollections.length > 0 && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
          <select
            value={collectionToAdd}
            onChange={(e) => setCollectionToAdd(e.target.value ? Number(e.target.value) : "")}
            style={{ maxWidth: 200, display: "inline-block" }}
          >
            <option value="">Add to collection...</option>
            {allCollections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button type="button" className="secondary" onClick={addToCollection} disabled={!collectionToAdd}>
            Add
          </button>
        </div>
      )}

      {isAdmin && (
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={toggleMonitored} className="secondary">
            {item.monitored ? "Unmonitor" : "Monitor"}
          </button>
          <button onClick={toggleProtected} className="secondary" title="Protected items are skipped by watch-status auto-archival">
            {item.protected ? "Unprotect" : "Protect from archival"}
          </button>
          <button
            onClick={toggleWatched}
            className="secondary"
            title="Also pushed to your configured media server, if it recognizes this file"
          >
            {watched ? "Mark unwatched" : "Mark watched"}
          </button>
          {shape === "single" && (
            <button onClick={() => runSearch(null)} disabled={searching}>
              {searching && !target ? "Searching..." : "Search now"}
            </button>
          )}
          <button onClick={toggleImport} className="secondary">
            {showImport ? "Hide manual import" : "Manual Import"}
          </button>
          {shape === "single" && item.hasFile && (
            <button className="secondary" onClick={checkCorrupt}>
              Check for corruption
            </button>
          )}
          <button
            className="secondary"
            onClick={() => downloadFile(`/media/${item.id}/export?format=nfo`, `${item.title}.nfo`)}
          >
            Export .nfo
          </button>
          {(metadataProviders[item.type]?.length ?? 0) > 0 && (
            <button
              className="secondary"
              onClick={() => setShowSearchMatch(true)}
              title="Search with a custom query and pick a different metadata match — for when the current title is wrong or garbled"
            >
              Search for a different match...
            </button>
          )}
          {(item.type === "movie" || item.type === "series" || item.type === "anime") && (
            <button
              className="secondary"
              onClick={() => downloadFile(`/media/${item.id}/export?format=plexmatch`, `.plexmatch`)}
              title="Rename this file to exactly .plexmatch and place it in this item's own folder for Plex to pick it up"
            >
              Export for Plex
            </button>
          )}
          {typeInfo && typeInfo.groupLevels.length > 0 && (
            <button onClick={() => setShowMove((v) => !v)} className="secondary">
              {showMove ? "Cancel move" : "Move to group..."}
            </button>
          )}
          {/* Fanart.tv only supports lookup by a known TMDB/TVDB/MusicBrainz id, i.e. exactly these
              three types — this isn't a UI simplification, it's a real capability limit. */}
          {(item.type === "movie" || item.type === "series" || item.type === "artist") && (
            <button onClick={toggleArtwork} className="secondary">
              {showArtwork ? "Hide artwork" : "Artwork"}
            </button>
          )}
          <button onClick={remove} className="danger">
            Remove
          </button>
        </div>
      )}

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      {watchStateError && <p style={{ color: "var(--danger)" }}>{watchStateError}</p>}

      {typeInfo && typeInfo.groupLevels.length > 0 && groupBreadcrumb && !showMove && (
        <p style={{ color: "var(--muted)" }}>Location: {groupBreadcrumb}</p>
      )}

      {showMove && typeInfo && (
        <div className="form-panel">
          <GroupPicker type={item.type} groupLevels={typeInfo.groupLevels} onChange={setPendingGroupId} />
          <button type="button" onClick={saveGroup} disabled={!pendingGroupId} style={{ marginTop: 8 }}>
            Save location
          </button>
        </div>
      )}

      {isAdmin && (metadataProviders[item.type]?.length ?? 0) > 0 && (
        <>
          <h2>Additional Metadata Sources</h2>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
            Pull a second opinion from another provider without changing this item's primary
            fields yet. Once you've fetched from one or more, pick which source to use per field
            below — mixing and matching (e.g. this provider's poster with that one's overview) is
            fine — then apply the merged result in one go.
          </p>
          <div className="toolbar" style={{ marginBottom: 12 }}>
            {metadataProviders[item.type].map((p) => (
              <button key={p} type="button" className="secondary" onClick={() => fetchSupplemental(p)} disabled={fetchingProvider === p}>
                {fetchingProvider === p ? "Fetching..." : `Fetch from ${p}`}
              </button>
            ))}
          </div>
          {Object.keys(item.extraMetadata).length > 0 &&
            (() => {
              const providers = Object.entries(item.extraMetadata);
              const row = (
                field: "title" | "year" | "overview" | "posterUrl",
                label: string,
                render: (value: string | number | null) => ReactNode
              ) => (
                <tr>
                  <th style={{ whiteSpace: "nowrap" }}>{label}</th>
                  <td>
                    <label style={{ display: "flex", alignItems: "flex-start", gap: 6, cursor: "pointer" }}>
                      <input
                        type="radio"
                        name={`merge-${field}`}
                        checked={mergeChoice[field] === "current"}
                        onChange={() => setMergeChoice((prev) => ({ ...prev, [field]: "current" }))}
                        style={{ marginTop: 4 }}
                      />
                      {render(item[field])}
                    </label>
                  </td>
                  {providers.map(([provider, data]) => (
                    <td key={provider}>
                      {data[field] != null && data[field] !== "" ? (
                        <label style={{ display: "flex", alignItems: "flex-start", gap: 6, cursor: "pointer" }}>
                          <input
                            type="radio"
                            name={`merge-${field}`}
                            checked={mergeChoice[field] === provider}
                            onChange={() => setMergeChoice((prev) => ({ ...prev, [field]: provider }))}
                            style={{ marginTop: 4 }}
                          />
                          {render(data[field])}
                        </label>
                      ) : (
                        <span style={{ color: "var(--muted)" }}>—</span>
                      )}
                    </td>
                  ))}
                </tr>
              );

              return (
                <>
                  <div style={{ overflowX: "auto" }}>
                    <table>
                      <thead>
                        <tr>
                          <th></th>
                          <th>Current</th>
                          {providers.map(([provider]) => (
                            <th key={provider} style={{ textTransform: "capitalize" }}>
                              {provider}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {row("posterUrl", "Poster", (v) =>
                          v ? (
                            <img src={v as string} alt="" style={{ width: 40, height: 60, objectFit: "cover", borderRadius: 3 }} />
                          ) : (
                            <span style={{ color: "var(--muted)" }}>none</span>
                          )
                        )}
                        {row("title", "Title", (v) => <span>{v}</span>)}
                        {row("year", "Year", (v) => <span>{v ?? "-"}</span>)}
                        {row("overview", "Overview", (v) => (
                          <span style={{ fontSize: "0.85rem", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                            {v}
                          </span>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button type="button" onClick={applyMerge} disabled={applyingMerge} style={{ marginTop: 12 }}>
                    {applyingMerge ? "Applying..." : "Apply merged metadata"}
                  </button>
                </>
              );
            })()}
        </>
      )}

      {showArtwork && (
        <>
          <h2>Artwork (via Fanart.tv)</h2>
          {loadingArtwork && <p className="empty">Loading...</p>}
          {artworkError && <p style={{ color: "var(--danger)" }}>{artworkError}</p>}
          {artworkOptions && !loadingArtwork && (
            <>
              {artworkOptions.posters.length === 0 && (
                <p className="empty">No posters found on Fanart.tv for this item.</p>
              )}
              <div className="grid">
                {artworkOptions.posters.map((url, idx) => (
                  <div key={idx} className="card" onClick={() => selectArtwork(url)}>
                    <div className="poster" style={{ backgroundImage: `url(${url})` }} />
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {showImport && (
        <>
          <h2>Manual Import</h2>
          <div className="form-panel">
            {shape === "episodic" && (
              <>
                <label>Target episode</label>
                <select
                  value={importEpisodeId}
                  onChange={(e) => setImportEpisodeId(e.target.value ? Number(e.target.value) : "")}
                >
                  <option value="">Select an episode...</option>
                  {(item.children as Episode[]).map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      S{String(ep.seasonNumber).padStart(2, "0")}E{String(ep.episodeNumber).padStart(2, "0")}
                      {ep.title ? ` - ${ep.title}` : ""}
                    </option>
                  ))}
                </select>
              </>
            )}
            {shape === "collection" && (
              <>
                <label>Target {childLabel.toLowerCase()}</label>
                <select
                  value={importSubItemId}
                  onChange={(e) => setImportSubItemId(e.target.value ? Number(e.target.value) : "")}
                >
                  <option value="">Select...</option>
                  {(item.children as SubItem[]).map((si) => (
                    <option key={si.id} value={si.id}>
                      {si.title}
                    </option>
                  ))}
                </select>
              </>
            )}

            <p style={{ color: "var(--muted)", fontSize: "0.82rem", marginTop: 12 }}>
              Browsing downloads: /{browsePath || ""}
            </p>
            {browsePath && (
              <button
                type="button"
                className="secondary"
                onClick={() => browse(browsePath.split("/").slice(0, -1).join("/"))}
              >
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
                      {e.isMediaFile && <button onClick={() => manualImport(e)}>Import</button>}
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
        <>
          <h2>Search results{target ? ` — ${target.label}` : ""}</h2>
          {results.length === 0 && <p className="empty">No results found.</p>}
          {results.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Quality</th>
                  <th>Format score</th>
                  <th>Indexer</th>
                  <th>Size</th>
                  <th>Seeders</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, idx) => (
                  <tr key={idx} style={{ opacity: r.matchesTarget && !r.blocklisted ? 1 : 0.55 }}>
                    <td>
                      {r.title}
                      {r.blocklisted && (
                        <span className="badge danger" style={{ marginLeft: 6 }}>
                          blocklisted
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${r.allowedByProfile ? "ok" : "danger"}`}>{r.parsedQuality}</span>
                    </td>
                    <td title={r.formatMatches.join(", ")}>{r.formatScore}</td>
                    <td>{r.indexerName}</td>
                    <td>
                      {(r.size / 1e9).toFixed(2)} GB
                      {!r.sizeAllowed && (
                        <span className="badge danger" style={{ marginLeft: 6 }} title="Outside the configured size range for this quality">
                          size?
                        </span>
                      )}
                    </td>
                    <td>{r.seeders ?? "-"}</td>
                    <td style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => grab(r)} disabled={r.blocklisted}>
                        Grab
                      </button>
                      {!r.blocklisted && (
                        <button className="danger" onClick={() => blocklistResult(r)}>
                          Blocklist
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {shape === "episodic" && (item.children as Episode[]).length > 0 && (
        <>
          {(() => {
            const episodes = item.children as Episode[];
            const have = episodes.filter((ep) => ep.hasFile).length;
            const missing = episodes.length - have;
            return (
              <p style={{ color: "var(--muted)" }}>
                <span className="badge ok">{have} have</span>{" "}
                <span className={`badge ${missing > 0 ? "danger" : ""}`}>{missing} missing</span>{" "}
                <span className="badge">{episodes.length} total</span>
              </p>
            );
          })()}
          <h2>Episodes</h2>
          {Array.from(new Set((item.children as Episode[]).map((ep) => ep.seasonNumber)))
            .sort((a, b) => a - b)
            .map((seasonNumber) => {
              const seasonEpisodes = (item.children as Episode[])
                .filter((ep) => ep.seasonNumber === seasonNumber)
                .sort((a, b) => a.episodeNumber - b.episodeNumber);
              const seasonHave = seasonEpisodes.filter((ep) => ep.hasFile).length;
              const isOpen = openSeasons.has(seasonNumber);
              return (
                <div key={seasonNumber} className="form-panel" style={{ marginBottom: 12, padding: 0, maxWidth: "none" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "12px 16px",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSeasonOpen(seasonNumber)}
                      aria-expanded={isOpen}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        flex: 1,
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        margin: 0,
                        color: "inherit",
                        font: "inherit",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>{isOpen ? "▾" : "▸"}</span>
                      <h3 style={{ margin: 0 }}>Season {seasonNumber}</h3>
                    </button>
                    <span className="badge ok">{seasonHave}</span>
                    <span className="badge">{seasonEpisodes.length}</span>
                    {isAdmin && (
                      <div style={{ display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
                        <button
                          className="secondary"
                          disabled={searching}
                          onClick={() => runSearch({ seasonNumber, label: `Season ${seasonNumber}` })}
                        >
                          Search season
                        </button>
                        <button className="secondary" onClick={() => toggleSeasonMonitor(seasonNumber, true)}>
                          Monitor
                        </button>
                        <button className="secondary" onClick={() => toggleSeasonMonitor(seasonNumber, false)}>
                          Unmonitor
                        </button>
                      </div>
                    )}
                  </div>
                  {isOpen && (
                    <table style={{ marginBottom: 0 }}>
                      <thead>
                        <tr>
                          <th>Episode</th>
                          <th>Title</th>
                          <th>Air date</th>
                          <th>Monitored</th>
                          <th>File</th>
                          <th>Quality</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {seasonEpisodes.map((ep) => (
                          <tr key={ep.id} onClick={() => navigate(`/media/${item.id}/episode/${ep.id}`)} style={{ cursor: "pointer" }}>
                            <td>{ep.episodeNumber}</td>
                            <td>{ep.title ?? <span style={{ color: "var(--muted)", fontStyle: "italic" }}>Episode {ep.episodeNumber}</span>}</td>
                            <td>{ep.airDate ?? "-"}</td>
                            <td>{ep.monitored ? "Yes" : "No"}</td>
                            <td>
                              <span className={`badge ${ep.hasFile ? "ok" : ""}`}>{ep.hasFile ? "Downloaded" : "Missing"}</span>
                            </td>
                            <td>
                              {ep.quality ?? "-"}
                              {formatMediaInfo(ep.mediaInfo) && (
                                <div style={{ color: "var(--muted)", fontSize: "0.75rem" }}>{formatMediaInfo(ep.mediaInfo)}</div>
                              )}
                            </td>
                            <td onClick={(e) => e.stopPropagation()}>
                              {isAdmin && (
                                <button
                                  className="secondary"
                                  disabled={searching}
                                  onClick={() =>
                                    runSearch({
                                      episodeId: ep.id,
                                      label: `S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`,
                                    })
                                  }
                                >
                                  Search
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
        </>
      )}

      {shape === "collection" && (item.children as SubItem[]).length > 0 && (
        <>
          {(() => {
            const children = item.children as SubItem[];
            const have = children.filter((si) => si.hasFile).length;
            const missing = children.length - have;
            return (
              <p style={{ color: "var(--muted)" }}>
                <span className="badge ok">{have} have</span>{" "}
                <span className={`badge ${missing > 0 ? "danger" : ""}`}>{missing} missing</span>{" "}
                <span className="badge">{children.length} total</span>
              </p>
            );
          })()}
          <h2>{childLabel}s</h2>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Title</th>
                <th>Release date</th>
                <th>File</th>
                <th>Quality</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(item.children as SubItem[]).map((si) => (
                <tr key={si.id} onClick={() => navigate(`/media/${item.id}/item/${si.id}`)} style={{ cursor: "pointer" }}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div
                      onClick={() => isAdmin && editSubItemCover(si)}
                      title={isAdmin ? "Click to add/change cover art" : undefined}
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 4,
                        overflow: "hidden",
                        background: "var(--panel-2, rgba(255,255,255,0.06))",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: isAdmin ? "pointer" : "default",
                        flexShrink: 0,
                      }}
                    >
                      {si.posterUrl ? (
                        <img src={si.posterUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : (
                        <span style={{ fontSize: "1.1rem", color: "var(--muted)" }}>♪</span>
                      )}
                    </div>
                  </td>
                  <td>{si.title}</td>
                  <td>{si.releaseDate ?? "-"}</td>
                  <td>
                    <span className={`badge ${si.hasFile ? "ok" : ""}`}>{si.hasFile ? "Downloaded" : "Missing"}</span>
                  </td>
                  <td>
                    {si.quality ?? "-"}
                    {formatMediaInfo(si.mediaInfo) && (
                      <div style={{ color: "var(--muted)", fontSize: "0.75rem" }}>{formatMediaInfo(si.mediaInfo)}</div>
                    )}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {isAdmin && item.type === "video" && si.externalProvider === "youtube" && (
                      <button className="secondary" onClick={() => downloadVideo(si)}>
                        Download
                      </button>
                    )}
                    {isAdmin && !(item.type === "video" && si.externalProvider === "youtube") && (
                      <button
                        className="secondary"
                        disabled={searching}
                        onClick={() => runSearch({ subItemId: si.id, label: si.title })}
                      >
                        Search
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {showSearchMatch && (
        <SearchMatchModal
          type={item.type}
          initialQuery={item.title}
          providers={metadataProviders[item.type] ?? []}
          onClose={() => setShowSearchMatch(false)}
          onSelect={applyRematch}
        />
      )}
    </div>
  );
}
