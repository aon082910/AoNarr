import { getSetting } from "./settingsStore.js";
import { MEDIA_TYPES, getMediaTypeConfig } from "./mediaTypes.js";
import type { MediaType } from "../types/index.js";

export interface MetadataSearchResult {
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
  /** Full YYYY-MM-DD release date, when the provider has one — currently only TMDB movie search
   * populates this (used by the Calendar page, which otherwise has no date to show movies by). */
  releaseDate?: string | null;
}

export interface MetadataEpisode {
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDate: string | null;
  overview: string | null;
}

export interface MetadataSubItem {
  title: string;
  releaseDate: string | null;
  externalId?: string;
  posterUrl?: string | null;
}

export interface MetadataTrack {
  trackNumber: number;
  title: string;
  durationSeconds: number | null;
}

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w342";
const MUSICBRAINZ_USER_AGENT = "AoNarr/0.1 (self-hosted media manager)";
const DISCOGS_USER_AGENT = "AoNarr/0.1 (self-hosted media manager)";

/**
 * A bare fetch() has no timeout — a single stalled request hangs forever. That's tolerable for a
 * one-off user-triggered lookup, but fetchAlbumTracksFor is now also called in a tight per-album
 * loop right after an artist/album import (see insertTracksForAlbum), where one hung request would
 * otherwise block the entire artist add indefinitely.
 */
function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

function requireSetting(key: string, label: string): string {
  const value = getSetting(key);
  if (!value) throw new Error(`${label} is not configured. Add one in Settings.`);
  return value;
}

// ---------------------------------------------------------------------------
// Movies: TMDB, OMDb
// ---------------------------------------------------------------------------

async function searchMoviesTmdb(query: string): Promise<MetadataSearchResult[]> {
  const key = requireSetting("tmdbApiKey", "TMDB API key");
  const url = new URL("https://api.themoviedb.org/3/search/movie");
  url.searchParams.set("api_key", key);
  url.searchParams.set("query", query);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB movie search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.results ?? []).map((r: any) => ({
    title: r.title,
    year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
    overview: r.overview || null,
    posterUrl: r.poster_path ? `${TMDB_IMAGE_BASE}${r.poster_path}` : null,
    externalIds: { tmdb: String(r.id) },
    releaseDate: r.release_date || null,
  }));
}

async function searchMoviesOmdb(query: string): Promise<MetadataSearchResult[]> {
  const key = requireSetting("omdbApiKey", "OMDb API key");
  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", key);
  url.searchParams.set("s", query);
  url.searchParams.set("type", "movie");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`OMDb movie search failed: HTTP ${res.status}`);
  const body: any = await res.json();
  if (body.Response === "False") return [];

  return (body.Search ?? []).map((m: any) => ({
    title: m.Title,
    year: m.Year ? Number(String(m.Year).slice(0, 4)) : null,
    overview: null,
    posterUrl: m.Poster && m.Poster !== "N/A" ? m.Poster : null,
    externalIds: { imdb: m.imdbID },
  }));
}

const TRAKT_USER_AGENT = "AoNarr/0.1 (self-hosted media manager)";

function traktHeaders(clientId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": clientId,
    "User-Agent": TRAKT_USER_AGENT,
  };
}

async function searchMoviesTrakt(query: string): Promise<MetadataSearchResult[]> {
  const clientId = requireSetting("traktClientId", "Trakt Client ID");
  const url = new URL("https://api.trakt.tv/search/movie");
  url.searchParams.set("query", query);

  const res = await fetch(url.toString(), { headers: traktHeaders(clientId) });
  if (!res.ok) throw new Error(`Trakt movie search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body ?? []).map((r: any) => ({
    title: r.movie.title,
    year: r.movie.year ?? null,
    overview: r.movie.overview || null,
    posterUrl: null, // Trakt's basic search response has no images
    externalIds: {
      trakt: String(r.movie.ids.trakt),
      ...(r.movie.ids.imdb ? { imdb: r.movie.ids.imdb } : {}),
    },
  }));
}

// ---------------------------------------------------------------------------
// Series: TMDB, TVDB, TVMaze, Trakt
// ---------------------------------------------------------------------------

async function searchSeriesTmdb(query: string): Promise<MetadataSearchResult[]> {
  const key = requireSetting("tmdbApiKey", "TMDB API key");
  const url = new URL("https://api.themoviedb.org/3/search/tv");
  url.searchParams.set("api_key", key);
  url.searchParams.set("query", query);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB series search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.results ?? []).map((r: any) => ({
    title: r.name,
    year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) : null,
    overview: r.overview || null,
    posterUrl: r.poster_path ? `${TMDB_IMAGE_BASE}${r.poster_path}` : null,
    externalIds: { tmdb: String(r.id) },
  }));
}

// ---------------------------------------------------------------------------
// Discover — TMDB's trending endpoint, for a browse/discover page (Overseerr/Jellyseerr-style)
// instead of only search-then-request. Movies and TV only; TMDB has no equivalent trending concept
// for the other library types.
// ---------------------------------------------------------------------------

export async function fetchTrendingMovies(): Promise<MetadataSearchResult[]> {
  const key = requireSetting("tmdbApiKey", "TMDB API key");
  const res = await fetch(`https://api.themoviedb.org/3/trending/movie/week?api_key=${key}`);
  if (!res.ok) throw new Error(`TMDB trending movies failed: HTTP ${res.status}`);
  const body: any = await res.json();
  return (body.results ?? []).map((r: any) => ({
    title: r.title,
    year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
    overview: r.overview || null,
    posterUrl: r.poster_path ? `${TMDB_IMAGE_BASE}${r.poster_path}` : null,
    externalIds: { tmdb: String(r.id) },
    releaseDate: r.release_date || null,
  }));
}

export async function fetchTrendingSeries(): Promise<MetadataSearchResult[]> {
  const key = requireSetting("tmdbApiKey", "TMDB API key");
  const res = await fetch(`https://api.themoviedb.org/3/trending/tv/week?api_key=${key}`);
  if (!res.ok) throw new Error(`TMDB trending series failed: HTTP ${res.status}`);
  const body: any = await res.json();
  return (body.results ?? []).map((r: any) => ({
    title: r.name,
    year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) : null,
    overview: r.overview || null,
    posterUrl: r.poster_path ? `${TMDB_IMAGE_BASE}${r.poster_path}` : null,
    externalIds: { tmdb: String(r.id) },
  }));
}

