import { db } from "../db/index.js";
import { HttpError } from "../middleware/errorHandler.js";
import { indexerFromRow } from "../db/mappers.js";
import { checkIndexerHealth } from "../services/indexerClient.js";
import { mediaTypesForCategories } from "../services/indexerCategories.js";
import { parseIndexerConfig } from "../services/prowlarrSync.js";
import { callNative } from "./native.js";
import { type StarrApp } from "./apps.js";
import { flag, numericId, validationFailure } from "./shapes.js";
import type { StarrRoutes } from "./router.js";

/**
 * Indexers pushed by Prowlarr ("Applications" in Prowlarr). A pushed indexer is an ordinary AoNarr indexer; its config says
 * which of the four virtual apps hold it (`starrApps`) and keeps, per app, the settings exactly as Prowlarr sent them
 * (`starrFields`), so each app lists only what was pushed to it and hands the same values back. Prowlarr compares what it
 * would push with what it reads back and edits the indexer when they differ; a value AoNarr changed on the way would be
 * edited again at every sync. The same Prowlarr indexer pushed to Sonarr and to Radarr is one row serving both.
 *
 * Indexers the admin added by hand or pulled from Prowlarr are not listed, and are never taken over: Prowlarr removes what
 * it finds under its own address that it does not know, and a push would otherwise rename, re-key and later delete them.
 */

/** What Prowlarr shows in place of a key it was not allowed to read, and accepts back in place of the real one. */
export const MASKED_KEY = "********";

type Field = { order: number; name: string; label: string; value: unknown; type: string; advanced?: boolean; helpText?: string; privacy?: string; selectOptions?: unknown[] };

function field(order: number, name: string, label: string, type: string, value: unknown, extra: Partial<Field> = {}): Field {
  return { order, name, label, value, type, advanced: false, ...extra };
}

/** The settings a Newznab or Torznab indexer of this app takes, with their default values. */
function schemaFields(app: StarrApp, protocol: "usenet" | "torrent"): Field[] {
  const fields: Field[] = [
    field(0, "baseUrl", "URL", "textbox", ""),
    field(1, "apiPath", "API Path", "textbox", "/api", { advanced: true }),
    field(2, "apiKey", "API Key", "textbox", "", { privacy: "apiKey" }),
    field(3, "categories", "Categories", "select", defaultCategories(app), { selectOptions: [] }),
  ];
  let order = 4;
  if (app.key === "sonarr") {
    fields.push(field(order++, "animeCategories", "Anime Categories", "select", [5070], { advanced: true, selectOptions: [] }));
    fields.push(field(order++, "animeStandardFormatSearch", "Anime Standard Format Search", "checkbox", false, { advanced: true }));
  }
  fields.push(field(order++, "additionalParameters", "Additional Parameters", "textbox", "", { advanced: true }));
  if (protocol === "torrent") {
    fields.push(field(order++, "minimumSeeders", "Minimum Seeders", "number", 1, { advanced: true }));
    fields.push(field(order++, "seedCriteria.seedRatio", "Seed Ratio", "number", null, { advanced: true }));
    fields.push(field(order++, "seedCriteria.seedTime", "Seed Time", "number", null, { advanced: true }));
    if (app.key === "sonarr") fields.push(field(order++, "seedCriteria.seasonPackSeedTime", "Season-Pack Seed Time", "number", null, { advanced: true }));
    if (app.key === "lidarr" || app.key === "readarr") fields.push(field(order++, "seedCriteria.discographySeedTime", "Discography Seed Time", "number", null, { advanced: true }));
    fields.push(field(order++, "rejectBlocklistedTorrentHashesWhileGrabbing", "Reject Blocklisted Torrent Hashes While Grabbing", "checkbox", false, { advanced: true }));
  }
  return fields;
}

function defaultCategories(app: StarrApp): number[] {
  switch (app.key) {
    case "sonarr":
      return [5030, 5040];
    case "radarr":
      return [2000];
    case "lidarr":
      return [3000];
    case "readarr":
      return [7000, 3030];
  }
}

function implementationOf(protocol: "usenet" | "torrent"): { implementation: string; configContract: string; infoLink: string } {
  const implementation = protocol === "usenet" ? "Newznab" : "Torznab";
  return { implementation, configContract: `${implementation}Settings`, infoLink: "" };
}

