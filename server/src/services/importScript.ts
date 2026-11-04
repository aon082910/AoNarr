import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";

/**
 * Sonarr's and Radarr's custom import script (`UseScriptImport`, `ScriptImportPath`; ScriptImportDecider.cs): a program of
 * the admin's that is run in place of the move, copy or hardlink of a file into the library. It is called with two
 * arguments, the file's source path and the destination path the import would have used, and everything else it might
 * need (the title, its ids, the quality, the release group, the episodes) is in its environment.
 *
 * The contract is Starr's. The script must exit 0; any other code is a failed import. What it prints says what it did:
 *   [MoveStatus] DeferMove        nothing was done: the import moves the file as usual
 *   [MoveStatus] MoveComplete     the script put the file in place itself (the default when it prints no status)
 *   [MoveStatus] RenameRequested  the script put the file in the library and wants it renamed to the destination
 *   [MediaFile] <path>            where the script put the file, when that is not the destination
 *   [ExtraFile] <path>            a file the script placed beside it (noted in the log; AoNarr tracks no extra files)
 *   [PreventExtraImport]          do not copy the release's subtitles beside the file
 *
 * The script path is instance configuration of the admin's, with the same trust as the notification script
 * (`customScriptPath`): it is run directly with execFile (no shell), and no release text is ever put in an argument.
 */

/** How long a script may run before it is stopped and the import fails. */
export const IMPORT_SCRIPT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

let timeoutOverrideMs: number | null = null;

/** Test-only: a shorter timeout (null restores the real one). */
export function __setImportScriptTimeoutMsForTests(ms: number | null): void {
  timeoutOverrideMs = ms;
}

/** The script failed, timed out, could not be started, or said something that cannot be trusted: the import fails and the
 * download stays where it is. Not an ImportSkippedError: a broken script is the admin's to fix, then the import is retried. */
export class ImportScriptError extends Error {}

export function importScriptEnabled(): boolean {
  return getSetting("useScriptImport") === "1";
}

export function importScriptPath(): string {
  return (getSetting("scriptImportPath") ?? "").trim();
}

/** Why the path cannot be run, as a clause ("the script ... does not exist"), or null when it can. */
export function importScriptPathProblem(scriptPath: string): string | null {
  const target = scriptPath.trim();
  if (!target) return "no script path is set";
  if (!path.isAbsolute(target)) return `the script "${target}" must be given as an absolute path`;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return `the script "${target}" does not exist (is its folder mounted into the container?)`;
  }
  if (!stat.isFile()) return `"${target}" is not a file`;
  if (process.platform !== "win32") {
    try {
      fs.accessSync(target, fs.constants.X_OK);
    } catch {
      return `the script "${target}" is not executable (chmod +x it)`;
    }
  }
  return null;
}

export type ScriptMoveStatus = "DeferMove" | "MoveComplete" | "RenameRequested";

export interface ScriptOutput {
  status: ScriptMoveStatus;
  mediaFile: string | null;
  extraFiles: string[];
  importExtraFiles: boolean;
}

// Starr's own pattern, line for line.
const OUTPUT_LINE =
  /^(?:\[(?:(?<mediaFile>MediaFile)|(?<extraFile>ExtraFile))\]\s?(?<fileName>.+)|(?<preventExtraImport>\[PreventExtraImport\])|\[MoveStatus\]\s?(?:(?<deferMove>DeferMove)|(?<moveComplete>MoveComplete)|(?<renameRequested>RenameRequested)))$/;

