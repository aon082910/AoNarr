import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";
import type { DownloadClient } from "../types.js";
import { formatBytes } from "../utils/format.js";
import { notify } from "../utils/notify.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import { PlusCircleIcon, ZapIcon } from "../components/NavIcons.js";
import { TrashIcon } from "../components/ActionIcons.js";
import { PageToolbar, ToolbarButton } from "../components/PageToolbar.js";

type ClientType = "qbittorrent" | "sabnzbd" | "http" | "ytdlp" | "realdebrid" | "alldebrid" | "torbox" | "blackhole" | "slskd";

interface ClientHealthStats {
  uploadedTotalBytes: number;
  downloadedTotalBytes: number;
  globalRatio: number | null;
  ratioLimitEnabled: boolean;
  ratioLimit: number | null;
  torrentsOverRatioLimit: number;
}

interface RemotePathMapping {
  id: number;
  downloadClientId: number;
  remotePath: string;
  localPath: string;
  createdAt: string;
}

const TYPE_LABELS: Record<ClientType, string> = {
  qbittorrent: "qBittorrent",
  sabnzbd: "SABnzbd",
  http: "Direct HTTP download",
  ytdlp: "yt-dlp",
  realdebrid: "Real-Debrid",
  alldebrid: "AllDebrid",
  torbox: "TorBox",
  blackhole: "Blackhole (watch folder)",
  slskd: "Soulseek (via slskd)",
};

