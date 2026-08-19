function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface ExportableItem {
  type: string;
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
}

/** Kodi/Jellyfin/Emby-style .nfo sidecar — the same shape services/nfoParser.ts already reads
 * back in, so an exported file round-trips through Import Media's "Load NFO" unchanged. */
export function buildNfo(item: ExportableItem): string {
  const root = item.type === "series" || item.type === "anime" ? "tvshow" : "movie";
  const uniqueIds = Object.entries(item.externalIds ?? {})
    .map(([provider, id]) => `  <uniqueid type="${escapeXml(provider)}">${escapeXml(id)}</uniqueid>`)
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<${root}>`,
    `  <title>${escapeXml(item.title)}</title>`,
    item.year ? `  <year>${item.year}</year>` : null,
    item.overview ? `  <plot>${escapeXml(item.overview)}</plot>` : null,
    item.posterUrl ? `  <thumb aspect="poster">${escapeXml(item.posterUrl)}</thumb>` : null,
    uniqueIds || null,
    `</${root}>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildJson(item: ExportableItem): string {
  return JSON.stringify(item, null, 2);
}

/** Calibre-compatible OPF sidecar (the format its GUI/command-line import reads for per-book
 * metadata) — for the book-shaped libraries (Books, Audiobooks, Comics, Manga). Calibre treats
 * `dc:creator` as the author; AoNarr doesn't model an author-vs-title-of-work distinction for
 * these types (the media_item title covers both roles depending on how the library's organized),
 * so both fields are set to the same title as a reasonable default the user can edit in Calibre. */
export function buildCalibreOpf(item: ExportableItem): string {
  const isbn = item.externalIds?.isbn;
  const identifiers = [
    isbn ? `    <dc:identifier opf:scheme="ISBN">${escapeXml(isbn)}</dc:identifier>` : null,
    ...Object.entries(item.externalIds ?? {})
      .filter(([p]) => p !== "isbn")
      .map(([provider, id]) => `    <dc:identifier opf:scheme="${escapeXml(provider)}">${escapeXml(id)}</dc:identifier>`),
  ]
    .filter(Boolean)
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<package xmlns="http://www.idpf.org/2007/opf" version="2.0">`,
    `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">`,
    `    <dc:title>${escapeXml(item.title)}</dc:title>`,
    `    <dc:creator opf:role="aut">${escapeXml(item.title)}</dc:creator>`,
    item.year ? `    <dc:date>${item.year}-01-01T00:00:00+00:00</dc:date>` : null,
    item.overview ? `    <dc:description>${escapeXml(item.overview)}</dc:description>` : null,
    identifiers || null,
    `  </metadata>`,
    `</package>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function safeFileName(title: string): string {
  return title.replace(/[/\\:*?"<>|]/g, "").trim().slice(0, 200);
}
