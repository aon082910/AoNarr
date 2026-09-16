import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";
import type { Indexer } from "../types.js";

type Protocol = "torznab" | "newznab" | "rss" | "ddl";

export default function Indexers() {
  const [indexers, setIndexers] = useState<Indexer[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [syncingProwlarr, setSyncingProwlarr] = useState(false);
  const [syncingJackett, setSyncingJackett] = useState(false);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<Protocol>("torznab");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testResults, setTestResults] = useState<Record<number, string>>({});
  const [testingAll, setTestingAll] = useState(false);

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

  async function updateQueryLimit(indexer: Indexer, value: string) {
    const parsed = value.trim() === "" ? null : Number(value);
    if (parsed === indexer.queryLimitPerHour) return;
    await api.patch(`/indexers/${indexer.id}`, { queryLimitPerHour: parsed });
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

  async function syncJackett() {
    setSyncingJackett(true);
    try {
      const result = await api.post<{ synced: number }>("/indexers/jackett-sync", {});
      alert(`Synced ${result.synced} indexer(s) from Jackett.`);
      load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSyncingJackett(false);
    }
  }

  async function test(id: number) {
    const result = await api.post<{ ok: boolean; resultCount?: number; error?: string }>(`/indexers/${id}/test`);
    setTestResults((prev) => ({
      ...prev,
      [id]: result.ok ? `OK (${result.resultCount} results)` : `Failed: ${result.error}`,
    }));
    load(); // the test itself just recorded a new health entry — refresh to show it
  }

  async function testAll() {
    setTestingAll(true);
    // Sequential, not parallel — an indexer with a configured query limit shouldn't have its whole
    // hourly budget spent testing every other indexer at the exact same moment.
    for (const i of indexers) await test(i.id);
    setTestingAll(false);
  }

  function healthLabel(i: Indexer): { text: string; className: string } {
    const h = i.health;
    if (!h || h.totalChecks === 0) return { text: "No checks yet", className: "" };
    const rate = h.successRate ?? 0;
    const className = rate >= 80 ? "ok" : rate > 0 ? "" : "danger";
    const responseText = h.avgResponseTimeMs != null ? ` · ${h.avgResponseTimeMs}ms avg` : "";
    return { text: `${rate}% (${h.totalChecks})${responseText}`, className };
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
        <button type="button" className="secondary" onClick={syncJackett} disabled={syncingJackett}>
          {syncingJackett ? "Syncing..." : "Sync from Jackett"}
        </button>
        <button type="button" className="secondary" onClick={testAll} disabled={testingAll || indexers.length === 0}>
          {testingAll ? "Testing..." : "Test all"}
        </button>
      </div>

      {showAdd && (
        <Modal title="Add Indexer" onClose={() => setShowAdd(false)} maxWidth={560}>
      <form className="form-panel" onSubmit={submit} style={{ padding: 0 }}>
        <label htmlFor="indexers-name-1">Name</label>
        <input id="indexers-name-1" value={name} onChange={(e) => setName(e.target.value)} required />

        <label htmlFor="indexers-protocol-2">Protocol</label>
        <select id="indexers-protocol-2" value={protocol} onChange={(e) => setProtocol(e.target.value as Protocol)}>
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

        <label htmlFor="indexers-api-key-protocol-ddl-sent-as-a-bearer-to-3">API key {protocol === "ddl" && "(sent as a Bearer token, if set)"}</label>
        <input id="indexers-api-key-protocol-ddl-sent-as-a-bearer-to-3" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />

        {protocol === "ddl" && (
          <>
            <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
              Dot-paths into the JSON response, e.g. <code>data.items</code> or{" "}
              <code>result.name</code>. Leave "Results path" blank if the response is already an
              array at the root.
            </p>
            <label htmlFor="indexers-results-path-4">Results path</label>
            <input id="indexers-results-path-4" value={resultsPath} onChange={(e) => setResultsPath(e.target.value)} placeholder="data.items" />
            <label htmlFor="indexers-title-field-5">Title field</label>
            <input id="indexers-title-field-5" value={titleField} onChange={(e) => setTitleField(e.target.value)} required />
            <label htmlFor="indexers-download-url-field-6">Download URL field</label>
            <input id="indexers-download-url-field-6" value={downloadUrlField} onChange={(e) => setDownloadUrlField(e.target.value)} required />
            <label htmlFor="indexers-size-field-bytes-optional-7">Size field (bytes, optional)</label>
            <input id="indexers-size-field-bytes-optional-7" value={sizeField} onChange={(e) => setSizeField(e.target.value)} />
            <label htmlFor="indexers-seeders-field-optional-8">Seeders field (optional)</label>
            <input id="indexers-seeders-field-optional-8" value={seedersField} onChange={(e) => setSeedersField(e.target.value)} />
            <label htmlFor="indexers-publish-date-field-optional-9">Publish date field (optional)</label>
            <input id="indexers-publish-date-field-optional-9" value={publishDateField} onChange={(e) => setPublishDateField(e.target.value)} />
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
            <th title="Proactive requests/hour cap — leave blank for no limit">Query Limit</th>
            <th>Health</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {indexers.map((i) => {
            const health = healthLabel(i);
            return (
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
              <td>
                <input
                  type="number"
                  min={0}
                  defaultValue={i.queryLimitPerHour ?? ""}
                  placeholder="unlimited"
                  style={{ width: 90 }}
                  onBlur={(e) => updateQueryLimit(i, e.target.value)}
                />
              </td>
              <td title={i.health?.lastError ?? undefined}>
                <span className={`badge ${health.className}`}>{health.text}</span>
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
            );
          })}
        </tbody>
      </table>
      {indexers.length === 0 && <p className="empty">No indexers configured yet.</p>}
    </div>
  );
}