/** What a script printed, as Starr reads it. Lines that are none of the markers are the script's own chatter and ignored. */
export function parseScriptOutput(stdout: string): ScriptOutput {
  const output: ScriptOutput = { status: "MoveComplete", mediaFile: null, extraFiles: [], importExtraFiles: true };
  for (const line of stdout.split(/\r?\n/)) {
    const match = OUTPUT_LINE.exec(line);
    const groups = match?.groups;
    if (!groups) continue;
    if (groups.mediaFile) {
      if (output.mediaFile !== null) throw new ImportScriptError("the script printed more than one [MediaFile]; only one media file can be returned");
      output.mediaFile = groups.fileName.trim();
    } else if (groups.extraFile) {
      output.extraFiles.push(groups.fileName.trim());
    } else if (groups.moveComplete) {
      output.status = "MoveComplete";
    } else if (groups.renameRequested) {
      output.status = "RenameRequested";
    } else if (groups.deferMove) {
      output.status = "DeferMove";
    } else if (groups.preventExtraImport) {
      output.importExtraFiles = false;
    }
  }
  return output;
}

/** What the script is told about the file, before it becomes environment variables. */
export interface ScriptFacts {
  sourcePath: string;
  destinationPath: string;
  /** What AoNarr would have done itself: move, copy, hardlink or symlink. */
  transferMode: string;
  mediaType: string;
  shape: "single" | "episodic";
  item: { id: number; title: string; year: number | null; folder: string; externalIds: Record<string, string>; seriesType: string | null };
  season: number | null;
  episodes: { id: number; number: number; airDate: string | null; title: string | null }[];
  quality: string | null;
  releaseTitle: string | null;
  releaseGroup: string | null;
  downloadId: string | null;
  downloadClientId: number | string | null;
  /** The library files this import replaces. */
  deletedPaths: string[];
}

