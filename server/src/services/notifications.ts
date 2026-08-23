import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger.js";
import { getSetting } from "./settingsStore.js";
import { sendPush } from "./push.js";
import { sendEmail } from "./smtp.js";
import { refreshMediaServerLibrary } from "./mediaServer.js";

const execFileAsync = promisify(execFile);

/**
 * Runs an admin-configured local script on each notification event, passing the same data every
 * other provider gets as `AONARR_*` environment variables — the same idea as Sonarr/Radarr's
 * "Custom Script" connection, for whatever automation (a personal Home Assistant call, a local log,
 * anything) a webhook alone can't cover. The script path is instance configuration set by the
 * admin themselves in Settings, not user-supplied input from an external source.
 */
async function runCustomScript(event: string, tokens: Record<string, string>): Promise<void> {
  const enabled = getSetting("customScriptEnabled");
  const scriptPath = getSetting("customScriptPath");
  if (enabled !== "1" || !scriptPath) return;

  const env: NodeJS.ProcessEnv = { ...process.env, AONARR_EVENT: event };
  for (const [key, value] of Object.entries(tokens)) {
    env[`AONARR_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`] = value;
  }

  try {
    await execFileAsync(scriptPath, [], { env, timeout: 30_000 });
  } catch (err) {
    throw new Error(`Custom script failed: ${(err as Error).message}`);
  }
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Webhook POST to ${url} failed: HTTP ${res.status}`);
  }
}

async function postForm(url: string, params: Record<string, string>): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    throw new Error(`POST to ${url} failed: HTTP ${res.status}`);
  }
}

interface NotificationContent {
  title: string;
  text: string; // plain text, used by Slack/Telegram/Pushover/generic
  color: number; // Discord embed color
  payload: Record<string, unknown>; // generic webhook body
}

async function fanOut(content: NotificationContent): Promise<void> {
  const discordUrl = getSetting("discordWebhookUrl");
  const slackUrl = getSetting("slackWebhookUrl");
  const genericUrl = getSetting("genericWebhookUrl");
  const telegramBotToken = getSetting("telegramBotToken");
  const telegramChatId = getSetting("telegramChatId");
  const pushoverApiToken = getSetting("pushoverApiToken");
  const pushoverUserKey = getSetting("pushoverUserKey");

  const jobs: Promise<void>[] = [];

  if (discordUrl) {
    jobs.push(
      postJson(discordUrl, { embeds: [{ title: content.title, description: content.text, color: content.color }] })
    );
  }
  if (slackUrl) {
    jobs.push(postJson(slackUrl, { text: `*${content.title}*\n${content.text}` }));
  }
  if (genericUrl) {
    jobs.push(postJson(genericUrl, content.payload));
  }
  if (telegramBotToken && telegramChatId) {
    jobs.push(
      postForm(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
        chat_id: telegramChatId,
        text: `${content.title}\n${content.text}`,
      })
    );
  }
  if (pushoverApiToken && pushoverUserKey) {
    jobs.push(
      postForm("https://api.pushover.net/1/messages.json", {
        token: pushoverApiToken,
        user: pushoverUserKey,
        title: content.title,
        message: content.text,
      })
    );
  }

  const matrixHomeserver = getSetting("matrixHomeserverUrl");
  const matrixAccessToken = getSetting("matrixAccessToken");
  const matrixRoomId = getSetting("matrixRoomId");
  if (matrixHomeserver && matrixAccessToken && matrixRoomId) {
    const txnId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const url = `${matrixHomeserver.replace(/\/+$/, "")}/_matrix/client/v3/rooms/${encodeURIComponent(
      matrixRoomId
    )}/send/m.room.message/${txnId}?access_token=${encodeURIComponent(matrixAccessToken)}`;
    jobs.push(
      (async () => {
        const res = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgtype: "m.text", body: `${content.title}\n${content.text}` }),
        });
        if (!res.ok) throw new Error(`Matrix send failed: HTTP ${res.status}`);
      })()
    );
  }

  const twilioSid = getSetting("twilioAccountSid");
  const twilioToken = getSetting("twilioAuthToken");
  const twilioFrom = getSetting("twilioFromNumber");
  const twilioTo = getSetting("twilioToNumber");
  if (twilioSid && twilioToken && twilioFrom && twilioTo) {
    jobs.push(
      (async () => {
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ From: twilioFrom, To: twilioTo, Body: `${content.title}: ${content.text}` }),
        });
        if (!res.ok) throw new Error(`SMS (Twilio) send failed: HTTP ${res.status}`);
      })()
    );
  }

  const smtpHost = getSetting("smtpHost");
  const smtpTo = getSetting("smtpTo");
  const smtpFrom = getSetting("smtpFrom");
  if (smtpHost && smtpTo && smtpFrom) {
    jobs.push(
      sendEmail(
        {
          host: smtpHost,
          port: Number(getSetting("smtpPort") || 587),
          secure: getSetting("smtpSecure") === "1",
          username: getSetting("smtpUsername") || undefined,
          password: getSetting("smtpPassword") || undefined,
          from: smtpFrom,
          to: smtpTo,
        },
        `AoNarr: ${content.title}`,
        content.text
      )
    );
  }

  // Web push always fans out too — it has no separate "configured" gate since it's opt-in per
  // browser (no subscriptions means no-op), unlike the webhook/bot providers above.
  jobs.push(sendPush(content.title, content.text));

  const { event, ...tokens } = content.payload as { event: string } & Record<string, string>;
  jobs.push(runCustomScript(event, tokens));

  const settled = await Promise.allSettled(jobs);
  for (const s of settled) {
    if (s.status === "rejected") log.warn("[notifications]", s.reason?.message ?? s.reason);
  }
}

const DEFAULT_TEMPLATES = {
  grabbed: "{mediaTitle}\n{releaseTitle}",
  imported: "{mediaTitle}\n{fileName}",
  failed: "{mediaTitle}: {reason}",
};

/** Renders a {token}-based template from Settings, falling back to the built-in default when
 * unset or when it references a token this event doesn't have (rather than leaving a literal
 * "{typo}" in the sent message). */
function renderTemplate(settingKey: string, defaultTemplate: string, tokens: Record<string, string>): string {
  const template = getSetting(settingKey) || defaultTemplate;
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in tokens ? tokens[key] : match));
}

export async function notifyGrabbed(mediaTitle: string, releaseTitle: string): Promise<void> {
  await fanOut({
    title: "Grabbed",
    text: renderTemplate("notifyTemplateGrabbed", DEFAULT_TEMPLATES.grabbed, { mediaTitle, releaseTitle }),
    color: 0x4f8cff,
    payload: { event: "grabbed", mediaTitle, releaseTitle },
  });
}

/**
 * `filePath` is separate from the human-readable `fileName` shown in the notification text — it's
 * only used, when present, to tell the configured media server to pick up the new file (see
 * mediaServer.ts's refreshMediaServerLibrary) rather than waiting for its own scan interval. Opt-in
 * via the `mediaServerRefreshOnImport` setting, off by default so upgrading doesn't change behavior
 * for anyone who already has a media server configured just for watch-state sync.
 */
export async function notifyImported(mediaTitle: string, fileName: string, filePath?: string): Promise<void> {
  await fanOut({
    title: "Imported",
    text: renderTemplate("notifyTemplateImported", DEFAULT_TEMPLATES.imported, { mediaTitle, fileName }),
    color: 0x4fbf6a,
    payload: { event: "imported", mediaTitle, fileName },
  });

  if (filePath && getSetting("mediaServerRefreshOnImport") === "1") {
    refreshMediaServerLibrary(filePath).catch((err) => log.warn("[notifications] media server refresh failed:", err.message));
  }
}

export async function notifyFailed(mediaTitle: string, reason: string): Promise<void> {
  await fanOut({
    title: "Failed",
    text: renderTemplate("notifyTemplateFailed", DEFAULT_TEMPLATES.failed, { mediaTitle, reason }),
    color: 0xe05c5c,
    payload: { event: "failed", mediaTitle, reason },
  });
}
