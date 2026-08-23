import { config } from "../config.js";
import { createPostgresAsyncDb, createSqliteAsyncDb, type AsyncDb } from "./asyncDb.js";
import { migratePostgresSchema } from "./postgresSchema.js";

/**
 * The async DB entry point every newly-converted file should import `db` from, instead of the old
 * synchronous `db/client.ts` export. See DATABASE_MIGRATION.md for the overall plan — this module
 * is where the driver actually gets picked.
 *
 * For "sqlite" (the default, and the only driver that fully works today — see the migration doc's
 * "Not done yet" section), `db/client.ts`'s existing synchronous setup runs unchanged via its own
 * top-level side effects (schema creation, all the ad-hoc column/structural migrations) — this
 * module just wraps its already-initialized `db` export in the async interface. For "postgres", the
 * schema is applied explicitly via `migratePostgresSchema` before anything else can query it, since
 * Postgres has no equivalent "runs automatically the moment the file is imported" mechanism.
 *
 * `initDb()` must be awaited before any other module touches `db` — call it once, at the very top
 * of the app's startup sequence in index.ts.
 */

let dbInstance: AsyncDb | null = null;

export async function initDb(): Promise<AsyncDb> {
  if (dbInstance) return dbInstance;

  if (config.databaseDriver === "postgres") {
    if (!config.databaseUrl) {
      throw new Error("AONARR_DATABASE_DRIVER=postgres requires AONARR_DATABASE_URL to be set");
    }
    const pg = createPostgresAsyncDb(config.databaseUrl);
    await migratePostgresSchema(pg);
    dbInstance = pg;
    return dbInstance;
  }

  const { db: sqliteDb } = await import("./client.js");
  dbInstance = createSqliteAsyncDb(sqliteDb);
  return dbInstance;
}

/** Only valid after `initDb()` has resolved — every route/service module that isn't itself
 * responsible for startup ordering can just import this directly, the same way they already import
 * the old synchronous `db` from `db/client.ts`. */
export const db: AsyncDb = new Proxy({} as AsyncDb, {
  get(_target, prop) {
    if (!dbInstance) throw new Error("db accessed before initDb() completed — check startup ordering in index.ts");
    return (dbInstance as any)[prop];
  },
});
