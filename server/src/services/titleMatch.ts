/**
 * Title normalization and comparison shared by every surface that asks "is this the same title":
 * the library scan (where these functions lived first), the IRC announce matcher, media-server
 * import, and the release identity gate (releaseIdentity.ts). A pure module with no DB or service
 * imports, so the scheduler and the parser-side code can use it without pulling libraryScan's
 * metadata/ffprobe dependencies along.
 */

/** Lowercased letters/digits only, Latin/Greek accents folded ("Émile" -> "emile"). Any script's
 * letters are kept — an ASCII-only filter reduced every Cyrillic/CJK/Greek title to "", which never
 * matches, so each such file created its own new item. Only accents on Latin/Greek letters are
 * dropped: elsewhere a mark is part of the letter (Japanese dakuten, Devanagari vowel signs, Thai
 * tones, Cyrillic й), and dropping it made different titles ("がき"/"かき") match. */
export function normalizeForMatch(s: string): string {
  // Canonical decomposition only, with fractions/superscripts dropped like any other punctuation: a
  // compatibility decomposition turned "™" into "tm" and "½" into "1 2", so "Tetris™" stopped
  // matching "Tetris" and a new file in a "Ranma" folder stopped matching "Ranma ½".
  return s
    .normalize("NFD")
    .replace(/([\p{Script=Latin}\p{Script=Greek}])[̀-ͯ]+/gu, "$1")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{Nd}\p{Nl}]+/gu, " ")
    .trim();
}

/** The key titles were matched by before other scripts' letters were kept: ASCII letters/digits. */
function asciiMatchKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function titlesMatch(a: string, b: string): boolean {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  // Exact normalized equality only. This used to also accept a.includes(b)/b.includes(a),
  // which merged any two shows/movies/albums whose normalized titles happened to be a
  // subset of one another (e.g. "Extraction" swallowing "Extraction 2", "The Office"
  // swallowing "The Office UK") into a single media_items row during Scan & Import —
  // reported as two different TV shows in two different folders getting collapsed into one.
  if (na && nb && na === nb) return true;
  // Titles that matched under the old ASCII-only key still do: a folder carrying a native-script
  // alias ("BTS (방탄소년단)") must keep joining the item added as "BTS", not start a second one.
  // A leftover of digits alone is only the sequel/volume number different titles share ("신과함께 2",
  // "범죄도시 2"), so it counts only when one title is nothing but that number ("2046 (花樣年華)").
  const la = asciiMatchKey(a);
  if (!la || la !== asciiMatchKey(b)) return false;
  return /[a-z]/.test(la) || la === na || la === nb;
}

/** The old (pre-exact-match) substring-inclusive comparison — deliberately kept around for just
 * one job: deciding whether a scanned file's filename/folder-guessed title is "close enough" to
 * be worth considering for a specific, already-known item (the `onlyTitle`-scoped per-item/
 * per-season Scan & Import button). A real metadata title ("The Office (US)") routinely doesn't
 * match a filename-guessed title ("The Office") under exact comparison, which — once titlesMatch()
 * became exact-only — made every single-item Scan & Import silently skip every file (reported as
 * "matched 0, created 0, skipped N" with no explanation, since a mismatched onlyTitle isn't
 * itself an error). Safe to keep loose here specifically because a per-item scan already knows
 * its target by id: this only widens which files get a *chance* to be considered, it doesn't
 * decide which existing show a file merges into — that still goes through the strict, exact
 * titlesMatch() below, so this can't reintroduce the cross-show-merge bug that made titlesMatch()
 * exact-only in the first place. Whole-word containment either way ("the office" within "the office
 * us"), never a raw substring, which let "go" match inside "django for beginners". */
export function looseTitlesMatch(a: string, b: string): boolean {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  return na === nb || ` ${na} `.includes(` ${nb} `) || ` ${nb} `.includes(` ${na} `);
}

/** Whether a provider hit is the title a file/folder named — tolerating a trailing "(2005)"/"(US)"
 * qualifier one provider adds and another doesn't ("Doctor Who (2005)" vs "Doctor Who"), and the
 * punctuation scene/clean filenames drop ("Greys Anatomy" vs "Grey's Anatomy", "Law and Order" vs
 * "Law & Order"). Never used to pick which existing item a file joins — that stays titlesMatch. */
export function sameTitleIgnoringQualifier(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/\s*\([^()]*\)\s*$/, "");
  const compact = (s: string) => normalizeForMatch(s.replace(/['’`]/g, "").replace(/&/g, " and ")).replace(/ /g, "");
  const same = (x: string, y: string) => titlesMatch(x, y) || (!!compact(x) && compact(x) === compact(y));
  return same(a, b) || same(strip(a), strip(b));
}