async function fetchSeriesEpisodesTmdb(tmdbId: string): Promise<MetadataEpisode[]> {
  const key = requireSetting("tmdbApiKey", "TMDB API key");
  const detailUrl = new URL(`https://api.themoviedb.org/3/tv/${tmdbId}`);
  detailUrl.searchParams.set("api_key", key);
  const detailRes = await fetch(detailUrl.toString());
  if (!detailRes.ok) throw new Error(`TMDB series lookup failed: HTTP ${detailRes.status}`);
  const detail: any = await detailRes.json();

  const seasonNumbers: number[] = (detail.seasons ?? [])
    .map((s: any) => s.season_number)
    .filter((n: number) => n > 0);

  const episodes: MetadataEpisode[] = [];
  for (const seasonNumber of seasonNumbers) {
    const seasonUrl = new URL(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}`);
    seasonUrl.searchParams.set("api_key", key);
    const seasonRes = await fetch(seasonUrl.toString());
    if (!seasonRes.ok) continue;
    const season: any = await seasonRes.json();
    for (const ep of season.episodes ?? []) {
      episodes.push({
        seasonNumber,
        episodeNumber: ep.episode_number,
        title: ep.name || null,
        airDate: ep.air_date || null,
        overview: ep.overview || null,
      });
    }
  }
  return episodes;
}

let tvdbToken: string | null = null;

async function getTvdbToken(forceRefresh = false): Promise<string> {
  if (tvdbToken && !forceRefresh) return tvdbToken;
  const key = requireSetting("tvdbApiKey", "TVDB API key");
  const res = await fetch("https://api4.thetvdb.com/v4/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: key }),
  });
  if (!res.ok) throw new Error(`TVDB login failed: HTTP ${res.status}`);
  const body: any = await res.json();
  if (!body.data?.token) throw new Error("TVDB login did not return a token");
  tvdbToken = body.data.token;
  return tvdbToken as string;
}

async function tvdbFetch(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`https://api4.thetvdb.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let token = await getTvdbToken();
  let res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    token = await getTvdbToken(true);
    res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) throw new Error(`TVDB request failed: HTTP ${res.status}`);
  return res.json();
}

async function searchSeriesTvdb(query: string): Promise<MetadataSearchResult[]> {
  const body = await tvdbFetch("/v4/search", { query, type: "series" });
  return (body.data ?? []).map((s: any) => ({
    title: s.name,
    year: s.year ? Number(s.year) : null,
    overview: s.overview || null,
    posterUrl: s.image_url || s.thumbnail || null,
    externalIds: { tvdb: String(s.tvdb_id ?? s.id) },
  }));
}

async function fetchSeriesEpisodesTvdb(tvdbId: string): Promise<MetadataEpisode[]> {
  const body = await tvdbFetch(`/v4/series/${tvdbId}/episodes/default`);
  const episodes = body.data?.episodes ?? [];
  return episodes.map((e: any) => ({
    seasonNumber: e.seasonNumber,
    episodeNumber: e.number,
    title: e.name || null,
    airDate: e.aired || null,
    overview: e.overview || null,
  }));
}

async function searchSeriesTvmaze(query: string): Promise<MetadataSearchResult[]> {
  const url = new URL("https://api.tvmaze.com/search/shows");
  url.searchParams.set("q", query);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TVMaze search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body ?? []).map((r: any) => ({
    title: r.show.name,
    year: r.show.premiered ? Number(r.show.premiered.slice(0, 4)) : null,
    overview: r.show.summary ? r.show.summary.replace(/<[^>]+>/g, "") : null,
    posterUrl: r.show.image?.medium || null,
    externalIds: { tvmaze: String(r.show.id) },
  }));
}

async function fetchSeriesEpisodesTvmaze(tvmazeId: string): Promise<MetadataEpisode[]> {
  const res = await fetch(`https://api.tvmaze.com/shows/${tvmazeId}/episodes`);
  if (!res.ok) throw new Error(`TVMaze episodes lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body ?? []).map((e: any) => ({
    seasonNumber: e.season,
    episodeNumber: e.number,
    title: e.name || null,
    airDate: e.airdate || null,
    overview: e.summary ? e.summary.replace(/<[^>]+>/g, "") : null,
  }));
}

async function searchSeriesTrakt(query: string): Promise<MetadataSearchResult[]> {
  const clientId = requireSetting("traktClientId", "Trakt Client ID");
  const url = new URL("https://api.trakt.tv/search/show");
  url.searchParams.set("query", query);

  const res = await fetch(url.toString(), { headers: traktHeaders(clientId) });
  if (!res.ok) throw new Error(`Trakt series search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body ?? []).map((r: any) => ({
    title: r.show.title,
    year: r.show.year ?? null,
    overview: r.show.overview || null,
    posterUrl: null,
    externalIds: { trakt: String(r.show.ids.trakt) },
  }));
}

async function fetchSeriesEpisodesTrakt(traktId: string): Promise<MetadataEpisode[]> {
  const clientId = requireSetting("traktClientId", "Trakt Client ID");
  const url = new URL(`https://api.trakt.tv/shows/${traktId}/seasons`);
  url.searchParams.set("extended", "episodes");

  const res = await fetch(url.toString(), { headers: traktHeaders(clientId) });
  if (!res.ok) throw new Error(`Trakt season lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();

  const episodes: MetadataEpisode[] = [];
  for (const season of body ?? []) {
    if (season.number === 0) continue; // specials
    for (const ep of season.episodes ?? []) {
      episodes.push({
        seasonNumber: season.number,
        episodeNumber: ep.number,
        title: ep.title || null,
        airDate: ep.first_aired ? ep.first_aired.slice(0, 10) : null,
        overview: ep.overview || null,
      });
    }
  }
  return episodes;
}

async function searchSeriesAnilist(query: string): Promise<MetadataSearchResult[]> {
  const gql = `
    query ($search: String) {
      Page(perPage: 15) {
        media(search: $search, type: ANIME) {
          id
          title { romaji english }
          startDate { year }
          description(asHtml: false)
          coverImage { medium }
        }
      }
    }
  `;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql, variables: { search: query } }),
  });
  if (!res.ok) throw new Error(`AniList search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body?.data?.Page?.media ?? []).map((m: any) => ({
    title: m.title.english || m.title.romaji,
    year: m.startDate?.year ?? null,
    overview: m.description || null,
    posterUrl: m.coverImage?.medium || null,
    externalIds: { anilist: String(m.id) },
  }));
}

/**
 * AniList's public API doesn't expose per-episode titles/air dates through a simple query (that
 * needs the airing-schedule API), so this generates placeholder numbered episodes from the total
 * count — enough to track monitoring/download status per episode, titles just won't be filled in.
 */
