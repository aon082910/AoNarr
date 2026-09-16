import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { addRecentSearch, clearRecentSearches, getRecentSearches } from "../utils/recentSearches.js";
import { useAuth } from "../context/AuthContext.js";

interface LibrarySearchResult {
  mediaItemId: number;
  type: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  matchedOn: "title" | "episode" | "child";
  matchDetail: string | null;
}

interface MetadataSearchResult {
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
}

interface AddResultGroup {
  type: string;
  results: MetadataSearchResult[];
}

/** Loose title match (case/diacritic/punctuation-insensitive) — used only to drop a metadata
 * search hit from "Add new" when it's obviously the same thing already sitting in the library
 * results above, not to be a precise duplicate detector (AddMedia's own add flow still runs the
 * real duplicate check). */
function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

export default function GlobalSearch() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const mediaTypes = useMediaTypes();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LibrarySearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [addResults, setAddResults] = useState<AddResultGroup[] | null>(null);
  const [addSearching, setAddSearching] = useState(false);
  const [recent, setRecent] = useState<string[]>(getRecentSearches());
  const labelFor = (key: string) => mediaTypes.find((t) => t.key === key)?.label ?? key;

  async function doSearch(q: string) {
    if (!q.trim()) return;
    setSearching(true);
    const trimmed = q.trim();

    const libraryPromise = api
      .get<LibrarySearchResult[]>(`/library-search?q=${encodeURIComponent(trimmed)}`)
      .then((res) => {
        setResults(res);
        return res;
      })
      .finally(() => setSearching(false));

    // "Add new" is admin-only, same as the Add Media page itself (/add is not even routed for a
    // non-admin household account) — /metadata/search is admin-gated server-side too, so this also
    // just avoids firing requests that would 401 anyway.
    if (!auth.isAdmin) {
      await libraryPromise;
      addRecentSearch(q);
      setRecent(getRecentSearches());
      return;
    }

    setAddSearching(true);
    setAddResults(null);

    // Fired alongside the library search (not after it) so "search everything" doesn't feel
    // slower than it used to — every library-type with a real metadata backend (TMDB, TVDB,
    // MusicBrainz, etc.) gets queried in parallel, and a type with no provider configured (a
    // missing API key, or a type like Courses with no metadata search at all) just contributes
    // nothing rather than surfacing an error for every other type's results.
    const searchableTypes = mediaTypes.filter((t) => t.hasMetadataSearch);
    const addPromise = Promise.allSettled(
      searchableTypes.map((t) =>
        api
          .get<MetadataSearchResult[]>(`/metadata/search?type=${t.key}&query=${encodeURIComponent(trimmed)}`)
          .then((res): AddResultGroup => ({ type: t.key, results: res.slice(0, 6) }))
      )
    ).then(async (settled) => {
      const libraryResults = await libraryPromise;
      const ownedTitles = new Set(
        libraryResults.filter((r) => r.matchedOn === "title").map((r) => `${r.type}:${normalizeTitle(r.title)}`)
      );
      const groups = settled
        .filter((s): s is PromiseFulfilledResult<AddResultGroup> => s.status === "fulfilled")
        .map((s) => s.value)
        .map((g) => ({ ...g, results: g.results.filter((r) => !ownedTitles.has(`${g.type}:${normalizeTitle(r.title)}`)) }))
        .filter((g) => g.results.length > 0);
      setAddResults(groups);
    });

    try {
      await Promise.all([libraryPromise, addPromise]);
    } finally {
      setAddSearching(false);
      addRecentSearch(q);
      setRecent(getRecentSearches());
    }
  }

  async function runSearch(e: FormEvent) {
    e.preventDefault();
    await doSearch(query);
  }

  function runRecent(q: string) {
    setQuery(q);
    doSearch(q);
  }

  function clearRecent() {
    clearRecentSearches();
    setRecent([]);
  }

  function goAdd(type: string, title: string) {
    navigate(`/add?type=${encodeURIComponent(type)}&q=${encodeURIComponent(title)}`);
  }

  return (
    <div>
      <h1>Search</h1>
      <p style={{ color: "var(--muted)" }}>
        Search titles, episodes, albums, issues, and videos across every library at once — and, for
        anything not already in your libraries, across every configured metadata provider so you
        can add it.
      </p>
      <form className="form-panel" onSubmit={runSearch} style={{ maxWidth: 480 }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search everything..." autoFocus />
        <button type="submit" disabled={searching}>
          {searching ? "Searching..." : "Search"}
        </button>
      </form>

      {recent.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>Recent:</span>
          {recent.map((q) => (
            <span key={q} className="badge" style={{ cursor: "pointer" }} onClick={() => runRecent(q)}>
              {q}
            </span>
          ))}
          <span
            style={{ color: "var(--muted)", fontSize: "0.8rem", cursor: "pointer", textDecoration: "underline" }}
            onClick={clearRecent}
          >
            Clear
          </span>
        </div>
      )}

      {results && (
        <>
          <h2>
            In your library <span style={{ color: "var(--muted)", fontWeight: 400 }}>({results.length})</span>
          </h2>
          {results.length === 0 && <p className="empty">Nothing matched.</p>}
          {results.length > 0 && (
            <div className="grid">
              {results.map((r) => (
                <div key={r.mediaItemId} className="card" onClick={() => navigate(`/media/${r.mediaItemId}`)}>
                  <div className="poster" style={r.posterUrl ? { backgroundImage: `url(${r.posterUrl})` } : undefined}>
                    {!r.posterUrl && "No poster"}
                  </div>
                  <div className="meta">
                    <div className="title">{r.title}</div>
                    <div className="sub">
                      {r.year ?? ""} · {labelFor(r.type)}
                      {r.matchedOn !== "title" && r.matchDetail ? ` · matched "${r.matchDetail}"` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {(addSearching || (addResults && addResults.length > 0)) && (
        <>
          <h2 style={{ marginTop: 32 }}>Add new</h2>
          <p style={{ color: "var(--muted)", marginTop: 0 }}>
            Not in your library yet — found on each type's metadata provider. Pick one to continue
            to Add Media with root folder, quality, and monitoring options.
          </p>
          {addSearching && !addResults && <p className="empty">Searching metadata providers...</p>}
          {addResults?.map((group) => (
            <div key={group.type} style={{ marginBottom: 20 }}>
              <h3 style={{ marginBottom: 8 }}>{labelFor(group.type)}</h3>
              <div className="grid">
                {group.results.map((r, idx) => (
                  <div key={idx} className="card" onClick={() => goAdd(group.type, r.title)}>
                    <div className="poster" style={r.posterUrl ? { backgroundImage: `url(${r.posterUrl})` } : undefined}>
                      {!r.posterUrl && "No poster"}
                    </div>
                    <div className="meta">
                      <div className="title">{r.title}</div>
                      <div className="sub">{r.year ?? ""}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
