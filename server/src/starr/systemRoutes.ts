import os from "node:os";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/errorHandler.js";
import { downloadClientFromRow, qualityProfileFromRow } from "../db/mappers.js";
import { getBuildInfo } from "../services/buildInfo.js";
import { getHealthReport } from "../services/healthReport.js";
import { getSetting } from "../services/settingsStore.js";
import { withAppUrlBase } from "../services/urlBase.js";
import { statfsAsync } from "../services/fsAsync.js";
import { callNative } from "./native.js";
import { typeFilter } from "./apps.js";
import type { StarrRoutes } from "./router.js";
import { loadQualityCatalog, numericId, qualityNameOf } from "./shapes.js";

const STATFS_TIMEOUT_MS = 5000;

/** Free and total bytes of a path; nulls when the mount does not answer. */
async function spaceOf(path: string): Promise<{ freeSpace: number | null; totalSpace: number | null }> {
  const stat = await statfsAsync(path, STATFS_TIMEOUT_MS).catch(() => null);
  if (!stat) return { freeSpace: null, totalSpace: null };
  // bavail, not bfree: the server runs unprivileged and cannot use the blocks reserved for root.
  return { freeSpace: stat.bavail * stat.bsize, totalSpace: stat.blocks * stat.bsize };
}

const LANGUAGES = [
  { id: -1, name: "Any" },
  { id: 0, name: "Unknown" },
  { id: 1, name: "English" },
  { id: 2, name: "French" },
  { id: 3, name: "Spanish" },
  { id: 4, name: "German" },
  { id: 5, name: "Italian" },
  { id: 6, name: "Danish" },
  { id: 7, name: "Dutch" },
  { id: 8, name: "Japanese" },
  { id: 9, name: "Icelandic" },
  { id: 10, name: "Chinese" },
  { id: 11, name: "Russian" },
  { id: 12, name: "Polish" },
  { id: 13, name: "Vietnamese" },
  { id: 14, name: "Swedish" },
  { id: 15, name: "Norwegian" },
  { id: 16, name: "Finnish" },
  { id: 17, name: "Turkish" },
  { id: 18, name: "Portuguese" },
  { id: 19, name: "Flemish" },
  { id: 20, name: "Greek" },
  { id: 21, name: "Korean" },
  { id: 22, name: "Hungarian" },
  { id: 23, name: "Hebrew" },
  { id: 24, name: "Lithuanian" },
  { id: 25, name: "Czech" },
  { id: 26, name: "Hindi" },
  { id: 27, name: "Romanian" },
  { id: 28, name: "Thai" },
  { id: 29, name: "Bulgarian" },
  { id: 30, name: "Portuguese (Brazil)" },
  { id: 31, name: "Arabic" },
  { id: 32, name: "Ukrainian" },
  { id: 33, name: "Persian" },
  { id: 34, name: "Bengali" },
  { id: 35, name: "Slovak" },
  { id: 36, name: "Latvian" },
  { id: 37, name: "Spanish (Latino)" },
  { id: 38, name: "Catalan" },
  { id: 39, name: "Croatian" },
  { id: 40, name: "Serbian" },
  { id: 41, name: "Bosnian" },
  { id: 42, name: "Estonian" },
  { id: 43, name: "Tamil" },
  { id: 44, name: "Indonesian" },
  { id: 45, name: "Telugu" },
  { id: 46, name: "Macedonian" },
  { id: 47, name: "Slovenian" },
  { id: 48, name: "Malayalam" },
  { id: 49, name: "Kannada" },
  { id: 50, name: "Albanian" },
  { id: 51, name: "Afrikaans" },
];

const CLIENT_IMPLEMENTATIONS: Record<string, string> = {
  qbittorrent: "QBittorrent",
  sabnzbd: "Sabnzbd",
  nzbget: "Nzbget",
  transmission: "Transmission",
  deluge: "Deluge",
  realdebrid: "RealDebrid",
  alldebrid: "AllDebrid",
  torbox: "TorBox",
  blackhole: "TorrentBlackhole",
  http: "DirectHttp",
  ytdlp: "YtDlp",
  slskd: "Slskd",
};

function clientProtocol(type: string): "usenet" | "torrent" {
  return type === "sabnzbd" || type === "nzbget" ? "usenet" : "torrent";
}