function schemaResource(app: StarrApp, protocol: "usenet" | "torrent") {
  const { implementation, configContract, infoLink } = implementationOf(protocol);
  return {
    id: 0,
    name: "",
    fields: schemaFields(app, protocol),
    implementationName: implementation,
    implementation,
    configContract,
    infoLink,
    tags: [],
    enableRss: true,
    enableAutomaticSearch: true,
    enableInteractiveSearch: true,
    supportsRss: true,
    supportsSearch: true,
    protocol,
    priority: 25,
    downloadClientId: 0,
    presets: [],
  };
}

// --- what Prowlarr pushed, kept per app ------------------------------------------------------------------------------

/** The settings of a push that AoNarr has no column for or stores in another shape, as Prowlarr sent them. */
interface PushedFields {
  baseUrl: string;
  apiPath: string;
  categories: number[];
  animeCategories: number[];
  animeStandardFormatSearch: boolean;
  additionalParameters: string;
  seasonPackSeedTime: number | null;
  discographySeedTime: number | null;
  rejectBlocklisted: boolean;
  /** The library types this app's categories name; the row serves the union over its apps. */
  mediaTypes: string[];
}

function appsOf(config: unknown): string[] {
  const apps = parseIndexerConfig(config).starrApps;
  return Array.isArray(apps) ? apps.map(String) : [];
}

function pushedFieldsOf(config: unknown): Record<string, PushedFields> {
  const stored = parseIndexerConfig(config).starrFields;
  return stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, PushedFields>) : {};
}

function categoryList(raw: unknown): number[] {
  return [...new Set(String(raw ?? "").split(",").map((c) => Number(c.trim())).filter((n) => Number.isInteger(n) && n > 0))];
}

const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((n) => b.includes(n));

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
}

function unionOfCategories(all: Record<string, PushedFields>): number[] {
  return [...new Set(Object.values(all).flatMap((f) => [...(f.categories ?? []), ...(f.animeCategories ?? [])]))];
}

/** What the app reports for a row: Prowlarr's own values where the admin has not changed the row since, else AoNarr's. */
function fieldValues(app: StarrApp, row: any): Record<string, unknown> {
  const indexer = indexerFromRow(row);
  const all = pushedFieldsOf(indexer.config);
  const stored = all[app.key];
  const column = categoryList(indexer.categories);
  // The categories column is the union over the apps; edited since the push, it is the admin's list and is shown as it is.
  const categoriesKept = !!stored && sameSet(column, unionOfCategories(all));
  return {
    baseUrl: stored && sameUrl(stored.baseUrl, indexer.url) ? stored.baseUrl : indexer.url,
    apiPath: stored?.apiPath ?? "/api",
    apiKey: indexer.apiKey ? MASKED_KEY : "",
    categories: categoriesKept ? stored.categories : column.length > 0 ? column : defaultCategories(app),
    animeCategories: categoriesKept ? stored.animeCategories : [],
    animeStandardFormatSearch: stored?.animeStandardFormatSearch ?? false,
    additionalParameters: stored?.additionalParameters ?? "",
    minimumSeeders: indexer.minimumSeeders,
    "seedCriteria.seedRatio": indexer.seedRatio,
    "seedCriteria.seedTime": indexer.seedTimeMinutes,
    "seedCriteria.seasonPackSeedTime": stored?.seasonPackSeedTime ?? null,
    "seedCriteria.discographySeedTime": stored?.discographySeedTime ?? null,
    rejectBlocklistedTorrentHashesWhileGrabbing: stored?.rejectBlocklisted ?? false,
  };
}

function indexerResource(app: StarrApp, row: any) {
  const indexer = indexerFromRow(row);
  const protocol: "usenet" | "torrent" = indexer.protocol === "newznab" ? "usenet" : "torrent";
  const values = fieldValues(app, row);
  const fields = schemaFields(app, protocol).map((f) => ({ ...f, value: f.name in values ? values[f.name] : f.value }));
  return {
    ...schemaResource(app, protocol),
    id: Number(indexer.id),
    name: indexer.name,
    fields,
    tags: indexer.tagIds ?? [],
    enableRss: !!Number(indexer.enableRss),
    enableAutomaticSearch: !!Number(indexer.enableAutomaticSearch),
    enableInteractiveSearch: !!Number(indexer.enableInteractiveSearch),
    protocol,
    priority: indexer.priority,
    downloadClientId: indexer.downloadClientId ?? 0,
  };
}

// --- reading a push -----------------------------------------------------------------------------------------------------

