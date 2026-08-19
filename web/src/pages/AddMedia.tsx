import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client.js";
import GroupPicker from "../components/GroupPicker.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { MediaItem, MediaType, QualityProfile, RootFolder } from "../types.js";
import { formatBytes } from "../utils/format.js";

interface MetadataSearchResult {
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
  excluded?: boolean;
}

const PROVIDER_LABELS: Record<string, string> = {
  tmdb: "TMDB",
  omdb: "OMDb",
  trakt: "Trakt",
  tvdb: "TVDB",
  tvmaze: "TVmaze",
  anilist: "AniList",
  musicbrainz: "MusicBrainz",
  deezer: "Deezer",
  discogs: "Discogs",
  lastfm: "Last.fm",
  openlibrary: "Open Library",
  googlebooks: "Google Books",
  comicvine: "Comic Vine",
  rawg: "RAWG",
  igdb: "IGDB",
  youtube: "YouTube",
  theporndb: "ThePornDB",
};

export default function AddMedia() {
  const navigate = useNavigate();
  const mediaTypes = useMediaTypes();
  const [type, setType] = useState<MediaType>("");
  const [providers, setProviders] = useState<Record<MediaType, string[]>>({});
  const [provider, setProvider] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<MetadataSearchResult[] | null>(null);
  const [selected, setSelected] = useState<MetadataSearchResult | null>(null);
  const [manual, setManual] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [overview, setOverview] = useState("");
  const [rootFolders, setRootFolders] = useState<RootFolder[]>([]);
  const [profiles, setProfiles] = useState<QualityProfile[]>([]);
  const [rootFolderId, setRootFolderId] = useState<number | "">("");
  const [qualityProfileId, setQualityProfileId] = useState<number | "">("");
  const [submitting, setSubmitting] = useState(false);

  const [nfoPath, setNfoPath] = useState("");
  const [nfoLoading, setNfoLoading] = useState(false);
  const [nfoResult, setNfoResult] = useState<MetadataSearchResult | null>(null);
  const [groupId, setGroupId] = useState<number | null>(null);

  const activeTypeInfo = mediaTypes.find((t) => t.key === type);

  useEffect(() => {
    api.get<RootFolder[]>("/root-folders").then(setRootFolders);
    api.get<QualityProfile[]>("/quality-profiles").then((p) => {
      setProfiles(p);
      if (p.length > 0) setQualityProfileId(p[0].id);
    });
    api.get<Record<MediaType, string[]>>("/metadata/providers").then(setProviders);
  }, []);

  useEffect(() => {
    if (!type && mediaTypes.length > 0) setType(mediaTypes[0].key);
  }, [mediaTypes, type]);

  useEffect(() => {
    setProvider(providers[type]?.[0] ?? "");
    // A type with no metadata provider (e.g. Courses) can only be added manually.
    if (activeTypeInfo && !activeTypeInfo.hasMetadataSearch) setManual(true);
  }, [type, providers]); // eslint-disable-line react-hooks/exhaustive-deps

  const foldersForType = rootFolders.filter((f) => f.mediaType === type);

  async function runSearch(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    setResults(null);
    setSelected(null);
    try {
      const res = await api.get<MetadataSearchResult[]>(
        `/metadata/search?type=${type}&query=${encodeURIComponent(query.trim())}&provider=${provider}`
      );
      setResults(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }

  function selectResult(result: MetadataSearchResult) {
    setSelected(result);
    setTitle(result.title);
    setYear(result.year ? String(result.year) : "");
    setOverview(result.overview ?? "");
  }

  async function doImport(confirmDuplicate = false) {
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = manual
        ? {
            type,
            title: title.trim(),
            year: year ? Number(year) : null,
            overview: overview || null,
            posterUrl: nfoResult?.posterUrl ?? null,
            externalIds: nfoResult?.externalIds ?? {},
            rootFolderId: rootFolderId || null,
            qualityProfileId: qualityProfileId || null,
            monitored: 1,
            confirmDuplicate,
            groupId,
          }
        : {
            type,
            title: title.trim(),
            year: year ? Number(year) : null,
            overview: overview || null,
            posterUrl: selected?.posterUrl ?? null,
            externalIds: selected?.externalIds ?? {},
            rootFolderId: rootFolderId || null,
            qualityProfileId: qualityProfileId || null,
            monitored: 1,
            confirmDuplicate,
            groupId,
          };
      const created = await api.post<MediaItem>(manual ? "/media" : "/metadata/import", payload);
      navigate(`/media/${created.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && Array.isArray(err.body?.duplicates)) {
        const names = err.body.duplicates.map((d: any) => `${d.title}${d.year ? ` (${d.year})` : ""}`).join(", ");
        if (confirm(`This looks like it might already be in your library: ${names}. Add it anyway?`)) {
          await doImport(true);
          return;
        }
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function loadNfo(e: FormEvent) {
    e.preventDefault();
    if (!nfoPath.trim()) return;
    setNfoLoading(true);
    setError(null);
    try {
      const parsed = await api.get<MetadataSearchResult>(`/import/nfo?path=${encodeURIComponent(nfoPath.trim())}`);
      setNfoResult(parsed);
      setManual(true);
      setSelected(null);
      setTitle(parsed.title ?? "");
      setYear(parsed.year ? String(parsed.year) : "");
      setOverview(parsed.overview ?? "");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setNfoLoading(false);
    }
  }

  function confirmImport(e: FormEvent) {
    e.preventDefault();
    doImport(false);
  }

  return (
    <div>
      <h1>Add Media</h1>

      <div className="form-panel">
        <label>Type</label>
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value as MediaType);
            setResults(null);
            setSelected(null);
          }}
        >
          {mediaTypes.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>

        {!manual && (
          <form onSubmit={runSearch}>
            <label>Metadata provider</label>
            <select value={provider} onChange={(e) => setProvider(e.target.value)} style={{ marginBottom: 10 }}>
              {(providers[type] ?? []).map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p] ?? p}
                </option>
              ))}
            </select>
            <label>Search</label>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Title..." />
            <button type="submit" disabled={searching}>
              {searching ? "Searching..." : "Search"}
            </button>
          </form>
        )}

        {activeTypeInfo?.hasMetadataSearch ? (
          <button type="button" className="secondary" onClick={() => setManual((m) => !m)}>
            {manual ? "Search metadata instead" : "Add manually (no metadata)"}
          </button>
        ) : (
          <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
            {activeTypeInfo?.label} has no metadata search provider — add it manually below.
          </p>
        )}

        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: "0.85rem" }}>
            Import from .nfo file instead
          </summary>
          <form onSubmit={loadNfo} style={{ marginTop: 8 }}>
            <label>Path to .nfo (relative to downloads directory)</label>
            <input
              value={nfoPath}
              onChange={(e) => setNfoPath(e.target.value)}
              placeholder="Some Movie (2020)/movie.nfo"
            />
            <button type="submit" disabled={nfoLoading}>
              {nfoLoading ? "Reading..." : "Load NFO"}
            </button>
            {nfoResult && <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>Loaded — review the fields below before adding.</p>}
          </form>
        </details>
      </div>

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {!manual && results && !selected && (
        <div className="grid">
          {results.length === 0 && <p className="empty">No results found.</p>}
          {results.map((r, idx) => (
            <div key={idx} className="card" onClick={() => selectResult(r)} style={r.excluded ? { opacity: 0.5 } : undefined}>
              <div className="poster" style={r.posterUrl ? { backgroundImage: `url(${r.posterUrl})` } : undefined}>
                {!r.posterUrl && "No poster"}
              </div>
              <div className="meta">
                <div className="title">{r.title}</div>
                <div className="sub">
                  {r.year ?? ""}
                  {r.excluded && " · excluded (click to add anyway)"}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {(manual || selected) && (
        <form className="form-panel" onSubmit={confirmImport}>
          <label>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />

          <label>Year</label>
          <input value={year} onChange={(e) => setYear(e.target.value)} type="number" />

          <label>Overview</label>
          <textarea value={overview} onChange={(e) => setOverview(e.target.value)} rows={3} />

          {activeTypeInfo && activeTypeInfo.groupLevels.length > 0 && (
            <GroupPicker type={type} groupLevels={activeTypeInfo.groupLevels} onChange={setGroupId} />
          )}

          <label>Root folder</label>
          <select value={rootFolderId} onChange={(e) => setRootFolderId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Auto (most free space)</option>
            {foldersForType.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
                {typeof f.freeBytes === "number" ? ` — ${formatBytes(f.freeBytes)} free` : ""}
              </option>
            ))}
          </select>

          <label>Quality profile</label>
          <select
            value={qualityProfileId}
            onChange={(e) => setQualityProfileId(e.target.value ? Number(e.target.value) : "")}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <button type="submit" disabled={submitting}>
            {submitting ? "Adding..." : "Add to library"}
          </button>
        </form>
      )}
    </div>
  );
}
