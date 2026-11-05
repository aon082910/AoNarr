/**
 * The quality ladder a new install starts with, worst to best, and the tiers that were added to it after
 * installs existed. No dependencies, so db/client.ts can seed from it ahead of the rest of the app.
 *
 * The names are Radarr's and Sonarr's (Quality.cs), and the places follow Radarr's weights: the pre-release
 * copies at the very bottom, then the standard-definition tiers (SDTV, DVD, DVD-R, the 480p/576p web and disc
 * rips), then HD by resolution, BR-DISK and Raw-HD last. "SD" is AoNarr's own and stays: it is the grade of a
 * standard-definition release whose source cannot be told (a bare "480p", a BDRip with no resolution), and
 * the tier every older profile and stored file already names.
 */
export const DEFAULT_QUALITY_ORDER = [
  // Pre-release copies, which a profile has to ask for by name.
  "WORKPRINT",
  "CAM",
  "TELESYNC",
  "TELECINE",
  "REGIONAL",
  "DVDSCR",
  // Standard definition.
  "SD",
  "SDTV",
  "DVD",
  "DVD-R",
  "WEBRip-480p",
  "WEBDL-480p",
  "Bluray-480p",
  "Bluray-576p",
  // HD and UHD.
  "HDTV-720p",
  "WEBRip-720p",
  "WEBDL-720p",
  "Bluray-720p",
  "HDTV-1080p",
  "WEBRip-1080p",
  "WEBDL-1080p",
  "Bluray-1080p",
  "Remux-1080p",
  "HDTV-2160p",
  "WEBRip-2160p",
  "WEBDL-2160p",
  "Bluray-2160p",
  "Remux-2160p",
  // Untouched discs and raw captures, as Radarr ranks them: above everything an encode can be.
  "BR-DISK",
  "Raw-HD",
] as const;

/** The ladder before it was extended (what an install from before that holds, give or take Bluray-720p). */
export const LEGACY_QUALITY_ORDER = [
  "SD",
  "DVD",
  "HDTV-720p",
  "WEBRip-720p",
  "WEBDL-720p",
  "Bluray-720p",
  "HDTV-1080p",
  "WEBRip-1080p",
  "WEBDL-1080p",
  "Bluray-1080p",
  "Remux-1080p",
  "HDTV-2160p",
  "WEBRip-2160p",
  "WEBDL-2160p",
  "Bluray-2160p",
  "Remux-2160p",
] as const;

/** The pre-release copies: nothing a profile allows unless its admin asked for them. */
export const PRE_RELEASE_QUALITIES = ["WORKPRINT", "CAM", "TELESYNC", "TELECINE", "REGIONAL", "DVDSCR"] as const;

/**
 * Standard-definition tiers that used to be graded "SD". A profile that allowed "SD" gains them when the ladder
 * is extended, so it takes the same releases it always did.
 */
export const SD_CLASS_QUALITIES = ["SDTV", "WEBRip-480p", "WEBDL-480p", "Bluray-480p", "Bluray-576p"] as const;

/** A DVD image was refused as "Unknown" before: a profile that allows "DVD" gains this one with the extension. */
export const DVD_IMAGE_QUALITY = "DVD-R";

/** Tiers no profile gains by itself: a copy, a disc image or a raw capture was refused or mis-graded before. */
export const OPT_IN_QUALITIES = [...PRE_RELEASE_QUALITIES, "BR-DISK", "Raw-HD"] as const;

/** The tiers the extension adds: everything on the default ladder the legacy one did not have. */
export const EXTENDED_LADDER_TIERS: readonly string[] = DEFAULT_QUALITY_ORDER.filter((name) => !(LEGACY_QUALITY_ORDER as readonly string[]).includes(name));

/** What the "Any" profile of a new install allows: its older list, plus the SD-class tiers beside "SD". */
export const DEFAULT_PROFILE_QUALITIES = [
  "SD",
  ...SD_CLASS_QUALITIES,
  "HDTV-720p",
  "WEBDL-720p",
  "Bluray-720p",
  "HDTV-1080p",
  "WEBDL-1080p",
  "Bluray-1080p",
  "Remux-2160p",
] as const;
