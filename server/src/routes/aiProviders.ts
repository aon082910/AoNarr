import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { aiProviderFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { queryAi } from "../services/aiClient.js";

export const aiProvidersRouter = Router();
aiProvidersRouter.use(requireAdmin);

aiProvidersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM ai_providers").all();
    res.json(rows.map(aiProviderFromRow));
  })
);

aiProvidersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.type || !b.baseUrl || !b.model) throw new HttpError(400, "name, type, baseUrl and model are required");
    if (b.type !== "local" && b.type !== "cloud") throw new HttpError(400, "type must be 'local' or 'cloud'");
    if (b.type === "cloud" && !b.apiKey) throw new HttpError(400, "apiKey is required for a cloud provider");

    // Only one instance is ever "the" default a feature reaches for automatically when it doesn't
    // ask for a specific one by id — same single-flag-wins-and-clears-the-rest pattern as any other
    // "pick one of these" setting in this codebase.
    if (b.isDefault) {
      await db.prepare("UPDATE ai_providers SET is_default = 0").run();
    }

    const result = await db
      .prepare(`INSERT INTO ai_providers (name, type, base_url, api_key, model, enabled, is_default) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(b.name, b.type, b.baseUrl.replace(/\/+$/, ""), b.apiKey ?? null, b.model, b.enabled ?? 1, b.isDefault ? 1 : 0);
    const row = await db.prepare("SELECT * FROM ai_providers WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(aiProviderFromRow(row));
  })
);

aiProvidersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (b.isDefault) {
      await db.prepare("UPDATE ai_providers SET is_default = 0").run();
    }
    const map: Record<string, string> = {
      name: "name",
      type: "type",
      baseUrl: "base_url",
      apiKey: "api_key",
      model: "model",
      enabled: "enabled",
      isDefault: "is_default",
    };
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, col] of Object.entries(map)) {
      if (b[key] === undefined) continue;
      sets.push(`${col} = ?`);
      values.push(key === "baseUrl" ? String(b[key]).replace(/\/+$/, "") : key === "isDefault" ? (b[key] ? 1 : 0) : b[key]);
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE ai_providers SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM ai_providers WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "AI provider not found");
    res.json(aiProviderFromRow(row));
  })
);

aiProvidersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM ai_providers WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "AI provider not found");
    res.status(204).send();
  })
);

/** Sends a trivial prompt and confirms a response comes back — the same "Test" pattern indexers
 * already offer, so a misconfigured URL/key/model is caught here instead of on first real use. */
aiProvidersRouter.post(
  "/:id/test",
  asyncHandler(async (req, res) => {
    const row = (await db.prepare("SELECT * FROM ai_providers WHERE id = ?").get(req.params.id)) as any;
    if (!row) throw new HttpError(404, "AI provider not found");
    try {
      const reply = await queryAi(
        { type: row.type, baseUrl: row.base_url, apiKey: row.api_key, model: row.model },
        "Reply with exactly one word: OK"
      );
      res.json({ ok: true, reply: reply.trim().slice(0, 200) });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message });
    }
  })
);
