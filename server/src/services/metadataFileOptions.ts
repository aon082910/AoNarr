import { getSetting } from "./settingsStore.js";
import { effectiveShape, getMediaTypeConfig, MEDIA_TYPES } from "./mediaTypes.js";

/**
 * Which metadata files AoNarr writes beside the media (NFO sidecars and artwork), per kind of library, after Sonarr's and
 * Lidarr's per-consumer metadata options.
 *
 * Kinds follow the shape of a library on disk, not a list of types: a movie-shaped type (Movies, Sports PPV, ROMs), an
 * episodic one (TV Shows, Anime, Sports, Courses, Adult), a music one and every other collection (Books, Comics, ...).
 *
 * NFO files:
 *  - `writeNfoOnImport` is the long-standing switch for movies, shows and the single-file collections, and stays the
 *    default for them;
 *  - `nfoTvEnabled` overrides it for shows only ("1" / "0"; unset follows `writeNfoOnImport`);
 *  - `nfoMusicEnabled` is new with music NFOs, so it is off until switched on: an upgrade must not start writing files.
 *
 * Artwork files: `writeImagesOnImport` is the master switch (off by default); the four kinds under it are on once the
 * master is, unless switched off one by one. `overwriteMetadataFiles` lets a run replace images already there.
 */
export type MetadataKind = "movie" | "tv" | "music" | "other";

export interface MetadataFileOptions {
  nfo: Record<MetadataKind, boolean>;
  /** The master switch for artwork files. */
  images: boolean;
  /** poster + fanart of a movie or a show. */
  posterFanart: boolean;
  seasonPosters: boolean;
  episodeThumbs: boolean;
  /** An album's cover and an artist's picture. */
  musicCover: boolean;
  overwrite: boolean;
}

/** An image kind is on when the master is on and the kind itself has not been switched off. */
function imageKindOn(master: boolean, key: string): boolean {
  return master && getSetting(key) !== "0";
}

export function readMetadataFileOptions(): MetadataFileOptions {
  const legacy = getSetting("writeNfoOnImport") === "1";
  const tv = getSetting("nfoTvEnabled");
  const images = getSetting("writeImagesOnImport") === "1";
  return {
    nfo: {
      movie: legacy,
      tv: tv === "1" ? true : tv === "0" ? false : legacy,
      music: getSetting("nfoMusicEnabled") === "1",
      other: legacy,
    },
    images,
    posterFanart: imageKindOn(images, "imagesPosterFanart"),
    seasonPosters: imageKindOn(images, "imagesSeasonPosters"),
    episodeThumbs: imageKindOn(images, "imagesEpisodeThumbs"),
    musicCover: imageKindOn(images, "imagesMusicCover"),
    overwrite: getSetting("overwriteMetadataFiles") === "1",
  };
}

export function metadataKindOf(item: { type: string; legacyShape?: string | null }): MetadataKind {
  const shape = effectiveShape(item);
  if (shape === "single") return "movie";
  if (shape === "episodic") return "tv";
  return getMediaTypeConfig(item.type).sidecarFormat === "kodi-music" ? "music" : "other";
}

/** Whether an NFO is written for an item of this kind at import. */
export function nfoEnabledFor(item: { type: string; legacyShape?: string | null }, options = readMetadataFileOptions()): boolean {
  return options.nfo[metadataKindOf(item)];
}

/**
 * Whether artwork is written beside this kind of item at all: movies and shows of the types that follow the Kodi video
 * convention (so not ROMs), and music. Books and comics have no poster-in-the-folder convention worth guessing at.
 */
export function imagesApplyTo(item: { type: string; legacyShape?: string | null }): boolean {
  const kind = metadataKindOf(item);
  if (kind === "music") return true;
  return (kind === "movie" || kind === "tv") && MEDIA_TYPES[item.type]?.sidecarFormat === "kodi-video";
}

/** Whether any file kind is switched on for this kind of item (nothing to do otherwise). */
export function anythingEnabledFor(item: { type: string; legacyShape?: string | null }, options = readMetadataFileOptions()): boolean {
  const kind = metadataKindOf(item);
  if (options.nfo[kind] && kind !== "other") return true;
  if (!imagesApplyTo(item)) return false;
  if (kind === "music") return options.musicCover;
  return options.posterFanart || (kind === "tv" && (options.seasonPosters || options.episodeThumbs));
}
