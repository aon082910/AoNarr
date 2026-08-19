import { log } from "./logger.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import type { DownloadClient } from "../types/index.js";

export interface GrabResult {
  downloadId: string;
}

export interface QueueStatusUpdate {
  downloadId: string;
  progress: number; // 0-1
  status: "downloading" | "completed" | "failed";
}

/** Common surface every download client backend implements. `releaseTitle` is only used by the
 * in-process adapters (http, ytdlp) that write the file into downloadsDir themselves — naming it
 * to match gives the importer's fuzzy-match a much better target than a raw URL basename would. */
export interface DownloadClientAdapter {
  addDownload(
    client: DownloadClient,
    downloadUrl: string,
    category: string | null,
    releaseTitle?: string
  ): Promise<GrabResult>;
  getStatus(client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]>;
  /** Not every backend has a real queue to reorder (the in-process http/ytdlp adapters download
   * sequentially with nothing to prioritize) — implementing this is optional; callers check for
   * its presence before offering the UI action. */
  setPriority?(client: DownloadClient, downloadId: string, priority: "top" | "normal"): Promise<void>;
  /** Torrent-specific health: seed ratio, upload/download totals, ratio-limit config. Only
   * meaningful for backends that actually seed (qBittorrent) — usenet clients have no equivalent
   * concept, so this is optional and callers check for its presence. */
  getHealthStats?(client: DownloadClient): Promise<ClientHealthStats>;
}

export interface ClientHealthStats {
  uploadedTotalBytes: number;
  downloadedTotalBytes: number;
  globalRatio: number | null;
  ratioLimitEnabled: boolean;
  ratioLimit: number | null;
  torrentsOverRatioLimit: number;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, "_").trim().slice(0, 180);
}

function baseUrl(client: DownloadClient): string {
  const scheme = client.useSsl ? "https" : "http";
  return `${scheme}://${client.host}:${client.port}`;
}

/** qBittorrent Web API (v4.1+) adapter. */
class QBittorrentAdapter implements DownloadClientAdapter {
  private cookieCache = new Map<number, string>();

  private async login(client: DownloadClient): Promise<string> {
    const cached = this.cookieCache.get(client.id);
    if (cached) return cached;

    const res = await fetch(`${baseUrl(client)}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: client.username ?? "",
        password: client.password ?? "",
      }),
    });
    const cookie = res.headers.get("set-cookie");
    if (!res.ok || !cookie) {
      throw new Error(`Failed to authenticate with qBittorrent client "${client.name}"`);
    }
    const sid = cookie.split(";")[0];
    this.cookieCache.set(client.id, sid);
    return sid;
  }

  async addDownload(client: DownloadClient, downloadUrl: string, category: string | null): Promise<GrabResult> {
    const cookie = await this.login(client);
    const form = new URLSearchParams({ urls: downloadUrl });
    if (category) form.set("category", category);

    const res = await fetch(`${baseUrl(client)}/api/v2/torrents/add`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: form,
    });
    if (!res.ok) throw new Error(`qBittorrent add failed: HTTP ${res.status}`);

    // qBittorrent doesn't return a hash on add; the caller tracks by downloadUrl until
    // the next queue poll resolves it against /torrents/info.
    return { downloadId: downloadUrl };
  }

  async getStatus(client: DownloadClient, _downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    const cookie = await this.login(client);
    const res = await fetch(`${baseUrl(client)}/api/v2/torrents/info`, {
      headers: { Cookie: cookie },
    });
    if (!res.ok) throw new Error(`qBittorrent status failed: HTTP ${res.status}`);
    const torrents = (await res.json()) as any[];

    return torrents.map((t) => ({
      downloadId: t.hash,
      progress: t.progress ?? 0,
      status: t.progress >= 1 ? "completed" : t.state === "error" ? "failed" : "downloading",
    }));
  }

  /** qBittorrent orders torrents by queue position; `topPrio`/`bottomPrio` move one to either end
   * (there's no direct "set numeric priority" call in the Web API). */
  async setPriority(client: DownloadClient, downloadId: string, priority: "top" | "normal"): Promise<void> {
    const cookie = await this.login(client);
    const endpoint = priority === "top" ? "topPrio" : "bottomPrio";
    const res = await fetch(`${baseUrl(client)}/api/v2/torrents/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ hashes: downloadId }),
    });
    if (!res.ok) throw new Error(`qBittorrent ${endpoint} failed: HTTP ${res.status}`);
  }

  async getHealthStats(client: DownloadClient): Promise<ClientHealthStats> {
    const cookie = await this.login(client);

    const [transferRes, prefsRes, torrentsRes] = await Promise.all([
      fetch(`${baseUrl(client)}/api/v2/transfer/info`, { headers: { Cookie: cookie } }),
      fetch(`${baseUrl(client)}/api/v2/app/preferences`, { headers: { Cookie: cookie } }),
      fetch(`${baseUrl(client)}/api/v2/torrents/info`, { headers: { Cookie: cookie } }),
    ]);
    if (!transferRes.ok || !prefsRes.ok || !torrentsRes.ok) {
      throw new Error("qBittorrent health stats request failed");
    }

    const transfer: any = await transferRes.json();
    const prefs: any = await prefsRes.json();
    const torrents = (await torrentsRes.json()) as any[];

    const ratioLimitEnabled = !!prefs.max_ratio_enabled;
    const ratioLimit = ratioLimitEnabled ? Number(prefs.max_ratio) : null;
    const torrentsOverRatioLimit = ratioLimit !== null ? torrents.filter((t) => (t.ratio ?? 0) >= ratioLimit).length : 0;

    const uploadedTotalBytes = Number(transfer.up_info_data ?? 0);
    const downloadedTotalBytes = Number(transfer.dl_info_data ?? 0);

    return {
      uploadedTotalBytes,
      downloadedTotalBytes,
      globalRatio: downloadedTotalBytes > 0 ? uploadedTotalBytes / downloadedTotalBytes : null,
      ratioLimitEnabled,
      ratioLimit,
      torrentsOverRatioLimit,
    };
  }
}

