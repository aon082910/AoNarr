/**
 * The four Starr apps AoNarr can answer as. AoNarr keeps every library type in one set of tables, but the tools that talk to
 * a Starr app (Prowlarr, Overseerr, Bazarr, Homepage, Unpackerr ...) treat Sonarr, Radarr, Lidarr and Readarr as four
 * servers, and `/queue`, `/rootfolder`, `/tag`, `/history` and `/wanted` mean "only my kind of media". Each virtual app is
 * mounted at its own path (`/sonarr`, `/radarr`, `/lidarr`, `/readarr`, which is what a tool's URL base field is for), and
 * the library types it lists decide what its endpoints see.
 */
export type StarrAppKey = "sonarr" | "radarr" | "lidarr" | "readarr";

export interface StarrApp {
  key: StarrAppKey;
  appName: string;
  /** The API version segment: v3 for Sonarr and Radarr, v1 for Lidarr and Readarr. */
  apiVersion: "v3" | "v1";
  /**
   * The version the app reports. Tools gate on it (Prowlarr wants Sonarr 3.0.5 or later, Overseerr tells v3 from v4), so it
   * is a Starr version number and not AoNarr's own, which is in `aonarrVersion` of the status body.
   */
  claimedVersion: string;
  /** AoNarr library types this app lists. */
  types: string[];
  /** The resource of a title (series, movie, artist, author) and of its parts (episode, album, book; none for a movie). */
  parent: "series" | "movie" | "artist" | "author";
  child: "episode" | "album" | "book" | null;
  /** The resource of a file on disk. */
  file: "episodefile" | "moviefile" | "trackfile" | "bookfile";
  /** The keys a queue or history row carries to name its title and part. */
  parentKey: "seriesId" | "movieId" | "artistId" | "authorId";
  childKey: "episodeId" | "albumId" | "bookId" | null;
}

export const STARR_APPS: Record<StarrAppKey, StarrApp> = {
  sonarr: {
    key: "sonarr",
    appName: "Sonarr",
    apiVersion: "v3",
    claimedVersion: "4.0.9.2244",
    types: ["series", "anime"],
    parent: "series",
    child: "episode",
    file: "episodefile",
    parentKey: "seriesId",
    childKey: "episodeId",
  },
  radarr: {
    key: "radarr",
    appName: "Radarr",
    apiVersion: "v3",
    claimedVersion: "5.8.3.8933",
    types: ["movie"],
    parent: "movie",
    child: null,
    file: "moviefile",
    parentKey: "movieId",
    childKey: null,
  },
  lidarr: {
    key: "lidarr",
    appName: "Lidarr",
    apiVersion: "v1",
    claimedVersion: "2.5.3.4341",
    types: ["artist"],
    parent: "artist",
    child: "album",
    file: "trackfile",
    parentKey: "artistId",
    childKey: "albumId",
  },
  readarr: {
    key: "readarr",
    appName: "Readarr",
    apiVersion: "v1",
    claimedVersion: "0.4.0.2589",
    types: ["author"],
    parent: "author",
    child: "book",
    file: "bookfile",
    parentKey: "authorId",
    childKey: "bookId",
  },
};

export const STARR_APP_KEYS = Object.keys(STARR_APPS) as StarrAppKey[];

/** SQL placeholders and values for "type IN (...)" of an app. */
export function typeFilter(app: StarrApp, column = "m.type"): { sql: string; params: string[] } {
  return { sql: `${column} IN (${app.types.map(() => "?").join(",")})`, params: [...app.types] };
}
