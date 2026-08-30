import crypto from "node:crypto";
import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { getSetting } from "../services/settingsStore.js";
import { db } from "../db/index.js";
import { searchMetadata, fetchSeriesEpisodesFor } from "../services/metadata.js";
import { autoSelectRootFolderId } from "../services/rootFolderSelect.js";
import { findPossibleDuplicates } from "../services/duplicateCheck.js";
import { log } from "../services/logger.js";

// Discord's Ed25519 public key is distributed as a raw 32-byte hex string, not a PEM/DER file —
// this is the standard fixed SPKI wrapper needed to hand it to Node's crypto.createPublicKey,
// the same trick every from-scratch (non-discord.js) interactions endpoint uses.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifyDiscordSignature(publicKeyHex: string, signature: string, timestamp: string, rawBody: Buffer): boolean {
  try {
    const keyObject = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.concat([Buffer.from(timestamp, "utf-8"), rawBody]), keyObject, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Admin — register the /request slash command with Discord.
// ---------------------------------------------------------------------------

export const discordCommandRouter = Router();
discordCommandRouter.use(requireAdmin);

const REQUEST_COMMAND = {
  name: "request",
  description: "Request a movie or TV show for AoNarr to acquire",
  options: [
    {
      type: 3, // STRING
      name: "type",
      description: "Movie or TV show",
      required: true,
      choices: [
        { name: "Movie", value: "movie" },
        { name: "TV Show", value: "series" },
      ],
    },
    { type: 3, name: "title", description: "Title to search for", required: true },
  ],
};

discordCommandRouter.post(
  "/register",
  asyncHandler(async (_req, res) => {
    const token = getSetting("discordBotToken");
    const appId = getSetting("discordApplicationId");
    if (!token || !appId) throw new HttpError(400, "Set the Discord bot token and application ID first");

    const guildId = getSetting("discordGuildId");
    const url = guildId
      ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
      : `https://discord.com/api/v10/applications/${appId}/commands`;

    const discordRes = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([REQUEST_COMMAND]),
    });
    if (!discordRes.ok) {
      throw new HttpError(400, `Discord command registration failed: HTTP ${discordRes.status} — ${await discordRes.text()}`);
    }
    // A guild-scoped command is usable within seconds; a global one can take up to an hour to
    // propagate across every server the bot is in — Discord's own limitation, not AoNarr's.
    res.json({ registered: true, scope: guildId ? "guild" : "global" });
  })
);

// ---------------------------------------------------------------------------
// Public — the actual interactions webhook Discord calls. Verified by Ed25519 signature (the
// only auth mechanism Discord's interactions endpoint supports — there's no room for a custom
// header or ?token= the way every other webhook in this app uses), not requireAuth; see
// middleware/auth.ts's exemption.
// ---------------------------------------------------------------------------

export const discordInteractionsRouter = Router();

/** Adds a movie/series to the library from a resolved search result, mirroring the same
 * insert + episode-population shape every other external-add path in this app uses (Overseerr
 * webhook, watch-history auto-request, import lists). Returns the created title on success. */
async function addFromSearchResult(type: "movie" | "series", result: any): Promise<string> {
  const rootFolderId = await autoSelectRootFolderId(type);
  const qualityProfileId =
    ((await db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get()) as { id: number } | undefined)?.id ?? null;

  const insertResult = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, root_folder_id, quality_profile_id, monitored, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`
    )
    .run(
      type,
      result.title,
      result.title.toLowerCase(),
      result.year,
      result.overview,
      result.posterUrl,
      JSON.stringify(result.externalIds),
      rootFolderId,
      qualityProfileId
    );

  if (type === "series") {
    const episodes = await fetchSeriesEpisodesFor(result.externalIds).catch(() => []);
    for (const ep of episodes) {
      await db
        .prepare(
          `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, overview, monitored)
           VALUES (?, ?, ?, ?, ?, ?, 1)`
        )
        .run(insertResult.lastInsertRowid, ep.seasonNumber, ep.episodeNumber, ep.title, ep.airDate, ep.overview);
    }
  }
  return result.title;
}

/** Discord requires a response within 3 seconds or the interaction is dropped — a metadata
 * search plus episode population can easily run longer, so this always defers first (type 5,
 * "thinking...") and follows up via Discord's webhook-message-edit endpoint once the real work
 * finishes, the standard pattern for anything slower than an instant reply. */
async function handleRequestCommand(interaction: any, appId: string): Promise<void> {
  const options: any[] = interaction.data?.options ?? [];
  const type = options.find((o) => o.name === "type")?.value === "series" ? "series" : "movie";
  const title = options.find((o) => o.name === "title")?.value as string | undefined;

  const editUrl = `https://discord.com/api/v10/webhooks/${appId}/${interaction.token}/messages/@original`;
  const respond = (content: string) => fetch(editUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });

  if (!title) {
    await respond("A title is required.");
    return;
  }

  try {
    const results = await searchMetadata(type, title);
    const best = results[0];
    if (!best) {
      await respond(`No ${type === "movie" ? "movie" : "TV show"} results found for "${title}".`);
      return;
    }
    if ((await findPossibleDuplicates(type, best.title, best.year)).length > 0) {
      await respond(`"${best.title}"${best.year ? ` (${best.year})` : ""} is already in the library.`);
      return;
    }
    const addedTitle = await addFromSearchResult(type, best);
    await respond(`Added **${addedTitle}**${best.year ? ` (${best.year})` : ""} — it'll be searched for on the next scheduled run.`);
  } catch (err) {
    log.warn("[discordInteractions] /request failed:", (err as Error).message);
    await respond(`Something went wrong requesting "${title}": ${(err as Error).message}`);
  }
}

discordInteractionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const publicKey = getSetting("discordPublicKey");
    const signature = req.header("X-Signature-Ed25519");
    const timestamp = req.header("X-Signature-Timestamp");
    const rawBody = (req as any).rawBody as Buffer | undefined;

    if (!publicKey || !signature || !timestamp || !rawBody || !verifyDiscordSignature(publicKey, signature, timestamp, rawBody)) {
      res.status(401).send("invalid request signature");
      return;
    }

    const interaction = req.body;

    // PING (type 1) — Discord sends this once when you first save the endpoint URL in the
    // Developer Portal, purely to confirm it's live and verifies signatures correctly.
    if (interaction.type === 1) {
      res.json({ type: 1 });
      return;
    }

    // APPLICATION_COMMAND (type 2) — respond immediately with "deferred" (type 5), then do the
    // real work in the background and PATCH the response in once it's ready.
    if (interaction.type === 2 && interaction.data?.name === "request") {
      res.json({ type: 5 });
      const appId = getSetting("discordApplicationId") ?? "";
      handleRequestCommand(interaction, appId).catch((err) => log.warn("[discordInteractions] deferred handler failed:", err.message));
      return;
    }

    res.json({ type: 4, data: { content: "Unrecognized command." } });
  })
);
