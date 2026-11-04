import path from "node:path";
import { getSetting } from "./settingsStore.js";
import { parseExternalIds, slugOf } from "../starr/shapes.js";

/**
 * What a notification can know about the title it is for, beyond its text. The notify functions take it as an
 * optional last argument; the connection's tag filter and the Sonarr/Radarr-shaped webhook body use it. Everything is
 * optional: a call site passes what it has, and a field nobody passed is left out of the body rather than invented.
 */
export interface NotifyMedia {
  id?: number;
  type: string;
  title: string;
  year?: number | null;
  path?: string | null;
  externalIds?: Record<string, string>;
  releaseDate?: string | null;
  seriesType?: string | null;
}

export interface NotifyEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string | null;
  airDate?: string | null;
}

export interface NotifyContext {
  /** The title: its tags decide which tagged connections hear of it, and the webhook body is built from its row. */
  mediaItemId?: number | null;
  /** The title's tags, when the caller already has them (a title that is being deleted has no row left to ask). */
  tagIds?: number[];
  /** The title as it was, when its row may be gone by the time the notification is sent. */
  media?: NotifyMedia;
  episodeIds?: number[];
  release?: { title?: string; indexer?: string | null; size?: number | null; quality?: string | null; releaseGroup?: string | null; protocol?: string | null };
  downloadClient?: { name?: string; type?: string; downloadId?: string | null };
  file?: { path: string; size?: number | null; quality?: string | null; releaseGroup?: string | null; sceneName?: string | null };
  renamed?: { from: string; to: string }[];
  health?: { level?: "warning" | "error"; types?: string[] };
}

/** The context once its title and episodes have been looked up. */
export interface ResolvedNotifyContext extends NotifyContext {
  episodes?: NotifyEpisode[];
}

export interface PayloadContent {
  title: string;
  text: string;
  payload: Record<string, unknown>;
}

const SERIES_TYPES = new Set(["series", "anime", "sports"]);

const asString = (value: unknown): string | undefined => (value == null || value === "" ? undefined : String(value));

function numeric(value: string | undefined): number | undefined {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) ? n : undefined;
}

function folderOf(media: NotifyMedia): string | undefined {
  if (!media.path) return undefined;
  return /\.[A-Za-z0-9]{2,5}$/.test(media.path) ? path.dirname(media.path) : media.path;
}

/** Sonarr's `series` object, Radarr's `movie` object, or a plain `media` object for a library they have no word for. */
function mediaPart(media: NotifyMedia | undefined): Record<string, unknown> {
  if (!media) return {};
  const ids = media.externalIds ?? {};
  if (SERIES_TYPES.has(media.type)) {
    return {
      series: {
        id: media.id,
        title: media.title,
        titleSlug: slugOf(media.title, media.id ?? ""),
        path: folderOf(media),
        tvdbId: numeric(ids.tvdb),
        tmdbId: numeric(ids.tmdb),
        imdbId: ids.imdb,
        type: media.seriesType || (media.type === "anime" ? "anime" : "standard"),
        year: media.year ?? undefined,
      },
    };
  }
  if (media.type === "movie") {
    return {
      movie: {
        id: media.id,
        title: media.title,
        year: media.year ?? undefined,
        releaseDate: media.releaseDate ?? undefined,
        folderPath: folderOf(media),
        tmdbId: numeric(ids.tmdb),
        imdbId: ids.imdb,
      },
    };
  }
  return { media: { id: media.id, type: media.type, title: media.title, year: media.year ?? undefined, path: folderOf(media) } };
}

function episodesPart(ctx: ResolvedNotifyContext): Record<string, unknown> {
  if (!ctx.episodes || ctx.episodes.length === 0) return {};
  return {
    episodes: ctx.episodes.map((e) => ({
      id: e.id,
      seasonNumber: e.seasonNumber,
      episodeNumber: e.episodeNumber,
      title: e.title ?? undefined,
      airDate: e.airDate ?? undefined,
      seriesId: ctx.media?.id,
    })),
  };
}

function relativeTo(media: NotifyMedia | undefined, file: string): string {
  const folder = media ? folderOf(media) : undefined;
  if (folder && file.startsWith(folder)) return file.slice(folder.length).replace(/^[\\/]+/, "");
  return path.basename(file);
}

function fileObject(media: NotifyMedia | undefined, file: NonNullable<NotifyContext["file"]>): Record<string, unknown> {
  return {
    relativePath: relativeTo(media, file.path),
    path: file.path,
    quality: file.quality ?? undefined,
    releaseGroup: file.releaseGroup ?? undefined,
    sceneName: file.sceneName ?? undefined,
    size: file.size ?? undefined,
  };
}

/** The key Sonarr/Radarr name a title's file by. */
const fileKey = (media: NotifyMedia | undefined, series: string, movie: string): string => (media && SERIES_TYPES.has(media.type) ? series : movie);

