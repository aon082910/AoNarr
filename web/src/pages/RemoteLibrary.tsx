import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";
import { FolderIcon } from "../components/ActionIcons.js";
import { PlusCircleIcon } from "../components/NavIcons.js";
import { PageToolbar, ToolbarButton } from "../components/PageToolbar.js";

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
  const [mode, setMode] = useState<"add" | number | null>(null);
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

  function openAdd() {
    setName("");
    setUrl("");
    setApiKey("");
    setMode("add");
  }

  function openEdit(i: RemoteInstance) {
    setName(i.name);
    setUrl(i.url);
    setApiKey("");
    setMode(i.id);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name || !url || (mode === "add" && !apiKey)) return;
    if (mode === "add") {
      await api.post("/remote-instances", { name, url, apiKey });
    } else if (typeof mode === "number") {
      await api.patch(`/remote-instances/${mode}`, { name, url, ...(apiKey ? { apiKey } : {}) });
    }
    setMode(null);
    load();
  }

  async function removeInstance(id: number) {
    await api.del(`/remote-instances/${id}`);
    if (selectedId === id) {
      setSelectedId("");
      setItems(null);
    }
    setMode(null);
    load();
  }

  useEffect(() => {
    setTypeFilter("all");
    // Cleared unconditionally (not just when a new instance is actually selected) — otherwise the
    // previously-browsed instance's grid (or its error) stayed on screen with no indication it's
    // stale after switching the dropdown, until "Browse" was clicked again.
    setItems(null);
    setError(null);
    if (selectedId === "") return;
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

  const editingInstance = typeof mode === "number" ? instances.find((i) => i.id === mode) ?? null : null;

  return (
    <div>
      <h1>Remote Library</h1>
      <p style={{ color: "var(--muted)" }}>
        Browse another AoNarr instance's library read-only — useful for a household running
        separate instances per location. Nothing here can be added, edited, or grabbed; it's just
        a window into the remote instance's own library. Click a tile to edit that instance.
      </p>

      <PageToolbar
        left={<ToolbarButton icon={<PlusCircleIcon />} label="Add" onClick={openAdd} title="Add remote instance" />}
        right={
          instances.length > 0 ? (
            <>
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
              <ToolbarButton
                icon={<FolderIcon />}
                label={loading ? "Loading..." : "Browse"}
                onClick={browse}
                disabled={selectedId === "" || loading}
                title="Browse"
              />
            </>
          ) : undefined
        }
      />

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", marginBottom: 20 }}>
        {instances.map((i) => (
          <div key={i.id} className="card" onClick={() => openEdit(i)} style={{ padding: 16 }}>
            <div style={{ fontWeight: 600 }}>{i.name}</div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 4 }}>{i.url}</div>
          </div>
        ))}
      </div>
      {instances.length === 0 && <p className="empty">No remote instances configured yet.</p>}

      {mode !== null && (mode === "add" || editingInstance) && (
        <Modal title={mode === "add" ? "Add Remote Instance" : `Edit — ${editingInstance!.name}`} onClose={() => setMode(null)}>
          <form className="form-panel" onSubmit={submit} style={{ padding: 0 }}>
            <label htmlFor="remotelibrary-name-1">Name</label>
            <input id="remotelibrary-name-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Cabin AoNarr" required />
            <label htmlFor="remotelibrary-url-base-e-g-http-192-168-1-50-9876-2">URL (base, e.g. http://192.168.1.50:9876)</label>
            <input id="remotelibrary-url-base-e-g-http-192-168-1-50-9876-2" value={url} onChange={(e) => setUrl(e.target.value)} required />
            <label htmlFor="remotelibrary-api-key-mode-add-leave-blank-to-keep-cur-3">API key{mode !== "add" && " (leave blank to keep current)"}</label>
            <input id="remotelibrary-api-key-mode-add-leave-blank-to-keep-cur-3" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required={mode === "add"} />
            <div className="toolbar" style={{ justifyContent: "space-between", marginTop: 8 }}>
              <button type="submit">{mode === "add" ? "Add remote instance" : "Save"}</button>
              {mode !== "add" && (
                <button type="button" className="danger" onClick={() => removeInstance(mode as number)}>
                  Delete
                </button>
              )}
            </div>
          </form>
        </Modal>
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