async function fetchSeriesEpisodesAnilist(anilistId: string): Promise<MetadataEpisode[]> {
  const gql = `query ($id: Int) { Media(id: $id, type: ANIME) { episodes } }`;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql, variables: { id: Number(anilistId) } }),
  });
  if (!res.ok) throw new Error(`AniList episode lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();

  const count: number | null = body?.data?.Media?.episodes ?? null;
  if (!count) return [];
  return Array.from({ length: count }, (_, i) => ({
    seasonNumber: 1,
    episodeNumber: i + 1,
    title: null,
    airDate: null,
    overview: null,
  }));
}

// ---------------------------------------------------------------------------
// Artists: MusicBrainz, Deezer, Discogs, Last.fm
// ---------------------------------------------------------------------------

async function searchArtistsMusicbrainz(query: string): Promise<MetadataSearchResult[]> {
  const url = new URL("https://musicbrainz.org/ws/2/artist");
  url.searchParams.set("query", query);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("limit", "15");

  const res = await fetch(url.toString(), { headers: { "User-Agent": MUSICBRAINZ_USER_AGENT } });
  if (!res.ok) throw new Error(`MusicBrainz artist search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.artists ?? []).map((a: any) => ({
    title: a.name,
    year: a["life-span"]?.begin ? Number(String(a["life-span"].begin).slice(0, 4)) : null,
    overview: a.disambiguation || null,
    posterUrl: null,
    externalIds: { musicbrainz: a.id },
  }));
}

async function fetchArtistAlbumsMusicbrainz(mbid: string): Promise<MetadataSubItem[]> {
  const url = new URL("https://musicbrainz.org/ws/2/release-group");
  url.searchParams.set("artist", mbid);
  url.searchParams.set("type", "album");
  url.searchParams.set("fmt", "json");
  url.searchParams.set("limit", "100");

  const res = await fetch(url.toString(), { headers: { "User-Agent": MUSICBRAINZ_USER_AGENT } });
  if (!res.ok) throw new Error(`MusicBrainz album lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body["release-groups"] ?? []).map((rg: any) => ({
    title: rg.title,
    releaseDate: rg["first-release-date"] || null,
    externalId: rg.id,
  }));
}

async function fetchAlbumTracksMusicbrainz(releaseGroupMbid: string): Promise<MetadataTrack[]> {
  const rgUrl = new URL(`https://musicbrainz.org/ws/2/release-group/${releaseGroupMbid}`);
  rgUrl.searchParams.set("inc", "releases");
  rgUrl.searchParams.set("fmt", "json");
  const rgRes = await fetchWithTimeout(rgUrl.toString(), { headers: { "User-Agent": MUSICBRAINZ_USER_AGENT } });
  if (!rgRes.ok) throw new Error(`MusicBrainz release-group lookup failed: HTTP ${rgRes.status}`);
  const rgBody: any = await rgRes.json();

  const releaseId = rgBody.releases?.[0]?.id;
  if (!releaseId) return [];

  const relUrl = new URL(`https://musicbrainz.org/ws/2/release/${releaseId}`);
  relUrl.searchParams.set("inc", "recordings");
  relUrl.searchParams.set("fmt", "json");
  const relRes = await fetchWithTimeout(relUrl.toString(), { headers: { "User-Agent": MUSICBRAINZ_USER_AGENT } });
  if (!relRes.ok) throw new Error(`MusicBrainz release lookup failed: HTTP ${relRes.status}`);
  const relBody: any = await relRes.json();

  const tracks: MetadataTrack[] = [];
  for (const medium of relBody.media ?? []) {
    for (const track of medium.tracks ?? []) {
      tracks.push({
        trackNumber: Number(track.number) || tracks.length + 1,
        title: track.title ?? `Track ${track.number}`,
        durationSeconds: track.length ? Math.round(track.length / 1000) : null,
      });
    }
  }
  return tracks;
}

async function searchArtistsDeezer(query: string): Promise<MetadataSearchResult[]> {
  const url = new URL("https://api.deezer.com/search/artist");
  url.searchParams.set("q", query);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Deezer artist search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.data ?? []).map((a: any) => ({
    title: a.name,
    year: null,
    overview: null,
    posterUrl: a.picture_medium || null,
    externalIds: { deezer: String(a.id) },
  }));
}

async function fetchArtistAlbumsDeezer(deezerArtistId: string): Promise<MetadataSubItem[]> {
  const res = await fetch(`https://api.deezer.com/artist/${deezerArtistId}/albums?limit=100`);
  if (!res.ok) throw new Error(`Deezer album lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.data ?? []).map((al: any) => ({
    title: al.title,
    releaseDate: al.release_date || null,
    externalId: String(al.id),
    posterUrl: al.cover_medium || al.cover || null,
  }));
}

async function fetchAlbumTracksDeezer(deezerAlbumId: string): Promise<MetadataTrack[]> {
  const res = await fetchWithTimeout(`https://api.deezer.com/album/${deezerAlbumId}/tracks`);
  if (!res.ok) throw new Error(`Deezer track lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.data ?? []).map((t: any, idx: number) => ({
    trackNumber: t.track_position ?? idx + 1,
    title: t.title,
    durationSeconds: t.duration ?? null,
  }));
}

async function searchArtistsDiscogs(query: string): Promise<MetadataSearchResult[]> {
  const token = requireSetting("discogsToken", "Discogs personal access token");
  const url = new URL("https://api.discogs.com/database/search");
  url.searchParams.set("q", query);
  url.searchParams.set("type", "artist");
  url.searchParams.set("token", token);

  const res = await fetch(url.toString(), { headers: { "User-Agent": DISCOGS_USER_AGENT } });
  if (!res.ok) throw new Error(`Discogs artist search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.results ?? []).map((r: any) => ({
    title: r.title,
    year: null,
    overview: null,
    posterUrl: r.thumb || null,
    externalIds: { discogs: String(r.id) },
  }));
}

async function fetchArtistAlbumsDiscogs(discogsArtistId: string): Promise<MetadataSubItem[]> {
  const token = requireSetting("discogsToken", "Discogs personal access token");
  const url = new URL(`https://api.discogs.com/artists/${discogsArtistId}/releases`);
  url.searchParams.set("token", token);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("sort", "year");

  const res = await fetch(url.toString(), { headers: { "User-Agent": DISCOGS_USER_AGENT } });
  if (!res.ok) throw new Error(`Discogs release lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();

  const seen = new Set<string>();
  const results: MetadataSubItem[] = [];
  for (const r of body.releases ?? []) {
    if (r.role && r.role !== "Main") continue; // skip appearances/remixes credited to this artist
    if (seen.has(r.title)) continue;
    seen.add(r.title);
    results.push({ title: r.title, releaseDate: r.year ? String(r.year) : null, externalId: String(r.id), posterUrl: r.thumb || null });
  }
  return results;
}

async function searchArtistsLastfm(query: string): Promise<MetadataSearchResult[]> {
  const key = requireSetting("lastfmApiKey", "Last.fm API key");
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.searchParams.set("method", "artist.search");
  url.searchParams.set("artist", query);
  url.searchParams.set("api_key", key);
  url.searchParams.set("format", "json");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Last.fm artist search failed: HTTP ${res.status}`);
  const body: any = await res.json();
  const matches = body?.results?.artistmatches?.artist ?? [];
  const list = Array.isArray(matches) ? matches : [matches];

  return list.map((a: any) => ({
    title: a.name,
    year: null,
    overview: null,
    posterUrl: Array.isArray(a.image) ? a.image.find((i: any) => i.size === "large")?.["#text"] || null : null,
    // Last.fm's MBID is often blank for lesser-known artists; fall back to name so the artist is
    // still re-queryable for albums even without one.
    externalIds: { lastfm: a.mbid || a.name },
  }));
}

async function fetchArtistAlbumsLastfm(idOrName: string): Promise<MetadataSubItem[]> {
  const key = requireSetting("lastfmApiKey", "Last.fm API key");
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.searchParams.set("method", "artist.gettopalbums");
  const looksLikeMbid = /^[0-9a-f-]{36}$/i.test(idOrName);
  url.searchParams.set(looksLikeMbid ? "mbid" : "artist", idOrName);
  url.searchParams.set("api_key", key);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "100");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Last.fm album lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();
  const albums = body?.topalbums?.album ?? [];

  return albums.map((al: any) => ({
    title: al.name,
    releaseDate: null, // Last.fm's album endpoints don't include a release date
    externalId: al.mbid || al.name,
    posterUrl: Array.isArray(al.image) ? al.image.find((i: any) => i.size === "large")?.["#text"] || null : null,
  }));
}