/** `AONARR_<WORDS>` from a camelCase name, as the notification script's variables are named. */
function aonarrName(key: string): string {
  return `AONARR_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
}

const STARR_TRANSFER_MODE: Record<string, string> = { move: "Move", copy: "Copy", hardlink: "HardLinkOrCopy", symlink: "Symlink" };

/**
 * The script's environment: the process's own, then `AONARR_*` variables for the file and the title, then Starr's names
 * for the same facts (`Sonarr_*` for a show, `Radarr_*` for a film) so a script written for either runs unchanged.
 * Lists are comma separated, as in Sonarr, except titles and paths, which are separated by `|`.
 */
export function scriptEnvironment(facts: ScriptFacts): NodeJS.ProcessEnv {
  const ids = facts.item.externalIds;
  const episodes = facts.episodes;
  const own: Record<string, string | number | null | undefined> = {
    sourcePath: facts.sourcePath,
    destinationPath: facts.destinationPath,
    transferMode: facts.transferMode,
    mediaType: facts.mediaType,
    itemId: facts.item.id,
    itemTitle: facts.item.title,
    itemYear: facts.item.year,
    itemFolder: facts.item.folder,
    tmdbId: ids.tmdb,
    tvdbId: ids.tvdb,
    imdbId: ids.imdb,
    quality: facts.quality,
    releaseGroup: facts.releaseGroup,
    releaseTitle: facts.releaseTitle,
    sceneName: facts.releaseTitle,
    downloadId: facts.downloadId,
    downloadClientId: facts.downloadClientId,
    deletedPaths: facts.deletedPaths.join("|"),
  };
  if (facts.shape === "episodic") {
    Object.assign(own, {
      seriesType: facts.item.seriesType,
      seasonNumber: facts.season,
      episodeCount: episodes.length,
      episodeIds: episodes.map((e) => e.id).join(","),
      episodeNumbers: episodes.map((e) => e.number).join(","),
      episodeAirDates: episodes.map((e) => e.airDate ?? "").join(","),
      episodeTitles: episodes.map((e) => e.title ?? "").join("|"),
    });
  }

  const starr: Record<string, string | number | null | undefined> =
    facts.shape === "episodic"
      ? {
          Sonarr_SourcePath: facts.sourcePath,
          Sonarr_DestinationPath: facts.destinationPath,
          Sonarr_TransferMode: STARR_TRANSFER_MODE[facts.transferMode] ?? facts.transferMode,
          Sonarr_Series_Id: facts.item.id,
          Sonarr_Series_Title: facts.item.title,
          Sonarr_Series_Path: facts.item.folder,
          Sonarr_Series_TvdbId: ids.tvdb,
          Sonarr_Series_TmdbId: ids.tmdb,
          Sonarr_Series_ImdbId: ids.imdb,
          Sonarr_Series_Type: facts.item.seriesType ? facts.item.seriesType[0].toUpperCase() + facts.item.seriesType.slice(1) : null,
          Sonarr_EpisodeFile_EpisodeCount: episodes.length,
          Sonarr_EpisodeFile_EpisodeIds: episodes.map((e) => e.id).join(","),
          Sonarr_EpisodeFile_SeasonNumber: facts.season,
          Sonarr_EpisodeFile_EpisodeNumbers: episodes.map((e) => e.number).join(","),
          Sonarr_EpisodeFile_EpisodeAirDates: episodes.map((e) => e.airDate ?? "").join(","),
          Sonarr_EpisodeFile_EpisodeTitles: episodes.map((e) => e.title ?? "").join("|"),
          Sonarr_EpisodeFile_Quality: facts.quality,
          Sonarr_EpisodeFile_ReleaseGroup: facts.releaseGroup,
          Sonarr_EpisodeFile_SceneName: facts.releaseTitle,
          Sonarr_Download_Id: facts.downloadId,
          Sonarr_DeletedPaths: facts.deletedPaths.length > 0 ? facts.deletedPaths.join("|") : null,
        }
      : {
          Radarr_SourcePath: facts.sourcePath,
          Radarr_DestinationPath: facts.destinationPath,
          Radarr_TransferMode: STARR_TRANSFER_MODE[facts.transferMode] ?? facts.transferMode,
          Radarr_Movie_Id: facts.item.id,
          Radarr_Movie_Title: facts.item.title,
          Radarr_Movie_Year: facts.item.year,
          Radarr_Movie_Path: facts.item.folder,
          Radarr_Movie_TmdbId: ids.tmdb,
          Radarr_Movie_ImdbId: ids.imdb,
          Radarr_MovieFile_Quality: facts.quality,
          Radarr_MovieFile_ReleaseGroup: facts.releaseGroup,
          Radarr_MovieFile_SceneName: facts.releaseTitle,
          Radarr_Download_Id: facts.downloadId,
          Radarr_DeletedPaths: facts.deletedPaths.length > 0 ? facts.deletedPaths.join("|") : null,
        };

  const env: NodeJS.ProcessEnv = { ...process.env };
  const put = (name: string, value: string | number | null | undefined) => {
    // A NUL cannot be in an environment variable: spawn refuses the whole call.
    env[name] = value === null || value === undefined ? "" : String(value).replace(/\0/g, "");
  };
  for (const [key, value] of Object.entries(own)) put(aonarrName(key), value);
  for (const [name, value] of Object.entries(starr)) put(name, value);
  return env;
}

export interface ImportScriptRequest {
  sourcePath: string;
  destinationPath: string;
  env: NodeJS.ProcessEnv;
  /** The root folder the file belongs in: a file the script reports anywhere else is refused. */
  rootFolderPath: string;
  /** Extensions (lower case, with the dot) a reported media file may have. */
  mediaExtensions: readonly string[];
}

export interface ImportScriptResult {
  status: ScriptMoveStatus;
  /** Where the script says the file now is, checked; the destination path when it names none. Unset for DeferMove. */
  finalPath: string | null;
  extraFiles: string[];
  importExtraFiles: boolean;
}

function failureText(err: NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: unknown }, stderr: string): string {
  const tail = stderr.trim().split(/\r?\n/).slice(-3).join(" / ").slice(-300);
  const detail = tail ? ` (${tail})` : "";
  if (typeof err.code === "number") return `exited with code ${err.code}${detail}`;
  if (err.signal) return `was ended by ${err.signal}${detail}`;
  if (err.code === "ENOENT" || err.code === "EACCES" || err.code === "ENOEXEC") return `could not be started: ${err.message}`;
  if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "printed too much output";
  return `failed: ${err.message}${detail}`;
}

/**
 * Runs the import script for one file and reads what it says. Throws ImportScriptError when it cannot be run, exits
 * non-zero, runs past the timeout (the process is killed), or reports a file that is not a media file inside the root
 * folder. Nothing is moved, deleted or recorded here: the caller decides what the answer means for the file.
 */
export async function runImportScript(request: ImportScriptRequest): Promise<ImportScriptResult> {
  const scriptPath = importScriptPath();
  const problem = importScriptPathProblem(scriptPath);
  if (problem) throw new ImportScriptError(`the import script cannot run: ${problem}`);
  const name = path.basename(scriptPath);
  const timeoutMs = timeoutOverrideMs ?? IMPORT_SCRIPT_TIMEOUT_MS;

  log.debug(`[importScript] running "${scriptPath}" for "${request.sourcePath}" -> "${request.destinationPath}"`);
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    // Arguments are the two paths and nothing else; both are absolute, so neither can read as an option.
    const child = execFile(
      scriptPath,
      [request.sourcePath, request.destinationPath],
      { env: request.env, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, killSignal: "SIGKILL" },
      (err, out, errOut) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) reject(new ImportScriptError(`the import script "${name}" ${failureText(err as never, String(errOut ?? ""))}`));
        else resolve({ stdout: String(out ?? ""), stderr: String(errOut ?? "") });
      }
    );
    // The callback waits for the script's output pipes to close, which a grandchild it left running keeps open: the
    // timer gives up on its own, so a script that hangs cannot hold the import (and the lane behind it) for ever.
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(new ImportScriptError(`the import script "${name}" ran for more than ${Math.max(1, Math.round(timeoutMs / 1000))} seconds and was stopped`));
    }, timeoutMs);
    child.stdin?.end();
  });
  if (stderr.trim()) log.debug(`[importScript] "${name}" wrote to stderr: ${stderr.trim().slice(-500)}`);
  log.debug(`[importScript] "${name}" output: ${stdout.trim().slice(-1000)}`);

  const output = parseScriptOutput(stdout);
  for (const extra of output.extraFiles) log.info(`[importScript] "${name}" placed the extra file "${extra}"`);
  if (output.status === "DeferMove") return { status: output.status, finalPath: null, extraFiles: output.extraFiles, importExtraFiles: output.importExtraFiles };

  const finalPath = output.mediaFile ?? request.destinationPath;
  if (!path.isAbsolute(finalPath)) throw new ImportScriptError(`the import script "${name}" reported "${finalPath}", which is not an absolute path`);
  if (output.mediaFile !== null && !request.mediaExtensions.includes(path.extname(finalPath).toLowerCase())) {
    throw new ImportScriptError(`the import script "${name}" reported "${finalPath}", which is not a media file`);
  }
  let reported: fs.Stats | null = null;
  try {
    reported = fs.statSync(finalPath);
  } catch {
    // reported stays null
  }
  if (!reported?.isFile()) {
    throw new ImportScriptError(
      output.mediaFile !== null
        ? `the import script "${name}" reported "${finalPath}", which does not exist`
        : `the import script "${name}" finished without putting a file at "${finalPath}" (it should print [MoveStatus] DeferMove to leave the move to AoNarr)`
    );
  }
  const relative = path.relative(path.resolve(request.rootFolderPath), path.resolve(finalPath));
  if (relative === "" || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new ImportScriptError(`the import script "${name}" put the file at "${finalPath}", outside the root folder "${request.rootFolderPath}"`);
  }
  return { status: output.status, finalPath: path.resolve(finalPath), extraFiles: output.extraFiles, importExtraFiles: output.importExtraFiles };
}
