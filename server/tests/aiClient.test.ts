import { describe, it, expect, afterEach, vi } from "vitest";
import { queryAi, type AiProviderConfig } from "../src/services/aiClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(response: { ok: boolean; status?: number; body?: unknown; jsonThrows?: boolean }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => {
      if (response.jsonThrows) throw new Error("invalid json");
      return response.body;
    },
  }) as any);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const localCfg: AiProviderConfig = { type: "local", baseUrl: "http://ollama.local:11434/", apiKey: null, model: "llava" };
const cloudCfg: AiProviderConfig = { type: "cloud", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test-key", model: "gpt-4o" };

describe("queryAi — local (Ollama)", () => {
  it("posts to /api/chat with a stripped trailing slash and returns the message content", async () => {
    const fetchMock = mockFetch({ ok: true, body: { message: { content: "It's The Movie (2020)" } } });

    const result = await queryAi(localCfg, "describe this");

    expect(result).toBe("It's The Movie (2020)");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://ollama.local:11434/api/chat");
    const parsedBody = JSON.parse(opts.body);
    expect(parsedBody).toEqual({ model: "llava", messages: [{ role: "user", content: "describe this" }], stream: false });
  });

  it("includes the image in the message when imageBase64 is provided", async () => {
    mockFetch({ ok: true, body: { message: { content: "reply" } } });

    await queryAi(localCfg, "describe this", "base64imagedata");

    const opts = (globalThis.fetch as any).mock.calls[0][1];
    const parsedBody = JSON.parse(opts.body);
    expect(parsedBody.messages[0].images).toEqual(["base64imagedata"]);
  });

  it("omits the Authorization header when no api key is configured", async () => {
    mockFetch({ ok: true, body: { message: { content: "reply" } } });

    await queryAi(localCfg, "prompt");

    const opts = (globalThis.fetch as any).mock.calls[0][1];
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it("includes a Bearer Authorization header when an api key is configured", async () => {
    mockFetch({ ok: true, body: { message: { content: "reply" } } });

    await queryAi({ ...localCfg, apiKey: "local-key" }, "prompt");

    const opts = (globalThis.fetch as any).mock.calls[0][1];
    expect(opts.headers.Authorization).toBe("Bearer local-key");
  });

  it("throws on a non-ok response", async () => {
    mockFetch({ ok: false, status: 503 });

    await expect(queryAi(localCfg, "prompt")).rejects.toThrow(/HTTP 503/);
  });

  it("throws when the response shape is unexpected", async () => {
    mockFetch({ ok: true, body: { unexpected: "shape" } });

    await expect(queryAi(localCfg, "prompt")).rejects.toThrow(/unexpected response shape/);
  });
});

describe("queryAi — cloud (OpenAI-compatible)", () => {
  it("posts to /chat/completions and returns the choice's message content", async () => {
    const fetchMock = mockFetch({ ok: true, body: { choices: [{ message: { content: "Cloud reply" } }] } });

    const result = await queryAi(cloudCfg, "describe this");

    expect(result).toBe("Cloud reply");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(opts.headers.Authorization).toBe("Bearer sk-test-key");
    const parsedBody = JSON.parse(opts.body);
    expect(parsedBody.messages[0].content).toEqual([{ type: "text", text: "describe this" }]);
  });

  it("includes an image_url content part with a data URI when imageBase64 is provided", async () => {
    mockFetch({ ok: true, body: { choices: [{ message: { content: "reply" } }] } });

    await queryAi(cloudCfg, "describe this", "abc123");

    const opts = (globalThis.fetch as any).mock.calls[0][1];
    const parsedBody = JSON.parse(opts.body);
    expect(parsedBody.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,abc123" } });
  });

  it("throws with the provider's own error message when the response includes one", async () => {
    mockFetch({ ok: false, status: 401, body: { error: { message: "Invalid API key" } } });

    await expect(queryAi(cloudCfg, "prompt")).rejects.toThrow(/HTTP 401 — Invalid API key/);
  });

  it("throws with just the status when the error response has no parseable body", async () => {
    mockFetch({ ok: false, status: 500, jsonThrows: true });

    await expect(queryAi(cloudCfg, "prompt")).rejects.toThrow(/HTTP 500/);
  });

  it("throws when the response shape is unexpected", async () => {
    mockFetch({ ok: true, body: { choices: [] } });

    await expect(queryAi(cloudCfg, "prompt")).rejects.toThrow(/unexpected response shape/);
  });
});