// ---------------------------------------------------------------------------
// Authors: Open Library, Google Books
// ---------------------------------------------------------------------------

async function searchAuthorsOpenlibrary(query: string): Promise<MetadataSearchResult[]> {
  const url = new URL("https://openlibrary.org/search/authors.json");
  url.searchParams.set("q", query);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Open Library author search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.docs ?? []).map((d: any) => ({
    title: d.name,
    year: d.birth_date ? Number(String(d.birth_date).slice(-4)) || null : null,
    overview: d.top_work ? `Known for: ${d.top_work}` : null,
    posterUrl: d.key ? `https://covers.openlibrary.org/a/olid/${d.key}-M.jpg` : null,
    externalIds: { openlibrary: d.key },
  }));
}

async function fetchAuthorBooksOpenlibrary(openLibraryKey: string): Promise<MetadataSubItem[]> {
  const url = `https://openlibrary.org/authors/${openLibraryKey}/works.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open Library works lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();

  // A handful of Open Library "work" entries carry no title at all (data-quality gaps in their
  // catalog, not a query issue on our end) — sub_items.title is NOT NULL, so skip those rather
  // than let one bad entry fail the whole author's book-list insert transaction.
  return (body.entries ?? [])
    .filter((w: any) => w.title)
    .map((w: any) => ({
      title: w.title,
      releaseDate: w.first_publish_date || null,
    }));
}

/** Google Books has no stable per-author id, so the author's display name doubles as its "external id" for re-querying. */
async function searchAuthorsGoogleBooks(query: string): Promise<MetadataSearchResult[]> {
  const key = getSetting("googleBooksApiKey");
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", `inauthor:"${query}"`);
  url.searchParams.set("maxResults", "20");
  if (key) url.searchParams.set("key", key);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Google Books search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  const seen = new Map<string, MetadataSearchResult>();
  for (const item of body.items ?? []) {
    for (const author of item.volumeInfo?.authors ?? []) {
      if (seen.has(author)) continue;
      seen.set(author, {
        title: author,
        year: null,
        overview: item.volumeInfo?.title ? `Known for: ${item.volumeInfo.title}` : null,
        posterUrl: item.volumeInfo?.imageLinks?.thumbnail || null,
        externalIds: { googlebooks: author },
      });
    }
  }
  return Array.from(seen.values());
}

async function fetchAuthorBooksGoogleBooks(authorName: string): Promise<MetadataSubItem[]> {
  const key = getSetting("googleBooksApiKey");
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", `inauthor:"${authorName}"`);
  url.searchParams.set("maxResults", "40");
  if (key) url.searchParams.set("key", key);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Google Books works lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.items ?? []).map((item: any) => ({
    title: item.volumeInfo?.title ?? "Untitled",
    releaseDate: item.volumeInfo?.publishedDate || null,
  }));
}

// ---------------------------------------------------------------------------
// Comics: Comic Vine
// ---------------------------------------------------------------------------

const COMICVINE_USER_AGENT = "AoNarr/0.1 (self-hosted media manager)";

async function searchComicsComicVine(query: string): Promise<MetadataSearchResult[]> {
  const key = requireSetting("comicVineApiKey", "Comic Vine API key");
  const url = new URL("https://comicvine.gamespot.com/api/search/");
  url.searchParams.set("api_key", key);
  url.searchParams.set("format", "json");
  url.searchParams.set("resources", "volume");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "15");

  const res = await fetch(url.toString(), { headers: { "User-Agent": COMICVINE_USER_AGENT } });
  if (!res.ok) throw new Error(`Comic Vine search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.results ?? []).map((v: any) => ({
    title: v.name,
    year: v.start_year ? Number(v.start_year) : null,
    overview: v.description ? v.description.replace(/<[^>]+>/g, "") : null,
    posterUrl: v.image?.medium_url || null,
    externalIds: { comicvine: String(v.id) },
  }));
}

async function fetchComicIssuesComicVine(volumeId: string): Promise<MetadataSubItem[]> {
  const key = requireSetting("comicVineApiKey", "Comic Vine API key");
  const url = new URL("https://comicvine.gamespot.com/api/issues/");
  url.searchParams.set("api_key", key);
  url.searchParams.set("format", "json");
  url.searchParams.set("filter", `volume:${volumeId}`);
  url.searchParams.set("field_list", "id,issue_number,name,cover_date");
  url.searchParams.set("limit", "100");
  url.searchParams.set("sort", "issue_number:asc");

  const res = await fetch(url.toString(), { headers: { "User-Agent": COMICVINE_USER_AGENT } });
  if (!res.ok) throw new Error(`Comic Vine issue lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.results ?? []).map((issue: any) => ({
    title: issue.name ? `#${issue.issue_number} - ${issue.name}` : `#${issue.issue_number}`,
    releaseDate: issue.cover_date || null,
    externalId: String(issue.id),
  }));
}

// ---------------------------------------------------------------------------
// ROMs: RAWG, IGDB
// ---------------------------------------------------------------------------

