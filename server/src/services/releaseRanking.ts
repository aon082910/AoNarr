import type { SearchResult } from "../types/index.js";

/**
 * The tie-break keys that order releases which survived every rejection and share a format score,
 * after Sonarr/Radarr's DownloadDecisionComparer: preferred protocol, torrent peers in log10
 * buckets, usenet age buckets and size. Pure functions, so the order is testable on its own.
 */

export type PreferredProtocol = "none" | "usenet" | "torrent";

export function normalizePreferredProtocol(value: unknown): PreferredProtocol {
  return value === "usenet" || value === "torrent" ? value : "none";
}

/** Higher sorts first: 1 for a release on the preferred protocol, 0 for anything else. */
export function protocolPreferenceKey(preferred: PreferredProtocol, protocol: SearchResult["protocol"]): number {
  return preferred !== "none" && protocol === preferred ? 1 : 0;
}

/** Releases of different protocols are never compared by peers or age, so the protocol is a key of its own
 * ahead of those: without it the order would depend on which releases are compared (A beats B on size, B
 * beats C on size, C beats A on seeders). Lower sorts first; torrents first keeps the order of a
 * default install, where a seeded torrent has always beaten an NZB. */
export function protocolGroup(protocol: SearchResult["protocol"]): number {
  return protocol === "torrent" ? 0 : protocol === "usenet" ? 1 : protocol === "http" ? 2 : 3;
}

/** Radarr/Sonarr compare peers as Math.Round(Math.Log10(n)), so 45 and 60 seeders tie. */
export function peerBucket(count: number | null | undefined): number {
  return count != null && count > 0 ? Math.round(Math.log10(count)) : 0;
}

/**
 * Seeders then leechers, in log10 buckets, but only between two torrents: a usenet result has no
 * seeders, and a torrent with 2 of them must not outrank an equal NZB (the protocol key decides that).
 * Higher sorts first. Returns 0 when either side is not a torrent.
 */
export function comparePeers(a: SearchResult, b: SearchResult): number {
  if (a.protocol !== "torrent" || b.protocol !== "torrent") return 0;
  return peerBucket(b.seeders) - peerBucket(a.seeders) || peerBucket(b.leechers) - peerBucket(a.leechers);
}

/** Sonarr's usenet age buckets: under an hour 1000, under a day 100, under a week 10, then older is
 * lower by log10 of the age in days. Higher sorts first. */
export function usenetAgeBucket(publishDate: string | null | undefined, now = Date.now()): number {
  const at = publishDate ? Date.parse(publishDate) : NaN;
  if (!Number.isFinite(at)) return 0;
  const hours = Math.max(0, (now - at) / 3_600_000);
  if (hours < 1) return 1000;
  if (hours <= 24) return 100;
  const days = hours / 24;
  if (days <= 7) return 10;
  return -Math.round(Math.log10(days));
}

export function compareUsenetAge(a: SearchResult, b: SearchResult, now = Date.now()): number {
  if (a.protocol !== "usenet" || b.protocol !== "usenet") return 0;
  return usenetAgeBucket(b.publishDate, now) - usenetAgeBucket(a.publishDate, now);
}

const SIZE_BUCKET_BYTES = 200 * 1024 * 1024;

/**
 * With a preferred size configured the distance to it decides (smaller first, handled by the
 * caller); with none, the larger release wins, compared in 200 MB steps so a few MB do not decide.
 * A release of unknown size ranks last. Higher sorts first.
 */
export function largerIsBetterKey(sizeBytes: number | null): number {
  return sizeBytes == null ? -1 : Math.round(sizeBytes / SIZE_BUCKET_BYTES);
}
