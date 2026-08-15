import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";

interface RemoteInstance {
  id: number;
  name: string;
  url: string;
  createdAt: string;
}

interface RemoteMediaItem {
  id: number;
  type: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  monitored: 0 | 1;
  hasFile: 0 | 1;
}

interface RemoteMediaTypeInfo {
  key: string;
  label: string;
}

export default function RemoteLibrary() {
  const [instances, setInstances] = useState<RemoteInstance[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  const [selectedId, setSelectedId] = useState<number | "">("");
  const [remoteTypes, setRemoteTypes] = useState<RemoteMediaTypeInfo[]>([]);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [items, setItems] = useState<RemoteMediaItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.get<RemoteInstance[]>("/remote-instances").then(setInstances);
  }
  useEffect(load, []);

  async function addInstance(e: FormEvent) {
    e.preventDefault();
    if (!name || !url || !apiKey) return;
    await api.post("/remote-instances", { name, url, apiKey });
    setName("");
    setUrl("");
    setApiKey("");
    load();
  }

  async function removeInstance(id: number) {
    await api.del(`/remote-instances/${id}`);
    if (selectedId === id) {
      setSelectedId("");
      setItems(null);
    }
    load();
  }

  useEffect(() => {
    if (selectedId === "") return;
    setError(null);
    api
      .get<RemoteMediaTypeInfo[]>(`/remote-instances/${selectedId}/media-types`)
      .then(setRemoteTypes)
      .catch((e) => setError((e as Error).message));
  }, [selectedId]);

  async function browse() {
    if (selectedId === "") return;
    setLoading(true);
    setError(null);
    try {
      const qs = typeFilter !== "all" ? `?type=${typeFilter}` : "";
      const result = await api.get<RemoteMediaItem[]>(`/remote-instances/${selectedId}/media${qs}`);
      setItems(result);
    } catch (e) {
      setError((e as Error).message);
      setItems(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1>Remote Library</h1>
      <p style={{ color: "var(--muted)" }}>
        Browse another AoNarr instance's library read-only — useful for a household running
        separate instances per location. Nothing here can be added, edited, or grabbed; it's just
        a window into the remote instance's own library.
      </p>

      <form className="form-panel" onSubmit={addInstance}>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cabin AoNarr" required />
        <label>URL (base, e.g. http://192.168.1.50:7878)</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} required />
        <label>API key</label>
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
        <button type="submit">Add remote instance</button>
      </form>

      {instances.length === 0 && <p className="empty">No remote instances configured yet.</p>}
      {instances.length > 0 && (
        <table style={{ marginBottom: 20 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>URL</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {instances.map((i) => (
              <tr key={i.id}>
                <td>{i.name}</td>
                <td>{i.url}</td>
                <td>
                  <button className="danger" onClick={() => removeInstance(i.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {instances.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <select value={selectedId} onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Select an instance...</option>
            {instances.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          {selectedId !== "" && (
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">All types</option>
              {remoteTypes.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          )}
          <button className="secondary" onClick={browse} disabled={selectedId === "" || loading}>
            {loading ? "Loading..." : "Browse"}
          </button>
        </div>
      )}

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {items && (
        <div className="grid">
          {items.length === 0 && <p className="empty">Nothing found.</p>}
          {items.map((item) => (
            <div key={item.id} className="card" style={{ cursor: "default" }}>
              <div className="poster" style={item.posterUrl ? { backgroundImage: `url(${item.posterUrl})` } : undefined}>
                {!item.posterUrl && "No poster"}
              </div>
              <div className="meta">
                <div className="title">{item.title}</div>
                <div className="sub">
                  {item.year ?? ""}
                  <span className={`badge ${item.hasFile ? "ok" : ""}`} style={{ marginLeft: 6 }}>
                    {item.hasFile ? "Downloaded" : "Missing"}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