async function searchRomsRawg(query: string): Promise<MetadataSearchResult[]> {
  const key = requireSetting("rawgApiKey", "RAWG API key");
  const url = new URL("https://api.rawg.io/api/games");
  url.searchParams.set("key", key);
  url.searchParams.set("search", query);
  url.searchParams.set("page_size", "15");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`RAWG search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.results ?? []).map((g: any) => ({
    title: g.name,
    year: g.released ? Number(String(g.released).slice(0, 4)) : null,
    overview: null,
    posterUrl: g.background_image || null,
    externalIds: { rawg: String(g.id) },
  }));
}

let igdbToken: { token: string; expiresAt: number } | null = null;

async function getIgdbToken(): Promise<string> {
  if (igdbToken && igdbToken.expiresAt > Date.now()) return igdbToken.token;
  const clientId = requireSetting("igdbClientId", "IGDB Client ID");
  const clientSecret = requireSetting("igdbClientSecret", "IGDB Client Secret");

  const url = new URL("https://id.twitch.tv/oauth2/token");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_secret", clientSecret);
  url.searchParams.set("grant_type", "client_credentials");

  const res = await fetch(url.toString(), { method: "POST" });
  if (!res.ok) throw new Error(`IGDB auth failed: HTTP ${res.status}`);
  const body: any = await res.json();
  igdbToken = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return igdbToken.token;
}

async function searchRomsIgdb(query: string): Promise<MetadataSearchResult[]> {
  const clientId = requireSetting("igdbClientId", "IGDB Client ID");
  const token = await getIgdbToken();

  const res = await fetch("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: { "Client-ID": clientId, Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body: `search "${query.replace(/"/g, '\\"')}"; fields name,first_release_date,cover.url; limit 15;`,
  });
  if (!res.ok) throw new Error(`IGDB search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body ?? []).map((g: any) => ({
    title: g.name,
    year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
    overview: null,
    posterUrl: g.cover?.url ? `https:${String(g.cover.url).replace("t_thumb", "t_cover_big")}` : null,
    externalIds: { igdb: String(g.id) },
  }));
}

export interface RomDetails {
  overview: string | null;
  system: string | null;
  maker: string | null;
  /** IGDB's own platform logo, for the System group's tile — RAWG has no equivalent asset, so a
   * RAWG-sourced game falls back to an opportunistic name-match lookup against IGDB if IGDB
   * credentials happen to also be configured (best-effort, not required). */
  systemLogoUrl: string | null;
}

function igdbImageUrl(url: string | undefined, size: string): string | null {
  return url ? `https:${url.replace("t_thumb", size)}` : null;
}

/** Neither RAWG's nor IGDB's search/list endpoint returns overview/platform/developer — those only
 * come back from a per-game detail lookup, so this is a separate call the client makes once, after
 * the user picks a search result on Add Media, rather than bloating every search result with it. */
export async function fetchRomDetailsFor(externalIds: Record<string, string>): Promise<RomDetails | null> {
  if (externalIds.rawg) return fetchRomDetailsRawg(externalIds.rawg);
  if (externalIds.igdb) return fetchRomDetailsIgdb(externalIds.igdb);
  return null;
}

async function fetchRomDetailsRawg(id: string): Promise<RomDetails> {
  const key = requireSetting("rawgApiKey", "RAWG API key");
  const res = await fetch(`https://api.rawg.io/api/games/${id}?key=${key}`);
  if (!res.ok) throw new Error(`RAWG game lookup failed: HTTP ${res.status}`);
  const g: any = await res.json();
  const system = g.platforms?.[0]?.platform?.name ?? null;
  const systemLogoUrl = system ? await fetchIgdbPlatformLogo(system).catch(() => null) : null;
  return {
    overview: g.description_raw ? String(g.description_raw).trim() || null : null,
    system,
    maker: g.developers?.[0]?.name ?? g.publishers?.[0]?.name ?? null,
    systemLogoUrl,
  };
}

async function fetchRomDetailsIgdb(id: string): Promise<RomDetails> {
  const clientId = requireSetting("igdbClientId", "IGDB Client ID");
  const token = await getIgdbToken();
  const res = await fetch("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: { "Client-ID": clientId, Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body: `fields summary,platforms.name,platforms.platform_logo.url,involved_companies.company.name,involved_companies.developer,involved_companies.publisher; where id = ${Number(id)};`,
  });
  if (!res.ok) throw new Error(`IGDB game lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();
  const g = body?.[0];
  if (!g) return { overview: null, system: null, maker: null, systemLogoUrl: null };
  const companies: any[] = g.involved_companies ?? [];
  const developer = companies.find((c) => c.developer)?.company?.name;
  const publisher = companies.find((c) => c.publisher)?.company?.name;
  return {
    overview: g.summary ? String(g.summary).trim() || null : null,
    system: g.platforms?.[0]?.name ?? null,
    maker: developer ?? publisher ?? null,
    systemLogoUrl: igdbImageUrl(g.platforms?.[0]?.platform_logo?.url, "t_logo_med"),
  };
}

/** Opportunistic platform-logo lookup by name, for a RAWG-sourced game (RAWG itself has no
 * platform-logo asset) — silently unavailable if IGDB credentials aren't configured, since this
 * is only ever a nice-to-have on top of RAWG being the chosen provider. */
async function fetchIgdbPlatformLogo(platformName: string): Promise<string | null> {
  if (!getSetting("igdbClientId") || !getSetting("igdbClientSecret")) return null;
  const clientId = requireSetting("igdbClientId", "IGDB Client ID");
  const token = await getIgdbToken();
  const res = await fetch("https://api.igdb.com/v4/platforms", {
    method: "POST",
    headers: { "Client-ID": clientId, Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body: `search "${platformName.replace(/"/g, '\\"')}"; fields platform_logo.url; limit 1;`,
  });
  if (!res.ok) return null;
  const body: any = await res.json();
  return igdbImageUrl(body?.[0]?.platform_logo?.url, "t_logo_med");
}

// ---------------------------------------------------------------------------
// Online Videos: YouTube Data API (search finds a channel; children are that
// channel's uploaded videos)
// ---------------------------------------------------------------------------

async function searchVideosYoutube(query: string): Promise<MetadataSearchResult[]> {
  const key = requireSetting("youtubeApiKey", "YouTube Data API key");
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "channel");
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", "15");
  url.searchParams.set("key", key);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`YouTube search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.items ?? []).map((c: any) => ({
    title: c.snippet.title,
    year: c.snippet.publishedAt ? Number(String(c.snippet.publishedAt).slice(0, 4)) : null,
    overview: c.snippet.description || null,
    posterUrl: c.snippet.thumbnails?.medium?.url || null,
    externalIds: { youtube: c.snippet.channelId ?? c.id.channelId },
  }));
}

async function fetchChannelVideosYoutube(channelId: string): Promise<MetadataSubItem[]> {
  const key = requireSetting("youtubeApiKey", "YouTube Data API key");

  const channelUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
  channelUrl.searchParams.set("part", "contentDetails");
  channelUrl.searchParams.set("id", channelId);
  channelUrl.searchParams.set("key", key);
  const channelRes = await fetch(channelUrl.toString());
  if (!channelRes.ok) throw new Error(`YouTube channel lookup failed: HTTP ${channelRes.status}`);
  const channelBody: any = await channelRes.json();
  const uploadsPlaylistId = channelBody.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) return [];

  const videos: MetadataSubItem[] = [];
  let pageToken: string | undefined;
  do {
    const plUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    plUrl.searchParams.set("part", "snippet");
    plUrl.searchParams.set("playlistId", uploadsPlaylistId);
    plUrl.searchParams.set("maxResults", "50");
    plUrl.searchParams.set("key", key);
    if (pageToken) plUrl.searchParams.set("pageToken", pageToken);

    const plRes = await fetch(plUrl.toString());
    if (!plRes.ok) throw new Error(`YouTube playlist items lookup failed: HTTP ${plRes.status}`);
    const plBody: any = await plRes.json();

    for (const item of plBody.items ?? []) {
      videos.push({
        title: item.snippet.title,
        releaseDate: item.snippet.publishedAt ? String(item.snippet.publishedAt).slice(0, 10) : null,
        externalId: item.snippet.resourceId?.videoId,
      });
    }
    pageToken = plBody.nextPageToken;
  } while (pageToken && videos.length < 500); // safety cap against runaway channels

  return videos;
}

// ---------------------------------------------------------------------------
// Adult: ThePornDB (the same metadata source the real self-hosted *Starr fork
// for this content, Whisparr, uses)
// ---------------------------------------------------------------------------

async function searchAdultThePornDb(query: string): Promise<MetadataSearchResult[]> {
  const key = requireSetting("thePornDbApiKey", "ThePornDB API key");
  const url = new URL("https://api.metadataapi.net/scenes");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "15");

  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`ThePornDB search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.data ?? []).map((s: any) => ({
    title: s.title,
    year: s.date ? Number(String(s.date).slice(0, 4)) : null,
    overview: s.description || null,
    posterUrl: s.image || s.posters?.[0]?.url || null,
    externalIds: { theporndb: String(s.id) },
  }));
}

