import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { log } from "./logger.js";
import { recycleFile } from "./recycleBin.js";

/**
 * The library file an import script is about to replace is moved into a hidden folder beside the destination
 * (`.aonarr-replaced-xxxxxxxx`) for the length of the run, because a script that overwrites its destination would destroy
 * it. Whatever happens next settles it in the same call: put back, or recycled. This journal covers the one case that call
 * cannot: the process stopping in the middle (a restart, a crash, a kill of the container during a script that may run for
 * minutes), after which nothing would know the old file is there. Each active set-aside is written down before the file
 * is moved and struck out once it is settled; at the next start `sweepSetAside` settles whatever is still listed.
 *
 * The journal is a small JSON file in the config folder. Every change reads and rewrites it without waiting in between,
 * so two imports setting a file aside together cannot lose each other's entry, and a rewrite goes through a temporary
 * file, so a reader never sees half of one.
 */

export interface SetAside {
  /** Where the file was: the destination of the import. */
  original: string;
  /** The hidden folder, and the file in it. */
  dir: string;
  file: string;
  mediaType: string;
  title: string;
  mediaItemId: number | null;
}

/** "restored": back at its original path. "recycled": in the recycle bin, which remembers the original path (the script left
 * something else there). "kept": neither was possible, so it is still where it was set aside. */
export type SetAsideOutcome = "restored" | "recycled" | "kept";

export const SET_ASIDE_JOURNAL_NAME = "import-script-setaside.json";

export function setAsideJournalPath(): string {
  return path.join(config.configDir, SET_ASIDE_JOURNAL_NAME);
}

function isEntry(value: unknown): value is SetAside {
  const entry = value as Partial<SetAside> | null;
  return (
    !!entry &&
    typeof entry.original === "string" &&
    typeof entry.dir === "string" &&
    typeof entry.file === "string" &&
    typeof entry.mediaType === "string" &&
    typeof entry.title === "string" &&
    (entry.mediaItemId === null || typeof entry.mediaItemId === "number")
  );
}

function readJournal(): SetAside[] {
  let raw: string;
  try {
    raw = fs.readFileSync(setAsideJournalPath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn("[importScript] couldn't read the set-aside journal:", (err as Error).message);
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch (err) {
    log.warn("[importScript] the set-aside journal is not readable and is ignored:", (err as Error).message);
    return [];
  }
}

function writeJournal(entries: SetAside[]): void {
  const file = setAsideJournalPath();
  if (entries.length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(entries));
  fs.renameSync(temp, file);
}

/** Writes the set-aside down; call before the file is moved. A journal that cannot be written is logged and the import goes on:
 * the config folder holds the database too, so a folder that cannot be written fails the import soon enough. */
export function recordSetAside(entry: SetAside): void {
  try {
    writeJournal([...readJournal().filter((e) => e.file !== entry.file), entry]);
  } catch (err) {
    log.warn(`[importScript] couldn't write down that "${entry.original}" was set aside; a restart during the script would leave it at "${entry.file}":`, (err as Error).message);
  }
}

/** Strikes a settled set-aside out. */
export function forgetSetAside(file: string): void {
  try {
    const entries = readJournal();
    const rest = entries.filter((e) => e.file !== file);
    if (rest.length !== entries.length) writeJournal(rest);
  } catch (err) {
    log.warn("[importScript] couldn't update the set-aside journal:", (err as Error).message);
  }
}

function removeEmptyFolder(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    // not empty, or already gone
  }
}

/**
 * Settles a set-aside file that is not going to be replaced after all: back at its original path when nothing is there
 * (never over anything), else into the recycle bin under that original path, so it can be restored from there and is not
 * left hidden for good. Strikes it out of the journal once it has gone either way. With the recycle bin switched off the
 * recycling deletes the file, as it does for any file an import replaces.
 */
export async function settleSetAside(entry: SetAside): Promise<SetAsideOutcome> {
  let originalFree = false;
  try {
    fs.lstatSync(entry.original);
  } catch (err) {
    originalFree = (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (originalFree) {
    try {
      fs.renameSync(entry.file, entry.original);
      removeEmptyFolder(entry.dir);
      forgetSetAside(entry.file);
      return "restored";
    } catch (err) {
      log.warn(`[importScript] couldn't put "${entry.original}" back from "${entry.file}":`, (err as Error).message);
    }
  }
  if (await recycleFile(entry.file, entry.mediaType, entry.title, entry.mediaItemId, entry.original)) {
    removeEmptyFolder(entry.dir);
    forgetSetAside(entry.file);
    return "recycled";
  }
  return "kept";
}

/**
 * At start-up: settles every set-aside the journal still lists, which are those a restart cut off. An entry whose set-aside
 * file is gone is struck out. Never throws, and leaves an entry it could not settle for the next start.
 */
export async function sweepSetAside(): Promise<{ restored: number; recycled: number; kept: number; gone: number }> {
  const tally = { restored: 0, recycled: 0, kept: 0, gone: 0 };
  let entries: SetAside[];
  try {
    entries = readJournal();
  } catch {
    return tally;
  }
  for (const entry of entries) {
    try {
      try {
        fs.lstatSync(entry.file);
      } catch {
        forgetSetAside(entry.file);
        removeEmptyFolder(entry.dir);
        tally.gone++;
        continue;
      }
      const outcome = await settleSetAside(entry);
      tally[outcome]++;
      if (outcome === "restored") log.info(`[importScript] a restart cut off an import script run: "${entry.original}" was put back`);
      else if (outcome === "recycled") log.info(`[importScript] a restart cut off an import script run: "${entry.original}" was moved to the recycle bin, as the script had put another file there`);
      else log.warn(`[importScript] a restart cut off an import script run: "${entry.original}" is still at "${entry.file}"`);
    } catch (err) {
      tally.kept++;
      log.warn(`[importScript] couldn't settle the file set aside for "${entry.original}":`, (err as Error).message);
    }
  }
  return tally;
}