/** SABnzbd adapter. */
class SabnzbdAdapter implements DownloadClientAdapter {
  async addDownload(client: DownloadClient, downloadUrl: string, category: string | null): Promise<GrabResult> {
    const url = new URL(`${baseUrl(client)}/api`);
    url.searchParams.set("mode", "addurl");
    url.searchParams.set("name", downloadUrl);
    url.searchParams.set("apikey", client.apiKey ?? "");
    url.searchParams.set("output", "json");
    if (category) url.searchParams.set("cat", category);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`SABnzbd add failed: HTTP ${res.status}`);
    const body: any = await res.json();
    const downloadId = body?.nzo_ids?.[0] ?? downloadUrl;
    return { downloadId };
  }

  async getStatus(client: DownloadClient, _downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    const url = new URL(`${baseUrl(client)}/api`);
    url.searchParams.set("mode", "queue");
    url.searchParams.set("apikey", client.apiKey ?? "");
    url.searchParams.set("output", "json");

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`SABnzbd status failed: HTTP ${res.status}`);
    const body: any = await res.json();
    const slots: any[] = body?.queue?.slots ?? [];

    return slots.map((s) => ({
      downloadId: s.nzo_id,
      progress: s.percentage ? Number(s.percentage) / 100 : 0,
      status: s.status === "Failed" ? "failed" : s.percentage === "100" ? "completed" : "downloading",
    }));
  }

  /** SABnzbd doesn't have a "move to top" call directly, but setting priority to Force (2, the
   * highest level) has SABnzbd fetch it ahead of any Normal/Low-priority item — the closest
   * equivalent available through its API. "normal" resets it back to the default (0). */
  async setPriority(client: DownloadClient, downloadId: string, priority: "top" | "normal"): Promise<void> {
    const url = new URL(`${baseUrl(client)}/api`);
    url.searchParams.set("mode", "queue");
    url.searchParams.set("name", "priority");
    url.searchParams.set("value", downloadId);
    url.searchParams.set("value2", priority === "top" ? "2" : "0");
    url.searchParams.set("apikey", client.apiKey ?? "");
    url.searchParams.set("output", "json");
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`SABnzbd priority change failed: HTTP ${res.status}`);
  }
}

interface InProcessJob {
  progress: number;
  status: "downloading" | "completed" | "failed";
}

/**
 * Direct HTTP download — no external client at all; AoNarr streams the URL straight into
 * downloadsDir itself and the existing queue-poll/import pipeline picks it up exactly like a
 * torrent/usenet client's completed download would. Used for DDL/RSS indexer results.
 */
class HttpDownloadAdapter implements DownloadClientAdapter {
  private jobs = new Map<string, InProcessJob>();

