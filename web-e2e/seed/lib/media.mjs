// Fictional library content: every title, person, studio and overview below is invented.
// Builds rows for media_items, seasons, episodes, sub_items and tracks plus the sparse files the
// has_file rows point at. All dates derive from FIXED_NOW (see util.mjs) so the output is stable.
import { poster, backdrop, square } from "./art.mjs";
import { ago, sqlTs, dayOffset, addDays, rng, GB, MB, safeName, pad2, hexId } from "./util.mjs";

const EP_TITLES = [
  "Pilot", "The Long Tide", "Static Bloom", "Salt and Smoke", "Paper Lanterns", "A Quiet Reckoning",
  "The Ferryman's Hour", "Low Water", "Brass and Ash", "Undercurrent", "What the Gulls Know", "Harvest Moon",
  "Cold Open", "The Third Bell", "Weathervane", "Signal Fires", "Mercy Street", "Slack Tide", "Glass Weather",
  "Night Shift", "Tin Roof", "The Understudy", "Fault Lines", "Open Water", "Ledger", "Hollow Crown",
  "The Lamplighter", "After the Flood", "Small Hours", "Gold Leaf", "Switchback", "Dead Reckoning",
  "Orchard Row", "Lantern Night", "Foxfire", "Last Ferry", "Daybreak", "Black Ice", "Half a Map", "The Quiet Hour",
];
const EP_OVERVIEWS = [
  "Rain keeps everyone indoors, and an old secret finally surfaces.",
  "A routine delivery turns into a race against the tide.",
  "Two rivals are forced to share a lantern and a long walk home.",
  "The town gathers for a festival, and someone is missing from the photograph.",
  "A borrowed map leads to a door that should not exist.",
  "Old debts are called in on the coldest night of the year.",
  "A stranger arrives with a story that does not quite add up.",
  "The signal fires are lit, but nobody remembers who asked for them.",
];

const FILM_BITRATE = { 480: 1800, 720: 4200, 1080: 9800, 2160: 38000 };

function mediaInfoFor(quality, durationSec, r) {
  const h = /2160/.test(quality) ? 2160 : /1080/.test(quality) ? 1080 : /720/.test(quality) ? 720 : 480;
  const w = Math.round((h * 16) / 9);
  const remux = /Remux/.test(quality);
  const bluray = /Bluray/.test(quality);
  const uhd = h === 2160;
  const hevc = uhd || (/WEB/.test(quality) && r() < 0.5);
  const hdr = uhd ? (r() < 0.5 ? "dolby-vision-hdr10" : "hdr10") : "none";
  const audioCodec = remux ? "truehd" : bluray ? "dts" : /HDTV/.test(quality) ? "ac3" : "eac3";
  const channels = remux ? 8 : /HDTV-720/.test(quality) ? 2 : 6;
  const layout = channels === 8 ? "7.1" : channels === 6 ? "5.1" : "stereo";
  const audioStreams = [{ codec: audioCodec, channels, channelLayout: layout, language: "eng", bitrateKbps: remux ? 4200 : 640, default: true }];
  if (bluray || remux) audioStreams.push({ codec: "ac3", channels: 2, channelLayout: "stereo", language: "eng", bitrateKbps: 192, default: false });
  return {
    videoCodec: hevc ? "hevc" : "h264",
    audioCodec,
    width: w,
    height: h,
    bitrateKbps: Math.round(FILM_BITRATE[h] * (remux ? 1.9 : bluray ? 1.3 : 1) * (0.9 + r() * 0.25)),
    audioChannels: channels,
    durationSeconds: durationSec,
    colorTransfer: hdr === "none" ? "bt709" : "smpte2084",
    colorPrimaries: hdr === "none" ? "bt709" : "bt2020",
    colorSpace: hdr === "none" ? "bt709" : "bt2020nc",
    bitDepth: hdr === "none" ? 8 : 10,
    hdrFormat: hdr,
    frameRate: 23.976,
    audioStreams,
    subtitleStreams: [
      { codec: "subrip", language: "eng", forced: false, default: true },
      { codec: "subrip", language: "spa", forced: false, default: false },
    ],
  };
}

function audioInfo(codec, kbps, channels, durationSec) {
  return {
    videoCodec: null,
    audioCodec: codec,
    width: null,
    height: null,
    bitrateKbps: kbps,
    audioChannels: channels,
    durationSeconds: durationSec,
    audioStreams: [{ codec, channels, channelLayout: channels === 1 ? "mono" : "stereo", language: "eng", bitrateKbps: kbps, default: true }],
    subtitleStreams: [],
  };
}

/**
 * @param {{ roots: Record<string, {id:number,path:string}>, profiles: {any:number,hd:number,uhd:number}, groups: Record<string, number> }} ctx
 */