export default function DownloadClients() {
  const [clients, setClients] = useState<DownloadClient[]>([]);
  const [mode, setMode] = useState<"add" | number | null>(null);
  const [health, setHealth] = useState<Record<number, ClientHealthStats | "error">>({});
  const [testing, setTesting] = useState<number | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [testResultsAll, setTestResultsAll] = useState<Record<number, { ok: boolean; error?: string }>>({});
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<ClientType>("qbittorrent");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [category, setCategory] = useState("aonarr");
  const [audioOnly, setAudioOnly] = useState(false);

  const [mappings, setMappings] = useState<RemotePathMapping[]>([]);
  const [mappingClientId, setMappingClientId] = useState<number | "">("");
  const [mappingRemotePath, setMappingRemotePath] = useState("");
  const [mappingLocalPath, setMappingLocalPath] = useState("");
  const mappingSort = useSortableTable<RemotePathMapping, "client" | "remote" | "local">("client");

  const needsHost = type === "qbittorrent" || type === "sabnzbd" || type === "slskd";
  const needsWatchFolder = type === "blackhole";

  function load() {
    api.get<DownloadClient[]>("/download-clients").then(setClients);
    api.get<RemotePathMapping[]>("/remote-path-mappings").then(setMappings);
  }
  useEffect(load, []);

  async function addMapping(e: FormEvent) {
    e.preventDefault();
    if (!mappingClientId || !mappingRemotePath.trim() || !mappingLocalPath.trim()) return;
    await api.post("/remote-path-mappings", {
      downloadClientId: mappingClientId,
      remotePath: mappingRemotePath.trim(),
      localPath: mappingLocalPath.trim(),
    });
    setMappingRemotePath("");
    setMappingLocalPath("");
    load();
  }

  async function removeMapping(id: number) {
    await api.del(`/remote-path-mappings/${id}`);
    load();
  }

  function resetForm() {
    setName("");
    setType("qbittorrent");
    setHost("");
    setPort("");
    setUsername("");
    setPassword("");
    setApiKey("");
    setCategory("aonarr");
    setAudioOnly(false);
  }

  function openAdd() {
    resetForm();
    setTestResult(null);
    setMode("add");
  }

  function openEdit(c: DownloadClient) {
    setName(c.name);
    setType(c.type as ClientType);
    setHost(c.host ?? "");
    setPort(c.port ? String(c.port) : "");
    setUsername(c.username ?? "");
    setPassword("");
    setApiKey(c.apiKey ?? "");
    setCategory(c.category ?? "aonarr");
    setAudioOnly(!!c.audioOnly);
    setTestResult(null);
    setMode(c.id);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name || (needsHost && (!host || !port)) || (needsWatchFolder && !host)) return;
    const body = {
      name,
      type,
      host: needsHost || needsWatchFolder ? host : null,
      port: needsHost ? Number(port) : null,
      username: username || null,
      // Blank password on edit means "leave unchanged" — a real client's password never round-trips
      // back into this field, so clearing it and re-submitting would otherwise wipe it out.
      ...(mode === "add" || password ? { password: password || null } : {}),
      apiKey: apiKey || null,
      category,
      audioOnly,
    };
    try {
      if (mode === "add") {
        await api.post("/download-clients", body);
      } else if (typeof mode === "number") {
        await api.patch(`/download-clients/${mode}`, body);
      }
      setMode(null);
      load();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function remove(id: number) {
    try {
      await api.del(`/download-clients/${id}`);
      setMode(null);
      load();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function loadHealth(id: number) {
    try {
      const stats = await api.get<ClientHealthStats>(`/download-clients/${id}/health`);
      setHealth((prev) => ({ ...prev, [id]: stats }));
    } catch {
      setHealth((prev) => ({ ...prev, [id]: "error" }));
    }
  }

  async function testConnection(id: number) {
    setTesting(id);
    setTestResult(null);
    try {
      const result = await api.post<{ ok: boolean; error?: string }>(`/download-clients/${id}/test`);
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(null);
    }
  }

  async function testAll() {
    setTestingAll(true);
    for (const c of clients) {
      try {
        const result = await api.post<{ ok: boolean; error?: string }>(`/download-clients/${c.id}/test`);
        setTestResultsAll((prev) => ({ ...prev, [c.id]: result }));
      } catch (e) {
        setTestResultsAll((prev) => ({ ...prev, [c.id]: { ok: false, error: (e as Error).message } }));
      }
    }
    setTestingAll(false);
  }

  const editingClient = typeof mode === "number" ? clients.find((c) => c.id === mode) ?? null : null;

  return (
    <div>
      <h1>Download Clients</h1>
      <p style={{ color: "var(--muted)" }}>
        qBittorrent and SABnzbd talk to an external client over its API. "Direct HTTP download"
        and "yt-dlp" need no external client at all — AoNarr downloads the file itself, so add one
        of each you need without a host/port. Click a tile to edit it.
      </p>

      <PageToolbar
        left={
          <>
            <ToolbarButton icon={<PlusCircleIcon />} label="Add" onClick={openAdd} title="Add download client" />
            {clients.length > 0 && (
              <ToolbarButton
                icon={<ZapIcon />}
                label={testingAll ? "Testing..." : "Test All"}
                onClick={testAll}
                disabled={testingAll}
                title="Test all download clients"
              />
            )}
          </>
        }
      />

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", marginBottom: 16 }}>
        {clients.map((c) => (
          <div key={c.id} className="card" onClick={() => openEdit(c)} style={{ padding: 16 }}>
            <div style={{ fontWeight: 600 }}>{c.name}</div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 4 }}>
              {TYPE_LABELS[c.type as ClientType] ?? c.type}
              {c.host ? ` · ${c.host}:${c.port}` : ""}
            </div>
            <span className={`badge ${c.enabled ? "ok" : ""}`} style={{ marginTop: 8, display: "inline-block", marginRight: 6 }}>
              {c.enabled ? "Enabled" : "Disabled"}
            </span>
            {testResultsAll[c.id] && (
              <span className={`badge ${testResultsAll[c.id].ok ? "ok" : "danger"}`} title={testResultsAll[c.id].error} style={{ marginTop: 8, display: "inline-block" }}>
                {testResultsAll[c.id].ok ? "Test OK" : "Test failed"}
              </span>
            )}
          </div>
        ))}
      </div>
      {clients.length === 0 && <p className="empty">No download clients configured yet.</p>}

      {clients.length > 0 && (
        <div className="form-panel" style={{ marginTop: 24, maxWidth: 640 }}>
          <h2 style={{ marginBottom: 4 }}>Remote Path Mappings</h2>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
            Only needed when a download client runs on a different host/container than AoNarr and
            doesn't share the exact same filesystem layout (an SMB/NFS share mounted at a different
            path on each side, say). Rewrites the path prefix that client reports for a completed
            download (qBittorrent's content/save path, SABnzbd's history storage path) to the
            matching path AoNarr sees, so the importer can locate that specific download's files
            directly instead of falling back to its usual downloads-directory-wide fuzzy match.
            Leave empty if AoNarr and your download client(s) already share one downloads folder —
            the overwhelming majority of setups need no mappings at all.
          </p>

          {mappings.length > 0 && (
            <table style={{ marginBottom: 12 }}>
              <thead>
                <tr>
                  {mappingSort.sortableHeader("client", "Client")}
                  {mappingSort.sortableHeader("remote", "Remote path")}
                  {mappingSort.sortableHeader("local", "Local path")}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {mappingSort
                  .sortRows(mappings, (a, b, key) => {
                    if (key === "client") {
                      const nameA = clients.find((c) => c.id === a.downloadClientId)?.name ?? "";
                      const nameB = clients.find((c) => c.id === b.downloadClientId)?.name ?? "";
                      return nameA.localeCompare(nameB);
                    }
                    if (key === "remote") return a.remotePath.localeCompare(b.remotePath);
                    return a.localPath.localeCompare(b.localPath);
                  })
                  .map((m) => (
                  <tr key={m.id}>
                    <td>{clients.find((c) => c.id === m.downloadClientId)?.name ?? `#${m.downloadClientId}`}</td>
                    <td style={{ fontFamily: "monospace", fontSize: "0.85rem" }}>{m.remotePath}</td>
                    <td style={{ fontFamily: "monospace", fontSize: "0.85rem" }}>{m.localPath}</td>
                    <td>
                      <button type="button" className="icon-button danger" onClick={() => removeMapping(m.id)} title="Delete" aria-label="Delete">
                        <TrashIcon />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <form onSubmit={addMapping} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <label htmlFor="remotepathmapping-client">Client</label>
              <select
                id="remotepathmapping-client"
                value={mappingClientId}
                onChange={(e) => setMappingClientId(e.target.value ? Number(e.target.value) : "")}
                required
              >
                <option value="">Select...</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label htmlFor="remotepathmapping-remote">Remote path</label>
              <input
                id="remotepathmapping-remote"
                value={mappingRemotePath}
                onChange={(e) => setMappingRemotePath(e.target.value)}
                placeholder="C:\Downloads"
                required
              />
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label htmlFor="remotepathmapping-local">Local path</label>
              <input
                id="remotepathmapping-local"
                value={mappingLocalPath}
                onChange={(e) => setMappingLocalPath(e.target.value)}
                placeholder="/downloads"
                required
              />
            </div>
            <button type="submit">Add mapping</button>
          </form>
        </div>
      )}

      {mode !== null && (mode === "add" || editingClient) && (
        <Modal title={mode === "add" ? "Add Download Client" : `Edit — ${editingClient!.name}`} onClose={() => setMode(null)}>
          <form className="form-panel" onSubmit={submit} style={{ padding: 0 }}>
            <label htmlFor="downloadclients-name-1">Name</label>
            <input id="downloadclients-name-1" value={name} onChange={(e) => setName(e.target.value)} required />

            <label htmlFor="downloadclients-type-2">Type</label>
            <select id="downloadclients-type-2" value={type} onChange={(e) => setType(e.target.value as ClientType)}>
              <option value="qbittorrent">qBittorrent</option>
              <option value="sabnzbd">SABnzbd</option>
              <option value="http">Direct HTTP download (for DDL/RSS indexer results)</option>
              <option value="ytdlp">yt-dlp (for Online Videos)</option>
              <option value="realdebrid">Real-Debrid</option>
              <option value="alldebrid">AllDebrid</option>
              <option value="torbox">TorBox</option>
              <option value="blackhole">Blackhole (watch folder)</option>
              <option value="slskd">Soulseek (via slskd)</option>
            </select>

            {needsHost && (
              <>
                <label htmlFor="downloadclients-host-3">Host</label>
                <input id="downloadclients-host-3" value={host} onChange={(e) => setHost(e.target.value)} required placeholder="192.168.1.10" />
                <label htmlFor="downloadclients-port-4">Port</label>
                <input id="downloadclients-port-4" value={port} onChange={(e) => setPort(e.target.value)} type="number" required />
              </>
            )}

            {type === "qbittorrent" && (
              <>
                <label htmlFor="downloadclients-username-5">Username</label>
                <input id="downloadclients-username-5" value={username} onChange={(e) => setUsername(e.target.value)} />
                <label htmlFor="downloadclients-password-mode-add-leave-blank-to-keep-cu-6">Password{mode !== "add" && " (leave blank to keep current)"}</label>
                <input id="downloadclients-password-mode-add-leave-blank-to-keep-cu-6" value={password} onChange={(e) => setPassword(e.target.value)} type="password" />
              </>
            )}

            {type === "sabnzbd" && (
              <>
                <label htmlFor="downloadclients-api-key-7">API key</label>
                <input id="downloadclients-api-key-7" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              </>
            )}

            {type === "realdebrid" && (
              <>
                <label htmlFor="downloadclients-api-token-8">API token</label>
                <input id="downloadclients-api-token-8" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
                  From real-debrid.com → Account → API Token. AoNarr sends grabbed magnet/torrent
                  links to Real-Debrid, waits for it to cache them, then downloads the unrestricted
                  link(s) directly — no host/port needed, it's always their public API.
                </p>
              </>
            )}

            {needsWatchFolder && (
              <>
                <label htmlFor="downloadclients-watch-folder-path-9">Watch folder path</label>
                <input id="downloadclients-watch-folder-path-9" value={host} onChange={(e) => setHost(e.target.value)} required placeholder="/downloads/blackhole" />
                <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
                  Fire-and-forget: for a client with no usable API, AoNarr just drops a .torrent/
                  .magnet/.nzb file here for a separately-configured external client watching this same
                  folder to pick up on its own. AoNarr can't track its progress or auto-import the
                  finished file — point that client's own completed-download output at one of your
                  root folders to get files into the library.
                </p>
              </>
            )}

            {type === "alldebrid" && (
              <>
                <label htmlFor="downloadclients-api-key-10">API key</label>
                <input id="downloadclients-api-key-10" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
                  From alldebrid.com → Account → API keys. AoNarr sends grabbed magnet/torrent links
                  to AllDebrid, waits for it to cache them, then downloads the unlocked link(s)
                  directly — no host/port needed, it's always their public API.
                </p>
              </>
            )}

            {type === "torbox" && (
              <>
                <label htmlFor="downloadclients-api-key-11">API key</label>
                <input id="downloadclients-api-key-11" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
                  From torbox.app → Settings → API key. AoNarr sends grabbed magnet/torrent links to
                  TorBox, waits for it to cache them, then downloads the file(s) directly — no
                  host/port needed, it's always their public API.
                </p>
              </>
            )}

            {type === "ytdlp" && (
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={audioOnly} onChange={(e) => setAudioOnly(e.target.checked)} />
                Audio only (extract to mp3 — for ripping music from a video)
              </label>
            )}

            {type === "slskd" && (
              <>
                <label htmlFor="downloadclients-api-key-12">API key</label>
                <input id="downloadclients-api-key-12" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
                  slskd's own configured API key (slskd.yml → web → authentication). AoNarr searches
                  Soulseek directly for Music library items and enqueues downloads through slskd, the
                  same way it talks to qBittorrent/SABnzbd — point slskd's own download directory at a
                  location AoNarr's importer can reach, the same as any other external client.
                </p>
              </>
            )}

            {needsHost && (
              <>
                <label htmlFor="downloadclients-category-13">Category</label>
                <input id="downloadclients-category-13" value={category} onChange={(e) => setCategory(e.target.value)} />
              </>
            )}

            {mode !== "add" && (
              <div className="toolbar" style={{ justifyContent: "space-between" }}>
                <button type="button" className="secondary" onClick={() => testConnection(mode as number)} disabled={testing === mode}>
                  {testing === mode ? "Testing..." : "Test connection"}
                </button>
                {type === "qbittorrent" && (
                  <button type="button" className="secondary" onClick={() => loadHealth(mode as number)}>
                    Check health
                  </button>
                )}
                {testResult && (
                  <span className={testResult.ok ? "badge ok" : "badge danger"}>
                    {testResult.ok ? "Connection OK" : testResult.error ?? "Test failed"}
                  </span>
                )}
                {health[mode as number] === "error" && <span style={{ color: "var(--danger)" }}>Could not fetch health stats.</span>}
              </div>
            )}
            {mode !== "add" && (() => {
              const stats = health[mode as number];
              return stats && stats !== "error" ? (
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", color: "var(--muted)", fontSize: "0.85rem" }}>
                  <span>Uploaded: {formatBytes(stats.uploadedTotalBytes)}</span>
                  <span>Downloaded: {formatBytes(stats.downloadedTotalBytes)}</span>
                  <span>Ratio: {stats.globalRatio !== null ? stats.globalRatio.toFixed(2) : "-"}</span>
                  <span>
                    Ratio limit: {stats.ratioLimitEnabled ? stats.ratioLimit : "disabled"}
                    {stats.ratioLimitEnabled && ` (${stats.torrentsOverRatioLimit} torrent(s) at/over limit)`}
                  </span>
                </div>
              ) : null;
            })()}

            <div className="toolbar" style={{ justifyContent: "space-between", marginTop: 8 }}>
              <button type="submit">{mode === "add" ? "Add download client" : "Save"}</button>
              {mode !== "add" && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => remove(mode as number)}
                >
                  Delete
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
