/**
 * A release's download link can carry an indexer key (`?apikey=`, `?passkey=`) or a tracker passkey (a magnet link's `tr=`),
 * so it is written to a log, or into a message an API answers, only through these.
 */

/** A link as it may be written down: scheme, host and path, no query string; a magnet link only by its info hash. */
export function describeLink(link: string): string {
  if (/^magnet:/i.test(link)) {
    const hash = /[?&]xt=urn:bt(?:ih|mh):([^&\s]+)/i.exec(link)?.[1];
    return hash ? `magnet:${hash.slice(0, 40)}` : "magnet link";
  }
  try {
    const url = new URL(link);
    return `${url.protocol}//${url.host}${url.pathname}`;
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