  async addDownload(
    _client: DownloadClient,
    downloadUrl: string,
    _category: string | null,
    releaseTitle?: string
  ): Promise<GrabResult> {
    const downloadId = crypto.randomUUID();
    this.jobs.set(downloadId, { progress: 0, status: "downloading" });

    (async () => {
      try {
        const res = await fetch(downloadUrl);
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const ext = path.extname(new URL(downloadUrl).pathname) || ".bin";
        const filename = sanitizeFilename(releaseTitle || path.basename(new URL(downloadUrl).pathname) || downloadId) + ext;
        fs.mkdirSync(config.downloadsDir, { recursive: true });
        const dest = path.join(config.downloadsDir, filename);

        const total = Number(res.headers.get("content-length") ?? 0);
        let received = 0;
        const fileStream = fs.createWriteStream(dest);
        for await (const chunk of res.body as any) {
          fileStream.write(chunk);
          received += chunk.length;
          if (total > 0) this.jobs.set(downloadId, { progress: Math.min(received / total, 0.99), status: "downloading" });
        }
        await new Promise<void>((resolve, reject) => fileStream.end((err: any) => (err ? reject(err) : resolve())));
        this.jobs.set(downloadId, { progress: 1, status: "completed" });
      } catch (err) {
        log.warn(`[http-download] failed for "${releaseTitle ?? downloadUrl}":`, (err as Error).message);
        this.jobs.set(downloadId, { progress: 0, status: "failed" });
      }
    })();

    return { downloadId };
  }

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return downloadIds
      .filter((id) => this.jobs.has(id))
      .map((id) => ({ downloadId: id, ...this.jobs.get(id)! }));
  }
}

/**
 * yt-dlp — spawns the `yt-dlp` binary (must be on PATH in the server image) to download a video
 * URL into downloadsDir. Used for Online Videos library downloads (YouTube etc.) rather than
 * indexer search results.
 */
class YtdlpAdapter implements DownloadClientAdapter {
  private jobs = new Map<string, InProcessJob>();

  async addDownload(
    client: DownloadClient,
    downloadUrl: string,
    _category: string | null,
    releaseTitle?: string
  ): Promise<GrabResult> {
    const downloadId = crypto.randomUUID();
    this.jobs.set(downloadId, { progress: 0, status: "downloading" });
    fs.mkdirSync(config.downloadsDir, { recursive: true });

    const outputTemplate = path.join(config.downloadsDir, `${sanitizeFilename(releaseTitle || downloadId)}.%(ext)s`);
    // Audio-only mode (e.g. ripping a music video / live set) extracts and transcodes to mp3
    // instead of saving the source video container — yt-dlp's own -x/--audio-format flags.
    const args = client.audioOnly
      ? ["-x", "--audio-format", "mp3", "-o", outputTemplate, "--newline", downloadUrl]
      : ["-o", outputTemplate, "--newline", downloadUrl];
    const proc = spawn("yt-dlp", args);

    let stderrTail = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      const match = chunk.toString().match(/(\d+(?:\.\d+)?)%/);
      if (match) this.jobs.set(downloadId, { progress: Math.min(Number(match[1]) / 100, 0.99), status: "downloading" });
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    proc.on("error", (err) => {
      log.warn(`[ytdlp] failed to start for "${releaseTitle ?? downloadUrl}":`, err.message);
      this.jobs.set(downloadId, { progress: 0, status: "failed" });
    });
    proc.on("exit", (code) => {
      if (code === 0) {
        this.jobs.set(downloadId, { progress: 1, status: "completed" });
      } else {
        log.warn(`[ytdlp] failed for "${releaseTitle ?? downloadUrl}" (exit ${code}):`, stderrTail.trim().split("\n").pop());
        this.jobs.set(downloadId, { progress: 0, status: "failed" });
      }
    });

    return { downloadId };
  }

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return downloadIds
      .filter((id) => this.jobs.has(id))
      .map((id) => ({ downloadId: id, ...this.jobs.get(id)! }));
  }
}

/**
 * Real-Debrid — a "debrid" torrent-caching service: instead of AoNarr peering directly, it hands
 * Real-Debrid a magnet/torrent, waits for RD's own servers to fetch it, then unrestricts the
 * resulting link(s) into plain HTTPS downloads AoNarr pulls into downloadsDir itself, same as
 * HttpDownloadAdapter's tail end. client.apiKey holds the RD API token (Settings -> Account on
 * real-debrid.com); there's no host/port, it's always their public API.
 */
class RealDebridAdapter implements DownloadClientAdapter {
  private jobs = new Map<string, InProcessJob>();
  private readonly base = "https://api.real-debrid.com/rest/1.0";

  private headers(client: DownloadClient): Record<string, string> {
    return { Authorization: `Bearer ${client.apiKey}` };
  }

