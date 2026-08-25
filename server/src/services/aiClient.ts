export interface AiProviderConfig {
  type: "local" | "cloud";
  baseUrl: string;
  apiKey: string | null;
  model: string;
}

/** Ollama's native chat API (not the OpenAI-compatible shim some builds also expose) — the more
 * common way self-hosted local models are actually run, and the one that needs no path guessing. */
async function queryOllama(cfg: AiProviderConfig, prompt: string, imageBase64?: string): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/api/chat`;
  const message: Record<string, unknown> = { role: "user", content: prompt };
  if (imageBase64) message.images = [imageBase64];

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model, messages: [message], stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Local AI provider request failed: HTTP ${res.status}`);
  const body: any = await res.json();
  const content = body?.message?.content;
  if (typeof content !== "string") throw new Error("Local AI provider returned an unexpected response shape");
  return content;
}

/** The OpenAI chat completions request/response shape — followed closely enough by most hosted
 * providers (OpenAI itself, and many others via a compatible proxy) that pointing `baseUrl` at any
 * of them works without provider-specific code, the same generic-adapter approach the DDL indexer
 * and Custom subtitle provider already use for arbitrary third-party APIs. */
async function queryOpenAiCompatible(cfg: AiProviderConfig, prompt: string, imageBase64?: string): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const content: any[] = [{ type: "text", text: prompt }];
  if (imageBase64) content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content }] }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const errBody: any = await res.json().catch(() => ({}));
    throw new Error(`Cloud AI provider request failed: HTTP ${res.status}${errBody?.error?.message ? ` — ${errBody.error.message}` : ""}`);
  }
  const body: any = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("Cloud AI provider returned an unexpected response shape");
  return text;
}

/** `imageBase64` (raw base64, no data: prefix) makes this a vision request when the configured
 * model supports one — both paths simply ignore it if not, most models just answer from the text
 * prompt alone in that case rather than erroring. */
export async function queryAi(cfg: AiProviderConfig, prompt: string, imageBase64?: string): Promise<string> {
  return cfg.type === "local" ? queryOllama(cfg, prompt, imageBase64) : queryOpenAiCompatible(cfg, prompt, imageBase64);
}
