import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

/**
 * The list endpoints (`GET /series`, `/movie`, `/artist`, `/author`, `/album`, `/book`) answer one unpaged array, which Bazarr,
 * Overseerr and Homepage depend on. Round 30g made them fast without changing a byte of that body; this is the proof: the
 * expected bodies in fixtures/starrListParity.json were written by the code of Round 28 (before any of the speed-up) from the
 * fixture below, and every list must still equal them field for field. The fixture keeps its dates far from today (2001, 2099)
 * so nothing in a body depends on the day the test runs.
 *
 * To rewrite the expected file after a change of the body that is meant: UPDATE_GOLDEN=1 npx vitest run tests/starrListParity.test.ts
 */
const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "starrListParity.json");

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

const get = (url: string) => request(app).get(url).set("X-Api-Key", apiKey);

async function insert(table: string, row: Record<string, unknown>): Promise<number> {
  const keys = Object.keys(row);
  const res = await db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => row[k]));
  return Number(res.lastInsertRowid);
}

const ADDED = "2024-03-04 05:06:07";
const mediaInfo = JSON.stringify({ video: { codec: "h264", width: 1920, height: 1080 }, audio: [{ codec: "eac3", channels: 6 }] });

async function seed() {
  const profile = Number(((await db.prepare("SELECT id FROM quality_profiles ORDER BY id").get()) as { id: number }).id);
  const folder = (p: string, type: string) => insert("root_folders", { path: p, media_type: type });
  const movies = await folder("/movies", "movie");
  const tv = await folder("/tv", "series");
  const anime = await folder("/anime", "anime");
  const music = await folder("/music", "artist");
  const books = await folder("/books", "author");
  const tagA = await insert("tags", { name: "alpha" });
  const tagB = await insert("tags", { name: "beta" });
  const tag = (id: number, ...tags: number[]) => Promise.all(tags.map((t) => insert("media_item_tags", { media_item_id: id, tag_id: t })));
  const base = { added_at: ADDED, quality_profile_id: profile, status: "unknown", monitored: 1, has_file: 0 };

  // Movies: every branch of the resource (file or none, folder or file path, odd JSON, dates, availability, qualities).
  const withFile = await insert("media_items", {
    ...base, type: "movie", title: "The Matrix", sort_title: "matrix", year: 1999, overview: "A hacker learns.", poster_url: "/api/media/art/1/poster", backdrop_url: "/api/media/art/1/fanart",
    external_ids: JSON.stringify({ tmdb: "603", imdb: "tt0133093" }), path: "/movies/The Matrix (1999)/The Matrix (1999) Bluray-1080p.mkv", root_folder_id: movies, has_file: 1, quality: "Bluray-1080p",
    release_date: "1999-03-31", digital_release_date: "2001-05-01", physical_release_date: "2001-06-02 00:00:00", rating: 8.7, runtime_minutes: 136, size_bytes: 9876543210, studio: "Warner",
    genres: JSON.stringify(["Action", "Sci-Fi"]), content_rating: "R", media_info: mediaInfo, minimum_availability: "released",
  });
  await tag(withFile, tagA, tagB);
  await insert("media_items", { ...base, type: "movie", title: "Amélie", sort_title: "amelie", year: 2001, external_ids: JSON.stringify({ tmdb: "194" }), root_folder_id: movies, release_date: "2001-04-25", minimum_availability: "announced" });
  await insert("media_items", { ...base, type: "movie", title: "!!!", sort_title: "!!!", year: null, external_ids: "{not json", root_folder_id: movies, genres: "{broken", release_date: "2099-01-01", minimum_availability: "inCinemas", monitored: 0 });
  await insert("media_items", { ...base, type: "movie", title: "Folder Path", sort_title: "folder path", year: 2005, path: "/movies/Folder Path (2005)", root_folder_id: movies, release_date: "2005-05-05", minimum_availability: "released", digital_release_date: "2099-02-02" });
  await insert("media_items", { ...base, type: "movie", title: "Odd Quality", sort_title: "odd quality", year: 2010, path: "/movies/Odd Quality/odd.mp4", root_folder_id: movies, has_file: 1, quality: "Weird-Q", size_bytes: 12345, media_info: "{broken", release_date: "2010-10-10", minimum_availability: "tba" });
  await insert("media_items", { ...base, type: "movie", title: "No Profile", sort_title: "no profile", year: 2011, quality_profile_id: null, release_date: "2011-11-11 10:20:30", rating: null, minimum_availability: null });
  await insert("media_items", { ...base, type: "movie", title: "Future Cinema", sort_title: "future cinema", year: 2099, root_folder_id: movies, release_date: "2099-03-03", physical_release_date: "2099-09-09", minimum_availability: "released" });
  await insert("media_items", { ...base, type: "movie", title: "Unicode Ö Ünïcode", sort_title: "unicode", year: 2020, external_ids: JSON.stringify({ imdb: "tt1" }), poster_url: "https://img.example/p.jpg", root_folder_id: movies, has_file: 1, path: "/movies/U/U.mkv", quality: "Remux-2160p", media_info: mediaInfo, size_bytes: 1 });
  // A type no Starr app lists must stay out of every list.
  await insert("media_items", { ...base, type: "rom", title: "A Rom", sort_title: "a rom" });

  // Series: aired and unaired episodes, specials, a show with none, statuses, an anime.
  const show = await insert("media_items", {
    ...base, type: "series", title: "Breaking Bad", sort_title: "breaking bad", year: 2008, overview: "A teacher.", poster_url: "/api/media/art/9/poster", external_ids: JSON.stringify({ tvdb: "81189", tmdb: "1396", imdb: "tt0903747" }),
    path: "/tv/Breaking Bad", root_folder_id: tv, status: "Ended", studio: "AMC", runtime_minutes: 47, rating: 9.5, genres: JSON.stringify(["Drama"]), content_rating: "TV-MA", series_type: "standard",
  });
  await tag(show, tagA);
  const ep = (itemId: number, season: number, number: number, over: Record<string, unknown> = {}) =>
    insert("episodes", { media_item_id: itemId, season_number: season, episode_number: number, title: `Episode ${season}x${number}`, air_date: "2008-01-20", monitored: 1, has_file: 0, ...over });
  await ep(show, 0, 1, { air_date: "2008-12-01" });
  await ep(show, 1, 1, { has_file: 1, quality: "WEBDL-1080p", file_path: "/tv/Breaking Bad/S01E01.mkv", size_bytes: 1500000000 });
  await ep(show, 1, 2, { air_date: "2008-01-27", has_file: 1, quality: "WEBDL-1080p", file_path: "/tv/Breaking Bad/S01E02.mkv", size_bytes: 1400000000 });
  await ep(show, 1, 3, { air_date: "2008-02-03", monitored: 0 });
  await ep(show, 2, 1, { air_date: "2009-03-08" });
  await ep(show, 2, 2, { air_date: "2099-05-05" });
  await ep(show, 2, 3, { air_date: null });
  await insert("media_items", { ...base, type: "series", title: "No Episodes Yet", sort_title: "no episodes yet", year: 2030, external_ids: "{}", root_folder_id: tv, status: "Planned" });
  const cancelled = await insert("media_items", { ...base, type: "series", title: "Cancelled Show", sort_title: "cancelled show", year: 2015, external_ids: JSON.stringify({ tvdb: "777" }), root_folder_id: tv, status: "Canceled", series_type: "daily", monitored: 0 });
  await ep(cancelled, 1, 1, { air_date: "2015-06-06", has_file: 1, quality: "HDTV-720p", file_path: "/tv/c/S01E01.mkv", size_bytes: 700 });
  const animeShow = await insert("media_items", { ...base, type: "anime", title: "Anime Show", sort_title: "anime show", year: 2012, external_ids: JSON.stringify({ tvdb: "9" }), root_folder_id: anime, status: "Returning Series", series_type: "anime", extra_metadata: JSON.stringify({ x: 1 }) });
  await ep(animeShow, 1, 1, { air_date: "2012-07-07" });
  await ep(animeShow, 1, 2, { air_date: "2012-07-14" });

  // Artists and albums, authors and books.
  const artist = await insert("media_items", { ...base, type: "artist", title: "Pink Floyd", sort_title: "pink floyd", external_ids: JSON.stringify({ musicbrainz: "83d91898-7763-47d7-b03b-b92132375c47" }), path: "/music/Pink Floyd", root_folder_id: music, status: "Ended", overview: "A band." });
  await tag(artist, tagB);
  const album = (itemId: number, title: string, over: Record<string, unknown> = {}) => insert("sub_items", { media_item_id: itemId, title, release_date: "1973-03-01", external_id: `mb-${title}`, external_provider: "musicbrainz", monitored: 1, has_file: 0, ...over });
  await album(artist, "The Dark Side of the Moon", { has_file: 1, quality: "FLAC", file_path: "/music/Pink Floyd/Dark Side", size_bytes: 400000000, poster_url: "/api/media/art/a1/poster", overview: "An album." });
  await album(artist, "Wish You Were Here", { release_date: "1975-09-12" });
  await album(artist, "Unreleased", { release_date: "2099-01-01", monitored: 0 });
  await insert("media_items", { ...base, type: "artist", title: "Silent Artist", sort_title: "silent artist", external_ids: null, monitored: 0 });
  const author = await insert("media_items", { ...base, type: "author", title: "Frank Herbert", sort_title: "herbert, frank", external_ids: JSON.stringify({ openlibrary: "OL79034A" }), path: "/books/Frank Herbert", root_folder_id: books, overview: "An author.", status: "Ended" });
  const book = (itemId: number, title: string, over: Record<string, unknown> = {}) => insert("sub_items", { media_item_id: itemId, title, release_date: "1965-08-01", external_id: `OL-${title}`, external_provider: "openlibrary", monitored: 1, has_file: 0, ...over });
  await book(author, "Dune", { has_file: 1, quality: "EPUB", file_path: "/books/Frank Herbert/Dune.epub", size_bytes: 2000000, series_name: "Dune Chronicles" });
  await book(author, "Dune Messiah", { release_date: "1969-10-01", series_name: "Dune Chronicles" });
  await insert("media_items", { ...base, type: "author", title: "No Books", sort_title: "no books", external_ids: JSON.stringify({ goodreads: "1" }) });

  // Inserted last on purpose: a new row takes the highest id, so no id in the expected bodies moves. It pins the "none" branch of
  // monitorNewItems (every other series row has NULL there and answers "all").
  await insert("media_items", { ...base, type: "series", title: "Watch Nothing", sort_title: "watch nothing", year: 2031, external_ids: JSON.stringify({ tvdb: "4242" }), root_folder_id: tv, status: "Planned", monitor_new_items: "none" });
}