  async addDownload(
    client: DownloadClient,
    downloadUrl: string,
    _category: string | null,
    releaseTitle?: string
  ): Promise<GrabResult> {
    const downloadId = crypto.randomUUID();
    this.jobs.set(downloadId, { progress: 0, status: "downloading" });

    (async () => {
      try {
        const torrentId = await this.addToRealDebrid(client, downloadUrl);
        await fetch(`${this.base}/torrents/selectFiles/${torrentId}`, {
          method: "POST",
          headers: { ...this.headers(client), "Content-Type": "application/x-www-form-urlencoded" },
          body: "files=all",
        });

        // Poll RD's own caching/download progress until it's fully fetched on their end.
        let links: string[] = [];
        for (;;) {
          const res = await fetch(`${this.base}/torrents/info/${torrentId}`, { headers: this.headers(client) });
          if (!res.ok) throw new Error(`Real-Debrid status check failed: HTTP ${res.status}`);
          const info: any = await res.json();
          if (info.status === "error" || info.status === "magnet_error" || info.status === "virus" || info.status === "dead") {
            throw new Error(`Real-Debrid reported "${info.status}"`);
          }
          if (info.status === "downloaded") {
            links = info.links ?? [];
            break;
          }
          this.jobs.set(downloadId, { progress: Math.min((info.progress ?? 0) / 100, 0.99), status: "downloading" });
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (links.length === 0) throw new Error("Real-Debrid reported no files");

        fs.mkdirSync(config.downloadsDir, { recursive: true });
        for (const link of links) {
          const unrestrictRes = await fetch(`${this.base}/unrestrict/link`, {
            method: "POST",
            headers: { ...this.headers(client), "Content-Type": "application/x-www-form-urlencoded" },
            body: `link=${encodeURIComponent(link)}`,
          });
          if (!unrestrictRes.ok) throw new Error(`Real-Debrid unrestrict failed: HTTP ${unrestrictRes.status}`);
          const unrestricted: any = await unrestrictRes.json();

          const fileRes = await fetch(unrestricted.download);
          if (!fileRes.ok || !fileRes.body) throw new Error(`Downloading unrestricted link failed: HTTP ${fileRes.status}`);
          const filename = sanitizeFilename(unrestricted.filename || releaseTitle || downloadId);
          const dest = path.join(config.downloadsDir, filename);
          const fileStream = fs.createWriteStream(dest);
          for await (const chunk of fileRes.body as any) fileStream.write(chunk);
          await new Promise<void>((resolve, reject) => fileStream.end((err: any) => (err ? reject(err) : resolve())));
        }

        this.jobs.set(downloadId, { progress: 1, status: "completed" });
      } catch (err) {
        log.warn(`[real-debrid] failed for "${releaseTitle ?? downloadUrl}":`, (err as Error).message);
        this.jobs.set(downloadId, { progress: 0, status: "failed" });
      }
    })();

    return { downloadId };
  }

  /** Magnet URIs go straight to addMagnet; anything else is fetched and treated as raw .torrent
   * bytes for addTorrent — covers indexer results that hand back a .torrent download URL instead
   * of a magnet link. */
  private async addToRealDebrid(client: DownloadClient, downloadUrl: string): Promise<string> {
    if (downloadUrl.startsWith("magnet:")) {
      const res = await fetch(`${this.base}/torrents/addMagnet`, {
        method: "POST",
        headers: { ...this.headers(client), "Content-Type": "application/x-www-form-urlencoded" },
        body: `magnet=${encodeURIComponent(downloadUrl)}`,
      });
      if (!res.ok) throw new Error(`Real-Debrid addMagnet failed: HTTP ${res.status}`);
      const body: any = await res.json();
      return body.id;
    }

    const torrentRes = await fetch(downloadUrl);
    if (!torrentRes.ok) throw new Error(`Failed to fetch .torrent for Real-Debrid: HTTP ${torrentRes.status}`);
    const torrentBytes = Buffer.from(await torrentRes.arrayBuffer());
    const addRes = await fetch(`${this.base}/torrents/addTorrent`, {
      method: "PUT",
      headers: this.headers(client),
      body: torrentBytes,
    });
    if (!addRes.ok) throw new Error(`Real-Debrid addTorrent failed: HTTP ${addRes.status}`);
    const addBody: any = await addRes.json();
    return addBody.id;
  }

  async getStatus(_client: DownloadClient, downloadIds: string[]): Promise<QueueStatusUpdate[]> {
    return downloadIds
      .filter((id) => this.jobs.has(id))
      .map((id) => ({ downloadId: id, ...this.jobs.get(id)! }));
  }
}

const adapters: Record<DownloadClient["type"], DownloadClientAdapter> = {
  qbittorrent: new QBittorrentAdapter(),
  sabnzbd: new SabnzbdAdapter(),
  http: new HttpDownloadAdapter(),
  ytdlp: new YtdlpAdapter(),
  realdebrid: new RealDebridAdapter(),
};

export function getDownloadClientAdapter(type: DownloadClient["type"]): DownloadClientAdapter {
  return adapters[type];
}
