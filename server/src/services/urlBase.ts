import type { DownloadClient } from "../types/index.js";

/** A URL base typed as "qbittorrent", "/qbittorrent/" or "/a//b" is "/qbittorrent" or "/a/b"; nothing is "". */
export function normalizeUrlBase(value: string | null | undefined): string {
  const parts = String(value ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? `/${parts.join("/")}` : "";
}

const URL_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** The sub-path AoNarr itself is served under, from the URL_BASE variable the container is started with:
 * "aonarr", "/aonarr/" and "//aonarr" are all "/aonarr"; unset, "" and "/" are ""; a value with a character a path
 * segment can't carry, or a "." / ".." segment, is "". The same rules run in web/url-base.sh (which refuses to start
 * the container on such a value) and web/src/utils/urlBase.ts. */
export function normalizeAppUrlBase(raw: string | null | undefined): string {
  const parts = String(raw ?? "")
    .trim()
    .split("/")
    .filter(Boolean);
  if (parts.some((part) => !URL_SEGMENT.test(part) || part === "." || part === "..")) return "";
  return parts.length > 0 ? `/${parts.join("/")}` : "";
}

/** Whether URL_BASE holds something other than a usable path (normalizeAppUrlBase() read it as no base). */
export function appUrlBaseIsInvalid(raw: string | null | undefined): boolean {
  return /[^\s/]/.test(String(raw ?? "")) && normalizeAppUrlBase(raw) === "";
}

/** The URL base of this instance ("" at the root). Read from the environment on each call: it is two string
 * operations, and a test can set the variable. nginx in front of the server cuts the prefix off before a request
 * arrives, so the routes themselves stay at /api/...; this is only for an address the server hands to a client. */
export function appUrlBase(): string {
  return normalizeAppUrlBase(process.env.URL_BASE);
}

/** A root-relative path of this app ("/api/opds?token=x") with the URL base in front; unchanged without one. */
export function withAppUrlBase(path: string): string {
  const base = appUrlBase();
  return base && path.startsWith("/") && !path.startsWith("//") ? `${base}${path}` : path;
}

/** The path part of an origin string: "https://h.example:8443/aonarr/" is "/aonarr", "http://aonarr" is "" (a host
 * name is not a path, even when it reads like one). Not a URL parse, so "//h/aonarr" and "" work too. */
function pathOfOrigin(origin: string): string {
  return origin.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*/i, "").replace(/\/+$/, "");
}

/** `origin` (the External URL setting, a guess from the request, or "" for a root-relative link) plus a path of this
 * app, with the URL base between them unless the External URL's path already ends with it (an admin who typed
 * https://host/aonarr there before the URL base existed keeps getting the same link). */
export function appUrl(origin: string, path: string): string {
  const base = appUrlBase();
  if (!base) return `${origin}${path}`;
  const root = origin.replace(/\/+$/, "");
  return pathOfOrigin(origin).endsWith(base) ? `${root}${path}` : `${root}${base}${path}`;
}

/** The proxied-artwork paths AoNarr stores as a poster/backdrop (/api/media/local-artwork/<token>, or a remote
 * library's relay of one): the only stored URLs that are root-relative paths of this app. */
const ARTWORK_PATH = /^\/api\/(?:media|remote-instances\/\d+)\/local-artwork\/[\w-]+$/;

/** A stored poster/backdrop URL as a client outside the UI (an OPDS reader, a Starr-style tool) should fetch it: the
 * stored value, with the URL base in front when it is one of AoNarr's own artwork paths. */
export function artworkUrlForClient(url: string): string {
  return ARTWORK_PATH.test(url) ? withAppUrlBase(url) : url;
}

/** scheme://host:port plus the client's URL base: where a client's HTTP API lives. */
export function clientBaseUrl(client: Pick<DownloadClient, "host" | "port" | "useSsl" | "urlBase">): string {
  const scheme = client.useSsl ? "https" : "http";
  return `${scheme}://${client.host}:${client.port}${normalizeUrlBase(client.urlBase)}`;
}