/**
 * The body Sonarr and Radarr send a webhook, for the events AoNarr has: `eventType` is their name for it, and the
 * title, release and file objects follow their documented shapes as far as AoNarr's data goes. A field AoNarr has no
 * value for is left out, not made up. Events they have no name for (duplicates found) keep AoNarr's own name.
 */
export function buildStarrPayload(content: PayloadContent, ctx: ResolvedNotifyContext): Record<string, unknown> {
  const p = content.payload;
  const event = String(p.event ?? "");
  const media = ctx.media;
  const base = { instanceName: "AoNarr", applicationUrl: (getSetting("externalUrl") ?? "").replace(/\/+$/, "") };
  const client = {
    downloadClient: ctx.downloadClient?.name,
    downloadClientType: ctx.downloadClient?.type,
    downloadId: ctx.downloadClient?.downloadId ?? undefined,
  };
  const release = () => ({
    release: {
      quality: ctx.release?.quality ?? undefined,
      releaseGroup: ctx.release?.releaseGroup ?? undefined,
      releaseTitle: asString(p.releaseTitle) ?? ctx.release?.title,
      indexer: ctx.release?.indexer ?? undefined,
      size: ctx.release?.size ?? undefined,
    },
  });

  switch (event) {
    case "test":
      // Sonarr's own test message carries a made-up series, and receivers read series.title from it.
      return { eventType: "Test", series: { id: 1, title: "Test Title", path: "C:\\testpath", tvdbId: 1234 }, ...base };
    case "grabbed":
      return { eventType: "Grab", ...mediaPart(media), ...episodesPart(ctx), ...release(), ...client, ...base };
    case "imported":
    case "upgraded":
      return {
        eventType: "Download",
        ...mediaPart(media),
        ...episodesPart(ctx),
        ...(ctx.file ? { [fileKey(media, "episodeFile", "movieFile")]: fileObject(media, ctx.file) } : { fileName: asString(p.fileName) }),
        isUpgrade: event === "upgraded",
        ...client,
        ...base,
      };
    case "renamed": {
      const renamed = (ctx.renamed ?? []).map((r) => ({
        relativePath: relativeTo(media, r.to),
        path: r.to,
        previousRelativePath: relativeTo(media, r.from),
        previousPath: r.from,
      }));
      return { eventType: "Rename", ...mediaPart(media), ...(renamed.length > 0 ? { [fileKey(media, "renamedEpisodeFiles", "renamedMovieFiles")]: renamed } : {}), ...base };
    }
    case "added":
      return { eventType: media && SERIES_TYPES.has(media.type) ? "SeriesAdd" : "MovieAdded", ...mediaPart(media), ...base };
    case "deleted":
      return { eventType: media && SERIES_TYPES.has(media.type) ? "SeriesDelete" : "MovieDelete", ...mediaPart(media), deletedFiles: p.deletedFiles === true, ...base };
    case "fileDeleted":
      return {
        eventType: media && SERIES_TYPES.has(media.type) ? "EpisodeFileDelete" : "MovieFileDelete",
        ...mediaPart(media),
        ...episodesPart(ctx),
        ...(ctx.file ? { [fileKey(media, "episodeFile", "movieFile")]: fileObject(media, ctx.file) } : { fileName: asString(p.fileName) }),
        deleteReason: "manual",
        ...base,
      };
    case "manualInteractionRequired":
      return {
        eventType: "ManualInteractionRequired",
        ...mediaPart(media),
        ...episodesPart(ctx),
        downloadInfo: { title: ctx.release?.title, quality: ctx.release?.quality ?? undefined, size: ctx.release?.size ?? undefined, statusMessages: [{ title: "Manual interaction required", messages: [String(p.reason ?? "")] }] },
        ...client,
        ...base,
      };
    case "failed":
      // Neither app has a failed-download webhook of its own (Lidarr names it DownloadFailure).
      return { eventType: "DownloadFailure", ...mediaPart(media), ...episodesPart(ctx), message: asString(p.reason), ...client, ...base };
    case "healthIssue":
      return { eventType: "Health", level: ctx.health?.level ?? "warning", message: asString(p.summary), type: ctx.health?.types?.length === 1 ? ctx.health.types[0] : undefined, ...base };
    case "healthRestored":
      return { eventType: "HealthRestored", message: asString(p.summary), ...base };
    case "updateAvailable":
      return { eventType: "ApplicationUpdate", message: asString(p.title), ...base };
    default:
      return { eventType: event === "duplicatesFound" ? "DuplicatesFound" : event, ...p, event: undefined, ...base };
  }
}

/** A media row (media_items) as the context's title. */
export function mediaFromRow(row: any): NotifyMedia {
  return {
    id: Number(row.id),
    type: String(row.type),
    title: String(row.title),
    year: row.year == null ? null : Number(row.year),
    path: row.path ?? null,
    externalIds: parseExternalIds(row.external_ids),
    releaseDate: row.release_date ?? null,
    seriesType: row.series_type ?? null,
  };
}
