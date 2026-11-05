import { db } from "../db/index.js";
import { HttpError } from "../middleware/errorHandler.js";
import { fetchByExternalId, searchMetadata, type MetadataSearchResult } from "../services/metadata.js";
import { COLLECTION_MONITOR_MODES, isNewItemMode } from "../services/monitorModes.js";
import { queueSearchAfterAdd } from "../services/searchOnAdd.js";
import { callNative } from "./native.js";
import { type StarrApp, typeFilter } from "./apps.js";
import { checkEdits, findExisting, oneAddAtATime, oneResource, requireTitle, rootFolderByPath } from "./libraryRoutes.js";
import { loadContext, subItemResource, titleResources, titleRows, type LibraryContext } from "./libraryResources.js";
import { idList, images, parseExternalIds, slugOf, validationFailure } from "./shapes.js";
import type { StarrRoutes } from "./router.js";

/**
 * Lidarr's and Readarr's lookup and add: `GET /artist/lookup`, `GET /author/lookup`, `POST /artist`, `POST /author`, and the
 * album and book lookups. Sonarr and Radarr have theirs in libraryRoutes.ts; the edit (PUT) and the delete are the shared ones
 * there. As for them, the add is AoNarr's own (`POST /api/metadata/import`, called in process), so an artist or author added
 * from here has the albums or books, the root folder defaults and the scan of the disk that an add from the web has.
 *
 * Lidarr identifies an artist by its MusicBrainz id and Readarr an author by a Goodreads id; AoNarr's author provider is Open
 * Library, so `foreignAuthorId` is an Open Library author id (OL...A) here, and is what a lookup answers.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** lidarr:<mbid>, lidarrid:<mbid>, mbid:<mbid>, musicbrainz:<mbid>, or a bare MusicBrainz id. */
const ARTIST_TERM = new RegExp(`^(?:(?:lidarr|lidarrid|mbid|musicbrainz):\\s*)?(${UUID})$`, "i");
/** readarr:<id>, openlibrary:<OL...A> and olid:<OL...A>, or a bare Open Library author id. */
const AUTHOR_TERM = /^(?:(?:readarr|readarrid|openlibrary|olid):\s*)?(OL\d+A)$/i;
const ISBN_TERM = /^isbn:\s*([\dXx][\dXx\- ]{8,16}[\dXx])$/i;
/** The forms that name one album or book by the foreign id the library keeps for it. */
const ALBUM_TERM = /^(?:lidarr|lidarrid|mbid|musicbrainz):\s*(\S+)$/i;
const BOOK_TERM = /^(?:readarr|readarrid|openlibrary|olid|goodreads):\s*(\S+)$/i;

const NEVER_ADDED = "0001-01-01T00:00:00Z";

function titleIn(rows: any[], ids: Record<string, string>): any | null {
  const wanted = Object.entries(ids).filter(([key, value]) => value && ["musicbrainz", "openlibrary"].includes(key));
  if (wanted.length === 0) return null;
  return (
    rows.find((row) => {
      const have = parseExternalIds(row.external_ids);
      return wanted.some(([key, value]) => have[key] === value);
    }) ?? null
  );
}

/** A provider's result as a resource of a title that is not in the library (id 0), in the shape the app's own lookup answers. */
function lookupResource(ctx: LibraryContext, result: MetadataSearchResult): any {
  const app = ctx.app;
  const ids = result.externalIds ?? {};
  const ended = /ended|inactive|deceased/i.test(result.status ?? "");
  const base = {
    id: 0,
    overview: result.overview ?? "",
    disambiguation: "",
    images: images(result.posterUrl, result.backdropUrl),
    links: [] as unknown[],
    path: "",
    qualityProfileId: 0,
    metadataProfileId: 0,
    monitored: false,
    monitorNewItems: "all",
    rootFolderPath: "",
    folder: "",
    genres: result.genres ?? [],
    tags: [] as number[],
    added: NEVER_ADDED,
    ratings: { votes: 0, value: result.rating ?? 0 },
    status: ended ? "ended" : "continuing",
    ended,
    sortName: result.title.toLowerCase(),
    cleanName: slugOf(result.title, "").replace(/-/g, ""),
  };
  if (app.key === "lidarr") {
    return {
      ...base,
      artistName: result.title,
      foreignArtistId: ids.musicbrainz ?? "",
      artistType: "",
      statistics: { albumCount: 0, trackFileCount: 0, trackCount: 0, totalTrackCount: 0, sizeOnDisk: 0, percentOfTracks: 0 },
    };
  }
  return {
    ...base,
    authorName: result.title,
    authorNameLastFirst: result.title,
    foreignAuthorId: ids.openlibrary ?? "",
    statistics: { bookCount: 0, bookFileCount: 0, availableBookCount: 0, totalBookCount: 0, sizeOnDisk: 0, percentOfBooks: 0 },
  };
}

