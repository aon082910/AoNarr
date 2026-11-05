import { Router } from "express";
import { clientIp, requireAdmin } from "../middleware/auth.js";
import crypto from "node:crypto";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { invalidateQualityRankCache, parseQualityGroups, parseQualityOrder, reconcileQualityOrder } from "../services/quality.js";
import { buildOtpauthUrl, generateBase32Secret, verifyTotp } from "../services/totp.js";
import { getSetting, setSetting, deleteSetting, getAllSettings } from "../services/settingsStore.js";
import { applySocksProxySetting, verifyOutboundDispatcher } from "../services/socksProxy.js";
import { isKnownSettingKey, settingValueProblem, suggestSettingKey } from "../services/settingsRegistry.js";
import { sendTestNotification } from "../services/notifications.js";
import { fetchWatchedFiles, getMediaServerConfig } from "../services/mediaServer.js";
import { checkRateLimit, recordFailure, recordSuccess } from "../services/rateLimiter.js";
import { normalizeProfileLanguage } from "../services/profileLanguage.js";
import { auditActor, logAuditEvent } from "../services/audit.js";

export const settingsRouter = Router();
settingsRouter.use(requireAdmin);

/** Settings rows that hold the server's own working state, kept out of GET /settings. */
const INTERNAL_STATE_KEYS = ["deletedFilePendingUnmonitor", "albumBackfillEmpty"];

/** Settings that change how outbound requests are made, so the dispatcher is rebuilt when one is written. */
const NETWORK_SETTING_KEYS = new Set(["socks5ProxyUrl", "tlsRejectUnauthorized", "proxyBypassLocal", "proxyBypassFilter"]);

settingsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    // Never echo the live TOTP secret back — unlike other stored credentials here (an SMTP
    // password, an indexer API key), this one exists specifically to survive a compromise of the
    // admin's own session/API key. Exposing it through the generic settings dump would silently
    // defeat that guarantee; the dedicated /totp/* endpoints below only ever verify a code against
    // it, never return it once set.
    const { totpSecret: _totpSecret, totpPendingSecret: _totpPendingSecret, ...safeSettings } = getAllSettings();
    // State the server keeps for itself (every cleared row id of the deleted-file job, the album backfill memory) is
    // not a setting the page shows, and can be large.
    for (const key of INTERNAL_STATE_KEYS) delete (safeSettings as Record<string, string>)[key];
    res.json(safeSettings);
  })
);

settingsRouter.put(
  "/:key",
  asyncHandler(async (req, res) => {
    const key = req.params.key;
    // A key nothing reads would be stored and answered 200, then silently do nothing.
    if (!isKnownSettingKey(key)) {
      const hint = suggestSettingKey(key);
      throw new HttpError(400, `Unknown setting "${key}".${hint ? ` Did you mean "${hint}"?` : ""}`);
    }
    const value = String((req.body ?? {}).value ?? "");
    const problem = settingValueProblem(key, value);
    if (problem) throw new HttpError(400, problem);
    setSetting(key, value);
    if (NETWORK_SETTING_KEYS.has(key)) {
      applySocksProxySetting();
      void verifyOutboundDispatcher();
    }
    res.json({ key, value });
  })
);

settingsRouter.post(
  "/notifications/:provider/test",
  asyncHandler(async (req, res) => {
    try {
      await sendTestNotification(req.params.provider);
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message });
    }
  })
);

/** Verifies the configured Plex/Jellyfin/Emby URL+token actually work, without waiting for the
 * next scheduled watch-status sync to silently fail — reuses the exact same request path that
 * sync already goes through (getMediaServerConfig + fetchWatchedFiles), just reporting success/
 * failure instead of the real watched-file list. */
settingsRouter.post(
  "/media-server/test",
  asyncHandler(async (_req, res) => {
    const cfg = getMediaServerConfig();
    if (!cfg) {
      res.json({ ok: false, error: "Media server type, URL, and token must all be set first" });
      return;
    }
    try {
      const files = await fetchWatchedFiles();
      res.json({ ok: true, fileCount: files.length });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message });
    }
  })
);

/** Regenerating invalidates the key immediately — the caller must update its own stored copy
 * (the web UI does this itself since it made the request with the old key). */
