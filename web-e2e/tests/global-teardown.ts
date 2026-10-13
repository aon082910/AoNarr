// Only acts when E2E_UPDATE_RATCHETS=1: merges this run's axe / tab-walk results into the committed baselines.
// Done here, in one process, because the tests run in parallel workers and must not write one shared file.
import fs from "node:fs";
import { PATHS, ratchetUpdateRequested } from "../config/shared";
import { mergeResultsIntoRatchet } from "./lib/ratchet";

export default async function globalTeardown(): Promise<void> {
  if (!ratchetUpdateRequested()) return;
  const info = JSON.parse(fs.readFileSync(PATHS.runInfo, "utf8")) as { startedAtMs: number; platform: string; playwright: string; browser: { version: string }; axeCore: string; webBuild: { gitCommit?: string; sourceHash?: string } | null };
  const meta = {
    updatedAt: new Date().toISOString(),
    platform: info.platform,
    playwright: info.playwright,
    chromium: info.browser.version,
    axeCore: info.axeCore,
    webCommit: info.webBuild?.gitCommit ?? null,
    webSourceHash: info.webBuild?.sourceHash?.slice(0, 12) ?? null,
    approvedBy: null,
  };
  const axe = mergeResultsIntoRatchet("axe", PATHS.axe, PATHS.axeBaseline, info.startedAtMs, meta);
  const tab = mergeResultsIntoRatchet("tabwalk", PATHS.tabwalk, PATHS.tabwalkBaseline, info.startedAtMs, meta);
  console.log(`[web-e2e] ratchet baselines updated: axe ${axe} entries, tab-walk ${tab} entries. The owner must review and approve the diff (baselines/APPROVALS.md).`);
}
