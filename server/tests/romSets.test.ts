import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { romSetCompanions, trackNamesOf } from "../src/services/romSets.js";

describe("trackNamesOf", () => {
  it("reads the files of a cue sheet, quoted or not", () => {
    const cue = 'FILE "Game (Track 1).bin" BINARY\r\n TRACK 01 MODE1/2352\r\nFILE Game2.bin BINARY\r\nFILE "Game (Track 1).bin" BINARY\r\n';
    expect(trackNamesOf(cue, ".cue")).toEqual(["Game (Track 1).bin", "Game2.bin"]);
  });

  it("reads the track files of a Dreamcast gdi, past its count line", () => {
    const gdi = '3\n1 0 4 2352 track01.bin 0\n2 450 0 2352 "track 02.raw" 0\n3 45000 4 2352 track03.bin 0\n';
    expect(trackNamesOf(gdi, ".gdi")).toEqual(["track01.bin", "track 02.raw", "track03.bin"]);
  });

  it("reads nothing from another kind of file", () => {
    expect(trackNamesOf("FILE x.bin BINARY", ".txt")).toEqual([]);
  });
});

describe("romSetCompanions", () => {
  it("lists the tracks that exist beside the sheet, and ignores a name that points out of its folder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "romset-"));
    try {
      fs.writeFileSync(path.join(dir, "g.cue"), 'FILE "g.bin" BINARY\nFILE "missing.bin" BINARY\nFILE "../escape.bin" BINARY\n');
      fs.writeFileSync(path.join(dir, "g.bin"), "x");
      fs.writeFileSync(path.join(path.dirname(dir), "escape.bin"), "x");
      expect(romSetCompanions(path.join(dir, "g.cue"))).toEqual([path.join(dir, "g.bin")]);
      expect(romSetCompanions(path.join(dir, "g.bin"))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(path.join(os.tmpdir(), "escape.bin"), { force: true });
    }
  });
});
