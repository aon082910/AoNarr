import fs from "node:fs";
import { log } from "./logger.js";

/**
 * Docker-secrets-style env var resolution: `NAME_FILE=/run/secrets/x` takes priority and is read
 * from disk (trimmed), falling back to a plain `NAME` env var. Lets secrets be mounted as files
 * (Docker/Swarm secrets, Kubernetes secret volumes) instead of landing in `docker inspect` output
 * or process-list-visible env vars.
 */
export function readEnvOrFile(name: string): string | undefined {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    try {
      return fs.readFileSync(filePath, "utf-8").trim();
    } catch (err) {
      // A caller (e.g. bootstrapAdmin.ts) treats a missing value here the same as the env var
      // never having been set at all and silently skips whatever it was for — a typo'd or
      // unreadable secrets-file path would otherwise fail with zero diagnostic anywhere.
      log.warn(`[env] ${name}_FILE is set to "${filePath}" but couldn't be read:`, (err as Error).message);
      return undefined;
    }
  }
  return process.env[name];
}