interface ParsedPush {
  name: string;
  protocol: "newznab" | "torznab";
  url: string;
  apiKey: string;
  fields: PushedFields;
  minimumSeeders: number | undefined;
  seedRatio: number | null | undefined;
  seedTimeMinutes: number | null | undefined;
  enableRss: boolean;
  enableAutomaticSearch: boolean;
  enableInteractiveSearch: boolean;
  priority: number;
  tagIds: number[];
  downloadClientId: number | null;
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function numberList(value: unknown): number[] {
  const list = Array.isArray(value) ? value : value == null || value === "" ? [] : String(value).split(",");
  return [...new Set(list.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
}

/** The library types this push is for: those its categories name, kept to the app's own types. */
function typesOfPush(app: StarrApp, categories: number[], animeCategories: number[]): string[] {
  const named = mediaTypesForCategories([...categories, ...animeCategories]) ?? [];
  const mine = named.filter((t) => app.types.includes(t));
  return mine.length > 0 ? mine : [...app.types];
}

function parsePush(app: StarrApp, body: any): ParsedPush {
  const implementation = String(body?.implementation ?? "");
  const protocol = /^newznab$/i.test(implementation) ? "newznab" : /^torznab$/i.test(implementation) ? "torznab" : null;
  if (!protocol) throw validationFailure([{ propertyName: "Implementation", errorMessage: `AoNarr takes Newznab and Torznab indexers, not "${implementation || "(none)"}"` }]);
  const named = new Map<string, unknown>((Array.isArray(body?.fields) ? body.fields : []).map((f: any) => [String(f?.name), f?.value]));
  const baseUrl = String(named.get("baseUrl") ?? "").trim();
  if (!/^https?:\/\//i.test(baseUrl)) throw validationFailure([{ propertyName: "BaseUrl", errorMessage: "URL must start with http:// or https://" }]);
  const apiPath = String(named.get("apiPath") ?? "/api").trim() || "/api";
  // The indexer client adds /api itself; a path that ends in it is the usual case, and anything else cannot be reached.
  if (!/\/api\/?$/.test(apiPath)) throw validationFailure([{ propertyName: "ApiPath", errorMessage: "AoNarr reaches an indexer at its /api path" }]);
  const name = String(body?.name ?? "").trim();
  if (!name) throw validationFailure([{ propertyName: "Name", errorMessage: "Name is required" }]);
  const categories = numberList(named.get("categories"));
  const animeCategories = numberList(named.get("animeCategories"));
  const minimum = numberOrNull(named.get("minimumSeeders"));
  const prefix = apiPath.replace(/\/+$/, "").replace(/\/api$/, "");
  return {
    name,
    protocol,
    url: `${baseUrl.replace(/\/+$/, "")}${prefix}`,
    apiKey: String(named.get("apiKey") ?? ""),
    fields: {
      baseUrl,
      apiPath,
      categories,
      animeCategories,
      animeStandardFormatSearch: named.get("animeStandardFormatSearch") === true,
      additionalParameters: String(named.get("additionalParameters") ?? ""),
      seasonPackSeedTime: numberOrNull(named.get("seedCriteria.seasonPackSeedTime")) ?? null,
      discographySeedTime: numberOrNull(named.get("seedCriteria.discographySeedTime")) ?? null,
      rejectBlocklisted: named.get("rejectBlocklistedTorrentHashesWhileGrabbing") === true,
      mediaTypes: typesOfPush(app, categories, animeCategories),
    },
    minimumSeeders: minimum === null ? 0 : minimum,
    seedRatio: numberOrNull(named.get("seedCriteria.seedRatio")),
    seedTimeMinutes: numberOrNull(named.get("seedCriteria.seedTime")),
    enableRss: body?.enableRss !== false,
    enableAutomaticSearch: body?.enableAutomaticSearch !== false,
    enableInteractiveSearch: body?.enableInteractiveSearch !== false,
    priority: Number.isInteger(Number(body?.priority)) && Number(body.priority) >= 1 ? Math.min(50, Number(body.priority)) : 25,
    tagIds: numberList(body?.tags),
    downloadClientId: Number(body?.downloadClientId) > 0 ? Number(body.downloadClientId) : null,
  };
}

async function existingTagIds(ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = (await db.prepare("SELECT id FROM tags").all()) as { id: number }[];
  const known = new Set(rows.map((r) => Number(r.id)));
  return ids.filter((id) => known.has(id));
}

async function probe(push: ParsedPush, apiKeyFallback?: string): Promise<void> {
  const apiKey = push.apiKey && push.apiKey !== MASKED_KEY ? push.apiKey : apiKeyFallback ?? "";
  const result = await checkIndexerHealth({ id: 0, name: push.name, protocol: push.protocol, url: push.url, apiKey, categories: "", mediaTypes: "", enabled: 1, priority: 25 } as any);
  if (!result.ok) throw validationFailure([{ propertyName: "BaseUrl", errorMessage: `Unable to connect to indexer: ${result.error ?? "no answer"}` }]);
}

// --- writing a push ---------------------------------------------------------------------------------------------------

/**
 * Stores a push for this app: a new row, or the row this app (or another app, for the same indexer) already holds. AoNarr's
 * own routes make the change when a setting AoNarr acts on changed; a push that only repeats what the row already says
 * touches nothing but the record of what Prowlarr sent, so a sync that re-sends every indexer does not reset the searches'
 * back-off each time.
 */
async function storePush(req: any, app: StarrApp, push: ParsedPush, existing: any | null, authoritative: boolean): Promise<number> {
  const tagIds = await existingTagIds(push.tagIds);
  const config = parseIndexerConfig(existing?.config);
  const apps = [...new Set([...appsOf(existing?.config), app.key])];
  const fieldsByApp = { ...pushedFieldsOf(existing?.config), [app.key]: push.fields };
  const nextConfig = { ...config, starrApps: apps, starrFields: fieldsByApp };
  const union = unionOfCategories(fieldsByApp);
  const kept = existing ? String(existing.media_types ?? "").split(",").filter((t) => t && !app.types.includes(t)) : [];
  const types = [...new Set([...kept, ...push.fields.mediaTypes])];

  if (!existing) {
    const created = await callNative(req.app, "POST", "/api/indexers", {
      name: push.name,
      protocol: push.protocol,
      url: push.url,
      apiKey: push.apiKey,
      categories: union.join(","),
      mediaTypes: types.join(","),
      enabled: true,
      priority: push.priority,
      minimumSeeders: push.minimumSeeders ?? (push.protocol === "torznab" ? 1 : 0),
      enableRss: push.enableRss,
      enableAutomaticSearch: push.enableAutomaticSearch,
      enableInteractiveSearch: push.enableInteractiveSearch,
      seedRatio: push.seedRatio,
      seedTimeMinutes: push.seedTimeMinutes,
      downloadClientId: push.downloadClientId,
      tagIds: tagIds.length > 0 ? tagIds : null,
      config: nextConfig,
    });
    return Number(created.body.id);
  }

  const current = indexerFromRow(existing);
  // Another app's push of the same indexer, or a repeat, says nothing about tags and the download client: they stay.
  const wantedTags = authoritative || tagIds.length > 0 ? tagIds : current.tagIds ?? [];
  const wantedClient = authoritative || push.downloadClientId !== null ? push.downloadClientId : current.downloadClientId;
  const apiKey = push.apiKey && push.apiKey !== MASKED_KEY ? push.apiKey : current.apiKey ?? "";
  const changes: Record<string, unknown> = {};
  const note = (key: string, differs: boolean, value: unknown) => {
    if (differs) changes[key] = value;
  };
  note("name", push.name !== current.name, push.name);
  note("protocol", push.protocol !== current.protocol, push.protocol);
  note("url", push.url !== current.url, push.url);
  note("apiKey", apiKey !== (current.apiKey ?? ""), apiKey);
  note("categories", !sameSet(union, categoryList(current.categories)), union.join(","));
  note("mediaTypes", [...types].sort().join(",") !== String(current.mediaTypes ?? "").split(",").filter(Boolean).sort().join(","), types.join(","));
  note("priority", authoritative && push.priority !== current.priority, push.priority);
  note("minimumSeeders", (push.minimumSeeders ?? 0) !== current.minimumSeeders, push.minimumSeeders ?? 0);
  note("enableRss", push.enableRss !== !!Number(current.enableRss), push.enableRss);
  note("enableAutomaticSearch", push.enableAutomaticSearch !== !!Number(current.enableAutomaticSearch), push.enableAutomaticSearch);
  note("enableInteractiveSearch", push.enableInteractiveSearch !== !!Number(current.enableInteractiveSearch), push.enableInteractiveSearch);
  note("seedRatio", (push.seedRatio ?? null) !== current.seedRatio, push.seedRatio ?? null);
  note("seedTimeMinutes", (push.seedTimeMinutes ?? null) !== current.seedTimeMinutes, push.seedTimeMinutes ?? null);
  note("downloadClientId", (wantedClient ?? null) !== (current.downloadClientId ?? null), wantedClient ?? null);
  note("tagIds", [...wantedTags].sort().join(",") !== [...(current.tagIds ?? [])].sort().join(","), wantedTags.length > 0 ? wantedTags : null);

  const configChanged = JSON.stringify(nextConfig) !== JSON.stringify(config);
  if (Object.keys(changes).length > 0) {
    await callNative(req.app, "PATCH", `/api/indexers/${existing.id}`, { ...changes, config: nextConfig });
  } else if (configChanged) {
    // Only the record of what Prowlarr sent: written directly, so the searches' back-off stays as it is.
    await db.prepare("UPDATE indexers SET config = ? WHERE id = ?").run(JSON.stringify(nextConfig), existing.id);
  }
  return Number(existing.id);
}

export function registerIndexerRoutes(r: StarrRoutes): void {
  const app = r.app;

  r.get("/indexer/schema", "Settings of the indexers AoNarr takes (Newznab and Torznab)", () => [schemaResource(app, "usenet"), schemaResource(app, "torrent")]);

  const allRows = async () => (await db.prepare("SELECT * FROM indexers ORDER BY id").all()) as any[];
  const mine = async () => (await allRows()).filter((row) => appsOf(row.config).includes(app.key));
  const fresh = async (id: number) => indexerResource(app, (await db.prepare("SELECT * FROM indexers WHERE id = ?").get(id)) as any);

  r.get("/indexer", "Indexers pushed to this app", async () => (await mine()).map((row) => indexerResource(app, row)));
  r.get("/indexer/:id", "One pushed indexer", async (req) => {
    const row = (await mine()).find((x) => Number(x.id) === numericId(req.params.id));
    if (!row) throw new HttpError(404, "NotFound");
    return indexerResource(app, row);
  });

  r.post("/indexer/test", "Test an indexer without saving it", async (req) => {
    const push = parsePush(app, req.body);
    // An edit of an indexer AoNarr holds is tested with the key it has, as the key Prowlarr reads back is masked.
    const known = Number(req.body?.id) > 0 ? (await mine()).find((x) => Number(x.id) === Number(req.body.id)) : undefined;
    await probe(push, known ? indexerFromRow(known).apiKey ?? "" : undefined);
    return {};
  }, 200);

  r.post("/indexer", "Add an indexer (Prowlarr push)", async (req) => {
    const push = parsePush(app, req.body);
    if (!flag(req.query.forceSave)) await probe(push);
    const rows = await allRows();
    const sameAddress = rows.find((row) => sameUrl(String(row.url), push.url));
    // The same indexer pushed to another app is one row. A row that was not pushed (one the admin added, or pulled from
    // Prowlarr by AoNarr itself) is not taken over: it would be renamed, re-keyed and later deleted along with the push.
    if (sameAddress && appsOf(sameAddress.config).length === 0) {
      throw validationFailure([{ propertyName: "BaseUrl", errorMessage: `AoNarr already has an indexer at this address ("${sameAddress.name}"). Remove it, or stop pulling it from Prowlarr, before Prowlarr pushes it.` }]);
    }
    return fresh(await storePush(req, app, push, sameAddress ?? null, false));
  });

  r.put("/indexer/:id", "Edit a pushed indexer", async (req) => {
    const id = numericId(req.params.id);
    const row = (await mine()).find((x) => Number(x.id) === id);
    if (!row) throw new HttpError(404, "NotFound");
    const push = parsePush(app, req.body);
    if (!flag(req.query.forceSave)) await probe(push, indexerFromRow(row).apiKey ?? "");
    await storePush(req, app, push, row, true);
    return fresh(id);
  });

  r.delete("/indexer/:id", "Remove a pushed indexer", async (req) => {
    const id = numericId(req.params.id);
    const row = (await mine()).find((x) => Number(x.id) === id);
    if (!row) throw new HttpError(404, "NotFound");
    const apps = appsOf(row.config).filter((a) => a !== app.key);
    if (apps.length === 0) {
      await callNative(req.app, "DELETE", `/api/indexers/${id}`);
    } else {
      // Still pushed to another app: only this app's share goes.
      const fields = pushedFieldsOf(row.config);
      delete fields[app.key];
      const mediaTypes = String(row.media_types ?? "")
        .split(",")
        .filter((t) => t && !app.types.includes(t));
      await callNative(req.app, "PATCH", `/api/indexers/${id}`, {
        categories: unionOfCategories(fields).join(","),
        mediaTypes: mediaTypes.join(","),
        config: { ...parseIndexerConfig(row.config), starrApps: apps, starrFields: fields },
      });
    }
    return {};
  });
}
