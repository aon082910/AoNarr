import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import type { QualityProfile } from "../types.js";

interface ImportList {
  id: number;
  name: string;
  type: "trakt" | "imdb" | "lastfm" | "tmdb";
  url: string;
  enabled: 0 | 1;
  quality_profile_id: number | null;
  require_review: 0 | 1;
  last_synced_at: string | null;
  last_added_count: number | null;
  last_error: string | null;
  min_rating: number | null;
  min_votes: number | null;
  exclude_genres: string | null; // JSON array
}

/** Last.fm's top-artists endpoint has no rating/vote/genre data to filter on — these fields are a
 * no-op for that type either way (services/importLists.ts's passesListFilters never rejects on
 * data an entry doesn't have), but hiding them for lastfm avoids implying they do something. */
function listSupportsFilters(type: ImportList["type"]): boolean {
  return type !== "lastfm";
}

function parseGenresList(json: string | null): string {
  if (!json) return "";
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.join(", ") : "";
  } catch {
    return "";
  }
}

const TYPE_LABELS: Record<ImportList["type"], string> = { trakt: "Trakt", imdb: "IMDb", lastfm: "Last.fm", tmdb: "TMDB" };
const URL_PLACEHOLDERS: Record<ImportList["type"], string> = {
  trakt: "https://trakt.tv/users/you/lists/to-watch (or .../watchlist)",
  imdb: "https://www.imdb.com/list/ls123456789/",
  lastfm: "https://www.last.fm/user/yourname (or just a username)",
  tmdb: "https://www.themoviedb.org/list/8290123 (or just the numeric list id)",
};