const LISTS: [string, string][] = [
  ["movie", "/radarr/api/v3/movie"],
  ["series", "/sonarr/api/v3/series"],
  ["artist", "/lidarr/api/v1/artist"],
  ["author", "/readarr/api/v1/author"],
  ["album", "/lidarr/api/v1/album"],
  ["book", "/readarr/api/v1/book"],
  ["movie-by-tmdb", "/radarr/api/v3/movie?tmdbId=603"],
  ["series-by-tvdb", "/sonarr/api/v3/series?tvdbId=81189"],
];

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  await seed();
});

describe("the unpaged lists keep their body", () => {
  it.each(LISTS)("%s: the body equals the one the code before the speed-up wrote", async (name, url) => {
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const golden: Record<string, unknown> = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, "utf8")) : {};
    if (process.env.UPDATE_GOLDEN === "1") {
      golden[name] = res.body;
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + "\n");
      return;
    }
    expect(golden[name], `no expected body for ${name}: write it with UPDATE_GOLDEN=1`).toBeDefined();
    expect(res.body).toEqual(golden[name]);
  });

  it("lists the same titles in the same order as before", async () => {
    const movies = (await get("/radarr/api/v3/movie")).body as any[];
    expect(movies.map((m) => m.title)).toEqual(["!!!", "Amélie", "Folder Path", "Future Cinema", "The Matrix", "No Profile", "Odd Quality", "Unicode Ö Ünïcode"]);
    const series = (await get("/sonarr/api/v3/series")).body as any[];
    expect(series.map((s) => s.title)).toEqual(["Anime Show", "Breaking Bad", "Cancelled Show", "No Episodes Yet", "Watch Nothing"]);
  });
});
