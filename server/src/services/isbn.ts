function isValidIsbn10(digits: string): boolean {
  if (digits.length !== 10) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    if (!/\d/.test(digits[i])) return false;
    sum += Number(digits[i]) * (10 - i);
  }
  const last = digits[9].toUpperCase();
  const lastVal = last === "X" ? 10 : Number(last);
  if (Number.isNaN(lastVal)) return false;
  sum += lastVal;
  return sum % 11 === 0;
}

function isValidIsbn13(digits: string): boolean {
  if (!/^97[89]\d{10}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

/** Converts an ISBN-10 to its ISBN-13 equivalent (978 prefix + recomputed check digit) — Open
 * Library's lookup accepts either, but normalizing to 13 keeps the returned id consistent
 * regardless of which one the book's own metadata happened to print. */
function isbn10To13(isbn10: string): string {
  const core = "978" + isbn10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return core + check;
}

/**
 * Scans free text for the first plausible, checksum-valid ISBN — tries a labeled "ISBN ..."
 * occurrence first (most reliable, since a book's own copyright page nearly always prints the
 * label), then falls back to any bare 10/13-digit run that passes its checksum. Hyphens/spaces
 * within a candidate are tolerated (real ISBNs are almost always printed with them) and stripped
 * before validation.
 */
export function findIsbnInText(text: string): string | null {
  const labeled = text.match(/ISBN(?:-1[03])?\s*:?\s*([\dXx][\dXx\- ]{8,16}[\dXx])/gi);
  const candidates: string[] = [];
  if (labeled) {
    for (const m of labeled) {
      const digits = m.replace(/^ISBN(?:-1[03])?\s*:?\s*/i, "");
      candidates.push(digits);
    }
  }
  // Bare digit runs, whether or not a label was found nearby — plenty of scanned/OCR'd copyright
  // pages lose the "ISBN" label itself but keep the number.
  const bare = text.match(/\b(?:97[89][\d\- ]{10,17}|[\dXx][\dXx\- ]{8,16}[\dXx])\b/g);
  if (bare) candidates.push(...bare);

  for (const raw of candidates) {
    const found = isbnFromCandidate(raw);
    if (found) return found;
  }
  return null;
}

/** Both patterns are greedy across spaces, so an ISBN followed by other numbers ("9780306406157
 * 10 9 8 7" — a printer's key) is captured as one over-long run that is never exactly 10/13 digits.
 * Tries every whitespace-aligned leading slice of the run, preferring an ISBN-13 over an ISBN-10. */
function isbnFromCandidate(raw: string): string | null {
  let prefix = "";
  let isbn10: string | null = null;
  for (const group of raw.trim().split(/\s+/)) {
    prefix += group.replace(/[^\dXx]/g, "").toUpperCase();
    if (prefix.length === 13 && isValidIsbn13(prefix)) return prefix;
    if (prefix.length === 10 && isValidIsbn10(prefix)) isbn10 = prefix;
    if (prefix.length >= 13) break;
  }
  return isbn10 ? isbn10To13(isbn10) : null;
}

/** The first checksum-valid ISBN among a book's own identifier values (EPUB dc:identifier entries,
 * a MOBI EXTH ISBN record) — each is checked on its own so a UUID or ASIN never merges with a
 * neighbour into a false match. */
export function findIsbnInIdentifiers(identifiers: readonly string[]): string | null {
  for (const value of identifiers) {
    const found = findIsbnInText(value);
    if (found) return found;
  }
  return null;
}