export default function ImportLists() {
  const [lists, setLists] = useState<ImportList[]>([]);
  const { sortRows: sortLists, sortableHeader: listHeader } = useSortableTable<ImportList, "name" | "type" | "enabled" | "lastSynced">("name");
  const [profiles, setProfiles] = useState<QualityProfile[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState<ImportList["type"]>("trakt");
  const [url, setUrl] = useState("");
  const [qualityProfileId, setQualityProfileId] = useState<number | "">("");
  const [requireReview, setRequireReview] = useState(false);
  const [minRating, setMinRating] = useState("");
  const [minVotes, setMinVotes] = useState("");
  const [excludeGenres, setExcludeGenres] = useState("");
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewCounts, setReviewCounts] = useState<Record<number, number>>({});

  function load() {
    api.get<ImportList[]>("/import-lists").then(setLists);
    api.get<{ importListId: number; count: number }[]>("/import-review/counts").then((rows) => {
      setReviewCounts(Object.fromEntries(rows.map((r) => [r.importListId, r.count])));
    });
  }
  useEffect(() => {
    load();
    api.get<QualityProfile[]>("/quality-profiles").then((p) => {
      setProfiles(p);
      if (p.length > 0) setQualityProfileId(p[0].id);
    });
  }, []);

  async function addList(e: FormEvent) {
    e.preventDefault();
    if (!name || !url) return;
    await api.post("/import-lists", {
      name,
      type,
      url,
      qualityProfileId: qualityProfileId || null,
      requireReview,
      minRating: minRating || null,
      minVotes: minVotes || null,
      excludeGenres: excludeGenres || null,
    });
    setName("");
    setUrl("");
    setMinRating("");
    setMinVotes("");
    setExcludeGenres("");
    load();
  }

  async function saveFilter(list: ImportList, field: "minRating" | "minVotes" | "excludeGenres", value: string) {
    await api.patch(`/import-lists/${list.id}`, { [field]: value || null });
    load();
  }

  async function toggleEnabled(list: ImportList) {
    await api.patch(`/import-lists/${list.id}`, { enabled: !list.enabled });
    load();
  }

  async function toggleRequireReview(list: ImportList) {
    await api.patch(`/import-lists/${list.id}`, { requireReview: !list.require_review });
    load();
  }

  async function removeList(id: number) {
    await api.del(`/import-lists/${id}`);
    load();
  }

  async function syncNow(id: number) {
    setSyncingId(id);
    setError(null);
    try {
      const result = await api.post<{ added: number; error?: string }>(`/import-lists/${id}/sync`, {});
      if (result.error) setError(result.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncingId(null);
      load();
    }
  }

  return (
    <div>
      <h1>Import Lists</h1>
      <p style={{ color: "var(--muted)" }}>
        Recurring "auto-add anything new here" sources — re-checked on the same schedule as
        auto-search, so anything new on the list gets added to your library automatically. Trakt,
        IMDb, and TMDB lists add movies/shows (TMDB needs an API key set under Settings →
        Metadata); a Last.fm profile adds its all-time top artists to Music (Last.fm has no
        user-playlist concept of its own, so top artists is the closest equivalent).
      </p>

      <form className="form-panel" onSubmit={addList}>
        <label htmlFor="importlists-name-1">Name</label>
        <input id="importlists-name-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="My watchlist" required />
        <label htmlFor="importlists-type-2">Type</label>
        <select id="importlists-type-2" value={type} onChange={(e) => setType(e.target.value as ImportList["type"])}>
          <option value="trakt">Trakt</option>
          <option value="imdb">IMDb</option>
          <option value="lastfm">Last.fm</option>
          <option value="tmdb">TMDB</option>
        </select>
        <label htmlFor="importlists-url-3">URL</label>
        <input id="importlists-url-3" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={URL_PLACEHOLDERS[type]} required />
        {profiles.length > 0 && (
          <>
            <label htmlFor="importlists-quality-profile-4">Quality profile</label>
            <select id="importlists-quality-profile-4" value={qualityProfileId} onChange={(e) => setQualityProfileId(e.target.value ? Number(e.target.value) : "")}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </>
        )}
        {listSupportsFilters(type) && (
          <>
            <label htmlFor="importlists-minimum-rating-0-10-optional-5">Minimum rating (0-10, optional)</label>
            <input id="importlists-minimum-rating-0-10-optional-5"
              type="number"
              min="0"
              max="10"
              step="0.1"
              value={minRating}
              onChange={(e) => setMinRating(e.target.value)}
              placeholder="No minimum"
            />
            <label htmlFor="importlists-minimum-vote-count-optional-6">Minimum vote count (optional)</label>
            <input id="importlists-minimum-vote-count-optional-6" type="number" min="0" value={minVotes} onChange={(e) => setMinVotes(e.target.value)} placeholder="No minimum" />
            <label htmlFor="importlists-exclude-genres-comma-separated-optional-7">Exclude genres (comma-separated, optional)</label>
            <input id="importlists-exclude-genres-comma-separated-optional-7" value={excludeGenres} onChange={(e) => setExcludeGenres(e.target.value)} placeholder="e.g. Horror, Documentary" />
            <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
              A list still adds everything it has by default — these narrow it down. Skipped for an
              item whose rating/votes/genres aren't known, rather than excluding it over missing
              data.
            </p>
          </>
        )}
        <label className="toolbar" style={{ gap: 8 }}>
          <input type="checkbox" checked={requireReview} onChange={(e) => setRequireReview(e.target.checked)} style={{ width: "auto" }} />
          Require review before adding
        </label>
        <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
          When on, a match found on this list is queued on the Import Review page instead of being
          added to your library automatically — approve or dismiss each one by hand.
        </p>
        <button type="submit">Add import list</button>
      </form>

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {lists.length === 0 && <p className="empty">No import lists configured yet.</p>}
      {lists.length > 0 && (
        <table>
          <thead>
            <tr>
              {listHeader("name", "Name")}
              {listHeader("type", "Type")}
              {listHeader("enabled", "Enabled")}
              <th>Review before add</th>
              <th>Filters</th>
              {listHeader("lastSynced", "Last synced")}
              <th>Last result</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sortLists(lists, (a, b, key) => {
              if (key === "name") return a.name.localeCompare(b.name);
              if (key === "type") return a.type.localeCompare(b.type);
              if (key === "enabled") return a.enabled - b.enabled;
              return (a.last_synced_at ?? "").localeCompare(b.last_synced_at ?? "");
            }).map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td>
                <td>{TYPE_LABELS[l.type]}</td>
                <td>
                  <input type="checkbox" checked={!!l.enabled} onChange={() => toggleEnabled(l)} />
                </td>
                <td>
                  <input type="checkbox" checked={!!l.require_review} onChange={() => toggleRequireReview(l)} />
                </td>
                <td>
                  {listSupportsFilters(l.type) ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 140 }}>
                      <input
                        key={`${l.id}-rating-${l.min_rating}`}
                        type="number"
                        min="0"
                        max="10"
                        step="0.1"
                        defaultValue={l.min_rating ?? ""}
                        placeholder="Min rating"
                        title="Minimum rating (0-10)"
                        onBlur={(e) => saveFilter(l, "minRating", e.target.value)}
                        style={{ fontSize: "0.8rem" }}
                      />
                      <input
                        key={`${l.id}-votes-${l.min_votes}`}
                        type="number"
                        min="0"
                        defaultValue={l.min_votes ?? ""}
                        placeholder="Min votes"
                        title="Minimum vote count"
                        onBlur={(e) => saveFilter(l, "minVotes", e.target.value)}
                        style={{ fontSize: "0.8rem" }}
                      />
                      <input
                        key={`${l.id}-genres-${l.exclude_genres}`}
                        defaultValue={parseGenresList(l.exclude_genres)}
                        placeholder="Exclude genres"
                        title="Comma-separated genres to exclude"
                        onBlur={(e) => saveFilter(l, "excludeGenres", e.target.value)}
                        style={{ fontSize: "0.8rem" }}
                      />
                    </div>
                  ) : (
                    <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>N/A</span>
                  )}
                </td>
                <td>{l.last_synced_at ?? "Never"}</td>
                <td>
                  {l.last_error ? (
                    <span style={{ color: "var(--danger)" }}>{l.last_error}</span>
                  ) : l.last_added_count != null ? (
                    `+${l.last_added_count}`
                  ) : (
                    ""
                  )}
                  {reviewCounts[l.id] > 0 && (
                    <>
                      {" "}
                      <Link to="/import-review" className="badge" title="Titles that couldn't be confidently matched — review them manually">
                        {reviewCounts[l.id]} need review
                      </Link>
                    </>
                  )}
                </td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button className="secondary" onClick={() => syncNow(l.id)} disabled={syncingId === l.id}>
                    {syncingId === l.id ? "Syncing..." : "Sync now"}
                  </button>
                  <button className="danger" onClick={() => removeList(l.id)}>
                    Delete
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
