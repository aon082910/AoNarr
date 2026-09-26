import { useEffect, useState } from "react";

const BASE = "/api";
const KEY_STORAGE = "aonarr_api_key";
const TOKEN_STORAGE = "aonarr_session_token";

/** Thrown on a non-2xx response other than 401 (which request()/downloadFile()/uploadRaw()/
 * uploadFormFile() all special-case into a forced logout instead); carries the HTTP status and
 * parsed JSON body so callers can branch on structured error data (e.g. a 409 duplicate-warning
 * payload) instead of only a message string. */
export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function getApiKey(): string | null {
  return localStorage.getItem(KEY_STORAGE);
}

export function setApiKey(key: string): void {
  localStorage.removeItem(TOKEN_STORAGE);
  localStorage.setItem(KEY_STORAGE, key);
}

export function clearApiKey(): void {
  localStorage.removeItem(KEY_STORAGE);
}

export function getSessionToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE);
}

export function setSessionToken(token: string): void {
  localStorage.removeItem(KEY_STORAGE);
  localStorage.setItem(TOKEN_STORAGE, token);
}

export function clearSessionToken(): void {
  localStorage.removeItem(TOKEN_STORAGE);
}

export function clearCredentials(): void {
  clearApiKey();
  clearSessionToken();
}

export function hasCredentials(): boolean {
  return !!getApiKey() || !!getSessionToken();
}

/** Sent on every request to the API. A page on another site can't send this header without a CORS
 * preflight the server refuses, so its presence tells the server's cross-origin guard
 * (server/src/app.ts) that a request came from this UI — even a multipart upload with
 * Authentication disabled, which has no credential header or JSON Content-Type to go by. */
export const UI_REQUEST_HEADERS: Readonly<Record<string, string>> = { "X-Requested-With": "AoNarr" };

/** UI_REQUEST_HEADERS plus the stored credential. */
function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { ...UI_REQUEST_HEADERS };
  const apiKey = getApiKey();
  const sessionToken = getSessionToken();
  if (apiKey) headers["X-Api-Key"] = apiKey;
  if (sessionToken) headers["X-Session-Token"] = sessionToken;
  return headers;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  // application/json even with no body (a bare POST/DELETE), which keeps every request one a
  // foreign page would need a preflight for.
  const headers: Record<string, string> = { ...apiHeaders(), "Content-Type": "application/json" };

  const res = await fetch(`${BASE}${path}`, { headers, ...options });
  if (res.status === 401) {
    clearCredentials();
    window.location.reload();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body, body.error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  // A 2xx can still carry an empty body (e.g. a bare res.status(201).send()), which res.json()
  // would reject on after the server already committed the change.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/** Downloads an authenticated endpoint's response as a file, since a plain <a href> can't carry
 * the X-Api-Key/X-Session-Token headers this API requires. */
export async function downloadFile(path: string, suggestedFilename: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { headers: apiHeaders() });
  if (res.status === 401) {
    clearCredentials();
    window.location.reload();
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition");
  const filename = disposition?.match(/filename="?([^"]+)"?/)?.[1] ?? suggestedFilename;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Uploads raw bytes (not JSON) to an endpoint — used for restoring a backup file. */
export async function uploadRaw(path: string, data: ArrayBuffer): Promise<unknown> {
  const headers: Record<string, string> = { ...apiHeaders(), "Content-Type": "application/octet-stream" };

  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: data });
  if (res.status === 401) {
    clearCredentials();
    window.location.reload();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Upload failed: ${res.status}`);
  }
  return res.json();
}

/** Uploads a File as multipart/form-data under the field name "file" — used for CSV bulk-edit
 * uploads. No Content-Type header is set explicitly so the browser fills in the multipart
 * boundary itself. */
export async function uploadFormFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file);

  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: apiHeaders(), body: form });
  if (res.status === 401) {
    clearCredentials();
    window.location.reload();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Upload failed: ${res.status}`);
  }
  return res.json();
}

/** A blob: URL for a user's avatar, or null while loading, when `enabled` is false, or when there's
 * none. An <img src> pointing at the API can't send the credential headers, and a credential in the
 * URL would be written to every proxy access log, so the image is fetched with headers instead.
 * Changing `version` fetches it again (after an upload replaced it). */
export function useAvatarUrl(userId: number | undefined, enabled: boolean, version = 0): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || userId == null) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    fetch(`${BASE}/auth/me/avatar/${userId}`, { headers: apiHeaders(), cache: "no-cache" })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!cancelled) setUrl(blob ? URL.createObjectURL(blob) : null);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, enabled, version]);

  // Each blob URL is released once a newer one replaced it or the component unmounted.
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url]
  );

  return url;
}

/**
 * Opens an EventSource on an authenticated SSE endpoint (`path` relative to /api) and keeps it open
 * until the returned function is called. EventSource can't send the credential headers, and a
 * credential in its URL would be written to every proxy access log, so each connection first trades
 * them for a short-lived single-use ticket. EventSource's own auto-reconnect would replay that spent
 * ticket, so reconnecting (with a fresh ticket, backing off while it keeps failing) happens here.
 * `setup` attaches listeners to each new EventSource.
 */
export function openEventStream(path: string, setup: (source: EventSource) => void): () => void {
  const MIN_RETRY_MS = 5_000;
  const MAX_RETRY_MS = 60_000;
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryMs = MIN_RETRY_MS;
  let closed = false;

  function scheduleReconnect() {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  }

  async function connect() {
    retryTimer = null;
    let ticket: string;
    try {
      ({ ticket } = await api.post<{ ticket: string }>("/auth/stream-ticket"));
    } catch {
      scheduleReconnect();
      return;
    }
    if (closed) return;
    const stream = new EventSource(`${BASE}${path}${path.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`);
    source = stream;
    stream.addEventListener("open", () => {
      retryMs = MIN_RETRY_MS;
    });
    stream.addEventListener("error", () => {
      stream.close();
      if (source === stream) source = null;
      scheduleReconnect();
    });
    setup(stream);
  }

  connect();
  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    source?.close();
  };
}
