import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import type { QualityProfile } from "../types.js";

interface ImportList {
  id: number;
  name: string;
  type: "trakt" | "imdb" | "lastfm";
  url: string;
  enabled: 0 | 1;
  quality_profile_id: number | null;
  last_synced_at: string | null;
  last_added_count: number | null;
  last_error: string | null;
}

const TYPE_LABELS: Record<ImportList["type"], string> = { trakt: "Trakt", imdb: "IMDb", lastfm: "Last.fm" };
const URL_PLACEHOLDERS: Record<ImportList["type"], string> = {
  trakt: "https://trakt.tv/users/you/lists/to-watch (or .../watchlist)",
  imdb: "https://www.imdb.com/list/ls123456789/",
  lastfm: "https://www.last.fm/user/yourname (or just a username)",
};

export default function ImportLists() {
  const [lists, setLists] = useState<ImportList[]>([]);
  const [profiles, setProfiles] = useState<QualityProfile[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState<ImportList["type"]>("trakt");
  const [url, setUrl] = useState("");
  const [qualityProfileId, setQualityProfileId] = useState<number | "">("");
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
    await api.post("/import-lists", { name, type, url, qualityProfileId: qualityProfileId || null });
    setName("");
    setUrl("");
    load();
  }

  async function toggleEnabled(list: ImportList) {
    await api.patch(`/import-lists/${list.id}`, { enabled: !list.enabled });
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
        auto-search, so anything new on the list gets added to your library automatically. Trakt
        and IMDb lists add movies/shows; a Last.fm profile adds its all-time top artists to Music
        (Last.fm has no user-playlist concept of its own, so top artists is the closest
        equivalent).
      </p>

      <form className="form-panel" onSubmit={addList}>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My watchlist" required />
        <label>Type</label>
        <select value={type} onChange={(e) => setType(e.target.value as ImportList["type"])}>
          <option value="trakt">Trakt</option>
          <option value="imdb">IMDb</option>
          <option value="lastfm">Last.fm</option>
        </select>
        <label>URL</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={URL_PLACEHOLDERS[type]} required />
        {profiles.length > 0 && (
          <>
            <label>Quality profile</label>
            <select value={qualityProfileId} onChange={(e) => setQualityProfileId(e.target.value ? Number(e.target.value) : "")}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </>
        )}
        <button type="submit">Add import list</button>
      </form>

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {lists.length === 0 && <p className="empty">No import lists configured yet.</p>}
      {lists.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Enabled</th>
              <th>Last synced</th>
              <th>Last result</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lists.map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td>
                <td>{TYPE_LABELS[l.type]}</td>
                <td>
                  <input type="checkbox" checked={!!l.enabled} onChange={() => toggleEnabled(l)} />
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
