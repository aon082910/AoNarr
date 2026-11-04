/**
 * The sub-path AoNarr is served under ("/aonarr" for https://host/aonarr/), or "" when it is served at the
 * root, which is how everything worked before the URL base existed.
 *
 * The web bundle is built once, so the base cannot be compiled in. The container's start-up script
 * (web/url-base.sh) writes /base-config.js, which sets window.__AONARR_BASE__, and links it from the served
 * index.html only when the URL_BASE variable is set. It is a real file, not an inline <script>, because the
 * page's Content-Security-Policy allows no inline script. Without that file this is "" and withBase() returns
 * its argument unchanged.
 *
 * Every URL the UI builds from a root-relative path goes through withBase(), so the prefix is applied in one
 * place. React Router gets the same value as its basename (main.tsx), so <Link> and navigate() need nothing.
 */

declare global {
  interface Window {
    __AONARR_BASE__?: string;
  }
}

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** "aonarr", "/aonarr/" and "//aonarr" are all "/aonarr"; "" and "/" are ""; a value with a character a path
 * segment can't carry (or a "." / ".." segment) is "". Keep in step with server/src/services/urlBase.ts
 * (appUrlBase) and web/url-base.sh, which apply the same rules to the same variable. */
export function normalizeAppUrlBase(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const parts = raw.trim().split("/").filter(Boolean);
  if (parts.some((part) => !SEGMENT.test(part) || part === "." || part === "..")) return "";
  return parts.length > 0 ? `/${parts.join("/")}` : "";
}

export const URL_BASE: string = normalizeAppUrlBase(typeof window === "undefined" ? "" : window.__AONARR_BASE__);

/** A root-relative path of this app ("/api/health", "/icon.svg", "/") with the URL base in front. Anything else
 * (an https:// URL, a protocol-relative "//cdn/x", a relative path) is returned as it came. */
export function withBase(path: string): string {
  if (!URL_BASE || !path.startsWith("/") || path.startsWith("//")) return path;
  return `${URL_BASE}${path}`;
}

/** withBase() as a full URL on the page's own origin: what Settings shows for a webhook, feed or MCP address. */
export function absoluteUrl(path: string): string {
  return `${window.location.origin}${withBase(path)}`;
}

/** `origin` (the External URL setting, or this page's origin) plus a path of this app, with the URL base between
 * them unless the External URL already ends with it (an admin who typed https://host/aonarr there before the
 * URL base existed keeps getting the same link). */
export function linkOnOrigin(origin: string, path: string): string {
  if (!URL_BASE) return `${origin}${path}`;
  const root = origin.replace(/\/+$/, "");
  return root.endsWith(URL_BASE) ? `${root}${path}` : `${root}${URL_BASE}${path}`;
}

// AoNarr stores the artwork it proxies (a media server's, ScreenScraper's, a remote library's) as a root-relative
// "/api/media/local-artwork/<token>" URL, and the UI puts that straight into <img src> and background-image.
// The stored value must stay base-free (the server compares and exports it), so the prefix is added to these
// URLs as they come out of an API response and taken off again as they go back in a request body. Only a value
// that is exactly such a path is touched, so no other text can be altered by accident.
const ARTWORK_PATH = /^\/api\/(?:media|remote-instances\/\d+)\/local-artwork\/[\w-]+$/;

/** JSON.parse reviver for API responses; undefined (no revival at all) when there is no URL base. */
export const reviveAppUrls: ((key: string, value: unknown) => unknown) | undefined = URL_BASE
  ? (_key, value) => (typeof value === "string" && ARTWORK_PATH.test(value) ? `${URL_BASE}${value}` : value)
  : undefined;

/** JSON.stringify replacer for request bodies: the reverse of reviveAppUrls. */
export const stripAppUrls: ((key: string, value: unknown) => unknown) | undefined = URL_BASE
  ? (_key, value) =>
      typeof value === "string" && value.startsWith(`${URL_BASE}/api/`) && ARTWORK_PATH.test(value.slice(URL_BASE.length))
        ? value.slice(URL_BASE.length)
        : value
  : undefined;