export function buildMedia(ctx) {
  const out = { items: [], seasons: [], episodes: [], subItems: [], tracks: [], files: [], refs: {}, meta: {} };
  let nextMedia = 1;
  let nextEpisode = 1;
  let nextSub = 1;
  let nextTrack = 1;
  let nextSeason = 1;
  const r = rng("media");

  const sizeFor = (quality, kind) => {
    const q = quality ?? "";
    if (kind === "movie") {
      if (/Remux-2160/.test(q)) return Math.round((46 + r() * 22) * GB);
      if (/2160/.test(q)) return Math.round((14 + r() * 12) * GB);
      if (/Remux-1080/.test(q)) return Math.round((24 + r() * 10) * GB);
      if (/Bluray-1080/.test(q)) return Math.round((9 + r() * 9) * GB);
      if (/1080/.test(q)) return Math.round((3.5 + r() * 4) * GB);
      return Math.round((1.4 + r() * 2) * GB);
    }
    if (/2160/.test(q)) return Math.round((5 + r() * 5) * GB);
    if (/1080/.test(q)) return Math.round((1.1 + r() * 1.6) * GB);
    return Math.round((380 + r() * 420) * MB);
  };

  function baseItem(o) {
    const id = nextMedia++;
    const root = ctx.roots[o.root];
    const item = {
      id,
      type: o.type,
      title: o.t,
      sort_title: o.t.toLowerCase(),
      year: o.y ?? null,
      overview: o.ov ?? null,
      poster_url: poster(o.t, o.y ? String(o.y) : undefined),
      external_ids: JSON.stringify(o.ext ?? {}),
      path: o.path ?? null,
      root_folder_id: root?.id ?? null,
      quality_profile_id: o.profile ?? ctx.profiles.any,
      monitored: o.mon === 0 ? 0 : 1,
      has_file: 0,
      quality: null,
      protected: o.protectedItem ? 1 : 0,
      status: "missing",
      added_at: sqlTs(o.added ?? ago({ days: 30 })),
      release_date: o.rel ?? null,
      backdrop_url: o.noBackdrop ? null : backdrop(o.t),
      rating: o.r ?? null,
      runtime_minutes: o.rt ?? null,
      size_bytes: null,
      studio: o.st ?? null,
      media_info: null,
      content_rating: o.cr ?? null,
      group_id: o.group ?? null,
      extra_metadata: o.extra ? JSON.stringify(o.extra) : null,
      minimum_availability: o.minAvail ?? null,
      series_type: o.seriesType ?? null,
      digital_release_date: o.digital ?? null,
      physical_release_date: o.physical ?? null,
      genres: o.g ? JSON.stringify(o.g) : null,
    };
    out.items.push(item);
    out.refs[o.key ?? o.t] = id;
    out.meta[id] = { tags: o.tags ?? [], col: o.col ?? null, dup: o.dupGroup ?? null };
    return item;
  }

  // ---------------------------------------------------------------- movies
  const MOVIE_ROOT = "movie";
  const movies = [
    { t: "The Lantern Keepers", y: 2024, g: ["Fantasy", "Drama"], r: 7.8, rt: 132, cr: "PG-13", st: "Brightwick Pictures", q: "Bluray-1080p", have: true, rel: "2024-06-14", added: ago({ days: 112 }), ov: "Three siblings inherit a lighthouse whose lamp has not been lit in sixty years, and learn why the coast has been so quiet since.", tags: ["keep"] },
    { t: "Midnight Orchid", y: 2018, g: ["Thriller"], r: 6.9, rt: 109, cr: "R", st: "Greyfield Films", q: "WEBDL-1080p", have: true, rel: "2018-10-26", added: ago({ days: 96 }), ov: "A florist becomes the only witness to a crime that no one else believes happened.", key: "Midnight Orchid", dupGroup: "orchid", ext: { tmdb: "900102" } },
    { t: "Midnight Orchid", y: 2018, g: ["Thriller"], r: 6.9, rt: 109, cr: "R", st: "Greyfield Films", q: null, have: false, rel: "2018-10-26", added: ago({ days: 9 }), ov: "A florist becomes the only witness to a crime that no one else believes happened.", key: "Midnight Orchid (2)", dupGroup: "orchid", ext: { tmdb: "900103" }, minAvail: "released" },
    { t: "Saltwater Hymn", y: 2021, g: ["Drama"], r: 7.4, rt: 118, cr: "PG-13", st: "Open Tide Studio", q: "WEBDL-1080p", have: true, rel: "2021-04-02", added: ago({ days: 90 }), ov: "A widowed fisherman and a visiting choir leader rebuild a village chapel one hymn at a time." },
    { t: "Paper Moon Heist", y: 2019, g: ["Comedy", "Crime"], r: 7.1, rt: 101, cr: "PG-13", st: "Brightwick Pictures", q: "Bluray-1080p", have: true, rel: "2019-08-09", added: ago({ days: 88 }), ov: "A retired origami artist assembles a crew of unlikely accomplices to fold the perfect robbery." },
    { t: "Echoes of Kestrel Bay", y: 2023, g: ["Mystery"], r: 7.0, rt: 124, cr: "PG-13", st: "Greyfield Films", q: "WEBDL-1080p", have: true, rel: "2023-09-22", added: ago({ days: 80 }), ov: "A sound engineer records a stretch of coastline and hears a conversation from fifty years ago." },
    { t: "Neon Harbor", y: 2022, g: ["Action", "Crime"], r: 7.6, rt: 116, cr: "R", st: "Midnight Sun Pictures", q: "Remux-2160p", have: true, rel: "2022-07-15", added: ago({ days: 75 }), ov: "A ferry pilot in a rain-soaked port city is dragged into a war between two smuggling families.", col: "neon", profile: "uhd", tags: ["4k"] },
    { t: "Neon Harbor II: Undertow", y: 2024, g: ["Action", "Crime"], r: 7.2, rt: 121, cr: "R", st: "Midnight Sun Pictures", q: "Remux-2160p", have: true, rel: "2024-07-19", added: ago({ days: 70 }), ov: "The ferry pilot returns to the harbor to find the old rivalries have learned to wear new faces.", col: "neon", profile: "uhd", tags: ["4k"] },
    { t: "Neon Harbor III: Afterglow", y: 2027, g: ["Action", "Crime"], r: null, rt: null, cr: null, st: "Midnight Sun Pictures", q: null, have: false, rel: "2027-02-12", added: ago({ days: 40 }), ov: "The final chapter of the harbor saga. Release date announced, trailer pending.", col: "neon", profile: "uhd", minAvail: "announced", unreleased: true },
    { t: "A Quiet Orbit", y: 2020, g: ["Science Fiction", "Drama"], r: 7.9, rt: 138, cr: "PG-13", st: "Open Tide Studio", q: "Bluray-1080p", have: true, rel: "2020-11-06", added: ago({ days: 66 }), ov: "A lone maintenance technician on a derelict relay station receives a message addressed to her future self." },
    { t: "The Cartographer's Daughter", y: 2017, g: ["Adventure", "Family"], r: 7.3, rt: 112, cr: "PG", st: "Brightwick Pictures", q: "WEBDL-1080p", have: true, rel: "2017-12-01", added: ago({ days: 60 }), ov: "A girl inherits her father's unfinished atlas and sets out to chart the places he only imagined.", tags: ["kids"] },
    { t: "Brass Monkeys of Dunmore", y: 2015, g: ["Comedy"], r: 6.4, rt: 97, cr: "PG-13", st: "Greyfield Films", q: "Bluray-1080p", have: true, rel: "2015-03-20", added: ago({ days: 58 }), ov: "A struggling marching band takes a wrong turn and enters the wrong championship." },
    { t: "Winterlight Station", y: 2025, g: ["Science Fiction", "Thriller"], r: 8.1, rt: 129, cr: "R", st: "Midnight Sun Pictures", q: "Remux-2160p", have: true, rel: "2025-12-12", added: ago({ days: 45 }), ov: "A crew of researchers at a polar outpost discovers their instruments are measuring something that is measuring them back.", profile: "uhd", tags: ["4k"] },
    { t: "The Salt Road", y: 2016, g: ["Western", "Drama"], r: 6.8, rt: 128, cr: "R", st: "Dunmore Pictures", q: "HDTV-720p", have: true, rel: "2016-05-13", added: ago({ days: 50 }), ov: "Two estranged brothers drive a salt caravan across a valley where the wells have started to fail." },
    { t: "Velvet Static", y: 2014, g: ["Drama", "Music"], r: 6.6, rt: 104, cr: "R", st: "Dunmore Pictures", q: "HDTV-720p", have: true, rel: "2014-09-05", added: ago({ days: 49 }), ov: "A fading radio host takes one last call from a listener who claims to be broadcasting from the future." },
    { t: "Ghosts of Marigold Lane", y: 2012, g: ["Horror"], r: 6.0, rt: 94, cr: "R", st: "Greyfield Films", q: "WEBDL-720p", have: true, rel: "2012-10-19", added: ago({ days: 48 }), ov: "A family moves to a quiet cul-de-sac and learns the neighbours have never really left." },
    { t: "Copperfield Mutiny", y: 2026, g: ["Adventure", "History"], r: 7.5, rt: 143, cr: "PG-13", st: "Open Tide Studio", q: null, have: false, rel: "2026-09-04", digital: "2026-10-09", added: ago({ days: 20 }), ov: "A merchant ship's crew stages the quietest mutiny in naval history, using nothing but paperwork.", minAvail: "released", profile: "hd" },
    { t: "Tidebreakers", y: 2025, g: ["Sports", "Drama"], r: 7.2, rt: 115, cr: "PG-13", st: "Brightwick Pictures", q: null, have: false, rel: "2025-08-22", added: ago({ days: 31 }), ov: "A struggling surf club trains for a regional cup in the roughest water on the coast.", minAvail: "released", tags: ["new"] },
    { t: "The Glass Orchard", y: 2024, g: ["Fantasy"], r: 7.0, rt: 126, cr: "PG-13", st: "Dunmore Pictures", q: null, have: false, rel: "2024-11-15", added: ago({ days: 30 }), ov: "In a greenhouse kingdom, every wish grows as a fruit and every fruit comes with a price.", minAvail: "released", tags: ["new"] },
    { t: "Starling Protocol", y: 2026, g: ["Thriller", "Science Fiction"], r: null, rt: 118, cr: "PG-13", st: "Midnight Sun Pictures", q: null, have: false, rel: dayOffset(3), added: ago({ days: 14 }), ov: "An analyst notices a flock of satellites behaving exactly like birds. Opens this week.", minAvail: "inCinemas" },
    { t: "Ember & Ash", y: 2026, g: ["Romance", "Drama"], r: null, rt: 111, cr: "PG-13", st: "Open Tide Studio", q: null, have: false, rel: dayOffset(10), added: ago({ days: 13 }), ov: "Two rival bakers are snowed in together over the longest winter weekend of their careers.", minAvail: "inCinemas" },
    { t: "Lighthouse at the End of the World", y: 2026, g: ["Documentary"], r: null, rt: 96, cr: "G", st: "Brightwick Pictures", q: null, have: false, rel: dayOffset(13), added: ago({ days: 12 }), ov: "A documentary following the last keepers of the world's remotest working light.", minAvail: "inCinemas" },
    { t: "Long Way to Lumen", y: 2027, g: ["Animation", "Family"], r: null, rt: null, cr: null, st: "Brightwick Pictures", q: null, have: false, rel: "2027-03-05", added: ago({ days: 8 }), ov: "A robot courier crosses a continent of lights to deliver one very small package.", minAvail: "announced", unreleased: true },
    { t: "Dust of a Thousand Suns", y: 2011, g: ["Science Fiction"], r: 6.7, rt: 133, cr: "PG-13", st: "Dunmore Pictures", q: "Bluray-1080p", have: true, mon: 0, rel: "2011-06-24", added: ago({ days: 100 }), ov: "A desert survey team finds a second sunrise on the western horizon.", protectedItem: true },
    { t: "Pocket Full of Thunder", y: 2009, g: ["Comedy"], r: 5.9, rt: 92, cr: "PG-13", st: "Greyfield Films", q: null, have: false, mon: 0, rel: "2009-07-17", added: ago({ days: 99 }), ov: "A weatherman discovers that his umbrella controls the forecast.", minAvail: "released" },
    { type: "ppv", rootKey: "ppv", t: "Rumble Night: Titans of the Ring", y: 2026, g: ["Sports", "Wrestling"], r: 7.0, rt: 210, cr: "TV-14", st: "Harbor Sports Network", q: "WEBDL-1080p", have: true, rel: "2026-09-12", added: ago({ days: 30 }), ov: "The season's biggest card, live from the Harbor Dome.", key: "Rumble Night: Titans of the Ring" },
    { type: "ppv", rootKey: "ppv", t: "Showdown at Pier 9", y: 2026, g: ["Sports", "Boxing"], r: null, rt: 190, cr: "TV-14", st: "Harbor Sports Network", q: null, have: false, rel: "2026-12-05", added: ago({ days: 16 }), ov: "Main event and undercard from the Pier 9 arena.", minAvail: "announced", unreleased: true, key: "Showdown at Pier 9" },
    { t: "Family Archive 1998-2004", y: 2019, g: ["Home Video"], r: null, rt: 74, cr: null, st: null, q: "WEBDL-720p", have: true, rel: null, added: ago({ days: 3 }), ov: "Digitised home videos from the Marlowe family archive.", noBackdrop: true, ext: {}, key: "Family Archive 1998-2004" },
  ];
  movies.forEach((m, i) => {
    const seq = i + 1;
    const profile = m.profile ? ctx.profiles[m.profile] : ctx.profiles.any;
    const type = m.type ?? "movie";
    const root = m.rootKey ?? (m.q && /2160/.test(m.q) ? "movie4k" : MOVIE_ROOT);
    const folder = `${safeName(m.t)} (${m.y})`;
    const rootPath = ctx.roots[root].path;
    let path = null;
    let size = null;
    let info = null;
    if (m.have) {
      path = `${rootPath}/${folder}/${safeName(m.t)} (${m.y}) [${m.q}].mkv`;
      size = sizeFor(m.q, "movie");
      info = mediaInfoFor(m.q, (m.rt ?? 100) * 60, r);
      out.files.push({ path, size });
    }
    const item = baseItem({
      type, root, t: m.t, y: m.y, ov: m.ov, ext: m.ext ?? { tmdb: String(900000 + seq), imdb: `tt${(7000000 + seq * 137).toString()}` },
      path, profile, mon: m.mon, added: m.added, rel: m.rel, r: m.r, rt: m.rt, st: m.st, cr: m.cr, g: m.g, key: m.key,
      minAvail: m.minAvail ?? (m.have ? "released" : null), digital: m.digital, protectedItem: m.protectedItem,
      noBackdrop: m.noBackdrop, tags: m.tags, col: m.col, dupGroup: m.dupGroup,
    });
    item.has_file = m.have ? 1 : 0;
    item.quality = m.q;
    item.size_bytes = size;
    item.media_info = info ? JSON.stringify(info) : null;
    item.status = m.have ? "downloaded" : m.unreleased ? "unreleased" : "missing";
    if (m.have) item.physical_release_date = m.rel ? addDays(m.rel, 90) : null;
  });

  // ----------------------------------------------------------- episodic shows
  function addEpisodic(o) {
    const item = baseItem({ ...o, type: o.type ?? "series" });
    const rootPath = ctx.roots[o.root].path;
    const showFolder = `${safeName(o.t)}${o.y ? ` (${o.y})` : ""}`;
    item.path = `${rootPath}/${showFolder}`;
    let anyFile = false;
    let absolute = 0;
    for (const s of o.seasons) {
      out.seasons.push({ id: nextSeason++, media_item_id: item.id, season_number: s.n, poster_url: poster(`${o.t} Season ${s.n}`, "Season " + s.n) });
      for (let e = 1; e <= s.count; e++) {
        absolute++;
        const id = nextEpisode++;
        const air = s.firstAir ? addDays(s.firstAir, (e - 1) * (s.every ?? 7)) : null;
        const have = typeof s.have === "function" ? s.have(e) : e <= (s.haveUpTo ?? 0);
        const q = typeof s.quality === "function" ? s.quality(e) : s.quality ?? "WEBDL-1080p";
        const title = s.titles ? s.titles[e - 1] : EP_TITLES[(o.titleOffset + absolute - 1) % EP_TITLES.length];
        let filePath = null;
        let size = null;
        let info = null;
        if (have) {
          filePath = `${item.path}/Season ${pad2(s.n)}/${safeName(o.t)} - S${pad2(s.n)}E${pad2(e)} - ${safeName(title)} [${q}].${o.ext2 ?? "mkv"}`;
          size = sizeFor(q, "episode");
          info = mediaInfoFor(q, (o.rt ?? 42) * 60, r);
          out.files.push({ path: filePath, size });
          anyFile = true;
        }
        out.episodes.push({
          id,
          media_item_id: item.id,
          season_number: s.n,
          episode_number: e,
          title,
          air_date: air,
          overview: EP_OVERVIEWS[(id + o.titleOffset) % EP_OVERVIEWS.length],
          monitored: typeof s.monitored === "function" ? (s.monitored(e) ? 1 : 0) : o.mon === 0 ? 0 : 1,
          has_file: have ? 1 : 0,
          quality: have ? q : null,
          file_path: filePath,
          media_info: info ? JSON.stringify(info) : null,
          size_bytes: size,
          absolute_episode_number: absolute,
        });
      }
    }
    item.has_file = anyFile ? 1 : 0;
    item.status = anyFile ? "downloaded" : "missing";
    return item;
  }

  addEpisodic({ t: "Harbor Lights", y: 2019, root: "series", g: ["Drama", "Mystery"], r: 8.4, rt: 47, cr: "TV-14", st: "Northline Network", ov: "In a fog-bound port town, a night-shift harbour pilot keeps finding things in the water that were never reported lost.", ext: { tmdb: "910001", tvdb: "381001" }, titleOffset: 0, added: ago({ days: 110 }), key: "Harbor Lights", tags: ["keep"], seriesType: "standard", profile: ctx.profiles.hd,
    seasons: [{ n: 1, count: 8, firstAir: "2019-02-07", haveUpTo: 8 }, { n: 2, count: 8, firstAir: "2020-02-06", haveUpTo: 8 }, { n: 3, count: 8, firstAir: "2021-02-04", haveUpTo: 8 }] });
  addEpisodic({ t: "The Quiet Division", y: 2022, root: "series", g: ["Crime", "Drama"], r: 7.9, rt: 52, cr: "TV-MA", st: "Northline Network", ov: "A small detective unit with no budget and an enormous backlog works the cases nobody else will touch.", ext: { tmdb: "910002", tvdb: "381002" }, titleOffset: 9, added: ago({ days: 105 }), key: "The Quiet Division", seriesType: "standard", profile: ctx.profiles.hd,
    seasons: [{ n: 1, count: 10, firstAir: "2022-09-15", haveUpTo: 10 }, { n: 2, count: 10, firstAir: "2024-09-12", haveUpTo: 6 }] });
  addEpisodic({ t: "Kestrel County", y: 2024, root: "series", g: ["Drama", "Thriller"], r: 8.0, rt: 55, cr: "TV-14", st: "Skyline Streaming", ov: "A new sheriff inherits a county where every farmhouse has a locked cellar and a polite explanation.", ext: { tmdb: "910003", tvdb: "381003" }, titleOffset: 17, added: ago({ days: 95 }), key: "Kestrel County", seriesType: "standard", profile: ctx.profiles.hd,
    seasons: [{ n: 1, count: 8, firstAir: "2024-10-03", haveUpTo: 8 }, { n: 2, count: 8, firstAir: "2026-09-17", haveUpTo: 3 }] });
  addEpisodic({ t: "Mapmakers of Aldermere", y: 2021, root: "series", g: ["Fantasy", "Adventure"], r: 7.5, rt: 58, cr: "TV-14", st: "Skyline Streaming", ov: "In a kingdom where maps rewrite themselves, a guild of cartographers is the only thing between the realm and chaos.", ext: { tmdb: "910004", tvdb: "381004" }, titleOffset: 4, added: ago({ days: 22 }), key: "Mapmakers of Aldermere", seriesType: "standard",
    seasons: [{ n: 1, count: 10, firstAir: "2021-06-10", haveUpTo: 0 }] });
  addEpisodic({ t: "Orlo Finch Tonight", y: 2025, root: "series", g: ["Talk Show", "Comedy"], r: 6.8, rt: 42, cr: "TV-PG", st: "Northline Network", ov: "A late-night talk show hosted by a perpetually unimpressed puppeteer.", ext: { tmdb: "910005", tvdb: "381005" }, titleOffset: 23, added: ago({ days: 21 }), key: "Orlo Finch Tonight", seriesType: "daily",
    seasons: [{ n: 1, count: 12, firstAir: "2026-09-28", every: 1, have: (e) => e >= 7, quality: "HDTV-720p", titles: ["Guest: Marisol Quinn", "Guest: Tomas Aldecott", "Guest: The Velvet Lanterns", "Cooking With Orlo", "Guest: Wren Hallowell", "Weather Special", "Guest: Priya Nandakumar", "Guest: Captain Marrow", "Puppet Roast", "Guest: DJ Hexagon", "Viewer Mail Night", "Guest: Odalys Renwick"] }] });
  addEpisodic({ t: "Salt & Static", y: 2017, root: "series", g: ["Comedy", "Drama"], r: 7.2, rt: 28, cr: "TV-14", st: "Dunmore Broadcasting", ov: "Two sound-effects artists at a failing radio drama discover their studio is haunted by its own broadcasts.", ext: { tmdb: "910006", tvdb: "381006" }, titleOffset: 30, added: ago({ days: 85 }), key: "Salt & Static", seriesType: "standard",
    seasons: [{ n: 1, count: 6, firstAir: "2017-01-12", haveUpTo: 6, quality: "HDTV-720p" }, { n: 2, count: 6, firstAir: "2018-01-11", haveUpTo: 6, quality: (e) => (e % 2 ? "HDTV-720p" : "WEBDL-720p") }] });
  addEpisodic({ t: "Drift Season", y: 2020, root: "series", g: ["Sports", "Documentary"], r: 7.6, rt: 44, cr: "TV-PG", st: "Dunmore Broadcasting", ov: "A documentary series following a year on the amateur drift-racing circuit.", ext: { tmdb: "910007", tvdb: "381007" }, titleOffset: 12, added: ago({ days: 92 }), key: "Drift Season", mon: 0, seriesType: "standard",
    seasons: [{ n: 1, count: 6, firstAir: "2020-07-02", haveUpTo: 3 }] });
  addEpisodic({ t: "Cartwheel Court", y: 2023, root: "series", g: ["Animation", "Comedy", "Family"], r: 7.4, rt: 22, cr: "TV-Y7", st: "Brightwick Kids", ov: "The animals of a tiny courthouse settle disputes with a great deal of enthusiasm and very little law.", ext: { tmdb: "910008", tvdb: "381008" }, titleOffset: 6, added: ago({ days: 86 }), key: "Cartwheel Court", seriesType: "standard", tags: ["kids"],
    seasons: [{ n: 1, count: 8, firstAir: "2023-03-04", haveUpTo: 8 }, { n: 2, count: 8, firstAir: "2024-03-02", haveUpTo: 8 }] });

  // anime
  addEpisodic({ t: "Tales of the Clockwork Hollow", y: 2025, root: "anime", type: "anime", g: ["Animation", "Fantasy"], r: 8.2, rt: 24, cr: "TV-14", st: "Studio Kiln", ov: "A clockmaker's apprentice repairs a town where every resident is, secretly, a mechanism.", ext: { anilist: "180001", tvdb: "381009" }, titleOffset: 2, added: ago({ days: 70 }), key: "Tales of the Clockwork Hollow", seriesType: "standard",
    seasons: [{ n: 1, count: 12, firstAir: "2025-10-04", haveUpTo: 8, quality: "WEBDL-1080p" }] });
  addEpisodic({ t: "Moonlit Dungeon Diaries", y: 2026, root: "anime", type: "anime", g: ["Animation", "Adventure"], r: null, rt: 24, cr: "TV-14", st: "Studio Kiln", ov: "A sleepy shopkeeper keeps the books for the adventurers who raid the dungeon under her inn.", ext: { anilist: "180002", tvdb: "381010" }, titleOffset: 21, added: ago({ days: 18 }), key: "Moonlit Dungeon Diaries", seriesType: "standard",
    seasons: [{ n: 1, count: 12, firstAir: "2026-10-01", haveUpTo: 1, quality: "WEBDL-1080p" }] });

  // sports (a league modelled as a show with dated matchday "episodes")
  addEpisodic({ t: "Premier Harbor League 2026", y: 2026, root: "sports", type: "sports", g: ["Sports"], r: null, rt: 110, cr: "TV-PG", st: "Harbor Sports Network", ov: "Weekly matchday coverage of the Premier Harbor League season.", ext: { tvdb: "381011" }, titleOffset: 1, added: ago({ days: 52 }), key: "Premier Harbor League 2026", seriesType: "standard", noBackdrop: false,
    seasons: [{ n: 1, count: 14, firstAir: "2026-08-15", have: (e) => e <= 9, quality: "WEBDL-1080p",
      titles: Array.from({ length: 14 }, (_, i) => `Matchday ${i + 1}`) }] });

  // course (folder-as-show, lessons as episodes)
  addEpisodic({ t: "Intro to Watercolor Landscapes", y: 2024, root: "course", type: "course", g: ["Art", "Education"], r: null, rt: 20, cr: null, st: "Brushwork Academy", ov: "Eight short lessons on mixing, washes and skies, taught by painting one valley across the seasons.", ext: {}, titleOffset: 0, added: ago({ days: 60 }), key: "Intro to Watercolor Landscapes", ext2: "mp4", noBackdrop: true,
    seasons: [{ n: 1, count: 8, firstAir: null, haveUpTo: 8, quality: "WEBDL-1080p", titles: ["Materials and Setup", "Wet on Wet", "Mixing Greys", "Skies", "Distant Hills", "Water and Reflections", "Foreground Details", "Putting It Together"] }] });

  // ------------------------------------------------------------- collection types
  function addSub(parent, s) {
    const id = nextSub++;
    out.subItems.push({
      id,
      media_item_id: parent.id,
      title: s.title,
      release_date: s.rel ?? null,
      external_id: s.extId ?? null,
      external_provider: s.provider ?? null,
      monitored: s.mon === 0 ? 0 : 1,
      has_file: s.have ? 1 : 0,
      quality: s.have ? s.quality ?? null : null,
      file_path: s.have ? s.filePath ?? null : null,
      series_name: s.seriesName ?? null,
      series_position: s.seriesPos ?? null,
      narrator: s.narrator ?? null,
      media_info: s.info ? JSON.stringify(s.info) : null,
      poster_url: s.cover === false ? null : (s.square ? square(s.title) : poster(s.title, parent.title)),
      size_bytes: s.have ? s.size ?? null : null,
      overview: s.ov ?? null,
    });
    if (s.have && s.filePath && !s.noFile) out.files.push({ path: s.filePath, size: s.size ?? 1024 });
    return id;
  }

  function addCollectionParent(o) {
    const root = ctx.roots[o.root];
    const item = baseItem({ ...o, path: `${root.path}/${safeName(o.t)}` });
    return item;
  }
  const finalizeParent = (item, subs) => {
    const any = subs.some((s) => s.have);
    item.has_file = any ? 1 : 0;
    item.status = any ? "downloaded" : "missing";
  };

  // music
  const ARTISTS = [
    { t: "The Velvet Lanterns", g: ["Indie", "Dream Pop"], ov: "A four-piece dream-pop band from the harbour district, known for long reverb tails and short album titles.", albums: [
      { title: "Paper Cities", y: 2016, have: true, tracks: ["Opening Night", "Paper Cities", "Salt Flats", "Glass Rooms", "Soft Landing", "Neon Lull", "The Long Way Round", "Afterimage", "Slow Wave", "Closing Time"] },
      { title: "Slow Fires", y: 2019, have: true, tracks: ["Ember", "Slow Fires", "Tin Whistle", "Warm Front", "Hollow Bells", "Lantern Song", "Backroads", "Low Light", "Cinder", "Goodnight Moon"] },
      { title: "Tidal Static", y: 2023, have: false, tracks: ["Tidal", "Static", "Breakwater", "Signal Flare", "Undertow", "Dry Dock", "Fog Horn", "Last Light"] },
      { title: "Afterlight", rel: dayOffset(7), have: false, tracks: ["Prelude", "Afterlight", "Quiet Hours", "Starboard", "Daybreak", "Epilogue"] },
    ] },
    { t: "Marisol Quinn", g: ["Jazz", "Vocal"], ov: "A jazz vocalist whose small-room recordings built a devoted following.", albums: [
      { title: "Blue Hours", y: 2021, have: true, partial: [1, 2, 3, 4, 5, 6], tracks: ["Blue Hours", "Cold Coffee", "Midnight Tram", "Rain Check", "Second Chorus", "Streetlight Waltz", "Quiet Corner", "Last Call", "Sunrise Set", "Reprise"] },
      { title: "Small Rooms", y: 2018, have: true, tracks: ["Small Rooms", "Velvet Rope", "Lullaby for Nobody", "Slow Burn", "Corner Booth", "Late Train", "Piano Bar", "Home Again"] },
    ] },
    { t: "Orchard Kings", g: ["Folk Rock"], ov: "A folk-rock trio from the orchard country.", albums: [
      { title: "Harvest Debt", y: 2014, have: true, tracks: ["Harvest Debt", "Cider Road", "Seven Acres", "The Press", "Rootstock", "Frost Warning", "Bushel and Peck", "Last Pick"] },
      { title: "Windfall", y: 2017, have: true, tracks: ["Windfall", "Ladder", "Bramble", "Over the Fence", "Honey Locust", "Sparrow Song", "Winter Store", "Orchard Lights", "Thaw"] },
      { title: "Grafted", y: 2022, have: false, tracks: ["Graft", "New Wood", "Scion", "Old Roots", "Blossom", "Pollen", "Fruit Set"] },
    ] },
    { t: "DJ Hexagon", g: ["Electronic"], ov: "Instrumental electronic producer.", albums: [
      { title: "Six Sides", y: 2020, have: true, tracks: ["Vertex", "Edge", "Face", "Diagonal", "Tessellate", "Hexad"] },
      { title: "Honeycomb EP", y: 2022, have: true, tracks: ["Cell One", "Cell Two", "Cell Three", "Comb"] },
    ] },
  ];
  ARTISTS.forEach((a, ai) => {
    const parent = addCollectionParent({ type: "artist", root: "artist", t: a.t, ov: a.ov, g: a.g, ext: { musicbrainz: hexId("mb-artist-" + a.t).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5") }, added: ago({ days: 80 - ai * 11 }), key: a.t, profile: ctx.profiles.any, noBackdrop: false });
    const subs = [];
    a.albums.forEach((al, ali) => {
      const folder = `${parent.path}/${safeName(al.title)}${al.y ? ` (${al.y})` : ""}`;
      const subId = addSub(parent, {
        title: al.title,
        rel: al.rel ?? (al.y ? `${al.y}-0${(ali % 9) + 1}-1${ali % 9}` : null),
        extId: hexId("mb-rg-" + a.t + al.title).slice(0, 36),
        provider: "musicbrainz",
        have: al.have,
        quality: al.have ? "FLAC" : null,
        filePath: al.have ? folder : null,
        noFile: true,
        size: al.have ? al.tracks.length * 31 * MB : null,
        square: true,
        info: al.have ? audioInfo("flac", 920, 2, al.tracks.length * 215) : null,
      });
      subs.push({ have: al.have });
      al.tracks.forEach((tt, ti) => {
        const hasT = al.have && (!al.partial || al.partial.includes(ti + 1));
        const tp = hasT ? `${folder}/${pad2(ti + 1)} - ${safeName(tt)}.flac` : null;
        const sz = Math.round((24 + r() * 14) * MB);
        if (hasT) out.files.push({ path: tp, size: sz });
        out.tracks.push({ id: nextTrack++, sub_item_id: subId, track_number: ti + 1, title: tt, duration_seconds: 150 + Math.round(r() * 170), has_file: hasT ? 1 : 0, file_path: tp });
      });
      out.refs[`album:${a.t}:${al.title}`] = subId;
    });
    finalizeParent(parent, subs);
  });

  // books
  const AUTHORS = [
    { t: "Odalys Renwick", g: ["Fantasy", "Mystery"], ov: "Author of the Lighthouse Cycle.", books: [
      { title: "The Tin Lighthouse", y: 2015, have: true, series: "Lighthouse Cycle", pos: 1, fmt: "EPUB" },
      { title: "Salt in the Wires", y: 2017, have: true, series: "Lighthouse Cycle", pos: 2, fmt: "EPUB" },
      { title: "The Drowned Chart", y: 2020, have: false, series: "Lighthouse Cycle", pos: 3, fmt: null },
      { title: "A Short History of Fog", y: 2022, have: true, fmt: "EPUB" },
    ] },
    { t: "Tomas Aldecott", g: ["Essays", "Nature"], ov: "Essayist and amateur astronomer.", books: [
      { title: "A Field Guide to Small Hours", y: 2019, have: true, fmt: "EPUB" },
      { title: "Dust Between Stars", y: 2022, have: true, fmt: "PDF" },
      { title: "Notes from the Observatory", y: 2024, have: false, fmt: null },
    ] },
    { t: "Priya Nandakumar", g: ["Literary Fiction"], ov: "Novelist and former librarian.", books: [
      { title: "The Second Library", y: 2021, have: true, fmt: "EPUB" },
      { title: "Letters to a Future Tide", rel: dayOffset(11), have: false, fmt: null },
    ] },
    { t: "Wren Hallowell", g: ["Young Adult", "Fantasy"], ov: "Young adult fantasy author.", books: [
      { title: "The Moth Queen", y: 2018, have: true, series: "Moth Queen Trilogy", pos: 1, fmt: "EPUB" },
      { title: "The Moth Throne", y: 2019, have: true, series: "Moth Queen Trilogy", pos: 2, fmt: "EPUB" },
      { title: "The Moth Crown", y: 2021, have: true, series: "Moth Queen Trilogy", pos: 3, fmt: "EPUB" },
    ] },
  ];
  AUTHORS.forEach((a, ai) => {
    const parent = addCollectionParent({ type: "author", root: "author", t: a.t, ov: a.ov, g: a.g, ext: { openlibrary: `OL${(7100 + ai * 13)}A` }, added: ago({ days: 74 - ai * 9 }), key: a.t, profile: ctx.profiles.any, noBackdrop: true });
    parent.backdrop_url = null;
    const subs = [];
    a.books.forEach((b, bi) => {
      const ext = (b.fmt ?? "epub").toLowerCase();
      const fp = b.have ? `${parent.path}/${safeName(b.title)}.${ext}` : null;
      const size = Math.round((1.1 + r() * 5) * MB);
      const subId = addSub(parent, { title: b.title, rel: b.rel ?? (b.y ? `${b.y}-0${(bi % 8) + 1}-1${bi % 9}` : null), extId: `OL${8000 + ai * 40 + bi}W`, provider: "openlibrary", have: b.have, quality: b.fmt, filePath: fp, size, seriesName: b.series, seriesPos: b.pos, ov: `${b.title} by ${a.t}.` });
      subs.push({ have: b.have });
      out.refs[`book:${a.t}:${b.title}`] = subId;
    });
    finalizeParent(parent, subs);
  });

  // audiobooks (multi-file per child)
  const AUDIO = [
    { t: "Odalys Renwick", key: "Odalys Renwick (audiobook)", g: ["Fantasy"], books: [{ title: "The Tin Lighthouse (Unabridged)", y: 2015, narrator: "Callum Reyes", have: true, parts: 9, series: "Lighthouse Cycle", pos: 1 }, { title: "Salt in the Wires (Unabridged)", y: 2017, narrator: "Callum Reyes", have: false, parts: 10, series: "Lighthouse Cycle", pos: 2 }] },
    { t: "Wren Hallowell", key: "Wren Hallowell (audiobook)", g: ["Young Adult"], books: [{ title: "The Moth Queen (Unabridged)", y: 2018, narrator: "Imogen Vale", have: true, parts: 12, series: "Moth Queen Trilogy", pos: 1 }] },
  ];
  AUDIO.forEach((a, ai) => {
    const parent = addCollectionParent({ type: "audiobook", root: "audiobook", t: a.t, ov: `Audiobooks narrated from the works of ${a.t}.`, g: a.g, ext: { openlibrary: `OL${7200 + ai}A` }, added: ago({ days: 40 - ai * 5 }), key: a.key, noBackdrop: true });
    parent.backdrop_url = null;
    const subs = [];
    a.books.forEach((b, bi) => {
      const folder = `${parent.path}/${safeName(b.title)}`;
      const subId = addSub(parent, { title: b.title, rel: `${b.y}-0${bi + 4}-0${bi + 2}`, extId: `OL${8400 + ai * 20 + bi}W`, provider: "openlibrary", have: b.have, quality: b.have ? "MP3" : null, filePath: b.have ? folder : null, noFile: true, size: b.have ? b.parts * 38 * MB : null, narrator: b.narrator, seriesName: b.series, seriesPos: b.pos, info: b.have ? audioInfo("mp3", 96, 1, b.parts * 2400) : null });
      subs.push({ have: b.have });
      for (let p = 1; p <= b.parts; p++) {
        const tp = b.have ? `${folder}/Part ${pad2(p)}.mp3` : null;
        if (tp) out.files.push({ path: tp, size: Math.round((30 + r() * 16) * MB) });
        out.tracks.push({ id: nextTrack++, sub_item_id: subId, track_number: p, title: `Part ${p}`, duration_seconds: 2100 + Math.round(r() * 700), has_file: b.have ? 1 : 0, file_path: tp });
      }
      out.refs[`audiobook:${a.t}:${b.title}`] = subId;
    });
    finalizeParent(parent, subs);
  });

  // comics
  const COMICS = [
    { t: "Captain Marrow", g: ["Superhero", "Adventure"], publisher: "Dunmore Comics", issues: 8, have: 5 },
    { t: "Pixel Pirates", g: ["Comedy", "Adventure"], publisher: "Brightwick Press", issues: 6, have: 6 },
  ];
  COMICS.forEach((c, ci) => {
    const parent = addCollectionParent({ type: "comic", root: "comic", t: c.t, y: 2019 + ci, ov: `${c.t}, published by ${c.publisher}.`, g: c.g, st: c.publisher, ext: { comicvine: String(55000 + ci) }, added: ago({ days: 55 - ci * 7 }), key: c.t, noBackdrop: true });
    parent.backdrop_url = null;
    const subs = [];
    for (let i = 1; i <= c.issues; i++) {
      const have = i <= c.have;
      const fp = have ? `${parent.path}/${safeName(c.t)} #${pad2(i)}.cbz` : null;
      const subId = addSub(parent, { title: `${c.t} #${i}`, rel: addDays(`${2019 + ci}-03-01`, (i - 1) * 30), extId: `cv-${ci}-${i}`, provider: "comicvine", have, quality: have ? "CBZ" : null, filePath: fp, size: Math.round((38 + r() * 30) * MB) });
      subs.push({ have });
    }
    finalizeParent(parent, subs);
  });

  // ROMs (single-shape games)
  const ROMS = [
    { t: "Turbo Tortoise Racing", y: 1996, sys: "Portable Classic", st: "Kiln Interactive", g: ["Racing"], size: 3.1 },
    { t: "Castle Quest Deluxe", y: 1992, sys: "Pocket Console", st: "Brightwick Games", g: ["Adventure", "RPG"], size: 1.4 },
    { t: "Pixel Fishing Club", y: 2001, sys: "Portable Classic", st: "Open Tide Games", g: ["Simulation"], size: 8.8 },
    { t: "Mega Maze Runner", y: 1994, sys: "Pocket Console", st: "Dunmore Interactive", g: ["Puzzle"], size: 0.6, have: false, ungrouped: true },
  ];
  ROMS.forEach((g, gi) => {
    const have = g.have !== false;
    const rootPath = ctx.roots.rom.path;
    const path = have ? `${rootPath}/${g.sys}/${safeName(g.t)} (${g.y}).zip` : null;
    const item = baseItem({ type: "rom", root: "rom", t: g.t, y: g.y, ov: `${g.t} (${g.y}) for the ${g.sys}.`, g: g.g, st: g.st, ext: { rawg: String(33000 + gi) }, path, added: ago({ days: 35 - gi * 6 }), rel: `${g.y}-06-01`, group: g.ungrouped ? null : ctx.groups[g.sys], extra: { platform: g.sys }, key: g.t, noBackdrop: false });
    item.has_file = have ? 1 : 0;
    item.status = have ? "downloaded" : "missing";
    item.size_bytes = have ? Math.round(g.size * MB) : null;
    if (have) out.files.push({ path, size: item.size_bytes });
  });

  // podcast (episodes straight from an RSS feed; the feed URL is an unreachable placeholder)
  {
    const parent = addCollectionParent({ type: "podcast", root: "podcast", t: "The Late Lantern Podcast", ov: "A weekly conversation about the stories behind the stories.", g: ["Society & Culture"], st: "Lantern Audio", ext: { itunes: "1500001", podcastFeed: "http://127.0.0.1:9/feed.xml" }, added: ago({ days: 27 }), key: "The Late Lantern Podcast", noBackdrop: true });
    parent.backdrop_url = null;
    const subs = [];
    const titles = ["The Lighthouse Episode", "Maps We Never Made", "On Being Underqualified", "A Brief History of Umbrellas", "Small Talk, Large Consequences", "Live From the Archive"];
    titles.forEach((ep, i) => {
      const have = i >= 2;
      const fp = have ? `${parent.path}/${pad2(i + 1)} - ${safeName(ep)}.mp3` : null;
      addSub(parent, { title: ep, rel: addDays("2026-08-30", i * 7), extId: `http://127.0.0.1:9/ep/${i + 1}.mp3`, provider: "rss", have, quality: have ? "MP3" : null, filePath: fp, size: Math.round((34 + r() * 20) * MB), info: have ? audioInfo("mp3", 128, 2, 2400 + i * 120) : null, ov: `Episode ${i + 1}.` });
      subs.push({ have });
    });
    finalizeParent(parent, subs);
  }

  // manga: chapters from MangaDex-style ids
  {
    const parent = addCollectionParent({ type: "manga", root: "manga", t: "Rin of the Seven Bridges", y: 2023, ov: "A courier crosses seven bridges, each guarded by a different promise.", g: ["Adventure", "Fantasy"], st: "Kiln Press", ext: { mangadex: hexId("mangadex-rin").slice(0, 36) }, added: ago({ days: 33 }), key: "Rin of the Seven Bridges", noBackdrop: false });
    const subs = [];
    for (let i = 1; i <= 8; i++) {
      const have = i <= 5;
      const fp = have ? `${parent.path}/Chapter ${pad2(i)}.cbz` : null;
      addSub(parent, { title: `Chapter ${i}`, rel: addDays("2023-04-01", (i - 1) * 14), extId: hexId("md-ch-" + i).slice(0, 36), provider: "mangadex", have, quality: have ? "CBZ" : null, filePath: fp, size: Math.round((18 + r() * 12) * MB) });
      subs.push({ have });
    }
    finalizeParent(parent, subs);
  }

  // online videos: a channel whose uploads are grabbed straight from the source (placeholder ids)
  {
    const parent = addCollectionParent({ type: "video", root: "video", t: "Workshop Wednesdays", ov: "A weekly maker channel: restoring furniture, building tiny boats and fixing things that were not broken.", g: ["Howto & Style"], st: "Workshop Wednesdays", ext: { youtube: "UCdemoWorkshop0000000001" }, added: ago({ days: 25 }), key: "Workshop Wednesdays", noBackdrop: true });
    parent.backdrop_url = null;
    const subs = [];
    ["Restoring a 1950s Workbench", "Building a Tiny Boat (Part 1)", "Building a Tiny Boat (Part 2)", "Sharpening Everything", "Shop Tour 2026"].forEach((v, i) => {
      const have = i !== 3;
      const fp = have ? `${parent.path}/${safeName(v)}.mp4` : null;
      addSub(parent, { title: v, rel: addDays("2026-08-12", i * 7), extId: `yt-demo-${i + 1}`, provider: "youtube", have, quality: have ? "WEBDL-1080p" : null, filePath: fp, size: Math.round((260 + r() * 400) * MB), info: have ? mediaInfoFor("WEBDL-1080p", 900 + i * 240, r) : null, cover: true, ov: `Upload ${i + 1}.` });
      subs.push({ have });
    });
    finalizeParent(parent, subs);
  }

  return out;
}