export function downloadClientResource(row: unknown) {
  const client = downloadClientFromRow(row);
  const implementation = CLIENT_IMPLEMENTATIONS[client.type] ?? client.type;
  return {
    id: Number(client.id),
    name: client.name,
    // Credentials are not part of a Starr read here: a dashboard needs the name, kind and state.
    fields: [
      { order: 0, name: "host", label: "Host", value: client.host ?? "", type: "textbox" },
      { order: 1, name: "port", label: "Port", value: client.port ?? 0, type: "number" },
      { order: 2, name: "useSsl", label: "Use SSL", value: !!Number(client.useSsl), type: "checkbox" },
      { order: 3, name: "category", label: "Category", value: client.category ?? "", type: "textbox" },
    ],
    implementationName: implementation,
    implementation,
    configContract: `${implementation}Settings`,
    infoLink: "",
    tags: client.tagIds ?? [],
    enable: !!Number(client.enabled),
    protocol: clientProtocol(client.type),
    priority: client.priority,
    removeCompletedDownloads: getSetting("removeCompletedDownloads") !== "0",
    removeFailedDownloads: getSetting("removeFailedDownloads") !== "0",
  };
}

export function registerSystemRoutes(r: StarrRoutes): void {
  const app = r.app;

  r.get("/system/status", `${app.appName} status`, async (req) => {
    const build = await getBuildInfo();
    const platform = os.platform();
    return {
      appName: app.appName,
      instanceName: "AoNarr",
      version: app.claimedVersion,
      aonarrVersion: build.appVersion,
      buildTime: build.buildTime ?? build.startedAt,
      isDebug: false,
      isProduction: true,
      isAdmin: false,
      isUserInteractive: false,
      startupPath: process.cwd(),
      appData: process.cwd(),
      osName: platform,
      osVersion: os.release(),
      isNetCore: true,
      isLinux: platform === "linux",
      isOsx: platform === "darwin",
      isWindows: platform === "win32",
      isDocker: build.docker,
      mode: "console",
      branch: "main",
      databaseType: build.databaseType,
      databaseVersion: build.databaseVersion ?? "",
      authentication: getSetting("authRequired") === "0" ? "none" : "forms",
      migrationVersion: 0,
      // A tool's URL base for this app: /sonarr, or /aonarr/sonarr when AoNarr is served under URL_BASE.
      urlBase: withAppUrlBase(`/${app.key}`),
      runtimeVersion: process.versions.node,
      runtimeName: "node",
      startTime: build.startedAt,
      packageVersion: build.appVersion,
      packageAuthor: "AoNarr",
      packageUpdateMechanism: "docker",
    };
  });

  r.get("/health", `${app.appName} health checks`, async (req) => {
    const report = await getHealthReport({ refresh: req.query.refresh === "1" });
    return report.issues.map((issue) => ({
      source: issue.source,
      type: issue.severity === "error" ? "error" : "warning",
      message: issue.message,
      wikiUrl: "",
    }));
  });

  r.get("/diskspace", "Free space of every root folder", async () => {
    const f = typeFilter(app, "media_type");
    const folders = (await db.prepare(`SELECT path, name FROM root_folders WHERE ${f.sql}`).all(...f.params)) as { path: string; name: string | null }[];
    const out = [];
    for (const folder of folders) {
      const space = await spaceOf(folder.path);
      if (space.totalSpace == null) continue;
      out.push({ path: folder.path, label: folder.name ?? "", freeSpace: space.freeSpace, totalSpace: space.totalSpace });
    }
    return out;
  });

  const rootFolder = async (row: any) => {
    const space = await spaceOf(row.path);
    return {
      id: Number(row.id),
      path: row.path,
      name: row.name ?? undefined,
      accessible: space.totalSpace != null,
      freeSpace: space.freeSpace ?? 0,
      totalSpace: space.totalSpace ?? 0,
      unmappedFolders: [],
      ...(row.default_quality_profile_id != null ? { defaultQualityProfileId: Number(row.default_quality_profile_id) } : {}),
      ...(row.default_metadata_profile_id != null ? { defaultMetadataProfileId: Number(row.default_metadata_profile_id) } : {}),
    };
  };
  r.get("/rootfolder", "Root folders of this app's library types", async () => {
    const f = typeFilter(app, "media_type");
    const rows = await db.prepare(`SELECT * FROM root_folders WHERE ${f.sql} ORDER BY id`).all(...f.params);
    return Promise.all(rows.map(rootFolder));
  });
  r.get("/rootfolder/:id", "One root folder", async (req) => {
    const f = typeFilter(app, "media_type");
    const row = await db.prepare(`SELECT * FROM root_folders WHERE id = ? AND ${f.sql}`).get(numericId(req.params.id), ...f.params);
    if (!row) throw new HttpError(404, "NotFound");
    return rootFolder(row);
  });

  // Tags are shared by every app: the same label is the same tag.
  const tagResource = (row: any) => ({ id: Number(row.id), label: String(row.name) });
  r.get("/tag", "Tags", async () => (await db.prepare("SELECT * FROM tags ORDER BY name").all()).map(tagResource));
  r.get("/tag/:id", "One tag", async (req) => {
    const row = await db.prepare("SELECT * FROM tags WHERE id = ?").get(numericId(req.params.id));
    if (!row) throw new HttpError(404, "NotFound");
    return tagResource(row);
  });
  r.post("/tag", "Add a tag", async (req) => {
    const label = String(req.body?.label ?? "").trim();
    if (!label) throw new HttpError(400, "label is required");
    const created = await callNative(req.app, "POST", "/api/tags", { name: label });
    return tagResource({ id: created.body.id, name: created.body.name });
  });
  r.put("/tag/:id", "Rename a tag", async (req) => {
    const id = numericId(req.params.id);
    const label = String(req.body?.label ?? "").trim();
    if (!label) throw new HttpError(400, "label is required");
    const clash = await db.prepare("SELECT id FROM tags WHERE name = ? AND id <> ?").get(label, id);
    if (clash) throw new HttpError(400, "A tag with this label already exists");
    const result = await db.prepare("UPDATE tags SET name = ? WHERE id = ?").run(label, id);
    if (result.changes === 0) throw new HttpError(404, "NotFound");
    return tagResource({ id, name: label });
  });
  r.delete("/tag/:id", "Delete a tag", async (req) => {
    await callNative(req.app, "DELETE", `/api/tags/${numericId(req.params.id)}`);
    return {};
  });

  const profileResource = async (row: any, catalog: Awaited<ReturnType<typeof loadQualityCatalog>>) => {
    const profile = qualityProfileFromRow(row);
    const allowed = new Set<string>(profile.allowedQualities);
    return {
      id: Number(profile.id),
      name: profile.name,
      upgradeAllowed: profile.upgradeAllowed,
      cutoff: catalog.byName.get(profile.cutoff)?.id ?? 0,
      items: catalog.ordered.map((q) => ({ quality: qualityNameOf(catalog, q.name), items: [], allowed: allowed.has(q.name) })),
      minFormatScore: profile.minFormatScore,
      cutoffFormatScore: profile.cutoffFormatScore,
      minUpgradeFormatScore: profile.minUpgradeFormatScore,
      formatItems: [],
      ...(app.key === "radarr" ? { language: { id: -1, name: "Any" } } : {}),
    };
  };
  r.get("/qualityprofile", "Quality profiles", async () => {
    const catalog = await loadQualityCatalog();
    const rows = await db.prepare("SELECT * FROM quality_profiles ORDER BY id").all();
    return Promise.all(rows.map((row) => profileResource(row, catalog)));
  });
  r.get("/qualityprofile/:id", "One quality profile", async (req) => {
    const row = await db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(numericId(req.params.id));
    if (!row) throw new HttpError(404, "NotFound");
    return profileResource(row, await loadQualityCatalog());
  });

  if (app.key === "sonarr") {
    // AoNarr has no language profiles; Overseerr asks for one when it adds a series, so there is a profile that means "any".
    const anyProfile = {
      id: 1,
      name: "Any",
      upgradeAllowed: false,
      cutoff: { id: -1, name: "Any" },
      languages: LANGUAGES.slice(0, 1).map((language) => ({ language, allowed: true })),
    };
    r.get("/languageprofile", "Language profiles (a single profile that allows any language)", () => [anyProfile]);
    r.get("/languageprofile/:id", "One language profile", (req) => {
      if (Number(req.params.id) !== 1) throw new HttpError(404, "NotFound");
      return anyProfile;
    });
  }
  if (app.key === "sonarr" || app.key === "radarr") {
    r.get("/language", "Languages", () => LANGUAGES.map((l) => ({ ...l, nameLower: l.name.toLowerCase() })));
  }

  if (app.key === "lidarr" || app.key === "readarr") {
    const metadataResource = (row: any) => ({
      id: Number(row.id),
      name: String(row.name),
      ...(app.key === "readarr"
        ? { minPopularity: 0, skipMissingDate: !!Number(row.skip_missing_date), skipMissingIsbn: false, skipPartsAndSets: !!Number(row.skip_sets), skipSeriesSecondary: false, allowedLanguages: "", minPages: 0, ignored: [] }
        : { primaryAlbumTypes: parseList(row.primary_types), secondaryAlbumTypes: parseList(row.excluded_secondary_types), releaseStatuses: [] }),
    });
    r.get("/metadataprofile", "Metadata profiles", async () => (await db.prepare("SELECT * FROM metadata_profiles ORDER BY id").all()).map(metadataResource));
    r.get("/metadataprofile/:id", "One metadata profile", async (req) => {
      const row = await db.prepare("SELECT * FROM metadata_profiles WHERE id = ?").get(numericId(req.params.id));
      if (!row) throw new HttpError(404, "NotFound");
      return metadataResource(row);
    });
  }

  r.get("/downloadclient", "Download clients", async () => (await db.prepare("SELECT * FROM download_clients ORDER BY id").all()).map(downloadClientResource));
  r.get("/downloadclient/:id", "One download client", async (req) => {
    const row = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(numericId(req.params.id));
    if (!row) throw new HttpError(404, "NotFound");
    return downloadClientResource(row);
  });
}

function parseList(raw: unknown): string[] {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}
