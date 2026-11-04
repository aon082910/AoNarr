import { describe, it, expect, vi, beforeEach } from "vitest";

// Counts how often titles are normalized, to show the targets are normalized once and not once per file.
const normalizeCalls = vi.fn();
vi.mock("../src/services/titleMatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/titleMatch.js")>();
  return {
    ...actual,
    normalizeForMatch: (s: string) => {
      normalizeCalls(s);
      return actual.normalizeForMatch(s);
    },
  };
});

import { buildScopeTitleIndex } from "../src/services/scopeTitleIndex.js";
import { looseTitlesMatch } from "../src/services/titleMatch.js";

beforeEach(() => normalizeCalls.mockClear());

const targets = [
  { id: 1, title: "The Office (US)" },
  { id: 2, title: "Ranma ½" },
  { id: 3, title: "Grey's Anatomy" },
  { id: 4, title: "Extraction" },
  { id: 5, title: "!!!" },
  { id: 6, title: "BTS" },
];
const files = [
  "The Office",
  "The Office US",
  "Ranma",
  "Ranma 1/2",
  "Greys Anatomy",
  "Grey's Anatomy",
  "Extraction 2",
  "Extraction",
  "Django for beginners",
  "Go",
  "BTS (방탄소년단)",
  "",
  "???",
  "Unrelated Show",
];

describe("buildScopeTitleIndex", () => {
  it("answers the same as looseTitlesMatch against each target, and returns the first target that matches", () => {
    const index = buildScopeTitleIndex(targets);
    for (const file of files) {
      const expected = targets.find((t) => looseTitlesMatch(file, t.title));
      expect(index.find(file), `file "${file}"`).toBe(expected);
      expect(index.has(file)).toBe(expected !== undefined);
    }
  });

  it("normalizes each target once, however many files are matched", () => {
    const index = buildScopeTitleIndex(targets);
    expect(normalizeCalls).toHaveBeenCalledTimes(targets.length);
    normalizeCalls.mockClear();

    for (const file of files) index.find(file);

    // One normalization per file, none per target and file.
    expect(normalizeCalls).toHaveBeenCalledTimes(files.length);
  });

  it("matches 5,000 files against 200 targets quickly", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: i, title: `Target Show ${i} Special` }));
    const index = buildScopeTitleIndex(many);
    const started = performance.now();
    let hits = 0;
    for (let f = 0; f < 5000; f++) {
      if (index.has(f % 10 === 0 ? `Target Show ${f % 200} Special` : `Some Other Folder ${f}`)) hits++;
    }
    const elapsed = performance.now() - started;
    expect(hits).toBe(500);
    expect(elapsed).toBeLessThan(2000);
  });
});
