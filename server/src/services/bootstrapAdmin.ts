import { db } from "../db/index.js";
import { hashPassword } from "./auth.js";
import { readEnvOrFile } from "./env.js";
import { log } from "./logger.js";

/**
 * Non-interactive alternative to the web UI's first-run "create admin account" screen — for
 * deployments (Docker secrets, Kubernetes, IaC) that want the admin account provisioned at
 * container start rather than clicked through in a browser. Only acts when no admin exists yet,
 * so it's safe to leave these env vars set permanently (e.g. rotating a secret file doesn't
 * change anything after the first run).
 */
export async function bootstrapAdminFromEnv(): Promise<void> {
  const existingAdmin = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existingAdmin) return;

  const username = readEnvOrFile("AONARR_ADMIN_USERNAME");
  const password = readEnvOrFile("AONARR_ADMIN_PASSWORD");
  if (!username || !password) return;

  if (password.length < 8) {
    log.warn("[bootstrapAdmin] AONARR_ADMIN_PASSWORD is too short (min 8 chars) — skipping admin bootstrap");
    return;
  }

  await db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(
    username.trim(),
    hashPassword(password)
  );
  log.info(`[bootstrapAdmin] created admin account "${username.trim()}" from environment`);
}
