import fs from "node:fs";
import path from "node:path";

/**
 * A disc game is several files: a .cue sheet (or a Dreamcast .gdi) naming the .bin tracks that hold the data. The
 * sheet is the file the importer is given; the tracks it names have to go with it, under the names it gives them,
 * or the game will not load.
 */

/** The track file names a .cue or .gdi sheet lists, as written ("Game (Track 1).bin"). */
export function trackNamesOf(sheetText: string, extension: string): string[] {
  const names: string[] = [];
  if (extension.toLowerCase() === ".cue") {
    // FILE "Game (Track 1).bin" BINARY   /   FILE Game.bin BINARY
    for (const m of sheetText.matchAll(/^\s*FILE\s+(?:"([^"]+)"|(\S+))\s+\w+/gim)) names.push((m[1] ?? m[2]).trim());
  } else if (extension.toLowerCase() === ".gdi") {
    // <track> <lba> <type> <sector size> <file name> <offset>; the first line is the track count.
    for (const line of sheetText.split(/\r?\n/).slice(1)) {
      const m = line.match(/^\s*\d+\s+\d+\s+\d+\s+\d+\s+(?:"([^"]+)"|(\S+))/);
      if (m) names.push((m[1] ?? m[2]).trim());
    }
  }
  return Array.from(new Set(names));
}

/** The track files of the sheet at `sheetPath` that exist beside it. Names that point out of the folder are ignored. */
export function romSetCompanions(sheetPath: string): string[] {
  const extension = path.extname(sheetPath);
  if (![".cue", ".gdi"].includes(extension.toLowerCase())) return [];
  let text: string;
  try {
    text = fs.readFileSync(sheetPath, "utf8");
  } catch {
    return [];
  }
  const dir = path.dirname(sheetPath);
  const found: string[] = [];
  for (const name of trackNamesOf(text, extension)) {
    if (name !== path.basename(name)) continue; // a path out of the sheet's folder is no companion
    let file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      // Sheets are often written on a system that ignores case: "Game.bin" for a "game.BIN" on disk.
      const actual = fs.readdirSync(dir).find((entry) => entry.toLowerCase() === name.toLowerCase());
      if (!actual) continue;
      file = path.join(dir, actual);
    }
    if (file !== sheetPath && fs.statSync(file).isFile()) found.push(file);
  }
  return found;
}
