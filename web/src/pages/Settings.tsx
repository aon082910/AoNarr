import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, downloadFile, setApiKey } from "../api/client.js";
import FolderPicker from "../components/FolderPicker.js";
import NamingSetupModal from "../components/NamingSetupModal.js";
import SettingsProviderTiles, { type SettingsProviderDef } from "../components/SettingsProviderTiles.js";
import SettingsSectionTiles from "../components/SettingsSectionTiles.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { BlocklistEntry, CustomFormat, ImportExclusion, MediaType, Quality, QualityProfile, RootFolder, Tag } from "../types.js";
import { formatBytes } from "../utils/format.js";

interface FormatScore extends CustomFormat {
  score: number;
}

interface SubtitleProvider {
  id: number;
  name: string;
  type: string;
  languages: string;
  enabled: 0 | 1;
}

/** Fired on grab/import/failure events (and Custom Script, run on the same events). Leaving a
 * provider's fields blank disables it; SMTP/Twilio need every listed field set, not just one. */
const NOTIFICATION_PROVIDERS: SettingsProviderDef[] = [
  {
    key: "discord",
    label: "Discord",
    fields: [{ key: "discordWebhookUrl", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/..." }],
    isConfigured: (s) => !!s.discordWebhookUrl,
  },
  {
    key: "slack",
    label: "Slack",
    fields: [{ key: "slackWebhookUrl", label: "Webhook URL", placeholder: "https://hooks.slack.com/services/..." }],
    isConfigured: (s) => !!s.slackWebhookUrl,
  },
  {
    key: "generic",
    label: "Generic Webhook",
    description: "Receives the raw event payload as JSON — for anything without built-in support.",
    fields: [{ key: "genericWebhookUrl", label: "Webhook URL", placeholder: "https://example.com/hooks/aonarr" }],
    isConfigured: (s) => !!s.genericWebhookUrl,
  },
  {
    key: "telegram",
    label: "Telegram",
    fields: [
      { key: "telegramBotToken", label: "Bot token", placeholder: "123456:ABC-DEF..." },
      { key: "telegramChatId", label: "Chat ID", placeholder: "-100123456789" },
    ],
    isConfigured: (s) => !!s.telegramBotToken && !!s.telegramChatId,
  },
  {
    key: "pushover",
    label: "Pushover",
    fields: [
      { key: "pushoverApiToken", label: "API token" },
      { key: "pushoverUserKey", label: "User key" },
    ],
    isConfigured: (s) => !!s.pushoverApiToken && !!s.pushoverUserKey,
  },
  {
    key: "smtp",
    label: "Email (SMTP)",
    fields: [
      { key: "smtpHost", label: "SMTP host", placeholder: "smtp.gmail.com" },
      { key: "smtpPort", label: "SMTP port", placeholder: "587" },
      {
        key: "smtpSecure",
        label: "Encryption",
        type: "select",
        options: [
          { value: "0", label: "STARTTLS (587/25)" },
          { value: "1", label: "Implicit TLS (465)" },
        ],
      },
      { key: "smtpUsername", label: "Username" },
      { key: "smtpPassword", label: "Password", type: "password" },
      { key: "smtpFrom", label: "Send from", placeholder: "aonarr@yourdomain.com" },
      { key: "smtpTo", label: "Send to", placeholder: "you@yourdomain.com" },
    ],
    isConfigured: (s) => !!s.smtpHost && !!s.smtpFrom && !!s.smtpTo,
  },
  {
    key: "matrix",
    label: "Matrix",
    fields: [
      { key: "matrixHomeserverUrl", label: "Homeserver URL", placeholder: "https://matrix.org" },
      { key: "matrixAccessToken", label: "Access token" },
      { key: "matrixRoomId", label: "Room ID", placeholder: "!roomid:matrix.org" },
    ],
    isConfigured: (s) => !!s.matrixHomeserverUrl && !!s.matrixAccessToken && !!s.matrixRoomId,
  },
  {
    key: "twilio",
    label: "SMS (Twilio)",
    fields: [
      { key: "twilioAccountSid", label: "Account SID" },
      { key: "twilioAuthToken", label: "Auth token", type: "password" },
      { key: "twilioFromNumber", label: "From number", placeholder: "+15551234567" },
      { key: "twilioToNumber", label: "To number", placeholder: "+15557654321" },
    ],
    isConfigured: (s) => !!s.twilioAccountSid && !!s.twilioAuthToken && !!s.twilioFromNumber && !!s.twilioToNumber,
  },
  {
    key: "customScript",
    label: "Custom Script",
    description: "Invoked directly (no shell) with event data as AONARR_* environment variables.",
    fields: [
      {
        key: "customScriptEnabled",
        label: "Enable",
        type: "select",
        options: [
          { value: "0", label: "Disabled" },
          { value: "1", label: "Enabled" },
        ],
      },
      {
        key: "customScriptPath",
        label: "Script path (inside the container; must be executable)",
        placeholder: "/config/scripts/on-event.sh",
        helpText: "chmod +x it and mount it into the container (e.g. under /config).",
      },
    ],
    isConfigured: (s) => s.customScriptEnabled === "1" && !!s.customScriptPath,
  },
];

/** MusicBrainz/Open Library/Deezer/TVmaze need no key so aren't listed here — Add Media can
 * always fall back to them regardless of what's configured on this page. */
const METADATA_PROVIDERS: SettingsProviderDef[] = [
  {
    key: "tmdb",
    label: "TMDB",
    description: "Movies & TV series",
    fields: [{ key: "tmdbApiKey", label: "API key", placeholder: "themoviedb.org/settings/api" }],
    isConfigured: (s) => !!s.tmdbApiKey,
  },
  {
    key: "omdb",
    label: "OMDb",
    description: "Movies",
    fields: [{ key: "omdbApiKey", label: "API key", placeholder: "omdbapi.com/apikey.aspx" }],
    isConfigured: (s) => !!s.omdbApiKey,
  },
  {
    key: "tvdb",
    label: "TVDB",
    description: "Series",
    fields: [{ key: "tvdbApiKey", label: "API key", placeholder: "thetvdb.com/api-information" }],
    isConfigured: (s) => !!s.tvdbApiKey,
  },
  {
    key: "trakt",
    label: "Trakt",
    description: "Movies & TV series",
    fields: [{ key: "traktClientId", label: "Client ID", placeholder: "trakt.tv/oauth/applications" }],
    isConfigured: (s) => !!s.traktClientId,
  },
  {
    key: "discogs",
    label: "Discogs",
    description: "Artists",
    fields: [{ key: "discogsToken", label: "Personal access token", placeholder: "discogs.com/settings/developers" }],
    isConfigured: (s) => !!s.discogsToken,
  },
  {
    key: "googleBooks",
    label: "Google Books",
    description: "Authors, optional — works without one at low volume",
    fields: [{ key: "googleBooksApiKey", label: "API key" }],
    isConfigured: (s) => !!s.googleBooksApiKey,
  },
  {
    key: "lastfm",
    label: "Last.fm",
    description: "Artists",
    fields: [{ key: "lastfmApiKey", label: "API key", placeholder: "last.fm/api/account/create" }],
    isConfigured: (s) => !!s.lastfmApiKey,
  },
  {
    key: "fanart",
    label: "Fanart.tv",
    description: "Artwork — not a search provider, see Artwork below",
    fields: [{ key: "fanartApiKey", label: "API key", placeholder: "fanart.tv/get-an-api-key" }],
    isConfigured: (s) => !!s.fanartApiKey,
  },
  {
    key: "comicvine",
    label: "Comic Vine",
    description: "Comics",
    fields: [{ key: "comicVineApiKey", label: "API key", placeholder: "comicvine.gamespot.com/api/" }],
    isConfigured: (s) => !!s.comicVineApiKey,
  },
  {
    key: "rawg",
    label: "RAWG",
    description: "ROMs",
    fields: [{ key: "rawgApiKey", label: "API key", placeholder: "rawg.io/apidocs" }],
    isConfigured: (s) => !!s.rawgApiKey,
  },
  {
    key: "igdb",
    label: "IGDB",
    description: "ROMs, alternative to RAWG",
    fields: [
      { key: "igdbClientId", label: "Client ID", placeholder: "dev.twitch.tv/console/apps (IGDB uses Twitch auth)" },
      { key: "igdbClientSecret", label: "Client Secret" },
    ],
    isConfigured: (s) => !!s.igdbClientId && !!s.igdbClientSecret,
  },
  {
    key: "youtube",
    label: "YouTube Data API",
    description: "Online videos",
    fields: [{ key: "youtubeApiKey", label: "API key", placeholder: "console.cloud.google.com — enable YouTube Data API v3" }],
    isConfigured: (s) => !!s.youtubeApiKey,
  },
  {
    key: "theporndb",
    label: "ThePornDB",
    description: "Adult",
    fields: [{ key: "thePornDbApiKey", label: "API key", placeholder: "theporndb.net/dashboard/api-keys" }],
    isConfigured: (s) => !!s.thePornDbApiKey,
  },
];

export default function Settings() {
  const mediaTypes = useMediaTypes();
  const [rootFolders, setRootFolders] = useState<RootFolder[]>([]);
  const [profiles, setProfiles] = useState<QualityProfile[]>([]);
  const [providers, setProviders] = useState<SubtitleProvider[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const templateInputRef = useRef<HTMLInputElement>(null);
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [totpDisableCode, setTotpDisableCode] = useState("");
  const [tab, setTab] = useState("general");

  const [folderPath, setFolderPath] = useState("");
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [namingModalType, setNamingModalType] = useState<MediaType | null>(null);
  const [folderType, setFolderType] = useState<MediaType>("movie");

  const [metadataProviders, setMetadataProviders] = useState<Record<MediaType, string[]>>({
    movie: ["tmdb"],
    series: ["tmdb"],
    artist: ["musicbrainz"],
    author: ["openlibrary"],
  });
  const [qualities, setQualities] = useState<Quality[]>([]);
  const [profileName, setProfileName] = useState("");
  const [profileCutoff, setProfileCutoff] = useState("WEBDL-1080p");
  const [profileQualities, setProfileQualities] = useState<Set<string>>(new Set());

  const [subType, setSubType] = useState<"opensubtitles" | "custom">("opensubtitles");
  const [subName, setSubName] = useState("OpenSubtitles");
  const [subApiKey, setSubApiKey] = useState("");
  const [subLanguages, setSubLanguages] = useState("eng");
  const [subSearchUrlTemplate, setSubSearchUrlTemplate] = useState("");
  const [subResultsPath, setSubResultsPath] = useState("");
  const [subDownloadUrlField, setSubDownloadUrlField] = useState("downloadUrl");
  const [subLanguageField, setSubLanguageField] = useState("language");
  const [subReleaseField, setSubReleaseField] = useState("release");
  const [subHearingImpaired, setSubHearingImpaired] = useState("");
  const [subForeignPartsOnly, setSubForeignPartsOnly] = useState("");

  const [tagName, setTagName] = useState("");

  const [blocklist, setBlocklist] = useState<BlocklistEntry[]>([]);
  const [exclusions, setExclusions] = useState<ImportExclusion[]>([]);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [customFormats, setCustomFormats] = useState<CustomFormat[]>([]);
  const [formatName, setFormatName] = useState("");
  const [formatPatterns, setFormatPatterns] = useState("");
  const [formatMediaTypes, setFormatMediaTypes] = useState<Set<MediaType>>(new Set());
  const [trashJson, setTrashJson] = useState("");
  const [trashError, setTrashError] = useState<string | null>(null);
  const [trashSyncing, setTrashSyncing] = useState<"radarr" | "sonarr" | null>(null);
  const [scoreProfileId, setScoreProfileId] = useState<number | "">("");
  const [formatScores, setFormatScores] = useState<FormatScore[]>([]);

  function load() {
    api.get<RootFolder[]>("/root-folders").then(setRootFolders);
    api.get<QualityProfile[]>("/quality-profiles").then((p) => {
      setProfiles(p);
      if (p.length > 0 && scoreProfileId === "") setScoreProfileId(p[0].id);
    });
    api.get<SubtitleProvider[]>("/subtitles/providers").then(setProviders);
    api.get<Tag[]>("/tags").then(setTags);
    api.get<CustomFormat[]>("/custom-formats").then(setCustomFormats);
    api.get<BlocklistEntry[]>("/blocklist").then(setBlocklist);
    api.get<ImportExclusion[]>("/import-exclusions").then(setExclusions);
    api.get<Quality[]>("/qualities").then((q) => {
      setQualities(q);
      setProfileQualities((prev) => (prev.size === 0 ? new Set(q.map((x) => x.name)) : prev));
    });
    api.get<Record<string, string>>("/settings").then(setSettings);
    api.get<Record<MediaType, string[]>>("/metadata/providers").then(setMetadataProviders);
  }
  useEffect(load, []);

  async function renameQuality(id: number, name: string) {
    await api.patch(`/qualities/${id}`, { name });
    load();
  }

  async function saveQualitySize(id: number, field: "minSizeMb" | "maxSizeMb" | "preferredSizeMb", value: string) {
    await api.patch(`/qualities/${id}`, { [field]: value === "" ? null : Number(value) });
    load();
  }

  async function moveQuality(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= qualities.length) return;
    const reordered = [...qualities];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    await api.post("/qualities/reorder", { orderedIds: reordered.map((q) => q.id) });
    load();
  }

  function toggleProfileQuality(name: string) {
    setProfileQualities((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  useEffect(() => {
    if (scoreProfileId === "") return;
    api.get<FormatScore[]>(`/custom-formats/scores/${scoreProfileId}`).then(setFormatScores);
  }, [scoreProfileId, customFormats]);

  /**
   * One condition group per line: comma-separated patterns are OR'd within the group; a line
   * starting with "NOT " negates the group. Special prefixes switch the condition type:
   *   SIZE: min-max        release size in MB (either bound optional, e.g. "SIZE: 2000-")
   *   LANG: french, multi  any of these detected language tags
   *   GROUP: RARBG, EVO    regex against the parsed release-group tag
   * Anything else is a title regex condition. All lines/groups are AND'd together. E.g.:
   *   REMUX, BluRay
   *   NOT x265
   *   SIZE: 4000-15000
   *   NOT LANG: french
   * means "(REMUX or BluRay) and not x265 and 4000-15000 MB and not French".
   */
  function parseConditionGroups(text: string) {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const negate = /^NOT\s+/i.test(line);
        const rest = negate ? line.replace(/^NOT\s+/i, "") : line;

        const sizeMatch = rest.match(/^SIZE:\s*(\d+)?\s*-\s*(\d+)?$/i);
        if (sizeMatch) {
          const minMb = sizeMatch[1] ? Number(sizeMatch[1]) : null;
          const maxMb = sizeMatch[2] ? Number(sizeMatch[2]) : null;
          return { type: "size" as const, minMb, maxMb, negate };
        }

        const langMatch = rest.match(/^LANG:\s*(.+)$/i);
        if (langMatch) {
          const languages = langMatch[1].split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
          return { type: "language" as const, languages, negate };
        }

        const groupMatch = rest.match(/^GROUP:\s*(.+)$/i);
        if (groupMatch) {
          const patterns = groupMatch[1].split(",").map((p) => p.trim()).filter(Boolean);
          return { type: "releaseGroup" as const, patterns, negate };
        }

        const sourceMatch = rest.match(/^SOURCE:\s*(.+)$/i);
        if (sourceMatch) {
          const sources = sourceMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
          return { type: "source" as const, sources, negate };
        }

        const resolutionMatch = rest.match(/^RESOLUTION:\s*(.+)$/i);
        if (resolutionMatch) {
          const resolutions = resolutionMatch[1].split(",").map((r) => r.trim().toLowerCase()).filter(Boolean);
          return { type: "resolution" as const, resolutions, negate };
        }

        const yearMatch = rest.match(/^YEAR:\s*(\d+)?\s*-\s*(\d+)?$/i);
        if (yearMatch) {
          const minYear = yearMatch[1] ? Number(yearMatch[1]) : null;
          const maxYear = yearMatch[2] ? Number(yearMatch[2]) : null;
          return { type: "year" as const, minYear, maxYear, negate };
        }

        const flagsMatch = rest.match(/^FLAGS:\s*(.+)$/i);
        if (flagsMatch) {
          const flags = flagsMatch[1].split(",").map((f) => f.trim().toLowerCase()).filter(Boolean);
          return { type: "releaseFlags" as const, flags, negate };
        }

        const patterns = rest
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        return { type: "title" as const, patterns, negate };
      })
      .filter((g) => {
        if (g.type === "size") return g.minMb != null || g.maxMb != null;
        if (g.type === "year") return g.minYear != null || g.maxYear != null;
        if (g.type === "language") return g.languages.length > 0;
        if (g.type === "source") return g.sources.length > 0;
        if (g.type === "resolution") return g.resolutions.length > 0;
        if (g.type === "releaseFlags") return g.flags.length > 0;
        return g.patterns.length > 0;
      });
  }

  async function addCustomFormat(e: FormEvent) {
    e.preventDefault();
    const conditionGroups = parseConditionGroups(formatPatterns);
    if (!formatName.trim() || conditionGroups.length === 0) return;
    await api.post("/custom-formats", {
      name: formatName.trim(),
      conditionGroups,
      mediaTypes: Array.from(formatMediaTypes),
    });
    setFormatName("");
    setFormatPatterns("");
    setFormatMediaTypes(new Set());
    load();
  }

  function toggleFormatMediaType(type: MediaType) {
    setFormatMediaTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  async function removeCustomFormat(id: number) {
    await api.del(`/custom-formats/${id}`);
    load();
  }

  async function saveCustomFormatMediaTypes(id: number, mediaTypes: MediaType[]) {
    await api.patch(`/custom-formats/${id}`, { mediaTypes });
    load();
  }

  async function importTrashFormat() {
    if (!trashJson.trim()) return;
    setTrashError(null);
    try {
      const result = await api.post<{ format: CustomFormat; skipped: string[] }>("/custom-formats/import-trash", {
        json: trashJson,
      });
      setTrashJson("");
      if (result.skipped.length > 0) {
        alert(`Imported "${result.format.name}" — skipped unsupported condition type(s): ${result.skipped.join(", ")}`);
      }
      load();
    } catch (e) {
      setTrashError((e as Error).message);
    }
  }

  async function syncTrashFormats(app: "radarr" | "sonarr") {
    setTrashSyncing(app);
    try {
      await api.post("/custom-formats/trash-sync", { app });
      alert(
        `Syncing ${app === "radarr" ? "Radarr" : "Sonarr"} formats from TRaSH-Guides in the background — this can take a minute for 100+ formats. Check the Logs page for the result, or refresh this list shortly.`
      );
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setTrashSyncing(null);
    }
  }

  async function removeBlocklistEntry(id: number) {
    await api.del(`/blocklist/${id}`);
    load();
  }

  async function removeExclusion(id: number) {
    await api.del(`/import-exclusions/${id}`);
    load();
  }

  async function showWebhookUrl() {
    const result = await api.get<{ token: string }>("/settings/media-server-webhook-token");
    setWebhookUrl(`${window.location.origin}/api/webhooks/media-server?token=${result.token}`);
  }

  async function regenerateWebhookToken() {
    if (!confirm("Regenerate the webhook URL? Your media server's webhook config will need updating with the new URL.")) return;
    const result = await api.post<{ token: string }>("/settings/media-server-webhook-token/regenerate", {});
    setWebhookUrl(`${window.location.origin}/api/webhooks/media-server?token=${result.token}`);
  }

  async function saveFormatScore(formatId: number, score: number) {
    if (scoreProfileId === "") return;
    await api.put(`/custom-formats/scores/${scoreProfileId}/${formatId}`, { score });
    setFormatScores((prev) => prev.map((f) => (f.id === formatId ? { ...f, score } : f)));
  }

  async function saveMinFormatScore(profileId: number, minFormatScore: number) {
    await api.patch(`/quality-profiles/${profileId}`, { minFormatScore });
    setProfiles((prev) => prev.map((p) => (p.id === profileId ? { ...p, minFormatScore } : p)));
  }

  async function addTag(e: FormEvent) {
    e.preventDefault();
    if (!tagName.trim()) return;
    await api.post("/tags", { name: tagName.trim() });
    setTagName("");
    load();
  }

  async function removeTag(id: number) {
    await api.del(`/tags/${id}`);
    load();
  }

  async function updateTagRetention(id: number, value: string) {
    const retentionDays = value === "" ? null : Number(value);
    await api.patch(`/tags/${id}`, { retentionDays });
    load();
  }

  async function regenerateApiKey() {
    if (!confirm("Regenerate the API key? Anything else using the old key will stop working.")) return;
    const result = await api.post<{ key: string; value: string }>("/settings/api-key/regenerate");
    setApiKey(result.value);
    setSettings((prev) => ({ ...prev, apiKey: result.value }));
  }

  async function startTotpSetup() {
    const result = await api.post<{ secret: string; otpauthUrl: string }>("/settings/totp/setup", {});
    setTotpSetup(result);
    setTotpCode("");
  }

  async function confirmTotpSetup() {
    try {
      await api.post("/settings/totp/verify", { code: totpCode });
      alert("Two-factor authentication enabled.");
      setTotpSetup(null);
      setTotpCode("");
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function disableTotp() {
    try {
      await api.post("/settings/totp/disable", { code: totpDisableCode });
      alert("Two-factor authentication disabled.");
      setTotpDisableCode("");
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function exportTemplate() {
    await downloadFile("/settings/template/export", "aonarr-template.json");
  }

  async function importTemplate(file: File) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const result = await api.post<{
        qualitiesImported: number;
        profilesImported: number;
        formatsImported: number;
        scoresImported: number;
        namingImported: number;
      }>("/settings/template/import", parsed);
      alert(
        `Imported: ${result.qualitiesImported} qualities, ${result.profilesImported} profiles, ` +
          `${result.formatsImported} custom formats, ${result.scoresImported} format scores, ${result.namingImported} naming templates.`
      );
      load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      if (templateInputRef.current) templateInputRef.current.value = "";
    }
  }

  async function saveSetting(key: string, value: string) {
    setSavingKey(key);
    try {
      await api.put(`/settings/${key}`, { value });
      setSettings((prev) => ({ ...prev, [key]: value }));
    } finally {
      setSavingKey(null);
    }
  }

  async function addFolder(e: FormEvent) {
    e.preventDefault();
    if (!folderPath) return;
    await api.post("/root-folders", { path: folderPath, mediaType: folderType });
    setFolderPath("");
    load();
  }

  async function removeFolder(id: number) {
    await api.del(`/root-folders/${id}`);
    load();
  }

  async function updateFolderQuota(id: number, field: "quotaPercent" | "pauseGrabsAtQuota", value: number | boolean | null) {
    await api.patch(`/root-folders/${id}`, { [field]: value });
    load();
  }

  async function addProfile(e: FormEvent) {
    e.preventDefault();
    if (!profileName || profileQualities.size === 0) return;
    await api.post("/quality-profiles", {
      name: profileName,
      allowedQualities: qualities.filter((q) => profileQualities.has(q.name)).map((q) => q.name),
      cutoff: profileCutoff,
    });
    setProfileName("");
    load();
  }

  async function removeProfile(id: number) {
    await api.del(`/quality-profiles/${id}`);
    load();
  }

  async function addProvider(e: FormEvent) {
    e.preventDefault();
    if (subType === "opensubtitles") {
      if (!subApiKey) return;
      await api.post("/subtitles/providers", {
        name: subName,
        type: subType,
        apiKey: subApiKey,
        languages: subLanguages,
        config: {
          ...(subHearingImpaired ? { hearingImpaired: subHearingImpaired } : {}),
          ...(subForeignPartsOnly ? { foreignPartsOnly: subForeignPartsOnly } : {}),
        },
      });
    } else {
      if (!subSearchUrlTemplate || !subDownloadUrlField) return;
      await api.post("/subtitles/providers", {
        name: subName,
        type: subType,
        apiKey: subApiKey || null,
        languages: subLanguages,
        config: {
          searchUrlTemplate: subSearchUrlTemplate,
          resultsPath: subResultsPath || undefined,
          downloadUrlField: subDownloadUrlField,
          languageField: subLanguageField || undefined,
          releaseField: subReleaseField || undefined,
        },
      });
    }
    setSubApiKey("");
    setSubSearchUrlTemplate("");
    setSubResultsPath("");
    load();
  }

  async function removeProvider(id: number) {
    await api.del(`/subtitles/providers/${id}`);
    load();
  }

  return (
    <div>
      <h1>Settings</h1>

      <div className="settings-tabs" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
        {[
          ["general", "General"],
          ["metadata", "Metadata Providers"],
          ["notifications", "Notifications"],
          ["media", "Media Management"],
          ["indexers", "Indexer Options"],
          ["library", "Library Sync"],
          ["quality", "Quality"],
          ["subtitles", "Import & Subtitles"],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "" : "secondary"}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ display: tab === "general" ? undefined : "none" }}>
      <h2>General</h2>
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
          Used when AoNarr needs to build a link back to itself from somewhere other than your
          browser — e.g. share links, if the URL your browser is on doesn't match your actual
          public URL (common behind a reverse proxy). Leave blank to just use the browser's URL.
        </p>
        <label>External URL</label>
        <input
          key={settings.externalUrl ?? "external-url-empty"}
          defaultValue={settings.externalUrl ?? ""}
          placeholder="https://aonarr.example.com"
          onBlur={(e) => saveSetting("externalUrl", e.target.value.replace(/\/+$/, ""))}
        />
      </div>

      <h2>Custom Theme</h2>
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
          Raw CSS, loaded after AoNarr's own stylesheet for everyone (no login required to load
          it, same as the stylesheet itself) — so it can override anything, including the color
          variables the built-in dark/light themes use:
          <br />
          <code>{"--bg --panel --border --text --muted --accent --accent-dim --danger --ok --input-bg"}</code>
          <br />
          e.g. <code>{":root { --accent: #ff6b35; }"}</code> to change the accent color instance-wide.
          Takes effect on next page load for everyone, no restart needed.
        </p>
        <textarea
          key={settings.customThemeCss ?? "theme-css-empty"}
          defaultValue={settings.customThemeCss ?? ""}
          rows={6}
          placeholder={":root {\n  --accent: #ff6b35;\n}"}
          onBlur={(e) => saveSetting("customThemeCss", e.target.value)}
        />
      </div>

      <h2>Security</h2>
      <div className="form-panel">
        <label>API key</label>
        <input value={settings.apiKey ?? ""} readOnly />
        <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
          Required by every request to this instance's API. The web UI already stores it after you
          logged in with it.
        </p>
        <button type="button" className="danger" onClick={regenerateApiKey}>
          Regenerate
        </button>
      </div>

      <h2>Two-Factor Authentication</h2>
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
          Adds a second step to the admin web login (an authenticator-app code, after the API
          key). This only gates the web UI's login screen — the API key itself is still the
          credential every API request uses, the same way a real Starr app works; there's no
          per-request 2FA check.
        </p>
        {settings.totpEnabled === "1" ? (
          <>
            <p>
              <span className="badge ok">Enabled</span>
            </p>
            <label>Enter a current code to disable</label>
            <input value={totpDisableCode} onChange={(e) => setTotpDisableCode(e.target.value)} maxLength={6} />
            <button type="button" className="danger" onClick={disableTotp}>
              Disable 2FA
            </button>
          </>
        ) : totpSetup ? (
          <>
            <p style={{ fontSize: "0.85rem" }}>
              Add this to an authenticator app (Google Authenticator, Authy, 1Password, etc.) —
              scan-by-URL isn't available here, so enter the secret manually as a "time-based"
              key:
            </p>
            <label>Secret</label>
            <input value={totpSetup.secret} readOnly />
            <label>otpauth URL (some apps accept pasting this directly)</label>
            <input value={totpSetup.otpauthUrl} readOnly />
            <label>Enter the 6-digit code from your app to confirm</label>
            <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} maxLength={6} autoFocus />
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={confirmTotpSetup}>
                Confirm &amp; enable
              </button>
              <button type="button" className="secondary" onClick={() => setTotpSetup(null)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <button type="button" onClick={startTotpSetup}>
            Set up 2FA
          </button>
        )}
      </div>

      <h2>Recycle Bin</h2>
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
          Files removed with "delete files" go here instead of being deleted outright, until the
          scheduled cleanup job (Jobs page) purges them. See the Recycle Bin page to restore or
          permanently delete an entry early.
        </p>
        <label>Recycle bin</label>
        <select
          key={settings.recycleBinEnabled ?? "recycle-enabled-empty"}
          defaultValue={settings.recycleBinEnabled ?? "1"}
          onChange={(e) => saveSetting("recycleBinEnabled", e.target.value)}
        >
          <option value="1">Enabled</option>
          <option value="0">Disabled (delete files outright)</option>
        </select>
        <label>Retention (days)</label>
        <input
          type="number"
          style={{ maxWidth: 120 }}
          key={settings.recycleBinRetentionDays ?? "recycle-days-empty"}
          defaultValue={settings.recycleBinRetentionDays ?? "30"}
          onBlur={(e) => saveSetting("recycleBinRetentionDays", e.target.value)}
        />
        <label>Recycle bin directory (blank = config dir's recycle-bin/ folder)</label>
        <input
          key={settings.recycleBinDir ?? "recycle-dir-empty"}
          defaultValue={settings.recycleBinDir ?? ""}
          placeholder="/config/recycle-bin"
          onBlur={(e) => saveSetting("recycleBinDir", e.target.value)}
        />
        <label>Corrupt media</label>
        <select
          key={settings.corruptMediaReviewEnabled ?? "corrupt-review-empty"}
          defaultValue={settings.corruptMediaReviewEnabled ?? "0"}
          onChange={(e) => saveSetting("corruptMediaReviewEnabled", e.target.value)}
        >
          <option value="0">Recycle automatically when the corrupt-media check flags a file</option>
          <option value="1">Hold for review on the Recycle Bin page before recycling</option>
        </select>
      </div>

      <h2>Config Template</h2>
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
          A portable bundle of the quality ladder, quality profiles, custom formats + their
          per-profile scores, and naming templates — everything about "how releases get picked
          and organized," with nothing instance-specific (no API keys, indexers, download
          clients, root folders, or users). Useful for sharing a setup or reusing it on another
          AoNarr instance. Re-importing updates existing entries by name rather than duplicating
          them. For a full instance backup, use System → Backup &amp; Restore instead.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="secondary" onClick={exportTemplate}>
            Export template
          </button>
          <button type="button" className="secondary" onClick={() => templateInputRef.current?.click()}>
            Import template...
          </button>
          <input
            ref={templateInputRef}
            type="file"
            accept=".json"
            style={{ display: "none" }}
            onChange={(e) => e.target.files?.[0] && importTemplate(e.target.files[0])}
          />
        </div>
      </div>

      </div>
      <div style={{ display: tab === "metadata" ? undefined : "none" }}>
      <h2>Metadata Providers</h2>
      <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
        MusicBrainz, Open Library, Deezer, and TVmaze need no key. Add keys/tokens below for the
        rest as you need them — Add Media lets you pick a provider per search regardless of the
        default set here.
      </p>
      <SettingsProviderTiles providers={METADATA_PROVIDERS} settings={settings} saveSetting={saveSetting} />
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
          Courses has no metadata search provider — public course catalogs (Udemy, Coursera, etc.)
          don't offer an open search API, so Courses is always added manually.
        </p>

        <h3 style={{ marginBottom: 4 }}>Default provider per type</h3>
        {mediaTypes
          .filter((t) => t.hasMetadataSearch)
          .map((t) => {
            const key = `default${t.key.charAt(0).toUpperCase()}${t.key.slice(1)}Provider`;
            return (
              <div key={t.key}>
                <label>{t.label}</label>
                <select
                  key={settings[key] ?? `${key}-empty`}
                  defaultValue={settings[key] ?? metadataProviders[t.key]?.[0]}
                  onChange={(e) => saveSetting(key, e.target.value)}
                >
                  {(metadataProviders[t.key] ?? []).map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
      </div>

      </div>
      <div style={{ display: tab === "notifications" ? undefined : "none" }}>
      <h2>Notifications</h2>
      <SettingsProviderTiles providers={NOTIFICATION_PROVIDERS} settings={settings} saveSetting={saveSetting} />

      <h2>Notification Message Templates</h2>
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
          Customize the message text sent to every enabled provider above. Leave blank to use the
          default.
        </p>
        <label>Grabbed — tokens: {"{mediaTitle}"} {"{releaseTitle}"}</label>
        <input
          key={settings.notifyTemplateGrabbed ?? "notify-grabbed-empty"}
          defaultValue={settings.notifyTemplateGrabbed ?? ""}
          placeholder={"{mediaTitle}\\n{releaseTitle}"}
          onBlur={(e) => saveSetting("notifyTemplateGrabbed", e.target.value)}
        />
        <label>Imported — tokens: {"{mediaTitle}"} {"{fileName}"}</label>
        <input
          key={settings.notifyTemplateImported ?? "notify-imported-empty"}
          defaultValue={settings.notifyTemplateImported ?? ""}
          placeholder={"{mediaTitle}\\n{fileName}"}
          onBlur={(e) => saveSetting("notifyTemplateImported", e.target.value)}
        />
        <label>Failed — tokens: {"{mediaTitle}"} {"{reason}"}</label>
        <input
          key={settings.notifyTemplateFailed ?? "notify-failed-empty"}
          defaultValue={settings.notifyTemplateFailed ?? ""}
          placeholder={"{mediaTitle}: {reason}"}
          onBlur={(e) => saveSetting("notifyTemplateFailed", e.target.value)}
        />
      </div>

      </div>
      <div style={{ display: tab === "media" ? undefined : "none" }}>
      <SettingsSectionTiles
        sections={[
          {
            key: "naming",
            label: "Naming",
            description: "File & folder naming templates per library type",
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  Click "Naming setup..." for a library type to open a picker with the tokens available for
                  that type, a live preview, and the option to turn renaming off entirely (keep files as
                  downloaded — the folder structure still applies so things stay organized, only the
                  filename itself is left alone).
                </p>
                {mediaTypes.map((t) => {
                  const templateKey = `naming${t.key.charAt(0).toUpperCase()}${t.key.slice(1)}Template`;
                  const enabledKey = `namingEnabled${t.key.charAt(0).toUpperCase()}${t.key.slice(1)}`;
                  const shapeDefault =
                    t.shape === "single"
                      ? "{title} ({year})/{title} ({year})"
                      : t.shape === "episodic"
                      ? "{parentTitle}/Season {season:00}/{parentTitle} - S{season:00}E{episode:00}"
                      : "{parentTitle}/{childTitle}";
                  const isEnabled = settings[enabledKey] !== "0";
                  return (
                    <div key={t.key} className="toolbar" style={{ justifyContent: "space-between", gap: 12 }}>
                      <div>
                        <strong>{t.label}</strong>
                        <div style={{ fontFamily: "monospace", fontSize: "0.8rem", color: "var(--muted)" }}>
                          {isEnabled ? settings[templateKey] ?? shapeDefault : "renaming disabled"}
                        </div>
                      </div>
                      <button type="button" className="secondary" onClick={() => setNamingModalType(t.key)}>
                        Naming setup...
                      </button>
                    </div>
                  );
                })}
              </div>
            ),
          },
          {
            key: "minimumAvailability",
            label: "Minimum Availability",
            description: "Delay auto-search until a movie actually releases",
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  Applies to single-file libraries (Movies, ROMs, Adult) — set per item on its own
                  page, defaulting to whatever's chosen here when added. "Announced" searches as
                  soon as it's added, same as always. "In cinemas" waits until the release date
                  AoNarr has on file has passed. "Released" waits release date plus the delay below
                  — an approximation of a digital/home-release window, since AoNarr only tracks one
                  release date per item rather than separate theatrical/digital/physical dates.
                  This only gates the scheduled auto-search; a manual search is never blocked.
                </p>
                <label>Default for newly-added movies</label>
                <select
                  key={settings.defaultMinimumAvailability ?? "min-avail-empty"}
                  defaultValue={settings.defaultMinimumAvailability ?? "announced"}
                  onChange={(e) => saveSetting("defaultMinimumAvailability", e.target.value)}
                >
                  <option value="announced">Announced — search immediately</option>
                  <option value="inCinemas">In cinemas — wait for the release date</option>
                  <option value="released">Released — wait release date + delay below</option>
                </select>
                <label>"Released" delay (days after release date)</label>
                <input
                  type="number"
                  min={0}
                  style={{ maxWidth: 120 }}
                  key={settings.minimumAvailabilityReleasedDelayDays ?? "min-avail-delay-empty"}
                  defaultValue={settings.minimumAvailabilityReleasedDelayDays ?? "90"}
                  onBlur={(e) => saveSetting("minimumAvailabilityReleasedDelayDays", e.target.value)}
                />
              </div>
            ),
          },
          {
            key: "mediaServerSync",
            label: "Media Server Sync",
            description: "Watch-status sync, library scans, and auto-archival",
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  Connect a media server to enable any of the sync options below — each is independent, so
                  you can use watch-status sync (e.g. to feed the Dashboard's "Recently Watched" widget)
                  without also wanting files auto-archived, or vice versa.
                </p>

                <label>Watch-status sync</label>
                <select
                  key={settings.watchStatusSyncEnabled ?? "watch-status-sync-empty"}
                  defaultValue={settings.watchStatusSyncEnabled ?? "0"}
                  onChange={(e) => saveSetting("watchStatusSyncEnabled", e.target.value)}
                >
                  <option value="0">Disabled</option>
                  <option value="1">Enabled — poll the media server for newly-watched items every 30 minutes</option>
                </select>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  Independent of auto-archival below — just keeps AoNarr's own record of what's been
                  watched up to date (webhook events, if configured further down, already do this in
                  real time; this is the periodic fallback/complement for when a webhook isn't set up).
                </p>

                <label>Library scan sync</label>
                <select
                  key={settings.mediaServerScanSyncEnabled ?? "media-server-scan-sync-empty"}
                  defaultValue={settings.mediaServerScanSyncEnabled ?? "0"}
                  onChange={(e) => saveSetting("mediaServerScanSyncEnabled", e.target.value)}
                >
                  <option value="0">Disabled</option>
                  <option value="1">Enabled — trigger a full media server library scan every 6 hours</option>
                </select>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  Separate from "Refresh media server library after each import" below, which does a
                  lighter targeted refresh right when a file is imported — this is a periodic full scan on
                  top of that, useful if files sometimes land outside AoNarr's own import path.
                </p>

                <h3 style={{ marginBottom: 4 }}>Watch-status Auto-Archival</h3>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  Once something has been watched and stays untouched past the retention window, its file
                  is moved to an archive folder (reversible) — or, if you explicitly opt in below, deleted
                  outright. Items marked <code>protected</code> on their detail page are always skipped.
                  Runs every 6 hours; you can also trigger a run from the System page.
                </p>
                <label>Enable auto-archival</label>
                <select
                  key={settings.archiveEnabled ?? "archive-enabled-empty"}
                  defaultValue={settings.archiveEnabled ?? "0"}
                  onChange={(e) => saveSetting("archiveEnabled", e.target.value)}
                >
                  <option value="0">Disabled</option>
                  <option value="1">Enabled</option>
                </select>
                <label>Media server</label>
                <select
                  key={settings.mediaServerType ?? "media-server-type-empty"}
                  defaultValue={settings.mediaServerType ?? "plex"}
                  onChange={(e) => saveSetting("mediaServerType", e.target.value)}
                >
                  <option value="plex">Plex</option>
                  <option value="jellyfin">Jellyfin</option>
                  <option value="emby">Emby</option>
                </select>
                <label>Media server URL</label>
                <input
                  key={settings.mediaServerUrl ?? "media-server-url-empty"}
                  defaultValue={settings.mediaServerUrl ?? ""}
                  placeholder="http://plex:32400"
                  onBlur={(e) => saveSetting("mediaServerUrl", e.target.value)}
                />
                <label>Media server token / API key</label>
                <input
                  key={settings.mediaServerToken ?? "media-server-token-empty"}
                  defaultValue={settings.mediaServerToken ?? ""}
                  onBlur={(e) => saveSetting("mediaServerToken", e.target.value)}
                />
                <label>Refresh media server library after each import</label>
                <select
                  key={settings.mediaServerRefreshOnImport ?? "media-server-refresh-empty"}
                  defaultValue={settings.mediaServerRefreshOnImport ?? "0"}
                  onChange={(e) => saveSetting("mediaServerRefreshOnImport", e.target.value)}
                >
                  <option value="0">Disabled — rely on the media server's own scan schedule</option>
                  <option value="1">Enabled — tell it about new files right away</option>
                </select>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  Plex gets a targeted refresh scoped to just the new file's folder; Jellyfin/Emby have no
                  equivalent lightweight endpoint, so they get a full library refresh instead — still
                  faster than waiting for their own scan interval, but heavier on a large library.
                </p>

                <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
                  Optional: paste this URL into Plex's Settings → Webhooks (or Jellyfin/Emby's Webhook
                  plugin) so a "recently watched" item shows up on the Dashboard immediately instead of
                  waiting for the next scheduled poll.
                </p>
                <button type="button" className="secondary" onClick={showWebhookUrl}>
                  Show webhook URL...
                </button>
                {webhookUrl && (
                  <>
                    <input value={webhookUrl} readOnly onFocus={(e) => e.target.select()} style={{ marginTop: 8 }} />
                    <button type="button" className="danger" onClick={regenerateWebhookToken} style={{ marginTop: 8 }}>
                      Regenerate URL
                    </button>
                  </>
                )}

                <label>Archive after (days watched &amp; untouched)</label>
                <input
                  type="number"
                  key={settings.archiveAfterDays ?? "archive-days-empty"}
                  defaultValue={settings.archiveAfterDays ?? "30"}
                  style={{ width: 100 }}
                  onBlur={(e) => saveSetting("archiveAfterDays", e.target.value)}
                />
                <label>Archive folder (files are moved here, not deleted)</label>
                <input
                  key={settings.archiveFolder ?? "archive-folder-empty"}
                  defaultValue={settings.archiveFolder ?? ""}
                  placeholder="/media/archive"
                  onBlur={(e) => saveSetting("archiveFolder", e.target.value)}
                />
                <label>Permanently delete instead of archiving</label>
                <select
                  key={settings.archivePermanentDelete ?? "archive-delete-empty"}
                  defaultValue={settings.archivePermanentDelete ?? "0"}
                  onChange={(e) => saveSetting("archivePermanentDelete", e.target.value)}
                >
                  <option value="0">No — move to archive folder (recommended)</option>
                  <option value="1">Yes — delete permanently</option>
                </select>
              </div>
            ),
          },
        ]}
      />
      {namingModalType &&
        (() => {
          const t = mediaTypes.find((mt) => mt.key === namingModalType)!;
          const templateKey = `naming${t.key.charAt(0).toUpperCase()}${t.key.slice(1)}Template`;
          const enabledKey = `namingEnabled${t.key.charAt(0).toUpperCase()}${t.key.slice(1)}`;
          const shapeDefault =
            t.shape === "single"
              ? "{title} ({year})/{title} ({year})"
              : t.shape === "episodic"
              ? "{parentTitle}/Season {season:00}/{parentTitle} - S{season:00}E{episode:00}"
              : "{parentTitle}/{childTitle}";
          return (
            <NamingSetupModal
              typeLabel={t.label}
              shape={t.shape}
              defaultTemplate={shapeDefault}
              initialTemplate={settings[templateKey] ?? shapeDefault}
              initialEnabled={settings[enabledKey] !== "0"}
              onClose={() => setNamingModalType(null)}
              onSave={async (template, enabled) => {
                await saveSetting(templateKey, template);
                await saveSetting(enabledKey, enabled ? "1" : "0");
              }}
            />
          );
        })()}

      </div>
      <div style={{ display: tab === "indexers" ? undefined : "none" }}>
      <SettingsSectionTiles
        sections={[
          {
            key: "prowlarrSync",
            label: "Prowlarr Sync",
            description: "Mirror Prowlarr's indexer list into AoNarr",
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  Mirrors your Prowlarr instance's indexer list into AoNarr — searches go through
                  Prowlarr's own per-indexer proxy, so indexer credentials stay managed there. Runs on a
                  schedule (see Jobs), or sync immediately from the Indexers page.
                </p>
                <label>Prowlarr URL</label>
                <input
                  key={settings.prowlarrUrl ?? "prowlarr-url-empty"}
                  defaultValue={settings.prowlarrUrl ?? ""}
                  placeholder="http://prowlarr:9696"
                  onBlur={(e) => saveSetting("prowlarrUrl", e.target.value)}
                />
                <label>Prowlarr API key</label>
                <input
                  key={settings.prowlarrApiKey ?? "prowlarr-key-empty"}
                  defaultValue={settings.prowlarrApiKey ?? ""}
                  onBlur={(e) => saveSetting("prowlarrApiKey", e.target.value)}
                />
              </div>
            ),
          },
          {
            key: "jackettSync",
            label: "Jackett Sync",
            description: "Mirror Jackett's indexer list into AoNarr",
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  Mirrors your Jackett instance's configured indexer list into AoNarr — searches go through
                  Jackett's own per-indexer Torznab proxy, so indexer credentials stay managed there.
                  Jackett is torrent-only (no Usenet indexers). Runs on a schedule (see Jobs), or sync
                  immediately from the Indexers page.
                </p>
                <label>Jackett URL</label>
                <input
                  key={settings.jackettUrl ?? "jackett-url-empty"}
                  defaultValue={settings.jackettUrl ?? ""}
                  placeholder="http://jackett:9117"
                  onBlur={(e) => saveSetting("jackettUrl", e.target.value)}
                />
                <label>Jackett API key</label>
                <input
                  key={settings.jackettApiKey ?? "jackett-key-empty"}
                  defaultValue={settings.jackettApiKey ?? ""}
                  onBlur={(e) => saveSetting("jackettApiKey", e.target.value)}
                />
              </div>
            ),
          },
          {
            key: "flaresolverr",
            label: "FlareSolverr",
            description: "Bypass Cloudflare/bot-detection for specific indexers",
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  For indexers behind Cloudflare or other bot-detection that block plain requests, point
                  this at a running{" "}
                  <a href="https://github.com/FlareSolverr/FlareSolverr" target="_blank" rel="noreferrer">
                    FlareSolverr
                  </a>{" "}
                  instance; then enable "Route requests through FlareSolverr" on the specific indexers that
                  need it. Indexers without it enabled are unaffected.
                </p>
                <label>FlareSolverr URL</label>
                <input
                  key={settings.flaresolverrUrl ?? "flaresolverr-url-empty"}
                  defaultValue={settings.flaresolverrUrl ?? ""}
                  placeholder="http://flaresolverr:8191"
                  onBlur={(e) => saveSetting("flaresolverrUrl", e.target.value)}
                />
              </div>
            ),
          },
          {
            key: "socks5",
            label: "SOCKS5 Proxy",
            description: "Route all outbound requests through a proxy",
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  Routes every outbound request AoNarr makes (indexers, metadata providers, download
                  client APIs) through a SOCKS5 proxy. Leave blank to disable. Takes effect immediately —
                  no restart needed.
                </p>
                <label>Proxy URL</label>
                <input
                  key={settings.socks5ProxyUrl ?? "socks5-empty"}
                  defaultValue={settings.socks5ProxyUrl ?? ""}
                  placeholder="socks5://user:pass@host:1080"
                  onBlur={(e) => saveSetting("socks5ProxyUrl", e.target.value)}
                />
              </div>
            ),
          },
          {
            key: "quietHours",
            label: "Quiet Hours",
            description: "Pause the auto-search cycle during a daily window",
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  Skip the auto-search cycle during a daily time window — e.g. to avoid ISP throttling
                  overnight or grabbing while someone's actively streaming. Manual searches and grabs
                  still work normally; this only pauses the scheduled auto-search.
                </p>
                <label>Enable quiet hours</label>
                <select
                  key={settings.quietHoursEnabled ?? "quiet-hours-enabled-empty"}
                  defaultValue={settings.quietHoursEnabled ?? "0"}
                  onChange={(e) => saveSetting("quietHoursEnabled", e.target.value)}
                >
                  <option value="0">Disabled</option>
                  <option value="1">Enabled</option>
                </select>
                <label>Start (24h, local time)</label>
                <input
                  type="time"
                  key={settings.quietHoursStart ?? "quiet-hours-start-empty"}
                  defaultValue={settings.quietHoursStart ?? "22:00"}
                  onBlur={(e) => saveSetting("quietHoursStart", e.target.value)}
                />
                <label>End (24h, local time)</label>
                <input
                  type="time"
                  key={settings.quietHoursEnd ?? "quiet-hours-end-empty"}
                  defaultValue={settings.quietHoursEnd ?? "06:00"}
                  onBlur={(e) => saveSetting("quietHoursEnd", e.target.value)}
                />
              </div>
            ),
          },
          {
            key: "searchWindow",
            label: "Search Window",
            description: "Restrict auto-search to a daily window",
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  Beyond quiet hours (which just pauses inside a window), this restricts auto-search to
                  only run inside a daily window — e.g. "only between 2am and 6am" — instead of every
                  interval around the clock. Manual searches are unaffected. Independent of Quiet Hours;
                  configuring both is redundant but harmless.
                </p>
                <label>Enable search window</label>
                <select
                  key={settings.searchWindowEnabled ?? "search-window-enabled-empty"}
                  defaultValue={settings.searchWindowEnabled ?? "0"}
                  onChange={(e) => saveSetting("searchWindowEnabled", e.target.value)}
                >
                  <option value="0">Disabled</option>
                  <option value="1">Enabled</option>
                </select>
                <label>Start (24h, local time)</label>
                <input
                  type="time"
                  key={settings.searchWindowStart ?? "search-window-start-empty"}
                  defaultValue={settings.searchWindowStart ?? "02:00"}
                  onBlur={(e) => saveSetting("searchWindowStart", e.target.value)}
                />
                <label>End (24h, local time)</label>
                <input
                  type="time"
                  key={settings.searchWindowEnd ?? "search-window-end-empty"}
                  defaultValue={settings.searchWindowEnd ?? "06:00"}
                  onBlur={(e) => saveSetting("searchWindowEnd", e.target.value)}
                />
              </div>
            ),
          },
          {
            key: "autoUpgrade",
            label: "Auto Upgrade",
            description: "Automatically re-search items below their quality cutoff",
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  Each quality profile's cutoff normally only matters going forward — anything already
                  downloaded below it just stays as-is unless someone notices and re-searches by hand.
                  Turning this on runs that re-search automatically on a schedule (Jobs page), stopping
                  at each item's cutoff. Off by default since it uses the same indexer/download-client
                  capacity as any other search.
                </p>
                <label>Enable auto upgrade</label>
                <select
                  key={settings.autoUpgradeEnabled ?? "auto-upgrade-enabled-empty"}
                  defaultValue={settings.autoUpgradeEnabled ?? "0"}
                  onChange={(e) => saveSetting("autoUpgradeEnabled", e.target.value)}
                >
                  <option value="0">Disabled</option>
                  <option value="1">Enabled</option>
                </select>
              </div>
            ),
          },
          {
            key: "stalledDownloads",
            label: "Stalled Downloads",
            description: "Drop and retry downloads stuck with no progress",
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  A download with no progress for longer than this gets dropped from the queue and
                  retried with the next-best release (same as a failed grab) — schedule for the cleanup
                  job itself is on the Jobs page.
                </p>
                <label>Stalled after (hours)</label>
                <input
                  type="number"
                  style={{ maxWidth: 120 }}
                  key={settings.stalledDownloadHours ?? "stalled-hours-empty"}
                  defaultValue={settings.stalledDownloadHours ?? "6"}
                  onBlur={(e) => saveSetting("stalledDownloadHours", e.target.value)}
                />
              </div>
            ),
          },
        ]}
      />
      </div>
      <div style={{ display: tab === "library" ? undefined : "none" }}>
      <SettingsSectionTiles
        sections={[
          {
            key: "traktListSync",
            label: "Trakt List Sync",
            description: "Auto-add anything new in a public Trakt list",
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  Point this at a public Trakt list or watchlist URL (e.g.{" "}
                  <code>https://trakt.tv/users/you/lists/to-watch</code> or{" "}
                  <code>https://trakt.tv/users/you/watchlist</code>) and AoNarr adds anything new in it as
                  a monitored movie or TV show — reuses the Trakt Client ID set above under Metadata
                  Providers. Runs every 12 hours; never removes items the list no longer has.
                </p>
                <label>Enable Trakt sync</label>
                <select
                  key={settings.traktSyncEnabled ?? "trakt-sync-enabled-empty"}
                  defaultValue={settings.traktSyncEnabled ?? "0"}
                  onChange={(e) => saveSetting("traktSyncEnabled", e.target.value)}
                >
                  <option value="0">Disabled</option>
                  <option value="1">Enabled</option>
                </select>
                <label>List URL</label>
                <input
                  key={settings.traktSyncUrl ?? "trakt-sync-url-empty"}
                  defaultValue={settings.traktSyncUrl ?? ""}
                  placeholder="https://trakt.tv/users/you/lists/to-watch"
                  onBlur={(e) => saveSetting("traktSyncUrl", e.target.value)}
                />
              </div>
            ),
          },
          {
            key: "rootFolders",
            label: "Root Folders",
            description: "Where each library type's files live",
            badge: `${rootFolders.length} folder${rootFolders.length === 1 ? "" : "s"}`,
            badgeOk: rootFolders.length > 0,
            maxWidth: 820,
            render: () => (
              <div>
                <form className="form-panel" onSubmit={addFolder}>
                  <label>Path</label>
                  <div className="toolbar">
                    <input value={folderPath} onChange={(e) => setFolderPath(e.target.value)} placeholder="/media/movies" required style={{ flex: 1 }} />
                    <button type="button" className="secondary" onClick={() => setShowFolderPicker(true)}>
                      Browse...
                    </button>
                  </div>
                  {showFolderPicker && (
                    <FolderPicker
                      initialPath={folderPath || "/media"}
                      onClose={() => setShowFolderPicker(false)}
                      onSelect={(p) => {
                        setFolderPath(p);
                        setShowFolderPicker(false);
                      }}
                    />
                  )}
                  <label>Media type</label>
                  <select value={folderType} onChange={(e) => setFolderType(e.target.value as MediaType)}>
                    {mediaTypes.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <button type="submit">Add root folder</button>
                </form>
                <table>
                  <thead>
                    <tr>
                      <th>Path</th>
                      <th>Type</th>
                      <th>Free space</th>
                      <th>Quota %</th>
                      <th>Pause grabs at quota</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rootFolders.map((f) => (
                      <tr key={f.id}>
                        <td>{f.path}</td>
                        <td>{mediaTypes.find((t) => t.key === f.mediaType)?.label ?? f.mediaType}</td>
                        <td>
                          {typeof f.freeBytes === "number" ? formatBytes(f.freeBytes) : "unknown"}
                          {typeof f.percentUsed === "number" && f.quotaPercent != null && f.percentUsed >= f.quotaPercent && (
                            <span className="badge" style={{ marginLeft: 6, background: "var(--danger)" }}>
                              {f.percentUsed}% used — over quota
                            </span>
                          )}
                        </td>
                        <td>
                          <input
                            type="number"
                            style={{ width: 70 }}
                            defaultValue={f.quotaPercent ?? ""}
                            placeholder="off"
                            onBlur={(e) => updateFolderQuota(f.id, "quotaPercent", e.target.value === "" ? null : Number(e.target.value))}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={!!f.pauseGrabsAtQuota}
                            onChange={(e) => updateFolderQuota(f.id, "pauseGrabsAtQuota", e.target.checked)}
                          />
                        </td>
                        <td>
                          <button className="danger" onClick={() => removeFolder(f.id)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
          },
          {
            key: "tags",
            label: "Tags",
            description: "Per-tag archival retention overrides",
            badge: `${tags.length} tag${tags.length === 1 ? "" : "s"}`,
            badgeOk: tags.length > 0,
            maxWidth: 620,
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
                  A tag's archival retention overrides the instance-wide default (Watch-status Auto-
                  Archival above) for every item it's applied to. Leave blank to use the default, enter a
                  number of days to keep items longer/shorter, or "never" to exempt tagged items entirely.
                  When an item has multiple overrides (from tags or collections), the most protective one
                  wins.
                </p>
                <form className="form-panel" onSubmit={addTag}>
                  <label>Name</label>
                  <input value={tagName} onChange={(e) => setTagName(e.target.value)} required />
                  <button type="submit">Add tag</button>
                </form>
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Archival retention (days)</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tags.map((t) => (
                      <tr key={t.id}>
                        <td>{t.name}</td>
                        <td>
                          <select
                            value={t.retentionDays === null ? "" : t.retentionDays === -1 ? "never" : "custom"}
                            onChange={(e) => {
                              if (e.target.value === "") updateTagRetention(t.id, "");
                              else if (e.target.value === "never") updateTagRetention(t.id, "-1");
                              else if (e.target.value === "custom") updateTagRetention(t.id, "30");
                            }}
                            style={{ display: "inline-block", width: "auto", marginRight: 6 }}
                          >
                            <option value="">Use default</option>
                            <option value="custom">Custom days...</option>
                            <option value="never">Never archive</option>
                          </select>
                          {t.retentionDays !== null && t.retentionDays !== -1 && (
                            <input
                              type="number"
                              style={{ width: 80, display: "inline-block" }}
                              defaultValue={t.retentionDays}
                              onBlur={(e) => updateTagRetention(t.id, e.target.value)}
                            />
                          )}
                        </td>
                        <td>
                          <button className="danger" onClick={() => removeTag(t.id)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {tags.length === 0 && <p className="empty">No tags yet.</p>}
              </div>
            ),
          },
        ]}
      />
      </div>
      <div style={{ display: tab === "quality" ? undefined : "none" }}>
      <SettingsSectionTiles
        sections={[
          {
            key: "qualityDefinitions",
            label: "Quality Definitions",
            description: "Rank, rename, and size-bound each quality",
            badge: `${qualities.length} qualities`,
            badgeOk: qualities.length > 0,
            maxWidth: 880,
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
                  Worst to best. Reorder to change how releases rank against each other; rename freely
                  (used as the name shown everywhere, including release parsing output). Min/max size (MB)
                  is optional and rejects releases parsed as this quality whose size falls outside it —
                  useful for catching mislabeled or fake releases. Preferred size is a soft target only —
                  used to break ties between otherwise-equal releases at this quality, closer wins; it
                  doesn't reject anything the way min/max do.
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Name</th>
                      <th>Min size (MB)</th>
                      <th>Max size (MB)</th>
                      <th>Preferred size (MB)</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {qualities.map((q, idx) => (
                      <tr key={q.id}>
                        <td>{idx + 1}</td>
                        <td>
                          <input
                            defaultValue={q.name}
                            onBlur={(e) => e.target.value !== q.name && renameQuality(q.id, e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            style={{ width: 100 }}
                            defaultValue={q.minSizeMb ?? ""}
                            onBlur={(e) => saveQualitySize(q.id, "minSizeMb", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            style={{ width: 100 }}
                            defaultValue={q.maxSizeMb ?? ""}
                            onBlur={(e) => saveQualitySize(q.id, "maxSizeMb", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            style={{ width: 100 }}
                            defaultValue={q.preferredSizeMb ?? ""}
                            onBlur={(e) => saveQualitySize(q.id, "preferredSizeMb", e.target.value)}
                          />
                        </td>
                        <td className="toolbar">
                          <button className="secondary" disabled={idx === 0} onClick={() => moveQuality(idx, -1)}>
                            Up
                          </button>
                          <button className="secondary" disabled={idx === qualities.length - 1} onClick={() => moveQuality(idx, 1)}>
                            Down
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
          },
          {
            key: "qualityProfiles",
            label: "Quality Profiles",
            description: "Named allowed-quality sets with a cutoff",
            badge: `${profiles.length} profile${profiles.length === 1 ? "" : "s"}`,
            badgeOk: profiles.length > 0,
            maxWidth: 720,
            render: () => (
              <div>
                <form className="form-panel" onSubmit={addProfile}>
                  <label>Name</label>
                  <input value={profileName} onChange={(e) => setProfileName(e.target.value)} required />
                  <label>Allowed qualities</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginBottom: 8 }}>
                    {qualities.map((q) => (
                      <label key={q.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.85rem", margin: 0 }}>
                        <input
                          type="checkbox"
                          checked={profileQualities.has(q.name)}
                          onChange={() => toggleProfileQuality(q.name)}
                          style={{ width: "auto" }}
                        />
                        {q.name}
                      </label>
                    ))}
                  </div>
                  <label>Cutoff (stop upgrading at)</label>
                  <select value={profileCutoff} onChange={(e) => setProfileCutoff(e.target.value)}>
                    {qualities.map((q) => (
                      <option key={q.id} value={q.name}>
                        {q.name}
                      </option>
                    ))}
                  </select>
                  <button type="submit">Add quality profile</button>
                </form>
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Cutoff</th>
                      <th>Min format score</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {profiles.map((p) => (
                      <tr key={p.id}>
                        <td>{p.name}</td>
                        <td>{p.cutoff}</td>
                        <td>
                          <input
                            type="number"
                            defaultValue={p.minFormatScore}
                            style={{ width: 80 }}
                            onBlur={(e) => saveMinFormatScore(p.id, Number(e.target.value))}
                          />
                        </td>
                        <td>
                          <button className="danger" onClick={() => removeProfile(p.id)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
          },
          {
            key: "customFormats",
            label: "Custom Formats",
            description: "Score releases up/down by matching conditions",
            badge: `${customFormats.length} format${customFormats.length === 1 ? "" : "s"}`,
            badgeOk: customFormats.length > 0,
            maxWidth: 880,
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
                  Score releases up or down by matching each release against title regex, size, language,
                  release-group, source, resolution, year, or release-flag conditions. One condition per
                  line; comma-separated patterns on a line are OR'd, all lines are AND'd, and a line starting
                  with <code>NOT</code> negates it. Prefixes switch the condition type —{" "}
                  <code>SIZE: 4000-15000</code> (either bound optional), <code>LANG: french, multi</code>{" "}
                  (detected language tags), <code>GROUP: RARBG, EVO</code> (regex against the parsed
                  release-group tag), <code>SOURCE: Remux, Bluray, WEBDL, WEBRip, HDTV, DVD</code>,{" "}
                  <code>RESOLUTION: 2160p, 1080p, 720p</code>, <code>YEAR: 2020-2024</code> (either bound
                  optional), <code>FLAGS: proper, repack, extended, unrated, directorscut, imax</code> —
                  anything else is a title regex. Example:
                  <br />
                  <code>SOURCE: Remux, Bluray</code>
                  <br />
                  <code>NOT x265</code>
                  <br />
                  <code>RESOLUTION: 2160p</code>
                  <br />
                  <code>NOT LANG: french</code>
                  <br />
                  means "(Remux or Bluray source) and not x265 and 2160p and not French". Assign scores per
                  quality profile below.
                </p>
                <form className="form-panel" onSubmit={addCustomFormat}>
                  <label>Name</label>
                  <input value={formatName} onChange={(e) => setFormatName(e.target.value)} required />
                  <label>Conditions (one group per line)</label>
                  <textarea
                    value={formatPatterns}
                    onChange={(e) => setFormatPatterns(e.target.value)}
                    placeholder={"SOURCE: Remux, Bluray\nNOT x265\nRESOLUTION: 2160p\nNOT LANG: french"}
                    rows={5}
                    required
                  />
                  <label>Applies to (leave all unchecked for every library)</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginBottom: 8 }}>
                    {mediaTypes.map((t) => (
                      <label key={t.key} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.85rem", margin: 0 }}>
                        <input
                          type="checkbox"
                          checked={formatMediaTypes.has(t.key)}
                          onChange={() => toggleFormatMediaType(t.key)}
                          style={{ width: "auto" }}
                        />
                        {t.label}
                      </label>
                    ))}
                  </div>
                  <button type="submit">Add custom format</button>
                </form>

                <div className="form-panel">
                  <label>Sync from TRaSH-Guides</label>
                  <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                    Pulls every custom format TRaSH-Guides publishes for Radarr or Sonarr straight from their
                    GitHub repo — unlike the one-off paste below, this is repeatable: re-running updates
                    formats already synced in (matched by TRaSH's own stable id) instead of duplicating them,
                    so it stays current as TRaSH's guides change. Newly-synced formats are scored 0 on every
                    quality profile until you set a score for them below.
                  </p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" onClick={() => syncTrashFormats("radarr")} disabled={trashSyncing !== null}>
                      {trashSyncing === "radarr" ? "Syncing..." : "Sync Radarr formats"}
                    </button>
                    <button type="button" onClick={() => syncTrashFormats("sonarr")} disabled={trashSyncing !== null}>
                      {trashSyncing === "sonarr" ? "Syncing..." : "Sync Sonarr formats"}
                    </button>
                  </div>
                </div>

                <div className="form-panel">
                  <label>Import from TRaSH-Guides (or a Radarr/Sonarr custom format export)</label>
                  <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                    Paste the format's JSON (from TRaSH-Guides' GitHub repo, or Radarr/Sonarr's own "Export"
                    on a custom format). Title/release-group/size conditions translate directly; language
                    and other condition types aren't supported and get skipped (reported after import) since
                    they use Radarr/Sonarr's own internal ids.
                  </p>
                  <textarea value={trashJson} onChange={(e) => setTrashJson(e.target.value)} rows={6} placeholder='{"name": "...", "specifications": [...]}' />
                  {trashError && <p style={{ color: "var(--danger)" }}>{trashError}</p>}
                  <button type="button" onClick={importTrashFormat}>
                    Import
                  </button>
                </div>

                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Conditions</th>
                      <th>Applies to</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {customFormats.map((f) => (
                      <tr key={f.id}>
                        <td>{f.name}</td>
                        <td>
                          {f.conditionGroups
                            .map((g) => {
                              const body =
                                g.type === "size"
                                  ? `SIZE ${g.minMb ?? ""}-${g.maxMb ?? ""}MB`
                                  : g.type === "language"
                                  ? `LANG (${(g.languages ?? []).join(" OR ")})`
                                  : g.type === "releaseGroup"
                                  ? `GROUP (${(g.patterns ?? []).join(" OR ")})`
                                  : g.type === "source"
                                  ? `SOURCE (${(g.sources ?? []).join(" OR ")})`
                                  : g.type === "resolution"
                                  ? `RESOLUTION (${(g.resolutions ?? []).join(" OR ")})`
                                  : g.type === "year"
                                  ? `YEAR ${g.minYear ?? ""}-${g.maxYear ?? ""}`
                                  : g.type === "releaseFlags"
                                  ? `FLAGS (${(g.flags ?? []).join(" OR ")})`
                                  : `(${(g.patterns ?? []).join(" OR ")})`;
                              return `${g.negate ? "NOT " : ""}${body}`;
                            })
                            .join(" AND ")}
                        </td>
                        <td>
                          <select
                            multiple
                            value={f.mediaTypes}
                            onChange={(e) =>
                              saveCustomFormatMediaTypes(
                                f.id,
                                Array.from(e.target.selectedOptions).map((o) => o.value as MediaType)
                              )
                            }
                            style={{ minWidth: 140, height: 60 }}
                            title="Ctrl/Cmd-click to select multiple; select none for every library"
                          >
                            {mediaTypes.map((t) => (
                              <option key={t.key} value={t.key}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                          {f.mediaTypes.length === 0 && <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>all libraries</div>}
                        </td>
                        <td>
                          <button className="danger" onClick={() => removeCustomFormat(f.id)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {customFormats.length === 0 && <p className="empty">No custom formats yet.</p>}

                {customFormats.length > 0 && profiles.length > 0 && (
                  <>
                    <h3>Format Scores</h3>
                    <label>Quality profile</label>
                    <select
                      value={scoreProfileId}
                      onChange={(e) => setScoreProfileId(e.target.value ? Number(e.target.value) : "")}
                      style={{ maxWidth: 260, marginBottom: 12 }}
                    >
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <table>
                      <thead>
                        <tr>
                          <th>Format</th>
                          <th>Score</th>
                        </tr>
                      </thead>
                      <tbody>
                        {formatScores.map((f) => (
                          <tr key={f.id}>
                            <td>{f.name}</td>
                            <td>
                              <input
                                type="number"
                                defaultValue={f.score}
                                style={{ width: 80 }}
                                onBlur={(e) => saveFormatScore(f.id, Number(e.target.value))}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </div>
            ),
          },
          {
            key: "blocklist",
            label: "Blocklist",
            description: "Releases never auto-grabbed again for their item",
            badge: `${blocklist.length} entr${blocklist.length === 1 ? "y" : "ies"}`,
            badgeOk: blocklist.length > 0,
            maxWidth: 720,
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
                  Releases blocklisted from a media item's search results — never auto-grabbed or shown as
                  grabbable again for that item. Add entries from a media item's search results page.
                </p>
                {blocklist.length === 0 && <p className="empty">Nothing blocklisted yet.</p>}
                {blocklist.length > 0 && (
                  <table>
                    <thead>
                      <tr>
                        <th>Media item</th>
                        <th>Release</th>
                        <th>Blocklisted</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {blocklist.map((b) => (
                        <tr key={b.id}>
                          <td>{b.mediaTitle}</td>
                          <td>{b.releaseTitle}</td>
                          <td>{b.createdAt}</td>
                          <td>
                            <button className="danger" onClick={() => removeBlocklistEntry(b.id)}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ),
          },
        ]}
      />
      </div>
      <div style={{ display: tab === "subtitles" ? undefined : "none" }}>
      <SettingsSectionTiles
        sections={[
          {
            key: "importExclusions",
            label: "Import Exclusions",
            description: "Titles never auto-added or re-suggested",
            badge: `${exclusions.length} excluded`,
            badgeOk: exclusions.length > 0,
            maxWidth: 680,
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
                  Titles that should never be auto-added or re-suggested — search results show them dimmed,
                  and Trakt sync / Recommendations skip them silently. Add entries from Add Media's search
                  results or Recommendations' "Not interested" button.
                </p>
                {exclusions.length === 0 && <p className="empty">Nothing excluded yet.</p>}
                {exclusions.length > 0 && (
                  <table>
                    <thead>
                      <tr>
                        <th>Title</th>
                        <th>Type</th>
                        <th>Reason</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {exclusions.map((ex) => (
                        <tr key={ex.id}>
                          <td>
                            {ex.title}
                            {ex.year ? ` (${ex.year})` : ""}
                          </td>
                          <td>{mediaTypes.find((t) => t.key === ex.type)?.label ?? ex.type}</td>
                          <td>{ex.reason ?? "-"}</td>
                          <td>
                            <button className="danger" onClick={() => removeExclusion(ex.id)}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ),
          },
          {
            key: "subtitleProviders",
            label: "Subtitle Providers",
            description: "OpenSubtitles or a custom JSON search API",
            badge: `${providers.length} provider${providers.length === 1 ? "" : "s"}`,
            badgeOk: providers.length > 0,
            maxWidth: 680,
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  OpenSubtitles is a hosted API and needs an API key. "Custom" points at any subtitle search
                  API you have access to that returns JSON and a directly-downloadable file URL per result —
                  useful for a legitimate provider with its own public API. AoNarr doesn't ship scrapers for
                  sites without a public API (e.g. Subscene/Addic7ed), since that would mean bypassing their
                  terms of service; use Custom instead if your provider has an API of its own.
                </p>
                <form className="form-panel" onSubmit={addProvider}>
                  <label>Provider type</label>
                  <select value={subType} onChange={(e) => setSubType(e.target.value as "opensubtitles" | "custom")}>
                    <option value="opensubtitles">OpenSubtitles</option>
                    <option value="custom">Custom (JSON API)</option>
                  </select>
                  <label>Name</label>
                  <input value={subName} onChange={(e) => setSubName(e.target.value)} />

                  {subType === "opensubtitles" ? (
                    <>
                      <label>OpenSubtitles API key</label>
                      <input value={subApiKey} onChange={(e) => setSubApiKey(e.target.value)} required />
                      <label>Hearing-impaired subtitles</label>
                      <select value={subHearingImpaired} onChange={(e) => setSubHearingImpaired(e.target.value)}>
                        <option value="">No preference (either)</option>
                        <option value="exclude">Exclude</option>
                        <option value="only">Require</option>
                      </select>
                      <label>Forced subtitles (foreign-dialogue-only)</label>
                      <select value={subForeignPartsOnly} onChange={(e) => setSubForeignPartsOnly(e.target.value)}>
                        <option value="">No preference (either)</option>
                        <option value="exclude">Exclude</option>
                        <option value="only">Require</option>
                      </select>
                    </>
                  ) : (
                    <>
                      <label>API key (sent as a Bearer token, if your provider needs one)</label>
                      <input value={subApiKey} onChange={(e) => setSubApiKey(e.target.value)} />
                      <label>Search URL template ({"{query}"} and {"{languages}"} get substituted)</label>
                      <input
                        value={subSearchUrlTemplate}
                        onChange={(e) => setSubSearchUrlTemplate(e.target.value)}
                        placeholder="https://example.com/api/search?q={query}&lang={languages}"
                        required
                      />
                      <label>Results array path (dot path; blank if the response itself is the array)</label>
                      <input value={subResultsPath} onChange={(e) => setSubResultsPath(e.target.value)} placeholder="data.results" />
                      <label>Download URL field (dot path within each result)</label>
                      <input value={subDownloadUrlField} onChange={(e) => setSubDownloadUrlField(e.target.value)} required />
                      <label>Language field</label>
                      <input value={subLanguageField} onChange={(e) => setSubLanguageField(e.target.value)} />
                      <label>Release name field</label>
                      <input value={subReleaseField} onChange={(e) => setSubReleaseField(e.target.value)} />
                    </>
                  )}

                  <label>Languages (comma-separated ISO codes)</label>
                  <input value={subLanguages} onChange={(e) => setSubLanguages(e.target.value)} />
                  <button type="submit">Add subtitle provider</button>
                </form>
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Languages</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {providers.map((p) => (
                      <tr key={p.id}>
                        <td>{p.name}</td>
                        <td>{p.type === "custom" ? "Custom" : "OpenSubtitles"}</td>
                        <td>{p.languages}</td>
                        <td>
                          <button className="danger" onClick={() => removeProvider(p.id)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
          },
        ]}
      />
      </div>
    </div>
  );
}
