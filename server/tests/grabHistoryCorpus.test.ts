import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseReleaseTitle } from "../src/services/releaseParser.js";
import { releaseIdentifiesTarget, type IdentityTarget } from "../src/services/releaseIdentity.js";

/**
 * Real grabs from the owner's Radarr and Sonarr history (2026-11-04 to 2026-11-26, 61,770 grabs).
 * Every row is a release that AoNarr's identity gate either accepted by indexer id alone or
 * rejected. A model labelled each row from its own film and TV knowledge (no web lookups), and a
 * sample was checked by hand; the 64 rows it could not settle are left out. `same` is true when the
 * release is that film or an episode of that show. `category` says why (localized_title, alt_title,
 * different_work, wrong_year, subset_title, spinoff, numbering, ...). Treat single labels as likely,
 * not certain.
 *
 * This is a ratchet, not a list of exact answers: the gate may not accept more of the wrong releases
 * or fewer of the right ones than it does today. When a change improves either number, lower or raise
 * the bound here in the same commit.
 */

interface Row {
  release: string;
  indexer: { imdbId?: string; tmdbId?: string; tvdbId?: string };
  target: IdentityTarget;
  same: boolean;
  category: string;
  starr: "radarr" | "sonarr";
}

const here = path.dirname(fileURLToPath(import.meta.url));
const rows: Row[] = fs
  .readFileSync(path.join(here, "fixtures", "grab-history-corpus.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row);

function score(starr: Row["starr"]) {
  const counts = { rightAccepted: 0, rightRejected: 0, wrongAccepted: 0, wrongRejected: 0 };
  const wrongAccepted: string[] = [];
  for (const row of rows.filter((r) => r.starr === starr)) {
    const verdict = releaseIdentifiesTarget({ title: row.release, ...row.indexer }, parseReleaseTitle(row.release), row.target);
    if (row.same) counts[verdict.ok ? "rightAccepted" : "rightRejected"]++;
    else {
      counts[verdict.ok ? "wrongAccepted" : "wrongRejected"]++;
      if (verdict.ok) wrongAccepted.push(`${row.release} -> ${row.target.title} (${row.target.year})`);
    }
  }
  return { counts, wrongAccepted };
}

describe("identity gate against labelled grab history", () => {
  it("has well-formed rows", () => {
    expect(rows.length).toBeGreaterThan(900);
    for (const row of rows) {
      expect(typeof row.release).toBe("string");
      expect(typeof row.same).toBe("boolean");
      expect(row.target.title).toBeTypeOf("string");
    }
  });

  it("films: accepts no more wrong releases and no fewer right ones than today", () => {
    const { counts, wrongAccepted } = score("radarr");
    // Before the 2026-11 change: 109 wrong accepted, 213 right accepted. Rows keep 12 aliases each.
    expect(counts.wrongAccepted, wrongAccepted.join("\n")).toBeLessThanOrEqual(11);
    expect(counts.rightAccepted).toBeGreaterThanOrEqual(289);
  });

  it("shows: accepts no more wrong releases and no fewer right ones than today", () => {
    const { counts, wrongAccepted } = score("sonarr");
    expect(counts.wrongAccepted, wrongAccepted.join("\n")).toBeLessThanOrEqual(22);
    expect(counts.rightAccepted).toBeGreaterThanOrEqual(93);
  });
});