/**
 * Trailer lookup for the media detail page — TMDB's /videos endpoint covers movies and TV series
 * (which also serves anime, since anime-via-TMDB uses the same tv endpoint). Prefers an
 * "official" YouTube "Trailer", falls back to any YouTube video TMDB has listed.
 */
export async function fetchTrailerFor(type: MediaType, externalIds: Record<string, string>): Promise<string | null> {
  if (!externalIds.tmdb) return null;
  const key = getSetting("tmdbApiKey");
  if (!key) return null;

  const kind = type === "movie" ? "movie" : "tv";
  const url = new URL(`https://api.themoviedb.org/3/${kind}/${externalIds.tmdb}/videos`);
  url.searchParams.set("api_key", key);

  const res = await fetch(url.toString());
  if (!res.ok) return null;
  const body: any = await res.json();
  const videos: any[] = body.results ?? [];

  const youtube = videos.filter((v) => v.site === "YouTube");
  const best =
    youtube.find((v) => v.type === "Trailer" && v.official) ??
    youtube.find((v) => v.type === "Trailer") ??
    youtube[0];
  return best ? `https://www.youtube.com/watch?v=${best.key}` : null;
}

// ---------------------------------------------------------------------------
// Manga: AniList (same GraphQL API used for anime, just `type: MANGA`) and MangaDex (public, no key)
// ---------------------------------------------------------------------------

async function searchMangaAnilist(query: string): Promise<MetadataSearchResult[]> {
  const gql = `
    query ($search: String) {
      Page(perPage: 15) {
        media(search: $search, type: MANGA) {
          id
          title { romaji english }
          startDate { year }
          description(asHtml: false)
          coverImage { medium }
        }
      }
    }
  `;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql, variables: { search: query } }),
  });
  if (!res.ok) throw new Error(`AniList search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body?.data?.Page?.media ?? []).map((m: any) => ({
    title: m.title.english || m.title.romaji,
    year: m.startDate?.year ?? null,
    overview: m.description || null,
    posterUrl: m.coverImage?.medium || null,
    externalIds: { anilist: String(m.id) },
  }));
}

async function searchMangaMangadex(query: string): Promise<MetadataSearchResult[]> {
  const url = new URL("https://api.mangadex.org/manga");
  url.searchParams.set("title", query);
  url.searchParams.set("limit", "15");
  url.searchParams.set("includes[]", "cover_art");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`MangaDex search failed: HTTP ${res.status}`);
  const body: any = await res.json();

  return (body.data ?? []).map((m: any) => {
    const title = m.attributes?.title?.en || Object.values(m.attributes?.title ?? {})[0] || "Unknown";
    const cover = m.relationships?.find((r: any) => r.type === "cover_art")?.attributes?.fileName;
    return {
      title: String(title),
      year: m.attributes?.year ?? null,
      overview: m.attributes?.description?.en || null,
      posterUrl: cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover}.256.jpg` : null,
      externalIds: { mangadex: String(m.id) },
    };
  });
}

/** MangaDex's own chapter feed for a manga — the actual chapter source (AniList is a
 * database/tracker with no per-chapter listing), used to populate a manga's "collection" children
 * the same way ComicVine populates a comic's Issues. Deduplicates by chapter number since the same
 * chapter is routinely re-translated by multiple scanlation groups, keeping whichever the API
 * returns first under the requested `order[chapter]=asc` sort. */
