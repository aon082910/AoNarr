import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client.js";
import GroupPicker from "../components/GroupPicker.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { LibraryGroup, MediaItem, MediaType, QualityProfile, RootFolder } from "../types.js";
import { formatBytes } from "../utils/format.js";

type MonitorStrategy = "all" | "future" | "missing" | "existing" | "recent" | "firstSeason" | "latestSeason" | "pilot" | "none";

const MONITOR_STRATEGY_LABELS: Record<MonitorStrategy, string> = {
  all: "All Episodes",
  future: "Future Episodes",
  missing: "Missing Episodes",
  existing: "Existing Episodes",
  recent: "Recent Episodes (last season)",
  firstSeason: "First Season",
  latestSeason: "Latest Season",
  pilot: "Pilot Episode Only",
  none: "None",
};

interface MetadataSearchResult {
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
  excluded?: boolean;
  releaseDate?: string | null;
  backdropUrl?: string | null;
  rating?: number | null;
  runtimeMinutes?: number | null;
  studio?: string | null;
  performers?: string[];
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
  itunes: "iTunes",
  hardcover: "Hardcover",
  goodreads: "Goodreads",
  audible: "Audible",
  audnexus: "AudNexus",
  comicvine: "Comic Vine",
  rawg: "RAWG",
  igdb: "IGDB",
  screenscraper: "ScreenScraper",
  thegamesdb: "TheGamesDB",
  youtube: "YouTube",
  vimeo: "Vimeo",
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
  /** Narrows/re-ranks search results toward this year (see searchMetadata's year-assisted
   * matching) — distinct from `year` below, which is the year of the item actually being added. */
  const [searchYear, setSearchYear] = useState("");
  const [searchMode, setSearchMode] = useState<"title" | "id">("title");
  const [idInput, setIdInput] = useState("");
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
  const [monitorStrategy, setMonitorStrategy] = useState<MonitorStrategy>("all");
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
    // A type with no metadata provider (e.g. Courses) can only be added manually; one that does
    // support search resets back to it — this used to only ever force manual on, never back off,
    // so switching from a no-search type to a search-capable one left the manual entry form
    // showing with no obvious reason why the search box had disappeared.
    setManual(!!activeTypeInfo && !activeTypeInfo.hasMetadataSearch);
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
        `/metadata/search?type=${type}&query=${encodeURIComponent(query.trim())}&provider=${provider}${
          searchYear.trim() ? `&year=${encodeURIComponent(searchYear.trim())}` : ""
        }`
      );
      setResults(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }

  async function runIdMatch(e: FormEvent) {
    e.preventDefault();
    if (!idInput.trim()) return;
    setSearching(true);
    setError(null);
    setResults(null);
    setSelected(null);
    try {
      const res = await api.get<MetadataSearchResult[]>(
        `/metadata/match?type=${type}&input=${encodeURIComponent(idInput.trim())}&provider=${provider}`
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
            monitorStrategy: activeTypeInfo?.shape === "episodic" ? monitorStrategy : undefined,
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
            backdropUrl: selected?.backdropUrl ?? null,
            rating: selected?.rating ?? null,
            runtimeMinutes: selected?.runtimeMinutes ?? null,
            studio: selected?.studio ?? null,
            performers: selected?.performers ?? undefined,
            monitorStrategy: activeTypeInfo?.shape === "episodic" ? monitorStrategy : undefined,
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
        <label htmlFor="addmedia-type-1">Type</label>
        <select id="addmedia-type-1"
          value={type}
          onChange={(e) => {
            setType(e.target.value as MediaType);
            setResults(null);
            setSelected(null);
            // A group belongs to one library type — a SNES group picked under ROMs must not ride
            // along into a movie added after switching types.
            setGroupId(null);
            setRomGroupChain(null);
          }}
        >
          {mediaTypes.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>

        {!manual && (
          <>
            <label htmlFor="addmedia-metadata-provider-2">Metadata provider</label>
            <select id="addmedia-metadata-provider-2" value={provider} onChange={(e) => setProvider(e.target.value)} style={{ marginBottom: 10 }}>
              {(providers[type] ?? []).map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p] ?? p}
                </option>
              ))}
            </select>

            <div className="toolbar" style={{ marginBottom: 6 }}>
              <button type="button" className={searchMode === "title" ? "" : "secondary"} onClick={() => setSearchMode("title")}>
                Search by title
              </button>
              <button type="button" className={searchMode === "id" ? "" : "secondary"} onClick={() => setSearchMode("id")}>
                Match by ID / URL
              </button>
            </div>

            {searchMode === "title" ? (
              <form onSubmit={runSearch}>
                <label htmlFor="add-media-search-title">Search</label>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <input id="add-media-search-title" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Title..." style={{ flex: 1 }} />
                  <input
                    aria-label="Year"
                    value={searchYear}
                    onChange={(e) => setSearchYear(e.target.value)}
                    placeholder="Year"
                    type="number"
                    title="Optional — narrows/re-ranks results toward this year, useful for remakes or generically-titled matches"
                    style={{ width: 90 }}
                  />
                </div>
                <button type="submit" disabled={searching}>
                  {searching ? "Searching..." : "Search"}
                </button>
              </form>
            ) : (
              <form onSubmit={runIdMatch}>
                <label htmlFor="addmedia-id-or-url-3">ID or URL</label>
                <input id="addmedia-id-or-url-3"
                  value={idInput}
                  onChange={(e) => setIdInput(e.target.value)}
                  placeholder='e.g. "tt1234567", "603", an ISBN, or a full themoviedb.org/imdb.com/anilist.co/... link'
                />
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 4 }}>
                  A pasted URL is matched by whichever provider it's from automatically. A bare ID
                  is matched against the provider selected above. Supports TMDB, IMDb, TVDB,
                  AniList, IGDB, RAWG, and ISBN (matched to the book's listed author).
                </p>
                <button type="submit" disabled={searching}>
                  {searching ? "Matching..." : "Match"}
                </button>
              </form>
            )}
          </>
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
            <label htmlFor="addmedia-path-to-nfo-relative-to-downloads-direct-4">Path to .nfo (relative to downloads directory)</label>
            <input id="addmedia-path-to-nfo-relative-to-downloads-direct-4"
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
              <label htmlFor="addmedia-coursera-edx-udemy-or-any-course-url-5">Coursera / edX / Udemy (or any) course URL</label>
              <input id="addmedia-coursera-edx-udemy-or-any-course-url-5"
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
          <label htmlFor="addmedia-title-6">Title</label>
          <input id="addmedia-title-6" value={title} onChange={(e) => setTitle(e.target.value)} required />

          <label htmlFor="addmedia-year-7">Year</label>
          <input id="addmedia-year-7" value={year} onChange={(e) => setYear(e.target.value)} type="number" />

          <label htmlFor="addmedia-overview-8">Overview</label>
          <textarea id="addmedia-overview-8" value={overview} onChange={(e) => setOverview(e.target.value)} rows={3} />

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

          <label htmlFor="addmedia-root-folder-9">Root folder</label>
          <select id="addmedia-root-folder-9" value={rootFolderId} onChange={(e) => setRootFolderId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Auto (most free space)</option>
            {foldersForType.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
                {typeof f.freeBytes === "number" ? ` — ${formatBytes(f.freeBytes)} free` : ""}
              </option>
            ))}
          </select>

          <label htmlFor="addmedia-quality-profile-10">Quality profile</label>
          <select id="addmedia-quality-profile-10"
            value={qualityProfileId}
            onChange={(e) => setQualityProfileId(e.target.value ? Number(e.target.value) : "")}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {activeTypeInfo?.shape === "episodic" && (
            <>
              <label htmlFor="addmedia-monitor-11">Monitor</label>
              <select id="addmedia-monitor-11" value={monitorStrategy} onChange={(e) => setMonitorStrategy(e.target.value as MonitorStrategy)}>
                {Object.entries(MONITOR_STRATEGY_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </>
          )}

          <button type="submit" disabled={submitting}>
            {submitting ? "Adding..." : "Add to library"}
          </button>
        </form>
      )}
    </div>
  );
}
