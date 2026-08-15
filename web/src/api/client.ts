const BASE = "/api";
const KEY_STORAGE = "aonarr_api_key";
const TOKEN_STORAGE = "aonarr_session_token";

/** Thrown on any non-2xx response; carries the HTTP status and parsed JSON body so callers can
 * branch on structured error data (e.g. a 409 duplicate-warning payload) instead of only a
 * message string. */
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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = getApiKey();
  const sessionToken = getSessionToken();
  if (apiKey) headers["X-Api-Key"] = apiKey;
  if (sessionToken) headers["X-Session-Token"] = sessionToken;

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
  return res.json();
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
  const headers: Record<string, string> = {};
  const apiKey = getApiKey();
  const sessionToken = getSessionToken();
  if (apiKey) headers["X-Api-Key"] = apiKey;
  if (sessionToken) headers["X-Session-Token"] = sessionToken;

  const res = await fetch(`${BASE}${path}`, { headers });
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
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  const apiKey = getApiKey();
  const sessionToken = getSessionToken();
  if (apiKey) headers["X-Api-Key"] = apiKey;
  if (sessionToken) headers["X-Session-Token"] = sessionToken;

  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: data });
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
  const headers: Record<string, string> = {};
  const apiKey = getApiKey();
  const sessionToken = getSessionToken();
  if (apiKey) headers["X-Api-Key"] = apiKey;
  if (sessionToken) headers["X-Session-Token"] = sessionToken;

  const form = new FormData();
  form.append("file", file);

  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Upload failed: ${res.status}`);
  }
  return res.json();
}
