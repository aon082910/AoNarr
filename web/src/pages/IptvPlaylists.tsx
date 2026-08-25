import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";

interface Playlist {
  id: number;
  name: string;
  enabled: 0 | 1;
  insertAfterMinutes: number | null;
  insertAfterEachItem: 0 | 1;
  fillerUrl: string | null;
  itemCount: number;
}

interface PlaylistItem {
  id: number;
  playlistId: number;
  position: number;
  title: string;
  externalUrl: string | null;
  mediaItemId: number | null;
  episodeId: number | null;
  durationSeconds: number | null;
}

export default function IptvPlaylists() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [token, setToken] = useState("");
  const [mode, setMode] = useState<"add" | number | null>(null);
  const [name, setName] = useState("");
  const [insertAfterMinutes, setInsertAfterMinutes] = useState("");
  const [insertAfterEachItem, setInsertAfterEachItem] = useState(false);
  const [fillerUrl, setFillerUrl] = useState("");

  const [items, setItems] = useState<PlaylistItem[] | null>(null);
  const [itemTitle, setItemTitle] = useState("");
  const [itemKind, setItemKind] = useState<"external" | "movie" | "episode">("external");
  const [itemUrl, setItemUrl] = useState("");
  const [itemRefId, setItemRefId] = useState("");
  const [itemDuration, setItemDuration] = useState("");

  function load() {
    api.get<Playlist[]>("/iptv/playlists").then(setPlaylists);
    api.get<{ token: string }>("/iptv/token").then((r) => setToken(r.token));
  }
  useEffect(load, []);

  function loadItems(playlistId: number) {
    api.get<PlaylistItem[]>(`/iptv/playlists/${playlistId}/items`).then(setItems);
  }

  function resetForm() {
    setName("");
    setInsertAfterMinutes("");
    setInsertAfterEachItem(false);
    setFillerUrl("");
    setItems(null);
    resetItemForm();
  }

  function resetItemForm() {
    setItemTitle("");
    setItemKind("external");
    setItemUrl("");
    setItemRefId("");
    setItemDuration("");
  }

  function openAdd() {
    resetForm();
    setMode("add");
  }

  function openEdit(p: Playlist) {
    setName(p.name);
    setInsertAfterMinutes(p.insertAfterMinutes != null ? String(p.insertAfterMinutes) : "");
    setInsertAfterEachItem(!!p.insertAfterEachItem);
    setFillerUrl(p.fillerUrl ?? "");
    setMode(p.id);
    loadItems(p.id);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name) return;
    const body = {
      name,
      insertAfterMinutes: insertAfterMinutes ? Number(insertAfterMinutes) : null,
      insertAfterEachItem,
      fillerUrl: fillerUrl || null,
    };
    if (mode === "add") {
      const created = await api.post<Playlist>("/iptv/playlists", body);
      setMode(created.id);
      loadItems(created.id);
    } else if (typeof mode === "number") {
      await api.patch(`/iptv/playlists/${mode}`, body);
    }
    load();
  }

  async function removePlaylist(id: number) {
    await api.del(`/iptv/playlists/${id}`);
    setMode(null);
    load();
  }

  async function regenerateToken() {
    if (!confirm("Regenerate the playlist token? Every feed URL already pasted into a media server will stop working until updated.")) return;
    const result = await api.post<{ token: string }>("/iptv/token/regenerate", {});
    setToken(result.token);
  }

  async function addItem(e: FormEvent) {
    e.preventDefault();
    if (typeof mode !== "number" || !itemTitle) return;
    const body: Record<string, unknown> = { title: itemTitle, durationSeconds: itemDuration ? Number(itemDuration) : null };
    if (itemKind === "external") body.externalUrl = itemUrl;
    else if (itemKind === "movie") body.mediaItemId = Number(itemRefId);
    else body.episodeId = Number(itemRefId);

    await api.post(`/iptv/playlists/${mode}/items`, body);
    resetItemForm();
    loadItems(mode);
    load();
  }

  async function moveItem(itemId: number, direction: "up" | "down") {
    if (typeof mode !== "number") return;
    const updated = await api.post<PlaylistItem[]>(`/iptv/playlists/${mode}/items/${itemId}/move`, { direction });
    setItems(updated);
  }

  async function removeItem(itemId: number) {
    if (typeof mode !== "number") return;
    await api.del(`/iptv/playlists/${mode}/items/${itemId}`);
    loadItems(mode);
    load();
  }

  const editingPlaylist = typeof mode === "number" ? playlists.find((p) => p.id === mode) ?? null : null;
  const feedUrl =
    typeof mode === "number" && token ? `${window.location.origin}/api/iptv/m3u/${mode}?token=${token}` : null;

  return (
    <div>
      <h1>IPTV Playlists</h1>
      <p style={{ color: "var(--muted)" }}>
        Custom M3U playlists a media server (Plex, Jellyfin, etc.) can subscribe to as a live-TV/
        tuner source — mixing AoNarr library items (streamed from their own downloaded files) with
        raw external stream URLs. Optionally insert a filler clip after each item or after a
        configured number of minutes — the filler is always a URL you supply yourself; AoNarr
        never sources or scrapes commercial content from anywhere. Click a tile to manage it.
      </p>
      <p style={{ color: "var(--muted)" }}>
        The library-item stream URLs embedded inside a feed are built from Settings → General's
        "External URL" if set (recommended — the feed is fetched by the media server, not your
        browser, so there's no request to guess the right address/port from otherwise); leave it
        unset and it falls back to a guess that may be missing your port behind a reverse proxy.
      </p>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", marginBottom: 16 }}>
        <div className="card" onClick={openAdd} style={{ padding: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontWeight: 600 }}>+ Add playlist</div>
        </div>
        {playlists.map((p) => (
          <div key={p.id} className="card" onClick={() => openEdit(p)} style={{ padding: 16 }}>
            <div style={{ fontWeight: 600 }}>{p.name}</div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 4 }}>
              {p.itemCount} item{p.itemCount === 1 ? "" : "s"}
            </div>
            <span className={`badge ${p.enabled ? "ok" : ""}`} style={{ marginTop: 8, display: "inline-block" }}>
              {p.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
        ))}
      </div>
      {playlists.length === 0 && <p className="empty">No IPTV playlists configured yet.</p>}

      {mode !== null && (mode === "add" || editingPlaylist) && (
        <Modal title={mode === "add" ? "Add Playlist" : `Edit — ${editingPlaylist?.name ?? ""}`} onClose={() => setMode(null)} maxWidth={760}>
          <form className="form-panel" onSubmit={submit} style={{ padding: 0 }}>
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
            <label>Insert filler after each item</label>
            <select value={insertAfterEachItem ? "1" : "0"} onChange={(e) => setInsertAfterEachItem(e.target.value === "1")}>
              <option value="0">No</option>
              <option value="1">Yes</option>
            </select>
            {!insertAfterEachItem && (
              <>
                <label>Insert filler every N minutes (blank = never)</label>
                <input
                  type="number"
                  style={{ maxWidth: 120 }}
                  value={insertAfterMinutes}
                  onChange={(e) => setInsertAfterMinutes(e.target.value)}
                />
              </>
            )}
            <label>Filler URL (your own content — leave blank to never insert one)</label>
            <input value={fillerUrl} onChange={(e) => setFillerUrl(e.target.value)} placeholder="https://example.com/my-bumper.mp4" />
            <button type="submit">{mode === "add" ? "Create playlist" : "Save"}</button>
          </form>

          {typeof mode === "number" && (
            <>
              {feedUrl && (
                <div className="form-panel">
                  <label>Feed URL — paste into Plex/Jellyfin's Live TV / tuner source setup</label>
                  <input value={feedUrl} readOnly onFocus={(e) => e.target.select()} />
                </div>
              )}

              <h3>Items</h3>
              <form className="form-panel" onSubmit={addItem}>
                <label>Title</label>
                <input value={itemTitle} onChange={(e) => setItemTitle(e.target.value)} required />
                <label>Source</label>
                <select value={itemKind} onChange={(e) => setItemKind(e.target.value as "external" | "movie" | "episode")}>
                  <option value="external">External stream URL</option>
                  <option value="movie">AoNarr movie (by media item id)</option>
                  <option value="episode">AoNarr TV episode (by episode id)</option>
                </select>
                {itemKind === "external" ? (
                  <>
                    <label>Stream URL</label>
                    <input value={itemUrl} onChange={(e) => setItemUrl(e.target.value)} required />
                  </>
                ) : (
                  <>
                    <label>{itemKind === "movie" ? "Media item ID" : "Episode ID"}</label>
                    <input
                      type="number"
                      style={{ maxWidth: 140 }}
                      value={itemRefId}
                      onChange={(e) => setItemRefId(e.target.value)}
                      required
                    />
                    <p style={{ color: "var(--muted)", fontSize: "0.78rem" }}>
                      Find the id in the item's own page URL (e.g. /media/42 → 42, or an episode row's id from its own page).
                    </p>
                  </>
                )}
                <label>Duration in seconds (used for the "every N minutes" filler timing; optional)</label>
                <input type="number" style={{ maxWidth: 140 }} value={itemDuration} onChange={(e) => setItemDuration(e.target.value)} />
                <button type="submit">Add item</button>
              </form>

              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Title</th>
                    <th>Source</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(items ?? []).map((it, idx) => (
                    <tr key={it.id}>
                      <td>{idx + 1}</td>
                      <td>{it.title}</td>
                      <td>
                        {it.externalUrl
                          ? "External URL"
                          : it.mediaItemId
                          ? `Movie #${it.mediaItemId}`
                          : `Episode #${it.episodeId}`}
                      </td>
                      <td className="toolbar">
                        <button className="secondary" disabled={idx === 0} onClick={() => moveItem(it.id, "up")}>
                          Up
                        </button>
                        <button className="secondary" disabled={idx === (items?.length ?? 0) - 1} onClick={() => moveItem(it.id, "down")}>
                          Down
                        </button>
                        <button className="danger" onClick={() => removeItem(it.id)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {items && items.length === 0 && <p className="empty">No items yet.</p>}

              <div className="toolbar" style={{ marginTop: 12 }}>
                <button className="danger" onClick={() => removePlaylist(mode)}>
                  Delete playlist
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      <div className="form-panel" style={{ marginTop: 16 }}>
        <label>Playlist token</label>
        <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
          Shared by every feed URL above — a media server subscribes with a plain URL and no
          custom headers, so this is gated by its own token instead of the admin API key.
        </p>
        <button type="button" className="danger" onClick={regenerateToken}>
          Regenerate token
        </button>
      </div>
    </div>
  );
}
