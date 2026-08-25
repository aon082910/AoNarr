import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";

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
  const [mode, setMode] = useState<"add" | number | null>(null);
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

  function openAdd() {
    setName("");
    setType("plex");
    setUrl("");
    setToken("");
    setMode("add");
  }

  function openEdit(l: FriendLibrary) {
    setName(l.name);
    setType(l.type);
    setUrl(l.url);
    setToken("");
    setMode(l.id);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name || !url || (mode === "add" && !token)) return;
    if (mode === "add") {
      await api.post("/friend-libraries", { name, type, url, token });
    } else if (typeof mode === "number") {
      await api.patch(`/friend-libraries/${mode}`, { name, type, url, ...(token ? { token } : {}) });
    }
    setMode(null);
    load();
  }

  async function removeLibrary(id: number) {
    await api.del(`/friend-libraries/${id}`);
    if (selectedId === id) {
      setSelectedId("");
      setMissing(null);
    }
    setMode(null);
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

  const editingLibrary = typeof mode === "number" ? libraries.find((l) => l.id === mode) ?? null : null;

  return (
    <div>
      <h1>Friend Libraries</h1>
      <p style={{ color: "var(--muted)" }}>
        A friend's own Plex/Jellyfin/Emby server, shared with you — different from the media
        server AoNarr manages its own library against in Settings. Compare their library against
        yours by title/year to see what they have that you don't, and add anything you want
        straight from the result. Click a tile to edit that library.
      </p>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", marginBottom: 16 }}>
        <div className="card" onClick={openAdd} style={{ padding: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontWeight: 600 }}>+ Add friend library</div>
        </div>
        {libraries.map((l) => (
          <div key={l.id} className="card" style={{ padding: 16 }}>
            <div onClick={() => openEdit(l)}>
              <div style={{ fontWeight: 600 }}>{l.name}</div>
              <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 4 }}>
                {TYPE_LABELS[l.type]} · {l.url}
              </div>
            </div>
            <button
              className="secondary"
              style={{ marginTop: 8 }}
              onClick={(e) => {
                e.stopPropagation();
                compare(l.id);
              }}
              disabled={loading && selectedId === l.id}
            >
              {loading && selectedId === l.id ? "Comparing..." : "Compare"}
            </button>
          </div>
        ))}
      </div>
      {libraries.length === 0 && <p className="empty">No friend libraries configured yet.</p>}

      {mode !== null && (mode === "add" || editingLibrary) && (
        <Modal title={mode === "add" ? "Add Friend Library" : `Edit — ${editingLibrary!.name}`} onClose={() => setMode(null)}>
          <form className="form-panel" onSubmit={submit} style={{ padding: 0 }}>
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
            <label>Token / API key{mode !== "add" && " (leave blank to keep current)"}</label>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={type === "plex" ? "X-Plex-Token, from your friend's account" : "API key, from your friend's server"}
              required={mode === "add"}
            />
            <div className="toolbar" style={{ justifyContent: "space-between", marginTop: 8 }}>
              <button type="submit">{mode === "add" ? "Add friend library" : "Save"}</button>
              {mode !== "add" && (
                <button type="button" className="danger" onClick={() => removeLibrary(mode as number)}>
                  Delete
                </button>
              )}
            </div>
          </form>
        </Modal>
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
