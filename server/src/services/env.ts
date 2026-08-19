import fs from "node:fs";

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
    } catch {
      return undefined;
    }
  }
  return process.env[name];
}