async function fetchMangaChaptersMangadex(mangaId: string): Promise<MetadataSubItem[]> {
  const url = new URL(`https://api.mangadex.org/manga/${mangaId}/feed`);
  url.searchParams.set("translatedLanguage[]", "en");
  url.searchParams.set("order[chapter]", "asc");
  url.searchParams.set("limit", "500");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`MangaDex chapter lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();

  const seenChapters = new Set<string>();
  const results: MetadataSubItem[] = [];
  for (const c of body.data ?? []) {
    const num = c.attributes?.chapter;
    if (!num || seenChapters.has(num)) continue;
    seenChapters.add(num);
    results.push({
      title: c.attributes.title ? `Chapter ${num} — ${c.attributes.title}` : `Chapter ${num}`,
      releaseDate: c.attributes.publishAt ?? null,
      externalId: c.id,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Provider registry + dispatch
// ---------------------------------------------------------------------------

export const METADATA_PROVIDERS: Record<MediaType, string[]> = Object.fromEntries(
  Object.values(MEDIA_TYPES).map((t) => [t.key, t.metadataProviders])
);

const SEARCH_FNS: Record<string, (query: string) => Promise<MetadataSearchResult[]>> = {
  omdb: searchMoviesOmdb,
  tvdb: searchSeriesTvdb,
  tvmaze: searchSeriesTvmaze,
  anilist: searchSeriesAnilist,
  musicbrainz: searchArtistsMusicbrainz,
  deezer: searchArtistsDeezer,
  discogs: searchArtistsDiscogs,
  lastfm: searchArtistsLastfm,
  openlibrary: searchAuthorsOpenlibrary,
  googlebooks: searchAuthorsGoogleBooks,
  comicvine: searchComicsComicVine,
  rawg: searchRomsRawg,
  igdb: searchRomsIgdb,
  youtube: searchVideosYoutube,
  theporndb: searchAdultThePornDb,
  mangadex: searchMangaMangadex,
};

// A few providers (TMDB, Trakt) search differently depending on media type despite being offered
// for more than one — this overrides SEARCH_FNS above for those (type, provider) combinations.
const TYPE_SPECIFIC_SEARCH_FNS: Record<string, Record<string, (query: string) => Promise<MetadataSearchResult[]>>> = {
  tmdb: { movie: searchMoviesTmdb, series: searchSeriesTmdb, anime: searchSeriesTmdb },
  trakt: { movie: searchMoviesTrakt, series: searchSeriesTrakt },
  anilist: { series: searchSeriesAnilist, anime: searchSeriesAnilist, manga: searchMangaAnilist },
};

function defaultProviderFor(type: MediaType): string | null {
  const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
  return getSetting(`default${capitalized}Provider`) ?? getMediaTypeConfig(type).defaultProvider;
}

export async function searchMetadata(
  type: MediaType,
  query: string,
  provider?: string
): Promise<MetadataSearchResult[]> {
  const chosen = provider || defaultProviderFor(type);
  if (!chosen) {
    throw new Error(`"${getMediaTypeConfig(type).label}" has no metadata search provider — add this item manually.`);
  }
  if (!METADATA_PROVIDERS[type]?.includes(chosen)) {
    throw new Error(`"${chosen}" is not a valid metadata provider for ${type}`);
  }
  const fn = TYPE_SPECIFIC_SEARCH_FNS[chosen]?.[type] ?? SEARCH_FNS[chosen];
  if (!fn) throw new Error(`No search implementation for provider "${chosen}"`);
  const results = await fn(query);

  // MusicBrainz — the default artist provider, kept as the default for its authoritative id (every
  // downstream album/track lookup keys off it) — has no artist artwork of its own; its own search
  // results always come back with posterUrl: null (see searchArtistsMusicbrainz above). Deezer's
  // public search API needs no key and reliably has artist photos, so opportunistically backfill
  // from it by name match rather than every scan-imported/refreshed artist staying posterless
  // forever regardless of which of Discogs/Last.fm/Fanart.tv keys the user has configured.
  if (type === "artist" && chosen === "musicbrainz" && results.some((r) => !r.posterUrl)) {
    try {
      const deezerResults = await searchArtistsDeezer(query);
      const postersByName = new Map<string, string>();
      for (const d of deezerResults) {
        if (d.posterUrl) postersByName.set(d.title.toLowerCase(), d.posterUrl);
      }
      for (const r of results) {
        if (!r.posterUrl) r.posterUrl = postersByName.get(r.title.toLowerCase()) ?? null;
      }
    } catch {
      // best-effort enrichment only — a Deezer hiccup shouldn't break the MusicBrainz search itself
    }
  }

  return results;
}

/** Dispatches to the right episode-fetch implementation based on which provider's id is present. */
export async function fetchSeriesEpisodesFor(externalIds: Record<string, string>): Promise<MetadataEpisode[]> {
  if (externalIds.tmdb) return fetchSeriesEpisodesTmdb(externalIds.tmdb);
  if (externalIds.tvdb) return fetchSeriesEpisodesTvdb(externalIds.tvdb);
  if (externalIds.tvmaze) return fetchSeriesEpisodesTvmaze(externalIds.tvmaze);
  if (externalIds.trakt) return fetchSeriesEpisodesTrakt(externalIds.trakt);
  if (externalIds.anilist) return fetchSeriesEpisodesAnilist(externalIds.anilist);
  return [];
}

/** Dispatches to the right album-list implementation; also reports which provider was used so it can be stored per-album (needed to later fetch tracks from the right API). */
export async function fetchArtistAlbumsFor(
  externalIds: Record<string, string>
): Promise<{ provider: string; albums: MetadataSubItem[] } | null> {
  if (externalIds.musicbrainz) return { provider: "musicbrainz", albums: await fetchArtistAlbumsMusicbrainz(externalIds.musicbrainz) };
  if (externalIds.deezer) return { provider: "deezer", albums: await fetchArtistAlbumsDeezer(externalIds.deezer) };
  if (externalIds.discogs) return { provider: "discogs", albums: await fetchArtistAlbumsDiscogs(externalIds.discogs) };
  if (externalIds.lastfm) return { provider: "lastfm", albums: await fetchArtistAlbumsLastfm(externalIds.lastfm) };
  return null;
}

/**
 * Dispatches to the right child-list implementation for every "collection, single-file-per-child"
 * type — Books, Comics, and Online Videos (Courses has no provider, so its externalIds never
 * match any of these and it correctly falls through to an empty list / manual-only entry).
 */
export async function fetchCollectionChildrenFor(
  externalIds: Record<string, string>
): Promise<{ provider: string | null; children: MetadataSubItem[] }> {
  if (externalIds.openlibrary) return { provider: "openlibrary", children: await fetchAuthorBooksOpenlibrary(externalIds.openlibrary) };
  if (externalIds.googlebooks) return { provider: "googlebooks", children: await fetchAuthorBooksGoogleBooks(externalIds.googlebooks) };
  if (externalIds.comicvine) return { provider: "comicvine", children: await fetchComicIssuesComicVine(externalIds.comicvine) };
  if (externalIds.mangadex) return { provider: "mangadex", children: await fetchMangaChaptersMangadex(externalIds.mangadex) };
  if (externalIds.youtube) return { provider: "youtube", children: await fetchChannelVideosYoutube(externalIds.youtube) };
  return { provider: null, children: [] };
}

/** Fetches an album's track list; the provider must be known (stored alongside the album at import time). */
export async function fetchAlbumTracksFor(provider: string, externalId: string): Promise<MetadataTrack[]> {
  if (provider === "musicbrainz") return fetchAlbumTracksMusicbrainz(externalId);
  if (provider === "deezer") return fetchAlbumTracksDeezer(externalId);
  throw new Error(`Track listings aren't available from ${provider}`);
}

// ---------------------------------------------------------------------------
// Artwork: Fanart.tv (lookup-by-id only, no title search — used to enrich an
// already-added item's poster, not to find new media)
// ---------------------------------------------------------------------------

export interface ArtworkOptions {
  posters: string[];
  backgrounds: string[];
  logos: string[];
}

