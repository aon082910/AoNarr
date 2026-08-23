/**
 * Backend-agnostic async DB interface — see DATABASE_MIGRATION.md for why this exists and what it
 * doesn't cover yet. Two implementations: SQLite (wraps the existing synchronous better-sqlite3
 * `db` export in resolved promises — zero behavior change, just an async-shaped call surface) and
 * PostgreSQL (a real `pg` connection).
 *
 * NOT WIRED INTO THE APP YET. Every route/service still imports the synchronous `db` from
 * `db/client.ts` directly. This module is phase 1 of DATABASE_MIGRATION.md's plan: prove the
 * abstraction itself is correct against a real Postgres instance before touching any of the ~70
 * files that would need `await` added to actually use it. Converting those files is the bulk of
 * the remaining work and happens in later rounds.
 *
 * Design choices that keep the 444 existing call sites' *shape* (not yet their sync-ness) mostly
 * unchanged once they are converted:
 * - Callers still write positional `?` placeholders — the Postgres implementation translates them
 *   to `$1, $2, ...` internally. Nothing about how call sites pass parameters needs to change.
 * - `.run()`'s result still exposes `.lastInsertRowid` on both backends. Postgres has no native
 *   equivalent (no ROWID), so every INSERT run through this interface has `RETURNING id` appended
 *   automatically (every one of this app's ~40 tables has an `id` primary key, so this is safe
 *   unconditionally) and `.lastInsertRowid` is populated from the returned row. The ~38 existing
 *   call sites that read `.lastInsertRowid` don't need to change at all beyond adding `await`.
 * - Transactions are explicit BEGIN/COMMIT/ROLLBACK on both backends (not better-sqlite3's own
 *   `db.transaction()` sugar, which requires a synchronous callback and can't wrap `await`ed
 *   statements) — the one place where using this interface looks different from the current
 *   `db.transaction(fn)()` call sites, all 13 of which will need that one specific rewrite.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import { Pool, type PoolClient } from "pg";

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint | null;
}

export interface AsyncStatement {
  run(...params: any[]): Promise<RunResult>;
  get(...params: any[]): Promise<any>;
  all(...params: any[]): Promise<any[]>;
}

export interface AsyncDb {
  readonly dialect: "sqlite" | "postgres";
  prepare(sql: string): AsyncStatement;
  exec(sql: string): Promise<void>;
  /** Runs `fn` inside BEGIN/COMMIT, ROLLBACK on throw. `fn` receives nothing — it closes over
   * whatever `db` instance it needs, same as every existing db.transaction(() => {...}) callback
   * already does; only the wrapping syntax differs from better-sqlite3's version. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SQLite implementation — wraps the existing synchronous driver
// ---------------------------------------------------------------------------

class SqliteAsyncDb implements AsyncDb {
  readonly dialect = "sqlite" as const;
  constructor(private db: Database.Database) {}

  prepare(sql: string): AsyncStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: async (...params: any[]) => {
        const info = stmt.run(...params);
        return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
      },
      get: async (...params: any[]) => stmt.get(...params),
      all: async (...params: any[]) => stmt.all(...params),
    };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec("BEGIN");
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL implementation
// ---------------------------------------------------------------------------

/** Translates `?` positional placeholders to Postgres's `$1, $2, ...`, skipping `?` characters
 * that appear inside single-quoted string literals (this codebase's SQL doesn't currently have
 * any, but a scanner that ignores that risks silently mistranslating one if it ever does). */
function toPgPlaceholders(sql: string): string {
  let out = "";
  let paramIndex = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inString = !inString;
      out += ch;
    } else if (ch === "?" && !inString) {
      paramIndex++;
      out += `$${paramIndex}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Tables with no plain `id` column — a key-value table keyed by `key` (settings), and junction/
 * join tables with a composite primary key. Appending RETURNING id to an INSERT into one of these
 * would fail with Postgres error 42703 and, worse, abort any transaction it ran inside (Postgres
 * poisons the whole transaction on a statement error, unlike SQLite) — so this is a static list
 * checked before ever sending the query, not a try/catch after the fact. None of these tables'
 * existing call sites read `.lastInsertRowid` today, so returning null for them is a no-op change.
 * Keep in sync manually if a future round adds a table shaped like these. */
const TABLES_WITHOUT_ID = new Set([
  "settings",
  "media_item_tags",
  "quality_profile_format_scores",
  "collection_items",
  "user_library_access",
  "sessions",
  "release_group_stats",
]);

function withReturningId(sql: string): string {
  if (!/^\s*insert\s+into/i.test(sql) || /\breturning\b/i.test(sql)) return sql;
  const tableMatch = sql.match(/^\s*insert\s+into\s+["`]?(\w+)["`]?/i);
  if (tableMatch && TABLES_WITHOUT_ID.has(tableMatch[1].toLowerCase())) return sql;
  return `${sql.replace(/;\s*$/, "")} RETURNING id`;
}

// Tracks the connection held by an in-progress transaction, scoped to the async call chain that's
// inside it — NOT shared mutable state on the db instance, which would cross-talk between two
// concurrent requests each running their own transaction against the same pooled singleton. Any
// query made anywhere inside `db.transaction(async () => { ...await db.prepare(...).run() })`
// automatically lands on the same connection/transaction, no matter how deep the call chain is,
// because AsyncLocalStorage propagates through every `await` in that chain — the same mechanism
// Node's own `AsyncLocalStorage` docs use request-tracing as the canonical example of.
const activeTransactionClient = new AsyncLocalStorage<PoolClient>();

class PostgresAsyncDb implements AsyncDb {
  readonly dialect = "postgres" as const;
  constructor(private pool: Pool) {}

  private async query(sql: string, params: any[]): Promise<{ rows: any[]; rowCount: number | null }> {
    const runner = activeTransactionClient.getStore() ?? this.pool;
    return runner.query(toPgPlaceholders(sql), params);
  }

  prepare(sql: string): AsyncStatement {
    return {
      run: async (...params: any[]) => {
        const result = await this.query(withReturningId(sql), params);
        return { changes: result.rowCount ?? 0, lastInsertRowid: result.rows[0]?.id ?? null };
      },
      get: async (...params: any[]) => (await this.query(sql, params)).rows[0],
      all: async (...params: any[]) => (await this.query(sql, params)).rows,
    };
  }

  async exec(sql: string): Promise<void> {
    const runner = activeTransactionClient.getStore() ?? this.pool;
    await runner.query(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await activeTransactionClient.run(client, fn);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createSqliteAsyncDb(sqliteDb: Database.Database): AsyncDb {
  return new SqliteAsyncDb(sqliteDb);
}

export function createPostgresAsyncDb(connectionString: string): AsyncDb {
  const pool = new Pool({ connectionString });
  return new PostgresAsyncDb(pool);
}
