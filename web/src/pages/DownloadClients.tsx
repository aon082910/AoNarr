import { Fragment, useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";
import type { DownloadClient } from "../types.js";
import { formatBytes } from "../utils/format.js";

type ClientType = "qbittorrent" | "sabnzbd" | "http" | "ytdlp" | "realdebrid";

interface ClientHealthStats {
  uploadedTotalBytes: number;
  downloadedTotalBytes: number;
  globalRatio: number | null;
  ratioLimitEnabled: boolean;
  ratioLimit: number | null;
  torrentsOverRatioLimit: number;
}

export default function DownloadClients() {
  const [clients, setClients] = useState<DownloadClient[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [health, setHealth] = useState<Record<number, ClientHealthStats | "error">>({});
  const [name, setName] = useState("");
  const [type, setType] = useState<ClientType>("qbittorrent");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [category, setCategory] = useState("aonarr");
  const [audioOnly, setAudioOnly] = useState(false);

  const needsHost = type === "qbittorrent" || type === "sabnzbd";

  function load() {
    api.get<DownloadClient[]>("/download-clients").then(setClients);
  }
  useEffect(load, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name || (needsHost && (!host || !port))) return;
    await api.post("/download-clients", {
      name,
      type,
      host: needsHost ? host : null,
      port: needsHost ? Number(port) : null,
      username: username || null,
      password: password || null,
      apiKey: apiKey || null,
      category,
      audioOnly,
    });
    setName("");
    setHost("");
    setPort("");
    setUsername("");
    setPassword("");
    setApiKey("");
    setAudioOnly(false);
    setShowAdd(false);
    load();
  }

  async function remove(id: number) {
    await api.del(`/download-clients/${id}`);
    load();
  }

  async function toggleAudioOnly(id: number, value: boolean) {
    await api.patch(`/download-clients/${id}`, { audioOnly: value });
    load();
  }

  async function loadHealth(id: number) {
    try {
      const stats = await api.get<ClientHealthStats>(`/download-clients/${id}/health`);
      setHealth((prev) => ({ ...prev, [id]: stats }));
    } catch {
      setHealth((prev) => ({ ...prev, [id]: "error" }));
    }
  }

  return (
    <div>
      <h1>Download Clients</h1>
      <p style={{ color: "var(--muted)" }}>
        qBittorrent and SABnzbd talk to an external client over its API. "Direct HTTP download"
        and "yt-dlp" need no external client at all — AoNarr downloads the file itself, so add one
        of each you need without a host/port.
      </p>

      <button type="button" onClick={() => setShowAdd(true)} style={{ marginBottom: 16 }}>
        + Add download client
      </button>

      {showAdd && (
        <Modal title="Add Download Client" onClose={() => setShowAdd(false)}>
      <form className="form-panel" onSubmit={submit} style={{ padding: 0 }}>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required />

        <label>Type</label>
        <select value={type} onChange={(e) => setType(e.target.value as ClientType)}>
          <option value="qbittorrent">qBittorrent</option>
          <option value="sabnzbd">SABnzbd</option>
          <option value="http">Direct HTTP download (for DDL/RSS indexer results)</option>
          <option value="ytdlp">yt-dlp (for Online Videos)</option>
          <option value="realdebrid">Real-Debrid</option>
        </select>

        {needsHost && (
          <>
            <label>Host</label>
            <input value={host} onChange={(e) => setHost(e.target.value)} required placeholder="192.168.1.10" />
            <label>Port</label>
            <input value={port} onChange={(e) => setPort(e.target.value)} type="number" required />
          </>
        )}

        {type === "qbittorrent" && (
          <>
            <label>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
            <label>Password</label>
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" />
          </>
        )}

        {type === "sabnzbd" && (
          <>
            <label>API key</label>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </>
        )}

        {type === "realdebrid" && (
          <>
            <label>API token</label>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
              From real-debrid.com → Account → API Token. AoNarr sends grabbed magnet/torrent
              links to Real-Debrid, waits for it to cache them, then downloads the unrestricted
              link(s) directly — no host/port needed, it's always their public API.
            </p>
          </>
        )}

        {type === "ytdlp" && (
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={audioOnly} onChange={(e) => setAudioOnly(e.target.checked)} />
            Audio only (extract to mp3 — for ripping music from a video)
          </label>
        )}

        {needsHost && (
          <>
            <label>Category</label>
            <input value={category} onChange={(e) => setCategory(e.target.value)} />
          </>
        )}

        <button type="submit">Add download client</button>
      </form>
        </Modal>
      )}

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Host</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => {
            const stats = health[c.id];
            return (
              <Fragment key={c.id}>
                <tr>
                  <td>{c.name}</td>
                  <td>{c.type}</td>
                  <td>{c.host ? `${c.host}:${c.port}` : "-"}</td>
                  <td style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {c.type === "qbittorrent" && (
                      <button className="secondary" onClick={() => loadHealth(c.id)}>
                        Health
                      </button>
                    )}
                    {c.type === "ytdlp" && (
                      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.85rem" }}>
                        <input
                          type="checkbox"
                          checked={!!c.audioOnly}
                          onChange={(e) => toggleAudioOnly(c.id, e.target.checked)}
                        />
                        Audio only
                      </label>
                    )}
                    <button className="danger" onClick={() => remove(c.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
                {stats === "error" && (
                  <tr>
                    <td colSpan={4} style={{ color: "var(--danger)" }}>
                      Could not fetch health stats for "{c.name}".
                    </td>
                  </tr>
                )}
                {stats && stats !== "error" && (
                  <tr>
                    <td colSpan={4}>
                      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", color: "var(--muted)", fontSize: "0.85rem" }}>
                        <span>Uploaded: {formatBytes(stats.uploadedTotalBytes)}</span>
                        <span>Downloaded: {formatBytes(stats.downloadedTotalBytes)}</span>
                        <span>Ratio: {stats.globalRatio !== null ? stats.globalRatio.toFixed(2) : "-"}</span>
                        <span>
                          Ratio limit: {stats.ratioLimitEnabled ? stats.ratioLimit : "disabled"}
                          {stats.ratioLimitEnabled && ` (${stats.torrentsOverRatioLimit} torrent(s) at/over limit)`}
                        </span>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {clients.length === 0 && <p className="empty">No download clients configured yet.</p>}
    </div>
  );
}
