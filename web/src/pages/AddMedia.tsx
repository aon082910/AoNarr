import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client.js";
import GroupPicker from "../components/GroupPicker.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { LibraryGroup, MediaItem, MediaType, QualityProfile, RootFolder } from "../types.js";
import { formatBytes } from "../utils/format.js";

interface MetadataSearchResult {
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
  excluded?: boolean;
  releaseDate?: string | null;
}

/** Hostname → the "Site" group name to file a scraped course under, so the group picker doesn't
 * make the user re-type "Coursera"/"Udemy"/"edX" for every course from the same platform. */
const COURSE_SITE_NAMES: Record<string, string> = {
  "coursera.org": "Coursera",
  "udemy.com": "Udemy",
  "edx.org": "edX",
};

function detectCourseSite(url: string): { name: string; domain: string } | null {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    for (const [domain, name] of Object.entries(COURSE_SITE_NAMES)) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) return { name, domain };
    }
  } catch {
    // not a valid URL — caller already validated this before getting here
  }
  return null;
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
  const [searchParams] = useSearchParams();
  const prefillQuery = searchParams.get("q") ?? "";
  const prefillType = searchParams.get("type") ?? "";
  const mediaTypes = useMediaTypes();
  const [type, setType] = useState<MediaType>("");
  const [providers, setProviders] = useState<Record<MediaType, string[]>>({});
  const [provider, setProvider] = useState("");
  const [query, setQuery] = useState(prefillQuery);
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
  const [courseUrl, setCourseUrl] = useState("");
  const [courseLoading, setCourseLoading] = useState(false);
  const [courseSiteGroupId, setCourseSiteGroupId] = useState<number | null>(null);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [romGroupChain, setRomGroupChain] = useState<(number | null)[] | null>(null);
  const [romDetailsLoading, setRomDetailsLoading] = useState(false);

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
    if (!type && mediaTypes.length > 0) {
      const preferred = mediaTypes.find((t) => t.key === prefillType);
      setType(preferred ? preferred.key : mediaTypes[0].key);
    }
  }, [mediaTypes, type, prefillType]);

  useEffect(() => {
    setProvider(providers[type]?.[0] ?? "");
    // A type with no metadata provider (e.g. Courses) can only be added manually.
    if (activeTypeInfo && !activeTypeInfo.hasMetadataSearch) setManual(true);
  }, [type, providers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deep-linked from another page (e.g. Friend Libraries "Add") with a query/type already chosen
  // — auto-run the search once the provider for that type has loaded, instead of making the user
  // press the search button for a query that's already filled in.
  useEffect(() => {
    if (!prefillQuery || !provider || results !== null) return;
    setSearching(true);
    setError(null);
    api
      .get<MetadataSearchResult[]>(`/metadata/search?type=${type}&query=${encodeURIComponent(prefillQuery)}&provider=${provider}`)
      .then(setResults)
      .catch((e) => setError((e as Error).message))
      .finally(() => setSearching(false));
  }, [prefillQuery, provider]); // eslint-disable-line react-hooks/exhaustive-deps

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

  async function findOrCreateGroup(
    mediaType: MediaType,
    kind: string,
    name: string,
    parentGroupId: number | null,
    logoUrl?: string | null
  ): Promise<number> {
    const groups = await api.get<LibraryGroup[]>(
      `/library-groups?mediaType=${mediaType}${parentGroupId ? `&parentId=${parentGroupId}` : ""}`
    );
    const existing = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing.id;
    const created = await api.post<LibraryGroup>("/library-groups", { mediaType, kind, name, parentGroupId, logoUrl });
    return created.id;
  }

  function selectResult(result: MetadataSearchResult) {
    setSelected(result);
    setTitle(result.title);
    setYear(result.year ? String(result.year) : "");
    setOverview(result.overview ?? "");
    setRomGroupChain(null);

    // RAWG/IGDB's search results don't carry overview/platform/developer — only their per-game
    // detail lookup does, so this is a follow-up call rather than something selectResult already
    // has. Auto-fills the overview (search results always sent it as null) and resolves/creates
    // the System → Maker group chain, same as detectCourseSite does for a single-level Site group.
    if (type === "rom" && result.externalIds) {
      const [provider, externalId] = Object.entries(result.externalIds)[0] ?? [];
      if (provider && externalId) {
        setRomDetailsLoading(true);
        api
          .get<{ overview: string | null; system: string | null; maker: string | null; systemLogoUrl: string | null }>(
            `/metadata/rom-details?provider=${provider}&externalId=${encodeURIComponent(externalId)}`
          )
          .then(async (details) => {
            if (details.overview) setOverview(details.overview);
            if (details.system) {
              const systemId = await findOrCreateGroup("rom", "system", details.system, null, details.systemLogoUrl);
              const makerId = details.maker ? await findOrCreateGroup("rom", "maker", details.maker, systemId) : null;
              setRomGroupChain([systemId, makerId]);
            }
          })
          .catch(() => {
            // Best-effort enrichment — a failed lookup (rate limit, missing key, network hiccup)
            // just leaves overview/group exactly where selectResult's basic fields already put
            // them, same as if this follow-up fetch had never run.
          })
          .finally(() => setRomDetailsLoading(false));
      }
    }
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
            releaseDate: selected?.releaseDate ?? null,
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

  async function loadCourseUrl(e: FormEvent) {
    e.preventDefault();
    if (!courseUrl.trim()) return;
    setCourseLoading(true);
    setError(null);
    try {
      const parsed = await api.post<MetadataSearchResult>("/import/course-url", { url: courseUrl.trim() });
      setNfoResult(parsed);
      setManual(true);
      setSelected(null);
      setTitle(parsed.title ?? "");
      setOverview(parsed.overview ?? "");

      const site = detectCourseSite(courseUrl.trim());
      if (site) {
        const groups = await api.get<LibraryGroup[]>("/library-groups?mediaType=course");
        const existing = groups.find((g) => g.name.toLowerCase() === site.name.toLowerCase());
        // A Site group created before this feature existed has no logo yet — backfill it here
        // rather than leaving it tile-less forever until someone happens to edit the group by hand.
        const group =
          existing && !existing.logoUrl
            ? await api.patch<LibraryGroup>(`/library-groups/${existing.id}`, { name: existing.name, website: site.domain })
            : existing ??
              (await api.post<LibraryGroup>("/library-groups", {
                mediaType: "course",
                kind: "site",
                name: site.name,
                website: site.domain,
              }));
        setCourseSiteGroupId(group.id);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCourseLoading(false);
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

        {type === "course" && (
          <details style={{ marginTop: 12 }} open>
            <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: "0.85rem" }}>
              Import from a course page URL
            </summary>
            <form onSubmit={loadCourseUrl} style={{ marginTop: 8 }}>
              <label>Coursera / edX / Udemy (or any) course URL</label>
              <input
                value={courseUrl}
                onChange={(e) => setCourseUrl(e.target.value)}
                placeholder="https://www.coursera.org/learn/..."
              />
              <button type="submit" disabled={courseLoading}>
                {courseLoading ? "Fetching..." : "Fetch course info"}
              </button>
              <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
                Pulls the title, description, and thumbnail the page publishes for link previews.
                The lesson-by-lesson breakdown isn't published in a scrapable form on these sites, so
                add lessons individually after creating this entry.
              </p>
            </form>
          </details>
        )}
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

          {type === "rom" && romDetailsLoading && (
            <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>Looking up system/maker...</p>
          )}
          {activeTypeInfo && activeTypeInfo.groupLevels.length > 0 && (
            <GroupPicker
              key={type === "course" ? courseSiteGroupId ?? "unset" : type === "rom" ? romGroupChain?.join(",") ?? "unset" : "default"}
              type={type}
              groupLevels={activeTypeInfo.groupLevels}
              initialChain={
                type === "course" && courseSiteGroupId
                  ? [courseSiteGroupId, ...activeTypeInfo.groupLevels.slice(1).map(() => null)]
                  : type === "rom" && romGroupChain
                    ? romGroupChain
                    : undefined
              }
              onChange={setGroupId}
            />
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
