import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseReleaseTitle } from "../src/services/releaseParser.js";
import { releaseIdentifiesTarget } from "../src/services/releaseIdentity.js";

/**
 * Table-driven release-name corpus (MATCHING_ACCURACY_PLAN.md, Round 0).
 *
 * Every row in fixtures/release-corpus.jsonl is parsed with parseReleaseTitle and its `expect`
 * fields are asserted as they hold TODAY. A row may also carry `todo: { round, expect }` — the
 * behaviour a later round will deliver. Those run as `it.fails`, so the suite is green while the
 * bug stands and turns red the moment a round fixes it, which is the cue to fold `todo.expect`
 * into `expect` and drop the marker. `identity[]` rows describe the Round 1 identity gate
 * (releaseIdentifiesTarget) against fixtures/identity-library.json; until that module exists they
 * are registered as pending so the expectations are reviewed with the parser rows.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");

type Expectation = Record<string, unknown>;
interface IdentityCheck {
  item: string;
  round: string;
  indexer?: { imdbId?: string; tmdbId?: string; tvdbId?: string };
  expect: { ok: boolean; matchType: string; reason?: string };
}
interface CorpusRow {
  title: string;
  kind: "release" | "file";
  expect: Expectation;
  todo?: { round: string; expect: Expectation };
  identity?: IdentityCheck[];
}
interface LibraryItem {
  type: string;
  title: string;
  year: number | null;
  externalIds: Record<string, string>;
  aliases: { title: string; source: string }[];
}

const rows: CorpusRow[] = fs
  .readFileSync(path.join(fixtures, "release-corpus.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as CorpusRow);

const library = JSON.parse(fs.readFileSync(path.join(fixtures, "identity-library.json"), "utf8")) as Record<string, LibraryItem | string>;
const libraryItems = Object.fromEntries(Object.entries(library).filter(([key]) => !key.startsWith("_"))) as Record<string, LibraryItem>;

/** Corpus keys that are shorthand for a ParsedRelease field. Keys not listed map to themselves —
 * including fields later rounds add (rejected, seasonRange), which read as `undefined` until they
 * exist. */
const FIELD: Record<string, string> = {
  season: "seasonNumber",
  episodes: "episodeNumbers",
  absolute: "absoluteEpisode",
  group: "releaseGroup",
  fullSeason: "isFullSeason",
};

const KNOWN_FUTURE_FIELDS = new Set(["rejected", "seasonRange"]);

function assertParsed(title: string, expectation: Expectation): void {
  const parsed = parseReleaseTitle(title) as unknown as Record<string, unknown>;
  for (const [key, want] of Object.entries(expectation)) {
    const field = FIELD[key] ?? key;
    expect(parsed[field], `${field} of "${title}"`).toEqual(want);
  }
}

describe("release-name corpus", () => {
  it("has well-formed rows", () => {
    expect(rows.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const row of rows) {
      expect(typeof row.title, `title of ${JSON.stringify(row)}`).toBe("string");
      expect(["release", "file"]).toContain(row.kind);
      expect(row.expect, `expect of "${row.title}"`).toBeTypeOf("object");
      const key = `${row.kind}:${row.title}`;
      expect(seen.has(key), `duplicate row "${key}"`).toBe(false);
      seen.add(key);
      for (const key of Object.keys(row.expect)) {
        expect(KNOWN_FUTURE_FIELDS.has(key), `"${row.title}" asserts future field "${key}" outside a todo`).toBe(false);
      }
      if (row.todo) {
        expect(row.todo.round, `todo round of "${row.title}"`).toMatch(/^R[1-6]$/);
        expect(Object.keys(row.todo.expect).length, `empty todo on "${row.title}"`).toBeGreaterThan(0);
      }
      for (const check of row.identity ?? []) {
        expect(libraryItems[check.item], `"${row.title}" references unknown library item "${check.item}"`).toBeDefined();
        expect(check.round).toMatch(/^R[1-6]$/);
        expect(typeof check.expect.ok).toBe("boolean");
        if (!check.expect.ok) expect(check.expect.matchType).toBe("none");
      }
    }
  });

  it("has a well-formed identity library", () => {
    for (const [key, item] of Object.entries(libraryItems)) {
      expect(item.title, `title of ${key}`).toBeTypeOf("string");
      expect(item.type, `type of ${key}`).toBeTypeOf("string");
      expect(item.year === null || typeof item.year === "number", `year of ${key}`).toBe(true);
      expect(item.externalIds, `externalIds of ${key}`).toBeTypeOf("object");
      expect(Array.isArray(item.aliases), `aliases of ${key}`).toBe(true);
    }
  });

  describe("parses today's behaviour", () => {
    for (const row of rows) {
      it(`${row.kind}: ${row.title}`, () => assertParsed(row.title, row.expect));
    }
  });

  describe("pending parser fixes (it.fails: green while the bug stands)", () => {
    for (const row of rows) {
      if (!row.todo) continue;
      it.fails(`[${row.todo.round}] ${row.kind}: ${row.title}`, () => assertParsed(row.title, { ...row.expect, ...row.todo!.expect }));
    }
  });

  describe("identity gate (releaseIdentifiesTarget, per-item, no alias rows yet)", () => {
    for (const row of rows) {
      for (const check of row.identity ?? []) {
        const want = check.expect.ok ? `ok as ${check.expect.matchType}` : `rejected (${check.expect.reason ?? "no reason"})`;
        const name = `[${check.round}] "${row.title}" vs ${check.item}${check.indexer ? " (indexer ids)" : ""} → ${want}`;
        // Rounds 3 and 4 add alias rows and fansub season/part conventions; until then those
        // checks describe the target behaviour and stay pending.
        if (check.round !== "R1") {
          it.todo(name);
          continue;
        }
        it(name, () => {
          const lib = libraryItems[check.item];
          const verdict = releaseIdentifiesTarget(
            { title: row.title, imdbId: check.indexer?.imdbId ?? null, tmdbId: check.indexer?.tmdbId ?? null, tvdbId: check.indexer?.tvdbId ?? null },
            parseReleaseTitle(row.title),
            { type: lib.type, title: lib.title, year: lib.year, externalIds: lib.externalIds }
          );
          expect({ ok: verdict.ok, matchType: verdict.matchType, ...(check.expect.reason ? { reason: verdict.reason } : {}) }, verdict.detail).toEqual(check.expect);
        });
      }
    }
  });
});
