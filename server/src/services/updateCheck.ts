import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** AoNarr has no semver/git-tag releases (it ships as a rolling `main` branch + Docker `latest`-
 * style tags), so there's no GitHub Releases API to check against the way Radarr checks its own
 * tagged releases. The closest honest equivalent is the round number CHANGELOG.md is already
 * organized by — every shipped change adds a new "## Round N — ..." entry at the top, so
 * comparing the locally-bundled CHANGELOG against the one on GitHub's main branch tells you
 * whether you're running an older build without needing any separate version scheme. */
export interface UpdateCheckResult {
  currentRound: number | null;
  currentTitle: string | null;
  latestRound: number | null;
  latestTitle: string | null;
  updateAvailable: boolean;
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

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const local = parseTopRound(readLocalChangelog());

  const res = await fetch("https://raw.githubusercontent.com/aon082910/AoNarr/main/CHANGELOG.md", {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub fetch failed: HTTP ${res.status}`);
  const remote = parseTopRound(await res.text());

  return {
    currentRound: local.round,
    currentTitle: local.title,
    latestRound: remote.round,
    latestTitle: remote.title,
    updateAvailable: local.round != null && remote.round != null && remote.round > local.round,
  };
}
