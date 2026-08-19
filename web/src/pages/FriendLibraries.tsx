import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";

interface FriendLibrary {
  id: number;
  name: string;
  type: "plex" | "jellyfin" | "emby";
  url: string;
  createdAt: string;
}

interface FriendLibraryItem {
  title: string;
  year: number | null;
  type: "movie" | "series";
}

const TYPE_LABELS: Record<FriendLibrary["type"], string> = { plex: "Plex", jellyfin: "Jellyfin", emby: "Emby" };

export default function FriendLibraries() {
  const [libraries, setLibraries] = useState<FriendLibrary[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState<FriendLibrary["type"]>("plex");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  const [selectedId, setSelectedId] = useState<number | "">("");
  const [missing, setMissing] = useState<FriendLibraryItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.get<FriendLibrary[]>("/friend-libraries").then(setLibraries);
  }
  useEffect(load, []);

  async function addLibrary(e: FormEvent) {
    e.preventDefault();
    if (!name || !url || !token) return;
    await api.post("/friend-libraries", { name, type, url, token });
    setName("");
    setUrl("");
    setToken("");
    load();
  }

  async function removeLibrary(id: number) {
    await api.del(`/friend-libraries/${id}`);
    if (selectedId === id) {
      setSelectedId("");
      setMissing(null);
    }
    load();
  }

  async function compare(id: number) {
    setSelectedId(id);
    setLoading(true);
    setError(null);
    setMissing(null);
    try {
      const result = await api.get<FriendLibraryItem[]>(`/friend-libraries/${id}/compare`);
      setMissing(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1>Friend Libraries</h1>
      <p style={{ color: "var(--muted)" }}>
        A friend's own Plex/Jellyfin/Emby server, shared with you — different from the media
        server AoNarr manages its own library against in Settings. Compare their library against
        yours by title/year to see what they have that you don't, and add anything you want
        straight from the result.
      </p>

      <form className="form-panel" onSubmit={addLibrary}>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex's Plex" required />
        <label>Type</label>
        <select value={type} onChange={(e) => setType(e.target.value as FriendLibrary["type"])}>
          <option value="plex">Plex</option>
          <option value="jellyfin">Jellyfin</option>
          <option value="emby">Emby</option>
        </select>
        <label>URL (base, as reachable from this instance)</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.60:32400" required />
        <label>Token / API key</label>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={type === "plex" ? "X-Plex-Token, from your friend's account" : "API key, from your friend's server"}
          required
        />
        <button type="submit">Add friend library</button>
      </form>

      {libraries.length === 0 && <p className="empty">No friend libraries configured yet.</p>}
      {libraries.length > 0 && (
        <table style={{ marginBottom: 20 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>URL</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {libraries.map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td>
                <td>{TYPE_LABELS[l.type]}</td>
                <td>{l.url}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button className="secondary" onClick={() => compare(l.id)} disabled={loading && selectedId === l.id}>
                    {loading && selectedId === l.id ? "Comparing..." : "Compare"}
                  </button>
                  <button className="danger" onClick={() => removeLibrary(l.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {missing && (
        <>
          <h2>Missing from your library</h2>
          {missing.length === 0 && <p className="empty">Nothing missing — your library already covers everything they have.</p>}
          {missing.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Year</th>
                  <th>Type</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {missing.map((item, i) => (
                  <tr key={i}>
                    <td>{item.title}</td>
                    <td>{item.year ?? ""}</td>
                    <td>{item.type === "movie" ? "Movie" : "Series"}</td>
                    <td>
                      <Link to={`/add?q=${encodeURIComponent(item.title)}&type=${item.type}`}>
                        <button type="button" className="secondary">
                          Add
                        </button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
