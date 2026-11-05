/**
 * A release's download link can carry an indexer key (`?apikey=`, `?passkey=`) or a tracker passkey (a magnet link's `tr=`),
 * so it is written to a log, or into a message an API answers, only through these.
 */

// What a link's last path segment may still say of itself: what it is a link to. Nothing else of the path is written down.
const KNOWN_LINK_ENDING = /\.(torrent|nzb|magnet|rss|xml|json|zip|gz)$/i;

/**
 * A link as it may be written down: scheme and host, and at most the file type it ends in; no path, no query string. A tracker
 * can put its passkey in the path (`/download/<passkey>/45.torrent`) as well as in the query, so no segment of the path is kept.
 * A magnet link is written only by its info hash.
 */
export function describeLink(link: string): string {
  if (/^magnet:/i.test(link)) {
    const hash = /[?&]xt=urn:bt(?:ih|mh):([^&\s]+)/i.exec(link)?.[1];
    return hash ? `magnet:${hash.slice(0, 40)}` : "magnet link";
  }
  try {
    const url = new URL(link);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return `${url.protocol}//${url.host}`;
    const ending = KNOWN_LINK_ENDING.exec(segments[segments.length - 1])?.[0].toLowerCase() ?? "";
    return `${url.protocol}//${url.host}/*${ending}`;
  } catch {
    return "a link";
  }
}

/** The message with every link in it written down by describeLink (an adapter's error message can quote the link it was given). */
export function redactLinks(message: string): string {
  return String(message)
    .replace(/magnet:\?\S+/gi, (m) => describeLink(m))
    .replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, (m) => describeLink(m));
}