async function fetchArtworkFanart(kind: "movies" | "tv" | "music", id: string): Promise<ArtworkOptions> {
  const key = requireSetting("fanartApiKey", "Fanart.tv API key");
  const res = await fetch(`https://webservice.fanart.tv/v3/${kind}/${id}?api_key=${key}`);
  if (res.status === 404) return { posters: [], backgrounds: [], logos: [] };
  if (!res.ok) throw new Error(`Fanart.tv lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();

  const urls = (arr: any[] | undefined) => (arr ?? []).map((x) => x.url).filter(Boolean);

  if (kind === "movies") {
    return {
      posters: urls(body.movieposter),
      backgrounds: urls(body.moviebackground),
      logos: urls(body.hdmovielogo ?? body.movielogo),
    };
  }
  if (kind === "tv") {
    return {
      posters: urls(body.tvposter),
      backgrounds: urls(body.showbackground),
      logos: urls(body.hdtvlogo ?? body.clearlogo),
    };
  }
  return {
    posters: urls(body.artistthumb),
    backgrounds: urls(body.artistbackground),
    logos: urls(body.hdmusiclogo ?? body.musiclogo),
  };
}

/**
 * Fanart.tv only supports lookup by an already-known TMDB (movies), TVDB (series), or
 * MusicBrainz (artists) id — there's no search-by-title, so this enriches an item already in the
 * library rather than being offered as an Add Media search provider.
 */
export async function fetchArtworkFor(type: MediaType, externalIds: Record<string, string>): Promise<ArtworkOptions> {
  if (type === "movie" && externalIds.tmdb) return fetchArtworkFanart("movies", externalIds.tmdb);
  if (type === "series" && externalIds.tvdb) return fetchArtworkFanart("tv", externalIds.tvdb);
  if (type === "artist" && externalIds.musicbrainz) return fetchArtworkFanart("music", externalIds.musicbrainz);
  throw new Error(
    "Artwork lookup needs a TMDB id (movies), TVDB id (series), or MusicBrainz id (artists) — this item doesn't have one"
  );
}

// ---------------------------------------------------------------------------
// Cast/crew (TMDB) — movies and TV shows only, since that's the only library
// shape TMDB has a credits concept for.
// ---------------------------------------------------------------------------

export interface CastMember {
  personId: number;
  name: string;
  character: string | null;
  photoUrl: string | null;
}

async function fetchCreditsTmdb(kind: "movie" | "tv", tmdbId: string): Promise<CastMember[]> {
  const key = requireSetting("tmdbApiKey", "TMDB API key");
  const res = await fetch(`https://api.themoviedb.org/3/${kind}/${tmdbId}/credits?api_key=${key}`);
  if (!res.ok) throw new Error(`TMDB credits lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();
  return (body.cast ?? []).slice(0, 20).map((c: any) => ({
    personId: c.id,
    name: c.name,
    character: c.character || null,
    photoUrl: c.profile_path ? `${TMDB_IMAGE_BASE}${c.profile_path}` : null,
  }));
}

/** Cast list for a media item already in the library — needs its TMDB id, same as artwork lookup. */
export async function fetchCastFor(type: MediaType, externalIds: Record<string, string>): Promise<CastMember[]> {
  if (!externalIds.tmdb) throw new Error("Cast lookup needs a TMDB id — this item doesn't have one");
  if (type === "movie") return fetchCreditsTmdb("movie", externalIds.tmdb);
  if (type === "series") return fetchCreditsTmdb("tv", externalIds.tmdb);
  throw new Error(`Cast lookup isn't available for "${type}"`);
}

// ---------------------------------------------------------------------------
// TMDB collections (movie franchises, e.g. "The Lord of the Rings Collection") — a movie's own
// /movie/{id} details response carries its collection membership (search results don't), so this
// is a separate lookup from the search/add flow, same shape as cast/artwork.
// ---------------------------------------------------------------------------

export interface TmdbCollectionPart {
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  releaseDate: string | null;
}

export interface TmdbCollection {
  id: number;
  name: string;
  overview: string | null;
  posterUrl: string | null;
  parts: TmdbCollectionPart[];
}

/** Null when the movie isn't part of a TMDB collection at all (most movies aren't) — not an error. */
export async function fetchTmdbCollectionFor(externalIds: Record<string, string>): Promise<TmdbCollection | null> {
  if (!externalIds.tmdb) throw new Error("Collection lookup needs a TMDB id — this item doesn't have one");
  const key = requireSetting("tmdbApiKey", "TMDB API key");

  const detailRes = await fetch(`https://api.themoviedb.org/3/movie/${externalIds.tmdb}?api_key=${key}`);
  if (!detailRes.ok) throw new Error(`TMDB movie lookup failed: HTTP ${detailRes.status}`);
  const detail: any = await detailRes.json();
  const collectionId = detail.belongs_to_collection?.id;
  if (!collectionId) return null;

  const collectionRes = await fetch(`https://api.themoviedb.org/3/collection/${collectionId}?api_key=${key}`);
  if (!collectionRes.ok) throw new Error(`TMDB collection lookup failed: HTTP ${collectionRes.status}`);
  const collection: any = await collectionRes.json();

  return {
    id: collection.id,
    name: collection.name,
    overview: collection.overview || null,
    posterUrl: collection.poster_path ? `${TMDB_IMAGE_BASE}${collection.poster_path}` : null,
    parts: (collection.parts ?? [])
      .map((p: any) => ({
        tmdbId: p.id,
        title: p.title,
        year: p.release_date ? Number(p.release_date.slice(0, 4)) : null,
        overview: p.overview || null,
        posterUrl: p.poster_path ? `${TMDB_IMAGE_BASE}${p.poster_path}` : null,
        releaseDate: p.release_date || null,
      }))
      .sort((a: TmdbCollectionPart, b: TmdbCollectionPart) => (a.releaseDate ?? "9999").localeCompare(b.releaseDate ?? "9999")),
  };
}

export interface PersonCredit {
  tmdbId: number;
  title: string;
  year: number | null;
  character: string | null;
  posterUrl: string | null;
  mediaType: "movie" | "series";
}

export interface PersonDetails {
  name: string;
  biography: string | null;
  photoUrl: string | null;
  credits: PersonCredit[];
}

/** A TMDB person's bio + combined movie/TV credit list, for the actor/cast browsing page. Credits
 * are sorted newest-first and deduped by (mediaType, tmdbId) — TMDB's combined_credits sometimes
 * lists the same title twice under different department entries (e.g. cast + a "creator" crew
 * credit on their own show). */
export async function fetchPersonDetails(tmdbPersonId: string): Promise<PersonDetails> {
  const key = requireSetting("tmdbApiKey", "TMDB API key");
  const res = await fetch(
    `https://api.themoviedb.org/3/person/${tmdbPersonId}?api_key=${key}&append_to_response=combined_credits`
  );
  if (!res.ok) throw new Error(`TMDB person lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();

  const seen = new Set<string>();
  const credits: PersonCredit[] = [];
  for (const c of body.combined_credits?.cast ?? []) {
    if (c.media_type !== "movie" && c.media_type !== "tv") continue;
    const key2 = `${c.media_type}-${c.id}`;
    if (seen.has(key2)) continue;
    seen.add(key2);
    const dateStr = c.release_date || c.first_air_date;
    credits.push({
      tmdbId: c.id,
      title: c.title ?? c.name ?? "Unknown",
      year: dateStr ? Number(String(dateStr).slice(0, 4)) : null,
      character: c.character || null,
      posterUrl: c.poster_path ? `${TMDB_IMAGE_BASE}${c.poster_path}` : null,
      mediaType: c.media_type === "movie" ? "movie" : "series",
    });
  }
  credits.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

  return {
    name: body.name ?? "Unknown",
    biography: body.biography || null,
    photoUrl: body.profile_path ? `${TMDB_IMAGE_BASE}${body.profile_path}` : null,
    credits,
  };
}
