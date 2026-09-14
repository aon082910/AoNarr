import { useState, type FormEvent } from "react";
import Modal from "./Modal.js";
import { api } from "../api/client.js";

export interface MetadataSearchResult {
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
  releaseDate?: string | null;
  backdropUrl?: string | null;
  rating?: number | null;
  runtimeMinutes?: number | null;
  studio?: string | null;
}

/**
 * Radarr/Sonarr-style "interactive search" popup: re-run metadata search with a query the admin
 * controls (rather than whatever the item's own stored title happens to be — the whole point,
 * since a wrong/garbled title is exactly what makes an item need this) and pick the right result
 * to re-point the item at. Search only, no "add" — this always applies to an item that already
 * exists, via onSelect.
 */
export default function SearchMatchModal({
  type,
  initialQuery,
  initialYear,
  providers,
  onClose,
  onSelect,
  title = "Search for a different match",
  description = 'Search with your own query instead of this item\'s current title — useful when the stored title is wrong or garbled and metadata lookups keep coming up empty. Picking a result re-points this item at it (title, year, overview, poster, external ids); episodes/files already on disk are left alone.',
}: {
  type: string;
  initialQuery: string;
  initialYear?: number | null;
  providers: string[];
  onClose: () => void;
  onSelect: (result: MetadataSearchResult) => void;
  title?: string;
  description?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [searchYear, setSearchYear] = useState(initialYear ? String(initialYear) : "");
  const [provider, setProvider] = useState(providers[0] ?? "");
  const [results, setResults] = useState<MetadataSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchMode, setSearchMode] = useState<"title" | "id">("title");
  const [idInput, setIdInput] = useState("");

  async function runSearch(e?: FormEvent) {
    e?.preventDefault();
    if (!query.trim() || !provider) return;
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

  async function runIdMatch(e?: FormEvent) {
    e?.preventDefault();
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

  async function pick(result: MetadataSearchResult) {
    setApplying(true);
    setError(null);
    try {
      await onSelect(result);
    } catch (e) {
      setError((e as Error).message);
      setApplying(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose} maxWidth={640}>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>{description}</p>

      <div className="toolbar" style={{ marginBottom: 8 }}>
        <button type="button" className={searchMode === "title" ? "" : "secondary"} onClick={() => setSearchMode("title")}>
          By title
        </button>
        <button type="button" className={searchMode === "id" ? "" : "secondary"} onClick={() => setSearchMode("id")}>
          By ID / URL
        </button>
        {providers.length > 1 && (
          <select value={provider} onChange={(e) => setProvider(e.target.value)} style={{ maxWidth: 140 }}>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </div>

      {searchMode === "title" ? (
        <form onSubmit={runSearch} className="toolbar" style={{ marginBottom: 12 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title..."
            style={{ flex: 1 }}
            autoFocus
          />
          <input
            value={searchYear}
            onChange={(e) => setSearchYear(e.target.value)}
            placeholder="Year"
            type="number"
            title="Optional — narrows/re-ranks results toward this year"
            style={{ width: 80 }}
          />
          <button type="submit" disabled={searching || applying}>
            {searching ? "Searching..." : "Search"}
          </button>
        </form>
      ) : (
        <form onSubmit={runIdMatch} className="toolbar" style={{ marginBottom: 12 }}>
          <input
            value={idInput}
            onChange={(e) => setIdInput(e.target.value)}
            placeholder='ID (e.g. "tt1234567") or a provider URL'
            style={{ flex: 1 }}
            autoFocus
          />
          <button type="submit" disabled={searching || applying}>
            {searching ? "Matching..." : "Match"}
          </button>
        </form>
      )}

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {results && results.length === 0 && <p className="empty">No results.</p>}
      {results && results.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "50vh", overflowY: "auto" }}>
          {results.map((r, i) => (
            <div
              key={i}
              className="form-panel"
              style={{ display: "flex", gap: 12, cursor: applying ? "default" : "pointer", margin: 0, opacity: applying ? 0.6 : 1 }}
              onClick={() => !applying && pick(r)}
            >
              {r.posterUrl ? (
                <img src={r.posterUrl} alt="" style={{ width: 50, height: 75, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} />
              ) : (
                <div style={{ width: 50, height: 75, background: "var(--input-bg)", borderRadius: 4, flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{r.title}</strong> {r.year ? `(${r.year})` : ""}
                {r.overview && (
                  <p
                    style={{
                      fontSize: "0.8rem",
                      color: "var(--muted)",
                      margin: "4px 0 0",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {r.overview}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
