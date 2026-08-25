import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";

interface AiProvider {
  id: number;
  name: string;
  type: "local" | "cloud";
  baseUrl: string;
  apiKey: string | null;
  model: string;
  enabled: 0 | 1;
  isDefault: 0 | 1;
}

export default function AiProviders() {
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [mode, setMode] = useState<"add" | number | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<"local" | "cloud">("local");
  const [baseUrl, setBaseUrl] = useState("http://ollama:11434");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; reply?: string; error?: string } | null>(null);

  function load() {
    api.get<AiProvider[]>("/ai-providers").then(setProviders);
  }
  useEffect(load, []);

  function resetForm() {
    setName("");
    setType("local");
    setBaseUrl("http://ollama:11434");
    setApiKey("");
    setModel("");
    setIsDefault(false);
    setTestResult(null);
  }

  function openAdd() {
    resetForm();
    setMode("add");
  }

  function openEdit(p: AiProvider) {
    setName(p.name);
    setType(p.type);
    setBaseUrl(p.baseUrl);
    setApiKey("");
    setModel(p.model);
    setIsDefault(!!p.isDefault);
    setTestResult(null);
    setMode(p.id);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name || !baseUrl || !model || (type === "cloud" && mode === "add" && !apiKey)) return;
    const body = {
      name,
      type,
      baseUrl,
      model,
      isDefault,
      ...(apiKey ? { apiKey } : {}),
    };
    if (mode === "add") {
      await api.post("/ai-providers", body);
    } else if (typeof mode === "number") {
      await api.patch(`/ai-providers/${mode}`, body);
    }
    setMode(null);
    load();
  }

  async function remove(id: number) {
    await api.del(`/ai-providers/${id}`);
    setMode(null);
    load();
  }

  async function testConnection(id: number) {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<{ ok: boolean; reply?: string; error?: string }>(`/ai-providers/${id}/test`, {});
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  const editingProvider = typeof mode === "number" ? providers.find((p) => p.id === mode) ?? null : null;

  return (
    <div>
      <h1>AI Providers</h1>
      <p style={{ color: "var(--muted)" }}>
        Local (e.g. Ollama) or cloud (any OpenAI-compatible chat completions API) providers for
        AI-assisted matching features — selectable per instance, so you can configure both a local
        and a cloud provider and pick whichever a given feature should use. Click a tile to edit it.
      </p>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", marginBottom: 16 }}>
        <div className="card" onClick={openAdd} style={{ padding: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontWeight: 600 }}>+ Add AI provider</div>
        </div>
        {providers.map((p) => (
          <div key={p.id} className="card" onClick={() => openEdit(p)} style={{ padding: 16 }}>
            <div style={{ fontWeight: 600 }}>{p.name}</div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 4 }}>
              {p.type === "local" ? "Local" : "Cloud"} · {p.model}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <span className={`badge ${p.enabled ? "ok" : ""}`}>{p.enabled ? "Enabled" : "Disabled"}</span>
              {!!p.isDefault && <span className="badge ok">Default</span>}
            </div>
          </div>
        ))}
      </div>
      {providers.length === 0 && <p className="empty">No AI providers configured yet.</p>}

      {mode !== null && (mode === "add" || editingProvider) && (
        <Modal title={mode === "add" ? "Add AI Provider" : `Edit — ${editingProvider!.name}`} onClose={() => setMode(null)}>
          <form className="form-panel" onSubmit={submit} style={{ padding: 0 }}>
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />

            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value as "local" | "cloud")}>
              <option value="local">Local (Ollama-style chat API)</option>
              <option value="cloud">Cloud (OpenAI-compatible chat completions API)</option>
            </select>

            <label>Base URL</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={type === "local" ? "http://ollama:11434" : "https://api.openai.com/v1"}
              required
            />

            <label>API key{type === "local" ? " (optional)" : mode !== "add" ? " (leave blank to keep current)" : ""}</label>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" required={type === "cloud" && mode === "add"} />

            <label>Model</label>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={type === "local" ? "llava" : "gpt-4o-mini"} required />

            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
              Use as the default provider when a feature doesn't ask for a specific one
            </label>

            {mode !== "add" && (
              <div className="toolbar" style={{ marginTop: 8 }}>
                <button type="button" className="secondary" disabled={testing} onClick={() => testConnection(mode as number)}>
                  {testing ? "Testing..." : "Test connection"}
                </button>
                {testResult && (
                  <span style={{ color: testResult.ok ? "var(--ok)" : "var(--danger)" }}>
                    {testResult.ok ? `OK — replied: "${testResult.reply}"` : testResult.error}
                  </span>
                )}
              </div>
            )}

            <div className="toolbar" style={{ justifyContent: "space-between", marginTop: 8 }}>
              <button type="submit">{mode === "add" ? "Add provider" : "Save"}</button>
              {mode !== "add" && (
                <button type="button" className="danger" onClick={() => remove(mode as number)}>
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