settingsRouter.post(
  "/api-key/regenerate",
  asyncHandler(async (req, res) => {
    const newKey = crypto.randomBytes(24).toString("hex");
    setSetting("apiKey", newKey);
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "api_key_regenerated");
    res.json({ key: "apiKey", value: newKey });
  })
);

/** 2 added tags, delay profiles and release profiles. An import still reads a version 1 file. */
const TEMPLATE_VERSION = 2;

/** A list of strings from an exported value, with anything else left out. */
function templateStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v).trim()).filter((v) => v.length > 0) : [];
}

/** The largest value the integer columns hold (and the delay profile API allows). */
const MAX_INT32 = 2147483647;

function templateWholeNumber(value: unknown, fallback: number, min = 0): number {
  const n = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isInteger(n) && n >= min && n <= MAX_INT32 ? n : fallback;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The id of the tag with this name, creating it when this instance does not have it yet. */
async function tagIdByName(name: string, cache: Map<string, number>): Promise<number> {
  const known = cache.get(name);
  if (known !== undefined) return known;
  await db.prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name = excluded.name").run(name);
  const row = (await db.prepare("SELECT id FROM tags WHERE name = ?").get(name)) as { id: number };
  cache.set(name, Number(row.id));
  return Number(row.id);
}

/**
 * A portable bundle of "how this instance is configured to grab/organize media" — quality
 * ladder, quality profiles, custom formats + their per-profile scores, naming templates, tags,
 * delay profiles and release profiles — deliberately excluding anything instance-specific (API
 * keys, indexers, download clients, root folder paths, users) so it's safe to share or reuse across
 * installs. A profile names its tag, not its tag id. A release profile's indexer scope is left out
 * because indexer ids belong to one instance, but the export says there was one (`indexerScoped`), so
 * an import can keep that profile switched off instead of letting it apply to every indexer. The size
 * mode travels with the quality sizes, because the same numbers mean different things per release and
 * per minute. Separate from the full DB backup in System, which is a byte-for-byte snapshot of
 * everything including that instance data.
 */
settingsRouter.get(
  "/template/export",
  asyncHandler(async (_req, res) => {
    const qualities = await db.prepare("SELECT name, rank, min_size_mb, max_size_mb, preferred_size_mb FROM qualities ORDER BY rank").all();
    const profiles = (await db
      .prepare(
        "SELECT name, allowed_qualities, cutoff, min_format_score, max_size_gb, prefer_cutoff_quality, upgrade_allowed, cutoff_format_score, min_upgrade_format_score, quality_groups, language, quality_order FROM quality_profiles"
      )
      .all()) as any[];
    const formats = (await db.prepare("SELECT id, name, patterns, media_types FROM custom_formats").all()) as any[];
    const scores = await db
      .prepare(
        `SELECT qp.name AS "profileName", cf.name AS "formatName", s.score
         FROM quality_profile_format_scores s
         JOIN quality_profiles qp ON qp.id = s.quality_profile_id
         JOIN custom_formats cf ON cf.id = s.custom_format_id`
      )
      .all();
    const namingTemplates = Object.fromEntries(Object.entries(getAllSettings()).filter(([key]) => key.startsWith("naming")));

    const tagRows = (await db.prepare("SELECT id, name, retention_days FROM tags ORDER BY name").all()) as {
      id: number;
      name: string;
      retention_days: number | null;
    }[];
    const tagNameById = new Map(tagRows.map((t) => [Number(t.id), t.name]));
    const delayRows = (await db.prepare("SELECT * FROM delay_profiles ORDER BY order_index, id").all()) as any[];
    const releaseRows = (await db.prepare("SELECT * FROM release_profiles ORDER BY name, id").all()) as any[];
    const jsonList = (raw: unknown): any[] => {
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };

    res.json({
      templateVersion: TEMPLATE_VERSION,
      exportedAt: new Date().toISOString(),
      tags: tagRows.map((t) => ({ name: t.name, retentionDays: t.retention_days == null ? null : Number(t.retention_days) })),
      delayProfiles: delayRows.map((p) => ({
        tagName: p.tag_id == null ? null : tagNameById.get(Number(p.tag_id)) ?? null,
        enableUsenet: !!Number(p.enable_usenet),
        enableTorrent: !!Number(p.enable_torrent),
        usenetDelayMinutes: Number(p.usenet_delay_minutes),
        torrentDelayMinutes: Number(p.torrent_delay_minutes),
        bypassIfHighestQuality: !!Number(p.bypass_if_highest_quality),
        orderIndex: Number(p.order_index),
        preferredProtocol: p.preferred_protocol,
        bypassIfAboveFormatScore: !!Number(p.bypass_if_above_format_score),
        minimumBypassFormatScore: Number(p.minimum_bypass_format_score),
      })),
      releaseProfiles: releaseRows.map((p) => ({
        name: p.name,
        enabled: !!Number(p.enabled),
        mustContain: jsonList(p.must_contain),
        mustNotContain: jsonList(p.must_not_contain),
        preferred: jsonList(p.preferred),
        mediaTypes: jsonList(p.media_types),
        tagNames: jsonList(p.tag_ids)
          .map((id) => tagNameById.get(Number(id)))
          .filter((name): name is string => !!name),
        indexerScoped: jsonList(p.indexer_ids).length > 0,
      })),
      sizeLimitMode: getSetting("sizeLimitMode") === "perMinute" ? "perMinute" : "absolute",
      qualities,
      qualityProfiles: profiles.map((p) => ({
        name: p.name,
        allowedQualities: JSON.parse(p.allowed_qualities),
        cutoff: p.cutoff,
        minFormatScore: p.min_format_score,
        maxSizeGb: p.max_size_gb,
        preferCutoffQuality: p.prefer_cutoff_quality == null ? true : !!Number(p.prefer_cutoff_quality),
        upgradeAllowed: p.upgrade_allowed == null ? true : !!Number(p.upgrade_allowed),
        cutoffFormatScore: Number(p.cutoff_format_score ?? 0),
        minUpgradeFormatScore: p.min_upgrade_format_score == null ? 1 : Number(p.min_upgrade_format_score),
        qualityGroups: parseQualityGroups(p.quality_groups),
        qualityOrder: parseQualityOrder(p.quality_order),
        language: p.language ?? null,
      })),
      customFormats: formats.map((f) => ({
        name: f.name,
        conditionGroups: JSON.parse(f.patterns),
        mediaTypes: f.media_types ? JSON.parse(f.media_types) : [],
      })),
      formatScores: scores,
      namingTemplates,
    });
  })
);

/** Imports a template exported above. Upserts by name — an existing quality/profile/format with
 * the same name is updated in place, so re-importing the same template (or a tweaked copy) is
 * safe to repeat rather than piling up duplicates. */
settingsRouter.post(
  "/template/import",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    let qualitiesImported = 0,
      profilesImported = 0,
      formatsImported = 0,
      scoresImported = 0,
      namingImported = 0,
      tagsImported = 0,
      delayProfilesImported = 0,
      releaseProfilesImported = 0,
      releaseProfilesCreated = 0;

    await db.transaction(async () => {
      // qualities.rank is UNIQUE too, not just name — a quality this instance doesn't have yet
      // can't reuse the source instance's rank, since after any delete/reorder here that rank is
      // usually already taken (a UNIQUE violation used to abort the entire import). New ones go in
      // at the end first, then get slotted in right after their nearest template-order predecessor
      // that this instance already has; existing qualities keep their own order untouched.
      const templateQualities = [...(b.qualities ?? [])].sort((x: any, y: any) => Number(x.rank) - Number(y.rank));
      const existingNames = new Set(((await db.prepare("SELECT name FROM qualities").all()) as { name: string }[]).map((r) => r.name));
      for (const q of templateQualities) {
        if (existingNames.has(q.name)) {
          await db
            .prepare("UPDATE qualities SET min_size_mb = ?, max_size_mb = ?, preferred_size_mb = ? WHERE name = ?")
            .run(q.min_size_mb ?? null, q.max_size_mb ?? null, q.preferred_size_mb ?? null, q.name);
        } else {
          await db
            .prepare(
              `INSERT INTO qualities (name, rank, min_size_mb, max_size_mb, preferred_size_mb)
               VALUES (?, (SELECT COALESCE(MAX(rank), -1) + 1 FROM qualities), ?, ?, ?)`
            )
            .run(q.name, q.min_size_mb ?? null, q.max_size_mb ?? null, q.preferred_size_mb ?? null);
        }
        qualitiesImported++;
      }
      // The numbers mean MB per release or MB per minute depending on this, so they travel together.
      if (templateQualities.length > 0 && (b.sizeLimitMode === "perMinute" || b.sizeLimitMode === "absolute")) {
        setSetting("sizeLimitMode", b.sizeLimitMode);
      }
      const newNames = templateQualities.map((q: any) => q.name).filter((name: string) => !existingNames.has(name));
      if (newNames.length > 0) {
        const all = (await db.prepare("SELECT id, name FROM qualities ORDER BY rank").all()) as { id: number; name: string }[];
        const idByName = new Map(all.map((r) => [r.name, r.id]));
        const order = all.map((r) => r.name).filter((name) => existingNames.has(name));
        const templateOrder = templateQualities.map((q: any) => q.name as string);
        for (const name of newNames) {
          let insertAt = 0;
          for (let i = templateOrder.indexOf(name) - 1; i >= 0; i--) {
            const predecessor = order.indexOf(templateOrder[i]);
            if (predecessor !== -1) {
              insertAt = predecessor + 1;
              break;
            }
          }
          order.splice(insertAt, 0, name);
        }
        // Staged through negative placeholders, same as POST /qualities/reorder, so no
        // intermediate write collides with another row's not-yet-updated rank.
        for (let i = 0; i < order.length; i++) await db.prepare("UPDATE qualities SET rank = ? WHERE id = ?").run(-(i + 1), idByName.get(order[i]));
        for (let i = 0; i < order.length; i++) await db.prepare("UPDATE qualities SET rank = ? WHERE id = ?").run(i, idByName.get(order[i]));
      }

      for (const p of b.qualityProfiles ?? []) {
        // A backup from before profiles had an order leaves the profile's own order alone, with what the backup newly
        // allows put into it (a quality the order leaves out would rank below every listed one).
        let qualityOrder = parseQualityOrder(p.qualityOrder);
        let qualityOrderSent = p.qualityOrder !== undefined;
        if (!qualityOrderSent && Array.isArray(p.allowedQualities)) {
          const own = (await db.prepare("SELECT quality_order FROM quality_profiles WHERE name = ?").get(p.name)) as { quality_order: string | null } | undefined;
          const ownOrder = parseQualityOrder(own?.quality_order);
          if (ownOrder) {
            qualityOrder = reconcileQualityOrder(ownOrder, p.allowedQualities);
            qualityOrderSent = true;
          }
        }
        await db
          .prepare(
            `INSERT INTO quality_profiles (name, allowed_qualities, cutoff, min_format_score, max_size_gb, prefer_cutoff_quality, upgrade_allowed, cutoff_format_score, min_upgrade_format_score, quality_groups, language, quality_order)
             VALUES (@name, @allowedQualities, @cutoff, @minFormatScore, @maxSizeGb, @preferCutoffQuality, COALESCE(@upgradeAllowed, 1), COALESCE(@cutoffFormatScore, 0), COALESCE(@minUpgradeFormatScore, 1), COALESCE(@qualityGroups, '[]'), @language, @qualityOrder)
             ON CONFLICT(name) DO UPDATE SET allowed_qualities = excluded.allowed_qualities,
               cutoff = excluded.cutoff, min_format_score = excluded.min_format_score, max_size_gb = excluded.max_size_gb,
               prefer_cutoff_quality = excluded.prefer_cutoff_quality, upgrade_allowed = COALESCE(@upgradeAllowed, quality_profiles.upgrade_allowed),
               cutoff_format_score = COALESCE(@cutoffFormatScore, quality_profiles.cutoff_format_score),
               min_upgrade_format_score = COALESCE(@minUpgradeFormatScore, quality_profiles.min_upgrade_format_score),
               quality_groups = COALESCE(@qualityGroups, quality_profiles.quality_groups),
               language = CASE WHEN @languageSent = 1 THEN @language ELSE quality_profiles.language END,
               quality_order = CASE WHEN @qualityOrderSent = 1 THEN @qualityOrder ELSE quality_profiles.quality_order END`
          )
          .run({
            ...p,
            allowedQualities: JSON.stringify(p.allowedQualities),
            maxSizeGb: p.maxSizeGb ?? null,
            // A backup from before the flag existed keeps the cap at the cutoff.
            preferCutoffQuality: p.preferCutoffQuality === false ? 0 : 1,
            // A backup from before the upgrade fields and quality groups leaves a profile's own values as they are
            // (a new profile gets the defaults).
            upgradeAllowed: p.upgradeAllowed === undefined || p.upgradeAllowed === null ? null : p.upgradeAllowed === false ? 0 : 1,
            cutoffFormatScore: p.cutoffFormatScore === undefined || p.cutoffFormatScore === null || !Number.isInteger(Number(p.cutoffFormatScore)) ? null : Number(p.cutoffFormatScore),
            minUpgradeFormatScore: p.minUpgradeFormatScore === undefined || p.minUpgradeFormatScore === null || !Number.isInteger(Number(p.minUpgradeFormatScore)) ? null : Number(p.minUpgradeFormatScore),
            qualityGroups: p.qualityGroups === undefined ? null : JSON.stringify(parseQualityGroups(p.qualityGroups)),
            // A backup from before profiles had a language leaves the profile's own language alone.
            language: normalizeProfileLanguage(p.language),
            languageSent: p.language === undefined ? 0 : 1,
            qualityOrder: qualityOrder ? JSON.stringify(qualityOrder) : null,
            qualityOrderSent: qualityOrderSent ? 1 : 0,
          });
        profilesImported++;
      }

      for (const f of b.customFormats ?? []) {
        const mediaTypes = Array.isArray(f.mediaTypes) ? f.mediaTypes : [];
        await db
          .prepare(
            `INSERT INTO custom_formats (name, patterns, media_types) VALUES (@name, @patterns, @mediaTypes)
             ON CONFLICT(name) DO UPDATE SET patterns = excluded.patterns, media_types = excluded.media_types`
          )
          .run({ name: f.name, patterns: JSON.stringify(f.conditionGroups), mediaTypes: mediaTypes.length > 0 ? JSON.stringify(mediaTypes) : null });
        formatsImported++;
      }

      for (const s of b.formatScores ?? []) {
        const profile = (await db.prepare("SELECT id FROM quality_profiles WHERE name = ?").get(s.profileName)) as
          | { id: number }
          | undefined;
        const format = (await db.prepare("SELECT id FROM custom_formats WHERE name = ?").get(s.formatName)) as
          | { id: number }
          | undefined;
        if (!profile || !format) continue;
        await db
          .prepare(
            `INSERT INTO quality_profile_format_scores (quality_profile_id, custom_format_id, score)
             VALUES (?, ?, ?)
             ON CONFLICT(quality_profile_id, custom_format_id) DO UPDATE SET score = excluded.score`
          )
          .run(profile.id, format.id, s.score);
        scoresImported++;
      }

      // Only naming* keys, matching what export emits — templates are advertised as safe to share
      // between instances, so an unfiltered loop here let a downloaded template flip any setting at
      // all (authRequired=0, a known apiKey, a proxy URL for all outbound traffic).
      for (const [key, value] of Object.entries(b.namingTemplates ?? {})) {
        if (!key.startsWith("naming")) continue;
        // The same checks as saving the setting by hand: a template that cannot work is left out.
        if (settingValueProblem(key, String(value))) continue;
        setSetting(key, String(value));
        namingImported++;
      }

      // Tags come first: the profiles below name them. A tag that is not on this instance yet is created.
      const tagIds = new Map<string, number>();
      for (const t of Array.isArray(b.tags) ? b.tags : []) {
        if (!isPlainObject(t)) continue;
        const name = String(t.name ?? "").trim();
        if (!name) continue;
        const id = await tagIdByName(name, tagIds);
        if (t.retentionDays !== undefined) {
          // -1 is "never archive", the override that keeps a tag's items out of auto-archival.
          const days = t.retentionDays === null ? null : templateWholeNumber(t.retentionDays, Number.NaN, -1);
          if (days === null || !Number.isNaN(days)) await db.prepare("UPDATE tags SET retention_days = ? WHERE id = ?").run(days, id);
        }
        tagsImported++;
      }

      // A delay profile is matched by its tag (the default one by having none), as the Delay Profiles
      // page allows one per tag: re-importing updates it in place.
      for (const p of Array.isArray(b.delayProfiles) ? b.delayProfiles : []) {
        // An entry with none of the delay fields would reset the profile it matches to no delay at all.
        const carriesSettings = isPlainObject(p) && ["enableUsenet", "enableTorrent", "usenetDelayMinutes", "torrentDelayMinutes", "preferredProtocol"].some((k) => p[k] !== undefined);
        if (!carriesSettings) continue;
        let tagId: number | null = null;
        if (p.tagName !== undefined && p.tagName !== null) {
          const name = String(p.tagName).trim();
          if (!name) continue;
          tagId = await tagIdByName(name, tagIds);
        }
        const preferredProtocol = p.preferredProtocol === "usenet" || p.preferredProtocol === "torrent" ? p.preferredProtocol : "none";
        const values = [
          p.enableUsenet === false ? 0 : 1,
          p.enableTorrent === false ? 0 : 1,
          templateWholeNumber(p.usenetDelayMinutes, 0),
          templateWholeNumber(p.torrentDelayMinutes, 0),
          p.bypassIfHighestQuality ? 1 : 0,
          preferredProtocol,
          p.bypassIfAboveFormatScore ? 1 : 0,
          Number.isInteger(Number(p.minimumBypassFormatScore)) && Math.abs(Number(p.minimumBypassFormatScore)) <= MAX_INT32 ? Number(p.minimumBypassFormatScore) : 0,
        ];
        const existing = (await db
          .prepare(tagId == null ? "SELECT id FROM delay_profiles WHERE tag_id IS NULL ORDER BY id" : "SELECT id FROM delay_profiles WHERE tag_id = ? ORDER BY id")
          .get(...(tagId == null ? [] : [tagId]))) as { id: number } | undefined;
        if (existing) {
          await db
            .prepare(
              `UPDATE delay_profiles SET enable_usenet = ?, enable_torrent = ?, usenet_delay_minutes = ?, torrent_delay_minutes = ?, bypass_if_highest_quality = ?,
               preferred_protocol = ?, bypass_if_above_format_score = ?, minimum_bypass_format_score = ? WHERE id = ?`
            )
            .run(...values, existing.id);
        } else {
          const maxOrder = (await db.prepare("SELECT MAX(order_index) AS m FROM delay_profiles").get()) as { m: number | null };
          await db
            .prepare(
              `INSERT INTO delay_profiles (tag_id, enable_usenet, enable_torrent, usenet_delay_minutes, torrent_delay_minutes, bypass_if_highest_quality,
               preferred_protocol, bypass_if_above_format_score, minimum_bypass_format_score, order_index)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(tagId, ...values, templateWholeNumber(p.orderIndex, (maxOrder.m ?? -1) + 1));
        }
        delayProfilesImported++;
      }

      // A release profile is matched by name when that name is unique on both sides; names are not
      // unique in the table, so otherwise by name and terms, else it is added. Its indexer scope is
      // never imported, because indexer ids belong to one instance: a profile that had one comes in
      // switched off, so a rule meant for one indexer does not start applying to all of them, and a
      // profile that already exists here keeps its own scope and on/off state.
      const releaseEntries = (Array.isArray(b.releaseProfiles) ? b.releaseProfiles : []).filter(isPlainObject);
      const nameCounts = new Map<string, number>();
      for (const p of releaseEntries) {
        const name = String(p.name ?? "").trim();
        if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
      for (const p of releaseEntries) {
        const name = String(p.name ?? "").trim();
        if (!name) continue;
        const tagIdList: number[] = [];
        for (const tagName of templateStrings(p.tagNames)) tagIdList.push(await tagIdByName(tagName, tagIds));
        const preferred = (Array.isArray(p.preferred) ? p.preferred : [])
          .map((x: any) => ({ term: String(x?.term ?? "").trim(), score: Number(x?.score) || 0 }))
          .filter((x: { term: string }) => x.term.length > 0);
        const mediaTypes = templateStrings(p.mediaTypes);
        const mustContain = JSON.stringify(templateStrings(p.mustContain));
        const mustNotContain = JSON.stringify(templateStrings(p.mustNotContain));
        const rest = [
          JSON.stringify(preferred),
          mediaTypes.length > 0 ? JSON.stringify(mediaTypes) : null,
          tagIdList.length > 0 ? JSON.stringify(tagIdList) : null,
        ];
        const sameName = (await db
          .prepare("SELECT id, must_contain, must_not_contain FROM release_profiles WHERE name = ? ORDER BY id")
          .all(name)) as { id: number; must_contain: string; must_not_contain: string }[];
        const target =
          sameName.length === 1 && nameCounts.get(name) === 1
            ? sameName[0]
            : sameName.find((r) => r.must_contain === mustContain && r.must_not_contain === mustNotContain);
        if (target) {
          await db
            .prepare("UPDATE release_profiles SET must_contain = ?, must_not_contain = ?, preferred = ?, media_types = ?, tag_ids = ? WHERE id = ?")
            .run(mustContain, mustNotContain, ...rest, target.id);
          if (p.indexerScoped !== true) await db.prepare("UPDATE release_profiles SET enabled = ? WHERE id = ?").run(p.enabled === false ? 0 : 1, target.id);
        } else {
          const enabled = p.enabled === false || p.indexerScoped === true ? 0 : 1;
          await db
            .prepare("INSERT INTO release_profiles (name, enabled, must_contain, must_not_contain, preferred, media_types, tag_ids) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(name, enabled, mustContain, mustNotContain, ...rest);
          releaseProfilesCreated++;
        }
        releaseProfilesImported++;
      }
    });
    invalidateQualityRankCache();

    res.json({
      qualitiesImported,
      profilesImported,
      formatsImported,
      scoresImported,
      namingImported,
      tagsImported,
      delayProfilesImported,
      releaseProfilesImported,
      releaseProfilesCreated,
    });
  })
);

/**
 * Optional TOTP two-factor step for the admin web login. This gates the *web UI's* login flow
 * only — the API key itself (X-Api-Key) remains the actual per-request credential for every API
 * call, same as a real Starr app; there's no session concept to attach a per-request 2FA check
 * to. Enabling/disabling requires already holding a valid API key (these routes sit behind
 * requireAdmin like the rest of this router), so this can't be used to lock out the real admin.
 */
settingsRouter.post(
  "/totp/setup",
  asyncHandler(async (_req, res) => {
    const secret = generateBase32Secret();
    setSetting("totpPendingSecret", secret);
    res.json({ secret, otpauthUrl: buildOtpauthUrl(secret, "admin") });
  })
);

settingsRouter.post(
  "/totp/verify",
  asyncHandler(async (req, res) => {
    const pendingSecret = getSetting("totpPendingSecret");
    if (!pendingSecret) throw new HttpError(400, "No pending TOTP setup — call /totp/setup first");
    const code = req.body?.code;
    if (!verifyTotp(pendingSecret, code ?? "")) throw new HttpError(400, "Invalid code");

    setSetting("totpSecret", pendingSecret);
    setSetting("totpEnabled", "1");
    deleteSetting("totpPendingSecret");
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "totp_enabled");
    res.json({ enabled: true });
  })
);

settingsRouter.post(
  "/totp/disable",
  asyncHandler(async (req, res) => {
    const secret = getSetting("totpSecret");
    if (secret) {
      const code = req.body?.code;
      if (!verifyTotp(secret, code ?? "")) throw new HttpError(400, "Invalid code");
    }
    setSetting("totpEnabled", "0");
    deleteSetting("totpSecret");
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "totp_disabled");
    res.json({ enabled: false });
  })
);

/** Used by the web login gate's second step — verifies a code against the already-enabled
 * secret without exposing the secret itself. Rate-limited per IP even though it already sits
 * behind a valid API key, since a 6-digit code is a much smaller space to guess than the key. */
settingsRouter.post(
  "/totp/check-login",
  asyncHandler(async (req, res) => {
    const secret = getSetting("totpSecret");
    if (!secret || getSetting("totpEnabled") !== "1") {
      res.json({ ok: true }); // 2FA not enabled — nothing to check
      return;
    }

    const rateLimitKey = `totp:${clientIp(req)}`;
    const rateLimit = checkRateLimit(rateLimitKey);
    if (!rateLimit.allowed) {
      res.status(429).json({ ok: false, error: "Too many failed attempts. Try again later.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }

    const ok = verifyTotp(secret, req.body?.code ?? "");
    if (ok) recordSuccess(rateLimitKey);
    else recordFailure(rateLimitKey);
    res.json({ ok });
  })
);
