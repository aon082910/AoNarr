import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DOCKER_HUB_REPO = "allornothing/aonarr";
const CHANGELOG_URL = "https://raw.githubusercontent.com/aon082910/AoNarr/main/CHANGELOG.md";

/** A tag is pushed after the image is built (and often after it was smoke-tested), so the pushed time of the
 * very build that is running is later than the build time baked into it. Only a push this much later than
 * the build counts as a newer image; a rebuild pushed within this time of the previous one is not noticed. */
export const UPDATE_PUSH_GRACE_MS = 6 * 60 * 60 * 1000;

/** AoNarr has no semver/git-tag releases (it ships as a rolling `main` branch + Docker tags). An
 * image built by the Dockerfile carries its build time (AONARR_BUILD_TIME) and tag (AONARR_IMAGE_TAG),
 * so the question "is there a newer image" is answered by Docker Hub's push time for that tag. A build
 * without them (a local or dev run) falls back to the round number CHANGELOG.md is organized by:
 * the bundled copy against the one on GitHub's main branch. Either way the changelog rounds are
 * returned for display. One checker serves the System page, the daily notifier and the settings route,
 * so they can no longer disagree. */
export interface UpdateCheckResult {
  currentRound: number | null;
  currentTitle: string | null;
  latestRound: number | null;
  latestTitle: string | null;
  updateAvailable: boolean;
  /** Which comparison decided `updateAvailable`. */
  source: "docker-hub" | "changelog";
  imageTag: string | null;
  currentBuildTime: string | null;
  /** When Docker Hub's copy of the tag was last pushed (docker-hub source only). */
  latestPushedAt: string | null;
  /** What the daily notifier remembers so it announces a newer build once: the push time or the round. */
  latestId: string | null;
}

function parseTopRound(markdown: string): { round: number | null; title: string | null } {
  const match = markdown.match(/^##\s*Round\s+(\d+)\s*[—-]\s*(.+)$/m);
  if (!match) return { round: null, title: null };
  return { round: Number(match[1]), title: match[2].trim() };
}

function readLocalChangelog(): string {
  const changelogPath = path.join(__dirname, "..", "..", "CHANGELOG.md");
  try {
    return fs.readFileSync(changelogPath, "utf-8");
  } catch {
    return "";
  }
}

async function fetchRemoteChangelogRound(): Promise<{ round: number | null; title: string | null }> {
  const res = await fetch(CHANGELOG_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`GitHub fetch failed: HTTP ${res.status}`);
  return parseTopRound(await res.text());
}

async function fetchTagPushedAt(imageTag: string): Promise<string | null> {
  const res = await fetch(`https://hub.docker.com/v2/repositories/${DOCKER_HUB_REPO}/tags/${encodeURIComponent(imageTag)}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Docker Hub lookup failed: HTTP ${res.status}`);
  const body = (await res.json()) as { tag_last_pushed?: string; last_updated?: string };
  return body.tag_last_pushed ?? body.last_updated ?? null;
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const local = parseTopRound(readLocalChangelog());
  // A build time without a zone ("2026-11-02 10:00:00") would be read in the container's TZ and could trip the
  // comparison by itself, so only a time that says its zone is trusted.
  const buildMs = config.buildTime && /(Z|[+-]\d{2}:?\d{2})$/i.test(config.buildTime.trim()) ? new Date(config.buildTime).getTime() : NaN;

  if (config.imageTag && Number.isFinite(buildMs)) {
    const latestPushedAt = await fetchTagPushedAt(config.imageTag);
    const pushedMs = latestPushedAt ? new Date(latestPushedAt).getTime() : NaN;
    // The round numbers are only for display here; GitHub being unreachable must not hide the answer.
    const remote = await fetchRemoteChangelogRound().catch(() => ({ round: null, title: null }));
    return {
      currentRound: local.round,
      currentTitle: local.title,
      latestRound: remote.round,
      latestTitle: remote.title,
      updateAvailable: Number.isFinite(pushedMs) && pushedMs > buildMs + UPDATE_PUSH_GRACE_MS,
      source: "docker-hub",
      imageTag: config.imageTag,
      currentBuildTime: config.buildTime,
      latestPushedAt,
      latestId: latestPushedAt,
    };
  }

  const remote = await fetchRemoteChangelogRound();
  return {
    currentRound: local.round,
    currentTitle: local.title,
    latestRound: remote.round,
    latestTitle: remote.title,
    updateAvailable: local.round != null && remote.round != null && remote.round > local.round,
    source: "changelog",
    imageTag: config.imageTag,
    currentBuildTime: config.buildTime,
    latestPushedAt: null,
    latestId: remote.round != null ? `Round ${remote.round}` : null,
  };
}
