import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import crypto from "node:crypto";
import { db } from "../db/client.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { invalidateQualityRankCache } from "../services/quality.js";
import { buildOtpauthUrl, generateBase32Secret, verifyTotp } from "../services/totp.js";
import { getSetting, setSetting } from "../services/settingsStore.js";
import { applySocksProxySetting } from "../services/socksProxy.js";
import { checkRateLimit, recordFailure, recordSuccess } from "../services/rateLimiter.js";
import { auditActor, logAuditEvent } from "../services/audit.js";

export const settingsRouter = Router();
settingsRouter.use(requireAdmin);

settingsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const row of rows) out[row.key] = row.value;
    res.json(out);
  })
);

settingsRouter.put(
  "/:key",
  asyncHandler(async (req, res) => {
    const value = String((req.body ?? {}).value ?? "");
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(req.params.key, value);
    if (req.params.key === "socks5ProxyUrl") applySocksProxySetting();
    res.json({ key: req.params.key, value });
  })
);

/** Regenerating invalidates the key immediately — the caller must update its own stored copy
 * (the web UI does this itself since it made the request with the old key). */
settingsRouter.post(
  "/api-key/regenerate",
  asyncHandler(async (req, res) => {
    const newKey = crypto.randomBytes(24).toString("hex");
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('apiKey', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(newKey);
    const actor = auditActor(req);
    logAuditEvent(actor.userId, actor.username, "api_key_regenerated");
    res.json({ key: "apiKey", value: newKey });
  })
);

const TEMPLATE_VERSION = 1;

/**
 * A portable bundle of "how this instance is configured to grab/organize media" — quality
 * ladder, quality profiles, custom formats + their per-profile scores, and naming templates —
 * deliberately excluding anything instance-specific (API keys, indexers, download clients, root
 * folder paths, users) so it's safe to share or reuse across installs. Separate from the full DB
 * backup in System, which is a byte-for-byte snapshot of everything including that instance data.
 */
settingsRouter.get(
  "/template/export",
  asyncHandler(async (_req, res) => {
    const qualities = db.prepare("SELECT name, rank, min_size_mb, max_size_mb FROM qualities ORDER BY rank").all();
    const profiles = db
      .prepare("SELECT name, allowed_qualities, cutoff, min_format_score FROM quality_profiles")
      .all() as any[];
    const formats = db.prepare("SELECT id, name, patterns FROM custom_formats").all() as any[];
    const scores = db
      .prepare(
        `SELECT qp.name AS profileName, cf.name AS formatName, s.score
         FROM quality_profile_format_scores s
         JOIN quality_profiles qp ON qp.id = s.quality_profile_id
         JOIN custom_formats cf ON cf.id = s.custom_format_id`
      )
      .all();
    const namingSettings = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'naming%'").all() as {
      key: string;
      value: string;
    }[];

    res.json({
      templateVersion: TEMPLATE_VERSION,
      exportedAt: new Date().toISOString(),
      qualities,
      qualityProfiles: profiles.map((p) => ({
        name: p.name,
        allowedQualities: JSON.parse(p.allowed_qualities),
        cutoff: p.cutoff,
        minFormatScore: p.min_format_score,
      })),
      customFormats: formats.map((f) => ({ name: f.name, conditionGroups: JSON.parse(f.patterns) })),
      formatScores: scores,
      namingTemplates: Object.fromEntries(namingSettings.map((r) => [r.key, r.value])),
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
      namingImported = 0;

    const importAll = db.transaction(() => {
      for (const q of b.qualities ?? []) {
        db.prepare(
          `INSERT INTO qualities (name, rank, min_size_mb, max_size_mb) VALUES (@name, @rank, @min_size_mb, @max_size_mb)
           ON CONFLICT(name) DO UPDATE SET min_size_mb = excluded.min_size_mb, max_size_mb = excluded.max_size_mb`
        ).run(q);
        qualitiesImported++;
      }

      for (const p of b.qualityProfiles ?? []) {
        db.prepare(
          `INSERT INTO quality_profiles (name, allowed_qualities, cutoff, min_format_score)
           VALUES (@name, @allowedQualities, @cutoff, @minFormatScore)
           ON CONFLICT(name) DO UPDATE SET allowed_qualities = excluded.allowed_qualities,
             cutoff = excluded.cutoff, min_format_score = excluded.min_format_score`
        ).run({ ...p, allowedQualities: JSON.stringify(p.allowedQualities) });
        profilesImported++;
      }

      for (const f of b.customFormats ?? []) {
        db.prepare(
          `INSERT INTO custom_formats (name, patterns) VALUES (@name, @patterns)
           ON CONFLICT(name) DO UPDATE SET patterns = excluded.patterns`
        ).run({ name: f.name, patterns: JSON.stringify(f.conditionGroups) });
        formatsImported++;
      }

      for (const s of b.formatScores ?? []) {
        const profile = db.prepare("SELECT id FROM quality_profiles WHERE name = ?").get(s.profileName) as
          | { id: number }
          | undefined;
        const format = db.prepare("SELECT id FROM custom_formats WHERE name = ?").get(s.formatName) as
          | { id: number }
          | undefined;
        if (!profile || !format) continue;
        db.prepare(
          `INSERT INTO quality_profile_format_scores (quality_profile_id, custom_format_id, score)
           VALUES (?, ?, ?)
           ON CONFLICT(quality_profile_id, custom_format_id) DO UPDATE SET score = excluded.score`
        ).run(profile.id, format.id, s.score);
        scoresImported++;
      }

      for (const [key, value] of Object.entries(b.namingTemplates ?? {})) {
        db.prepare(
          `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).run(key, value);
        namingImported++;
      }
    });
    importAll();
    invalidateQualityRankCache();

    res.json({ qualitiesImported, profilesImported, formatsImported, scoresImported, namingImported });
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
    db.prepare("DELETE FROM settings WHERE key = 'totpPendingSecret'").run();
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
    db.prepare("DELETE FROM settings WHERE key = 'totpSecret'").run();
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

    const rateLimitKey = `totp:${req.ip}`;
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
