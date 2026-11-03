import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../db/index.js";
import { config } from "../config.js";

/** When this process started, for the System page ("up since"). */
const STARTED_AT = new Date().toISOString();

export interface BuildInfo {
  appVersion: string;
  buildTime: string | null;
  imageTag: string | null;
  commit: string | null;
  startedAt: string;
  runtime: string;
  docker: boolean;
  databaseType: "sqlite" | "postgres";
  databaseVersion: string | null;
}

function readAppVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const APP_VERSION = readAppVersion();

/** What is running: Sonarr's System > Status shows version, branch, start time, runtime, whether it is
 * in Docker and the database type and version; the page used to show a hard-coded "0.1.0". Build time,
 * image tag and commit come from the image build (see the Dockerfiles); a dev run has none of them. */
export async function getBuildInfo(): Promise<BuildInfo> {
  let databaseVersion: string | null = null;
  try {
    if (db.dialect === "postgres") {
      const row = (await db.prepare("SHOW server_version").get()) as { server_version?: string } | undefined;
      databaseVersion = row?.server_version ?? null;
    } else {
      const row = (await db.prepare("SELECT sqlite_version() AS v").get()) as { v?: string } | undefined;
      databaseVersion = row?.v ?? null;
    }
  } catch {
    // the version is informational: a failing query must not break the status page
  }
  return {
    appVersion: APP_VERSION,
    buildTime: config.buildTime,
    imageTag: config.imageTag,
    commit: config.commit,
    startedAt: STARTED_AT,
    runtime: `Node ${process.version}`,
    docker: fs.existsSync("/.dockerenv"),
    databaseType: db.dialect,
    databaseVersion,
  };
}
