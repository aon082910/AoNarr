/**
 * Size limits a new install starts with, in megabytes per minute of video (Sonarr's and Radarr's
 * default quality definitions). Only a database with no qualities yet gets them, together with the
 * setting `sizeLimitMode` = "perMinute" that makes the numbers mean per minute; an existing install
 * keeps whatever it has.
 *
 * Where the two apps differ the looser value is taken, so that a tier that suits films does not
 * reject an episode and the reverse: the minimums are Sonarr's (they are what stop a 5 MB "1080p"),
 * the maximums are the larger of the two, and an open maximum (null) is where either app leaves it open.
 * No dependencies, so db/client.ts can use it ahead of the rest of the app.
 */
export interface DefaultQualitySize {
  min: number;
  max: number | null;
  preferred: number | null;
}

export const DEFAULT_QUALITY_SIZES: Record<string, DefaultQualitySize> = {
  // Pre-release copies: Radarr's limits (no minimum, 100 MB per minute at most).
  WORKPRINT: { min: 0, max: 100, preferred: 95 },
  CAM: { min: 0, max: 100, preferred: 95 },
  TELESYNC: { min: 0, max: 100, preferred: 95 },
  TELECINE: { min: 0, max: 100, preferred: 95 },
  REGIONAL: { min: 0, max: 100, preferred: 95 },
  DVDSCR: { min: 0, max: 100, preferred: 95 },
  SD: { min: 2, max: 100, preferred: 95 },
  SDTV: { min: 2, max: 100, preferred: 95 },
  DVD: { min: 2, max: 100, preferred: 95 },
  "DVD-R": { min: 2, max: 100, preferred: 95 },
  "WEBRip-480p": { min: 2, max: 100, preferred: 95 },
  "WEBDL-480p": { min: 2, max: 100, preferred: 95 },
  "Bluray-480p": { min: 2, max: 100, preferred: 95 },
  "Bluray-576p": { min: 2, max: 100, preferred: 95 },
  "HDTV-720p": { min: 3, max: 125, preferred: 95 },
  "WEBRip-720p": { min: 3, max: 130, preferred: 95 },
  "WEBDL-720p": { min: 3, max: 130, preferred: 95 },
  "Bluray-720p": { min: 4, max: 130, preferred: 95 },
  "HDTV-1080p": { min: 4, max: 125, preferred: 95 },
  "WEBRip-1080p": { min: 4, max: 130, preferred: 95 },
  "WEBDL-1080p": { min: 4, max: 130, preferred: 95 },
  "Bluray-1080p": { min: 4, max: null, preferred: null },
  "Remux-1080p": { min: 35, max: null, preferred: null },
  "HDTV-2160p": { min: 35, max: null, preferred: null },
  "WEBRip-2160p": { min: 35, max: null, preferred: null },
  "WEBDL-2160p": { min: 35, max: null, preferred: null },
  "Bluray-2160p": { min: 35, max: null, preferred: null },
  "Remux-2160p": { min: 35, max: null, preferred: null },
  "BR-DISK": { min: 0, max: null, preferred: null },
  "Raw-HD": { min: 4, max: null, preferred: null },
};

/** Off only when the environment says so; the test suite does, because its fixtures use releases of any size. */
export function seedQualitySizesEnabled(): boolean {
  return process.env.AONARR_SEED_QUALITY_SIZES !== "0";
}