/** The identity a lookup term names, as the id the metadata providers take, or null when it is a search. */
function idOfTerm(app: StarrApp, term: string): { provider: string; id: string } | null {
  if (app.key === "lidarr") {
    const hit = ARTIST_TERM.exec(term);
    return hit ? { provider: "musicbrainz", id: hit[1].toLowerCase() } : null;
  }
  const hit = AUTHOR_TERM.exec(term);
  if (hit) return { provider: "openlibrary", id: hit[1].toUpperCase() };
  const isbn = ISBN_TERM.exec(term);
  return isbn ? { provider: "isbn", id: isbn[1] } : null;
}

async function lookupTitles(ctx: LibraryContext, term: string): Promise<any[]> {
  const app = ctx.app;
  const type = app.parent;
  const rows = await titleRows(app);
  const local = async (row: any) => oneResource(ctx, row);
  const named = idOfTerm(app, term);
  let results: MetadataSearchResult[];
  if (named) {
    // A title the library already holds is answered first, with its own id and without waiting for a provider that may be down.
    const held = titleIn(rows, { [named.provider]: named.id });
    if (held) return [await local(held)];
    try {
      results = [await fetchByExternalId(type, named.provider, named.id)];
    } catch {
      // A provider that does not answer, or does not know the id, finds nothing: the caller shows "not found".
      return [];
    }
    // An ISBN names a book. The author it resolves to is the one the book lists; a book that lists none (the provider then
    // answers the book itself) is not an author, and a result without an author id could not be added.
    if (named.provider === "isbn" && !results[0].externalIds?.openlibrary) return [];
  } else if (/^(?:goodreads|readarr|lidarr|lidarrid|mbid|musicbrainz|openlibrary|olid|asin|isbn):/i.test(term)) {
    // An id form no provider here can resolve (Goodreads and ASIN ids, a malformed id): nothing is found.
    return [];
  } else {
    try {
      results = (await searchMetadata(type, term)).slice(0, 20);
    } catch {
      return [];
    }
  }
  return Promise.all(
    results.map(async (result) => {
      const held = titleIn(rows, result.externalIds ?? {});
      return held ? local(held) : lookupResource(ctx, result);
    })
  );
}

/** Albums or books the library holds, by the foreign id it keeps for them or by the words of the term. AoNarr adds an album or a book with its artist or author, so an album that is not in the library is found by looking up its artist. */
async function lookupChildren(ctx: LibraryContext, term: string): Promise<any[]> {
  const app = ctx.app;
  const f = typeFilter(app);
  const foreign = (app.key === "lidarr" ? ALBUM_TERM : BOOK_TERM).exec(term);
  let rows: any[];
  if (foreign) {
    rows = (await db.prepare(`SELECT s.* FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE ${f.sql} AND s.external_id = ? ORDER BY s.id LIMIT 50`).all(...f.params, foreign[1])) as any[];
  } else {
    const words = term
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .slice(0, 6);
    if (words.length === 0) return [];
    const clause = words.map(() => "(LOWER(s.title) LIKE ? OR LOWER(m.title) LIKE ?)").join(" AND ");
    rows = (await db
      .prepare(`SELECT s.* FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE ${f.sql} AND ${clause} ORDER BY s.title, s.id LIMIT 50`)
      .all(...f.params, ...words.flatMap((w) => [`%${w}%`, `%${w}%`]))) as any[];
  }
  if (rows.length === 0) return [];
  const resources = await titleResources(ctx, await titleRows(app, [...new Set(rows.map((r) => Number(r.media_item_id)))]));
  const parents = new Map<number, unknown>(resources.map((t) => [Number(t.id), t]));
  return rows.map((row) => subItemResource(ctx, app, row, { artist: parents.get(Number(row.media_item_id)) }));
}

