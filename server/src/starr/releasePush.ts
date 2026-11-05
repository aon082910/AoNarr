import { db } from "../db/index.js";
import { ReleasePushInvalid, pushRelease, type PushOutcome } from "../services/releasePush.js";
import { parseReleaseTitle } from "../services/releaseParser.js";
import { STARR_APPS, type StarrApp } from "./apps.js";
import { loadQualityCatalog, qualityModelOf, validationFailure } from "./shapes.js";
import type { StarrRoutes } from "./router.js";

/**
 * `POST /release/push` (autobrr and scripts): the sender found a release first and hands it over. The release is judged and
 * grabbed by the one-release step of the RSS sync (services/releasePush.ts), and the answer is the list of release resources a
 * Starr app gives, with `approved`, `rejected`, `temporarilyRejected` and the `rejections` that say why. The native route
 * (`POST /api/releases/push`) takes the same body and answers the same list.
 */

const ENGLISH = { id: 1, name: "English" };
const pascal = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** The Starr app whose library types include this item's type, for the `mapped...Id` field of the answer. */
async function appOfItem(id: number | null): Promise<StarrApp | null> {
  if (id == null) return null;
  const row = (await db.prepare("SELECT type FROM media_items WHERE id = ?").get(id)) as { type: string } | undefined;
  return row ? Object.values(STARR_APPS).find((a) => a.types.includes(row.type)) ?? null : null;
}

/** The release resource of a judged push. The download link is not in it (it can carry an indexer key). */
export async function releaseResources({ pushed, judgement }: PushOutcome, app?: StarrApp): Promise<any[]> {
  const release = pushed.release;
  const parsed = parseReleaseTitle(release.title);
  const catalog = await loadQualityCatalog();
  const approved = judgement.outcome === "grabbed";
  const temporarilyRejected = !approved && judgement.temporary;
  const rejected = !approved && !temporarilyRejected;
  const mapped = app ?? (await appOfItem(judgement.mediaItemId));
  const published = release.publishDate ? Date.parse(release.publishDate) : NaN;
  const minutes = Number.isFinite(published) ? Math.max(0, Math.floor((Date.now() - published) / 60000)) : 0;
  return [
    {
      guid: pushed.guid,
      quality: qualityModelOf(catalog, judgement.quality),
      qualityWeight: 0,
      age: Math.floor(minutes / 1440),
      ageHours: Math.round((minutes / 60) * 10) / 10,
      ageMinutes: minutes,
      size: release.size,
      indexerId: release.indexerId ?? 0,
      indexer: release.indexerName,
      releaseGroup: parsed.releaseGroup ?? undefined,
      releaseHash: release.infoHash ?? "",
      title: release.title,
      fullSeason: !!parsed.isFullSeason,
      sceneSource: false,
      seasonNumber: parsed.seasonNumber ?? 0,
      languages: [ENGLISH],
      languageWeight: 0,
      approved,
      temporarilyRejected,
      rejected,
      rejections: approved ? [] : judgement.reasons,
      publishDate: release.publishDate,
      protocol: release.protocol,
      seeders: release.seeders ?? undefined,
      leechers: release.leechers ?? undefined,
      indexerFlags: 0,
      customFormats: [],
      customFormatScore: 0,
      downloadAllowed: approved,
      releaseWeight: 0,
      episodeRequested: approved,
      ...(mapped && judgement.mediaItemId != null ? { [`mapped${pascal(mapped.parent)}Id`]: judgement.mediaItemId } : {}),
    },
  ];
}

/** A push body that is no release, as the validation list a Starr app answers (field names as its validator has them). */
export function asValidationFailure(err: ReleasePushInvalid) {
  return validationFailure(err.issues);
}

export function registerReleasePushRoutes(r: StarrRoutes): void {
  const app = r.app;
  r.post(
    "/release/push",
    "Hand over a release: it is judged like one of a feed and grabbed when it passes",
    async (req) => {
      try {
        return await releaseResources(await pushRelease(req.body, { types: app.types }), app);
      } catch (err) {
        if (err instanceof ReleasePushInvalid) throw asValidationFailure(err);
        throw err;
      }
    },
    200
  );
}
