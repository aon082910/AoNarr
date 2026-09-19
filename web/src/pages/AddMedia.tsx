import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { LibraryGroup, MediaType, MetadataSearchResult } from "../types.js";
import type { AddPreviewState } from "./AddPreview.js";

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
  mangadex: "MangaDex",
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

/** Find something to add — every lookup method (title search, ID/URL match, .nfo file, a scraped
 * course URL, or a plain no-metadata manual entry) converges on the same next step: navigate to
 * AddPreview.tsx with whatever candidate was found, which looks like the real MediaDetail.tsx page
 * and is where root folder/quality/monitoring actually get configured and the item actually gets
 * created — matching how Sonarr/Radarr's own "Add New" flow works. This page's only job is finding
 * the candidate, not configuring or creating it. */
export default function AddMedia() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillQuery = searchParams.get("q") ?? "";
  const prefillType = searchParams.get("type") ?? "";
  const mediaTypes = useMediaTypes();
  const [type, setType] = useState<MediaType>("");
  const [providers, setProviders] = useState<Record<MediaType, string[]>>({});
  const [defaultProviders, setDefaultProviders] = useState<Record<MediaType, string | null>>({});
  const [provider, setProvider] = useState("");
  const [query, setQuery] = useState(prefillQuery);
  /** Narrows/re-ranks search results toward this year (see searchMetadata's year-assisted
   * matching). */
  const [searchYear, setSearchYear] = useState("");
  const [searchMode, setSearchMode] = useState<"title" | "id">("title");
  const [idInput, setIdInput] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<MetadataSearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [nfoPath, setNfoPath] = useState("");
  const [nfoLoading, setNfoLoading] = useState(false);
  const [courseUrl, setCourseUrl] = useState("");
  const [courseLoading, setCourseLoading] = useState(false);

  const activeTypeInfo = mediaTypes.find((t) => t.key === type);

  useEffect(() => {
    api.get<Record<MediaType, string[]>>("/metadata/providers").then(setProviders);
    api.get<Record<MediaType, string | null>>("/metadata/default-providers").then(setDefaultProviders);
  }, []);

  useEffect(() => {
    if (!type && mediaTypes.length > 0) {
      const preferred = mediaTypes.find((t) => t.key === prefillType);
      setType(preferred ? preferred.key : mediaTypes[0].key);
    }
  }, [mediaTypes, type, prefillType]);

  useEffect(() => {
    // Prefer the server's real default (e.g. Manga's is "mangadex", not "anilist" — AniList has no
    // per-chapter listing) over just guessing index 0 of the provider list.
    setProvider(defaultProviders[type] ?? providers[type]?.[0] ?? "");
  }, [type, providers, defaultProviders]);

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

  function goToPreview(result: MetadataSearchResult, manual: boolean, initialGroupChain?: (number | null)[]) {
    const state: AddPreviewState = { type, result, manual, initialGroupChain };
    navigate("/add/preview", { state });
  }

  function goManual() {
    goToPreview({ title: "", year: null, overview: null, posterUrl: null, externalIds: {} }, true);
  }

  async function runSearch(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    setResults(null);
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

  async function loadNfo(e: FormEvent) {
    e.preventDefault();
    if (!nfoPath.trim()) return;
    setNfoLoading(true);
    setError(null);
    try {
      const parsed = await api.get<MetadataSearchResult>(`/import/nfo?path=${encodeURIComponent(nfoPath.trim())}`);
      goToPreview(parsed, true);
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
      let initialGroupChain: (number | null)[] | undefined;
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
        initialGroupChain = [group.id, ...(activeTypeInfo?.groupLevels.slice(1).map(() => null) ?? [])];
      }
      goToPreview(parsed, true, initialGroupChain);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCourseLoading(false);
    }
  }

  return (
    <div>
      <h1>Add Media</h1>

      <div className="form-panel">
        <label htmlFor="addmedia-type-1">Type</label>
        <select id="addmedia-type-1" value={type} onChange={(e) => { setType(e.target.value as MediaType); setResults(null); }}>
          {mediaTypes.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>

        {activeTypeInfo?.hasMetadataSearch && (
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
          <button type="button" className="secondary" onClick={goManual}>
            Add manually (no metadata)
          </button>
        ) : (
          <>
            <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
              {activeTypeInfo?.label} has no metadata search provider — add it manually below.
            </p>
            <button type="button" onClick={goManual}>
              Add manually
            </button>
          </>
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

      {results && (
        <div className="grid">
          {results.length === 0 && <p className="empty">No results found.</p>}
          {results.map((r, idx) => (
            <div key={idx} className="card" onClick={() => goToPreview(r, false)} style={r.excluded ? { opacity: 0.5 } : undefined}>
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
    </div>
  );
}