async function addArtistOrAuthor(req: any, app: StarrApp): Promise<any> {
  const b = req.body ?? {};
  const lidarr = app.key === "lidarr";
  const idField = lidarr ? "ForeignArtistId" : "ForeignAuthorId";
  const raw = String((lidarr ? b.foreignArtistId : b.foreignAuthorId) ?? "").trim();
  const identity = raw ? idOfTerm(app, raw) : null;
  if (!identity || identity.provider === "isbn") {
    throw validationFailure([{ propertyName: idField, errorMessage: raw ? `${idField} "${raw}" is not an id ${app.appName} can look up here (${lidarr ? "a MusicBrainz artist id" : "an Open Library author id such as OL23919A"})` : `${idField} must be given` }]);
  }
  const duplicate = await findExisting(app, { [identity.provider]: identity.id });
  if (duplicate) throw validationFailure([{ propertyName: idField, errorMessage: `This ${app.parent} has already been added` }]);

  let found: MetadataSearchResult;
  try {
    found = await fetchByExternalId(app.parent, identity.provider, identity.id);
  } catch {
    throw validationFailure([{ propertyName: idField, errorMessage: `No ${app.parent} was found for ${identity.provider}:${identity.id}` }]);
  }
  // A second look for the identity the provider returned: it may name the title by an id the request did not.
  if (await findExisting(app, found.externalIds ?? {})) throw validationFailure([{ propertyName: idField, errorMessage: `This ${app.parent} has already been added` }]);

  const folder = await rootFolderByPath(app, b.rootFolderPath);
  await checkEdits(app, b);

  // The Monitor option: Lidarr's and Readarr's (all, future, missing, existing, first, latest, none). Anything else (unknown,
  // specificAlbum, specificBook) is a choice by the list of albums or books named below, or no choice at all.
  const addOptions = b.addOptions && typeof b.addOptions === "object" ? b.addOptions : {};
  const named = lidarr ? addOptions.albumsToMonitor : addOptions.booksToMonitor;
  const chosen: string[] = Array.isArray(named) ? named.map(String).filter(Boolean) : [];
  const option = typeof addOptions.monitor === "string" ? addOptions.monitor : undefined;
  let monitorStrategy: string | undefined = option && (COLLECTION_MONITOR_MODES as readonly string[]).includes(option) ? option : undefined;
  if (chosen.length > 0 && monitorStrategy === undefined) monitorStrategy = "none";
  const monitored = b.monitored === false ? 0 : 1;

  const imported = await callNative(req.app, "POST", "/api/metadata/import", {
    type: app.parent,
    title: found.title,
    year: found.year,
    overview: found.overview,
    posterUrl: found.posterUrl,
    backdropUrl: found.backdropUrl,
    externalIds: found.externalIds,
    ...(folder ? { rootFolderId: folder.id } : {}),
    qualityProfileId: Number(b.qualityProfileId) > 0 ? Number(b.qualityProfileId) : undefined,
    metadataProfileId: Number(b.metadataProfileId) > 0 ? Number(b.metadataProfileId) : undefined,
    monitored,
    monitorStrategy,
    monitorNewItems: isNewItemMode(b.monitorNewItems) ? b.monitorNewItems : undefined,
    tagIds: idList(b.tags),
    confirmDuplicate: true,
  });
  const id = Number(imported.body.id);

  // Albums or books named by their foreign ids are the ones to monitor (the rest came in unmonitored with the "none" strategy).
  if (chosen.length > 0) {
    const wanted = new Set(chosen);
    const rows = (await db.prepare("SELECT id, external_id FROM sub_items WHERE media_item_id = ?").all(id)) as { id: number; external_id: string | null }[];
    for (const row of rows) {
      if (row.external_id && wanted.has(row.external_id)) await callNative(req.app, "PATCH", `/api/media/${id}/subitems/${row.id}`, { monitored: 1 });
    }
  }

  const wantsSearch = !!(lidarr ? addOptions.searchForMissingAlbums : addOptions.searchForMissingBooks);
  // The search waits for the disk scan that follows an add and skips a title the scan found a file for.
  if (wantsSearch && monitored === 1) queueSearchAfterAdd(id);

  const ctx = await loadContext(app);
  return oneResource(ctx, await requireTitle(app, id));
}

/** Registered before libraryRoutes' `/:id` routes, which would take "lookup" for an id. */
export function registerMusicBookRoutes(r: StarrRoutes): void {
  const app = r.app;
  if (app.key !== "lidarr" && app.key !== "readarr") return;
  const lookupHelp = app.key === "lidarr" ? "lidarr:, mbid: or a title" : "openlibrary:, isbn: or a name";

  r.get(`/${app.parent}/lookup`, `Find an ${app.parent} by id (${lookupHelp})`, async (req) => {
    const term = String(req.query.term ?? "").trim();
    if (!term) throw new HttpError(400, "term is required");
    return lookupTitles(await loadContext(app), term);
  });
  r.get(`/${app.child}/lookup`, `Find an ${app.child} of the library by foreign id or by words of its title`, async (req) => {
    const term = String(req.query.term ?? "").trim();
    if (!term) throw new HttpError(400, "term is required");
    return lookupChildren(await loadContext(app), term);
  });
  r.post(`/${app.parent}`, `Add an ${app.parent}`, async (req) => oneAddAtATime(() => addArtistOrAuthor(req, app)));
}
