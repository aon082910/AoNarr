import { parseStringPromise } from "xml2js";

export interface OpfResult {
  title: string | null;
  author: string | null;
  overview: string | null;
  year: number | null;
  /** Keyed by scheme, lowercased ("isbn", "google", "amazon", ...) — Calibre's own metadata.opf
   * <dc:identifier scheme="..."> convention, not a uniqueid list like Kodi's NFOs. */
  externalIds: Record<string, string>;
}

function firstText(value: unknown): string | null {
  if (Array.isArray(value)) return firstText(value[0]);
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object" && "_" in (value as any)) return firstText((value as any)._);
  return null;
}

/** Parses a Calibre-convention metadata.opf — Dublin Core fields under <package><metadata>, one
 * file per book, sitting in the same folder as the book itself. */
export async function parseOpf(xml: string): Promise<OpfResult> {
  const stripNamespace = (name: string) => name.replace(/^.*:/, "");
  const parsed = await parseStringPromise(xml, {
    explicitArray: true,
    mergeAttrs: true,
    tagNameProcessors: [stripNamespace],
    attrNameProcessors: [stripNamespace],
  });
  const root = parsed?.package?.metadata?.[0] ?? parsed?.metadata?.[0] ?? null;
  if (!root) return { title: null, author: null, overview: null, year: null, externalIds: {} };

  const title = firstText(root.title);
  const author = firstText(root.creator);
  const overview = firstText(root.description);
  const dateText = firstText(root.date);
  const year = dateText ? parseInt(dateText.slice(0, 4), 10) : null;

  const externalIds: Record<string, string> = {};
  const identifiers = Array.isArray(root.identifier) ? root.identifier : root.identifier ? [root.identifier] : [];
  for (const entry of identifiers) {
    const scheme = (entry?.scheme ? String(entry.scheme) : "").toLowerCase();
    const value = firstText(entry);
    if (scheme && value) externalIds[scheme] = value;
  }

  return { title, author, overview, year: year && !Number.isNaN(year) ? year : null, externalIds };
}
