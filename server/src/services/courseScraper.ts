/**
 * Scrapes a Coursera/edX/Udemy (or any other) course landing page for the metadata AoNarr needs to
 * prefill an Add Media entry — title, description, thumbnail. Courses has no metadata provider API
 * (mediaTypes.ts: "no viable public search API for arbitrary course platforms"), so this is the one
 * real way to get anything beyond typing a title by hand.
 *
 * Deliberately scoped to Open Graph tags (og:title/og:description/og:image) rather than each
 * platform's internal curriculum data: those og tags are meant to be publicly scraped (that's their
 * whole purpose — link-preview cards), present and stable on all three platforms, and generic
 * enough to work on course sites this was never specifically written for. A given platform's own
 * internal lesson/module JSON (verified present on Coursera during development, absent from Udemy's
 * server-rendered HTML entirely) is undocumented, platform-specific, and liable to break on any
 * front-end redesign — not something to build a "sync" feature on. The per-lesson breakdown still
 * has to be added by hand afterward, same as it does today.
 */

interface ScrapedCourse {
  title: string;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#x27": "'",
  "#39": "'",
  "#x2F": "/",
  nbsp: " ",
};

function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (ENTITY_MAP[entity]) return ENTITY_MAP[entity];
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return match;
  });
}

function extractMetaContent(html: string, property: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`, "i");
  const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`, "i"));
  return m ? decodeHtmlEntities(m[1]).trim() : null;
}

/** Strips the "| edX" / "- edX" style site-name suffix some platforms tack onto <title>/og:title. */
function stripSiteSuffix(title: string, hostname: string): string {
  if (hostname.includes("edx.org")) return title.replace(/\s*[|\-–]\s*edX\s*$/i, "").trim();
  return title.trim();
}

export async function scrapeCoursePage(url: string): Promise<ScrapedCourse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http(s) URLs are supported");

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html",
      },
    });
  } catch {
    throw new Error("Couldn't reach that URL — check it's correct and this server has network access to it");
  }
  if (!res.ok) throw new Error(`Failed to fetch course page: HTTP ${res.status}`);
  const html = await res.text();

  const ogTitle = extractMetaContent(html, "og:title");
  const titleTag = html.match(/<title>([^<]*)<\/title>/i)?.[1];
  const rawTitle = ogTitle || (titleTag ? decodeHtmlEntities(titleTag) : null);
  if (!rawTitle) throw new Error("Couldn't find a title on that page — it may not be a course landing page, or the site blocks scraping");

  return {
    title: stripSiteSuffix(rawTitle, parsed.hostname),
    overview: extractMetaContent(html, "og:description"),
    posterUrl: extractMetaContent(html, "og:image"),
    externalIds: { url },
  };
}
