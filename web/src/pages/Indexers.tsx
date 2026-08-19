import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";
import type { Indexer } from "../types.js";

type Protocol = "torznab" | "newznab" | "rss" | "ddl";

export default function Indexers() {
  const [indexers, setIndexers] = useState<Indexer[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [syncingProwlarr, setSyncingProwlarr] = useState(false);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<Protocol>("torznab");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testResults, setTestResults] = useState<Record<number, string>>({});

  const [resultsPath, setResultsPath] = useState("");
  const [titleField, setTitleField] = useState("title");
  const [sizeField, setSizeField] = useState("size");
  const [downloadUrlField, setDownloadUrlField] = useState("downloadUrl");
  const [seedersField, setSeedersField] = useState("");
  const [publishDateField, setPublishDateField] = useState("");
  const [useFlareSolverr, setUseFlareSolverr] = useState(false);

  function load() {
    api.get<Indexer[]>("/indexers").then(setIndexers);
  }
  useEffect(load, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name || !url) return;
    const config =
      protocol === "ddl"
        ? {
            resultsPath: resultsPath || null,
            titleField,
            sizeField: sizeField || null,
            downloadUrlField,
            seedersField: seedersField || null,
            publishDateField: publishDateField || null,
          }
        : null;
    await api.post("/indexers", { name, protocol, url, apiKey: apiKey || null, config, useFlareSolverr });
    setName("");
    setUrl("");
    setApiKey("");
    setUseFlareSolverr(false);
    setShowAdd(false);
    load();
  }

  async function remove(id: number) {
    await api.del(`/indexers/${id}`);
    load();
  }

  async function toggle(indexer: Indexer) {
    await api.patch(`/indexers/${indexer.id}`, { enabled: indexer.enabled ? 0 : 1 });
    load();
  }

  async function toggleFlareSolverr(indexer: Indexer) {
    await api.patch(`/indexers/${indexer.id}`, { useFlareSolverr: indexer.useFlareSolverr ? 0 : 1 });
    load();
  }

  async function syncProwlarr() {
    setSyncingProwlarr(true);
    try {
      const result = await api.post<{ synced: number }>("/indexers/prowlarr-sync", {});
      alert(`Synced ${result.synced} indexer(s) from Prowlarr.`);
      load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSyncingProwlarr(false);
    }
  }

  async function test(id: number) {
    const result = await api.post<{ ok: boolean; resultCount?: number; error?: string }>(`/indexers/${id}/test`);
    setTestResults((prev) => ({
      ...prev,
      [id]: result.ok ? `OK (${result.resultCount} results)` : `Failed: ${result.error}`,
    }));
  }

  return (
    <div>
      <h1>Indexers</h1>
      <p style={{ color: "var(--muted)" }}>
        Torznab (torrent) and Newznab (usenet) indexers are searched together across every media
        type. RSS covers plain feeds without full Torznab support (results are matched against
        the search query client-side). DDL is a generic adapter for any JSON search API — point
        it at a URL containing <code>{"{query}"}</code> and describe where the results live in
        the response; AoNarr never scrapes a site itself, only reads JSON the API returns.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button type="button" onClick={() => setShowAdd(true)}>
          + Add indexer
        </button>
        <button type="button" className="secondary" onClick={syncProwlarr} disabled={syncingProwlarr}>
          {syncingProwlarr ? "Syncing..." : "Sync from Prowlarr"}
        </button>
      </div>

      {showAdd && (
        <Modal title="Add Indexer" onClose={() => setShowAdd(false)} maxWidth={560}>
      <form className="form-panel" onSubmit={submit} style={{ padding: 0 }}>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required />

        <label>Protocol</label>
        <select value={protocol} onChange={(e) => setProtocol(e.target.value as Protocol)}>
          <option value="torznab">Torznab (torrent)</option>
          <option value="newznab">Newznab (usenet)</option>
          <option value="rss">RSS feed</option>
          <option value="ddl">Generic JSON API (DDL)</option>
        </select>

        <label>
          {protocol === "ddl"
            ? "Search URL template (must contain {query})"
            : protocol === "rss"
            ? "Feed URL"
            : "URL (base, e.g. https://indexer.example.com)"}
        </label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={protocol === "ddl" ? "https://api.example.com/search?q={query}" : undefined}
          required
        />

        <label>API key {protocol === "ddl" && "(sent as a Bearer token, if set)"}</label>
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} />

        {protocol === "ddl" && (
          <>
            <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
              Dot-paths into the JSON response, e.g. <code>data.items</code> or{" "}
              <code>result.name</code>. Leave "Results path" blank if the response is already an
              array at the root.
            </p>
            <label>Results path</label>
            <input value={resultsPath} onChange={(e) => setResultsPath(e.target.value)} placeholder="data.items" />
            <label>Title field</label>
            <input value={titleField} onChange={(e) => setTitleField(e.target.value)} required />
            <label>Download URL field</label>
            <input value={downloadUrlField} onChange={(e) => setDownloadUrlField(e.target.value)} required />
            <label>Size field (bytes, optional)</label>
            <input value={sizeField} onChange={(e) => setSizeField(e.target.value)} />
            <label>Seeders field (optional)</label>
            <input value={seedersField} onChange={(e) => setSeedersField(e.target.value)} />
            <label>Publish date field (optional)</label>
            <input value={publishDateField} onChange={(e) => setPublishDateField(e.target.value)} />
          </>
        )}

        {protocol !== "ddl" && (
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={useFlareSolverr} onChange={(e) => setUseFlareSolverr(e.target.checked)} />
            Route requests through FlareSolverr (for indexers behind Cloudflare/bot-detection —
            needs a FlareSolverr URL configured in Settings)
          </label>
        )}

        <button type="submit">Add indexer</button>
      </form>
        </Modal>
      )}

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Protocol</th>
            <th>URL</th>
            <th>Enabled</th>
            <th>FlareSolverr</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {indexers.map((i) => (
            <tr key={i.id}>
              <td>{i.name}</td>
              <td>{i.protocol}</td>
              <td>{i.url}</td>
              <td>
                <span className={`badge ${i.enabled ? "ok" : "danger"}`} onClick={() => toggle(i)} style={{ cursor: "pointer" }}>
                  {i.enabled ? "Enabled" : "Disabled"}
                </span>
              </td>
              <td>
                {i.protocol === "ddl" ? (
                  "-"
                ) : (
                  <span
                    className={`badge ${i.useFlareSolverr ? "ok" : ""}`}
                    onClick={() => toggleFlareSolverr(i)}
                    style={{ cursor: "pointer" }}
                  >
                    {i.useFlareSolverr ? "On" : "Off"}
                  </span>
                )}
              </td>
              <td style={{ display: "flex", gap: 8 }}>
                <button className="secondary" onClick={() => test(i.id)}>
                  Test
                </button>
                <button className="danger" onClick={() => remove(i.id)}>
                  Delete
                </button>
                {testResults[i.id] && <span style={{ alignSelf: "center", fontSize: "0.8rem" }}>{testResults[i.id]}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {indexers.length === 0 && <p className="empty">No indexers configured yet.</p>}
    </div>
  );
}
