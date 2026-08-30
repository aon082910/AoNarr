import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";

interface IrcFeed {
  id: number;
  name: string;
  host: string;
  port: number;
  useSsl: 0 | 1;
  nickname: string;
  saslUser: string | null;
  saslPass: string | null;
  channel: string;
  announceRegex: string;
  protocol: "torrent" | "usenet";
  enabled: 0 | 1;
  createdAt: string;
}

const EXAMPLE_REGEX = String.raw`New: (?<title>.+?) - (?<url>https?://\S+)`;

export default function IrcFeeds() {
  const [feeds, setFeeds] = useState<IrcFeed[]>([]);
  const [mode, setMode] = useState<"add" | number | null>(null);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("6697");
  const [useSsl, setUseSsl] = useState(true);
  const [nickname, setNickname] = useState("");
  const [saslUser, setSaslUser] = useState("");
  const [saslPass, setSaslPass] = useState("");
  const [channel, setChannel] = useState("");
  const [announceRegex, setAnnounceRegex] = useState("");
  const [protocol, setProtocol] = useState<"torrent" | "usenet">("torrent");
  const [enabled, setEnabled] = useState(true);

  function load() {
    api.get<IrcFeed[]>("/irc-feeds").then(setFeeds);
  }
  useEffect(load, []);

  function resetForm() {
    setName("");
    setHost("");
    setPort("6697");
    setUseSsl(true);
    setNickname("");
    setSaslUser("");
    setSaslPass("");
    setChannel("");
    setAnnounceRegex("");
    setProtocol("torrent");
    setEnabled(true);
  }

  function openAdd() {
    resetForm();
    setMode("add");
  }

  function openEdit(f: IrcFeed) {
    setName(f.name);
    setHost(f.host);
    setPort(String(f.port));
    setUseSsl(!!f.useSsl);
    setNickname(f.nickname);
    setSaslUser(f.saslUser ?? "");
    setSaslPass(f.saslPass ?? "");
    setChannel(f.channel);
    setAnnounceRegex(f.announceRegex);
    setProtocol(f.protocol);
    setEnabled(!!f.enabled);
    setMode(f.id);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !host.trim() || !nickname.trim() || !channel.trim() || !announceRegex.trim()) return;
    const body = {
      name: name.trim(),
      host: host.trim(),
      port: Number(port) || 6697,
      useSsl,
      nickname: nickname.trim(),
      saslUser: saslUser.trim() || null,
      saslPass: saslPass.trim() || null,
      channel: channel.trim(),
      announceRegex: announceRegex.trim(),
      protocol,
      enabled,
    };
    try {
      if (mode === "add") await api.post("/irc-feeds", body);
      else if (typeof mode === "number") await api.patch(`/irc-feeds/${mode}`, body);
      setMode(null);
      load();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function removeFeed(id: number) {
    if (!confirm("Remove this IRC announce feed? It'll disconnect immediately.")) return;
    await api.del(`/irc-feeds/${id}`);
    setMode(null);
    load();
  }

  const editingFeed = typeof mode === "number" ? feeds.find((f) => f.id === mode) ?? null : null;

  return (
    <div>
      <h1>IRC Announce Feeds</h1>
      <p style={{ color: "var(--muted)" }}>
        Autobrr's core idea: a private tracker's announce channel monitored in real time instead of
        waiting on scheduled indexer search — a release can be grabbed within seconds of being
        posted. An announce only ever results in a grab if it matches something already monitored
        and missing in your library (same title/episode matching and quality-profile scoring the
        scheduled search already uses) — nothing is grabbed just because a message matched the
        regex. <code>announceRegex</code> needs named capture groups <code>title</code> and{" "}
        <code>url</code>, e.g. <code>{EXAMPLE_REGEX}</code> — everything else about parsing an
        announce line is specific to your tracker.
      </p>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", marginBottom: 16 }}>
        <div className="card" onClick={openAdd} style={{ padding: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontWeight: 600 }}>+ Add feed</div>
        </div>
        {feeds.map((f) => (
          <div key={f.id} className="card" onClick={() => openEdit(f)} style={{ padding: 16 }}>
            <div style={{ fontWeight: 600 }}>{f.name}</div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 4 }}>
              {f.host}:{f.port} · {f.channel}
            </div>
            <span className={`badge ${f.enabled ? "ok" : ""}`} style={{ marginTop: 8, display: "inline-block" }}>
              {f.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
        ))}
      </div>
      {feeds.length === 0 && <p className="empty">No IRC announce feeds configured yet.</p>}

      {mode !== null && (mode === "add" || editingFeed) && (
        <Modal title={mode === "add" ? "Add IRC Feed" : `Edit — ${editingFeed!.name}`} onClose={() => setMode(null)}>
          <form className="form-panel" onSubmit={submit} style={{ padding: 0 }}>
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
            <label>Host</label>
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="irc.example.net" required />
            <label>Port</label>
            <input type="number" style={{ maxWidth: 120 }} value={port} onChange={(e) => setPort(e.target.value)} />
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={useSsl} onChange={(e) => setUseSsl(e.target.checked)} />
              Use TLS
            </label>
            <label>Nickname</label>
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} required />
            <label>SASL username (optional)</label>
            <input value={saslUser} onChange={(e) => setSaslUser(e.target.value)} />
            <label>SASL password (optional)</label>
            <input type="password" value={saslPass} onChange={(e) => setSaslPass(e.target.value)} placeholder={editingFeed?.saslPass ? "unchanged" : ""} />
            <label>Channel</label>
            <input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="#announces" required />
            <label>Announce regex (named groups: title, url)</label>
            <input value={announceRegex} onChange={(e) => setAnnounceRegex(e.target.value)} placeholder={EXAMPLE_REGEX} required />
            <label>Protocol</label>
            <select value={protocol} onChange={(e) => setProtocol(e.target.value as "torrent" | "usenet")}>
              <option value="torrent">Torrent</option>
              <option value="usenet">Usenet</option>
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Enabled
            </label>
            <div className="toolbar" style={{ justifyContent: "space-between", marginTop: 8 }}>
              <button type="submit">{mode === "add" ? "Add feed" : "Save"}</button>
              {mode !== "add" && (
                <button type="button" className="danger" onClick={() => removeFeed(mode as number)}>
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
