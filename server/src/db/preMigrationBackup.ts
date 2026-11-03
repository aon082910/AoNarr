import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { config } from "../config.js";

/**
 * A copy of the SQLite database taken at startup, before the schema and column migrations of db/client.ts
 * run, whenever the running build differs from the one that last started (Sonarr and Radarr take a
 * backup of this kind before installing an update). Every migration here runs the moment client.ts is
 * imported, with no snapshot and no schema version, so a bad one on a live library had no way back.
 *
 * Keyed on AONARR_BUILD_TIME, which the image build bakes in: a local or dev run has none and is never
 * snapshotted. A fresh install has nothing to protect. One copy per build, so a start-up crash loop
 * cannot overwrite the good copy with a half-migrated database; the newest PRE_MIGRATION_KEEP are kept.
 * The copy is made with VACUUM INTO (a consistent copy of the live file) and holds the database only, no
 * encryption key: migrations never change the key. Postgres is not covered: its schema step is idempotent
 * and a dump needs pg_dump, which the scheduled backup already uses.
 */
export const PRE_MIGRATION_KEEP = 3;
const FILE_PREFIX = "aonarr-pre-migration-";
const STATE_FILE = "last-build.json";
/** A failed pre-migration copy is shown in Health for this long after it happened. */
const PROBLEM_VISIBLE_DAYS = 7;

export interface PreMigrationState {
  buildId: string;
  at: string;
  file?: string;
  error?: string;
}

export type PreMigrationResult =
  | { kind: "skipped" }
  | { kind: "written"; file: string }
  | { kind: "failed"; error: string };

export function preMigrationDir(): string {
  return path.join(config.configDir, "Backups", "pre-migration");
}

export function currentBuildId(): string | null {
  return config.buildTime || null;
}

function sanitizeForFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function readState(dir: string): PreMigrationState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), "utf-8")) as PreMigrationState;
  } catch {
    return null;
  }
}

/** Keeps the copy just written and the `keep - 1` newest others. */
function rotate(dir: string, keep: number, justWritten: string): void {
  const others = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith(".db") && f !== justWritten)
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of others.slice(Math.max(0, keep - 1))) fs.rmSync(path.join(dir, old.f), { force: true });
}

/**
 * Takes the copy when `existedBefore` (the database file was already there and not empty when the app
 * opened it) and `buildId` differs from the build that last finished its migrations. Never throws: a
 * failure is returned so the caller can report it, and start-up goes on (a backup problem must not
 * stop the app from starting).
 */
export function snapshotBeforeMigration(
  db: Database.Database,
  existedBefore: boolean,
  buildId: string | null,
  dir: string = preMigrationDir(),
  keep: number = PRE_MIGRATION_KEEP
): PreMigrationResult {
  if (!existedBefore || !buildId) return { kind: "skipped" };
  const state = readState(dir);
  if (state?.buildId === buildId) return { kind: "skipped" };
  const target = path.join(dir, `${FILE_PREFIX}${sanitizeForFileName(buildId)}.db`);
  // Written under another name and renamed when complete: a copy cut short by a restart (a 10 s
  // SIGKILL during a long VACUUM INTO) must never be found later and trusted as the safety copy.
  const partial = `${target}.partial`;
  if (fs.existsSync(target)) return { kind: "skipped" };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(partial, { force: true });
    db.exec(`VACUUM INTO '${partial.replace(/'/g, "''")}'`);
    fs.renameSync(partial, target);
  } catch (err) {
    try {
      fs.rmSync(partial, { force: true });
    } catch {
      // nothing was written there
    }
    return { kind: "failed", error: (err as Error).message };
  }
  try {
    rotate(dir, keep, path.basename(target));
  } catch {
    // Trimming old copies is best effort: the new copy is complete and stays.
  }
  return { kind: "written", file: target };
}

/** Called once every migration has finished, so the next start of the same build does not copy again. */
export function recordMigrationDone(buildId: string | null, result: PreMigrationResult, dir: string = preMigrationDir()): void {
  if (!buildId) return;
  const state: PreMigrationState = { buildId, at: new Date().toISOString() };
  if (result.kind === "written") state.file = result.file;
  if (result.kind === "failed") state.error = result.error;
  // Skipped because the file for this build already exists: keep what the first start recorded.
  if (result.kind === "skipped") {
    const previous = readState(dir);
    if (previous?.buildId === buildId) return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state));
  } catch {
    // Not being able to write the marker only means the next start may skip or repeat a copy.
  }
}

/** Why the copy taken before the last upgrade failed, for Health, or null. */
export function getPreMigrationProblem(dir: string = preMigrationDir()): string | null {
  const state = readState(dir);
  if (!state?.error) return null;
  const ageDays = (Date.now() - new Date(state.at).getTime()) / (24 * 60 * 60 * 1000);
  if (!(ageDays < PROBLEM_VISIBLE_DAYS)) return null;
  return `The backup taken before upgrading the database failed, so this upgrade has no safety copy: ${state.error}`;
}
