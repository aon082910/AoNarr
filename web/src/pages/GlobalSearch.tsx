import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { addRecentSearch, clearRecentSearches, getRecentSearches } from "../utils/recentSearches.js";

interface LibrarySearchResult {
  mediaItemId: number;
  type: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  matchedOn: "title" | "episode" | "child";
  matchDetail: string | null;
}

export default function GlobalSearch() {
  const navigate = useNavigate();
  const mediaTypes = useMediaTypes();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LibrarySearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [recent, setRecent] = useState<string[]>(getRecentSearches());
  const labelFor = (key: string) => mediaTypes.find((t) => t.key === key)?.label ?? key;

  async function doSearch(q: string) {
    if (!q.trim()) return;
    setSearching(true);
    try {
      const res = await api.get<LibrarySearchResult[]>(`/library-search?q=${encodeURIComponent(q.trim())}`);
      setResults(res);
      addRecentSearch(q);
      setRecent(getRecentSearches());
    } finally {
      setSearching(false);
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

  return (
    <div>
      <h1>Search</h1>
      <p style={{ color: "var(--muted)" }}>Search titles, episodes, albums, issues, and videos across every library at once.</p>
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
            Results <span style={{ color: "var(--muted)", fontWeight: 400 }}>({results.length})</span>
          </h2>
          {results.length === 0 && <p className="empty">Nothing matched.</p>}
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
        </>
      )}
    </div>
  );
}
