#!/usr/bin/env node
// Re-record the Classic baselines: full-page screenshots (blocking ones), axe fingerprints and Tab-walk counters.
//
//   npm run update:baselines                       all Classic projects, all routes
//   npm run update:baselines -- --project=classic-dark-desktop
//   E2E_ROUTES=library-type,media-detail npm run update:baselines    (a subset; use cmd's `set` on Windows)
//
// This only WRITES the files. The owner must review the diff and record the approval in baselines/APPROVALS.md:
// an agent that generated a baseline must not be the one that approves it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { E2E_DIR, log } from "./_common.mjs";

const extra = process.argv.slice(2);
const hasProject = extra.some((a) => a.startsWith("--project"));
const cli = path.join(E2E_DIR, "node_modules", "@playwright", "test", "cli.js");

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: E2E_DIR, stdio: "inherit", env: { ...process.env, DO_NOT_TRACK: "1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

log("1/2 drift check");
run(["test", "--config=playwright.drift.config.ts"]);

log("2/2 recording Classic baselines (screens via --update-snapshots=changed, axe + tab-walk via E2E_UPDATE_RATCHETS=1)");
run(["test", ...(hasProject ? [] : ["--project=classic-*"]), "--update-snapshots=changed", ...extra], { E2E_UPDATE_RATCHETS: "1" });

log("Done. Review `git diff` / `git status` under web-e2e/baselines/, then the owner records approval in baselines/APPROVALS.md.");
