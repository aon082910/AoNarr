import type { DownloadClient } from "../types/index.js";

/** A URL base typed as "qbittorrent", "/qbittorrent/" or "/a//b" is "/qbittorrent" or "/a/b"; nothing is "". */
export function normalizeUrlBase(value: string | null | undefined): string {
  const parts = String(value ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? `/${parts.join("/")}` : "";
}

/** scheme://host:port plus the client's URL base: where a client's HTTP API lives. */
export function clientBaseUrl(client: Pick<DownloadClient, "host" | "port" | "useSsl" | "urlBase">): string {
  const scheme = client.useSsl ? "https" : "http";
  return `${scheme}://${client.host}:${client.port}${normalizeUrlBase(client.urlBase)}`;
}
