/**
 * Backend-agnostic async DB interface — see DATABASE_MIGRATION.md for why this exists and what it
 * doesn't cover yet. Two implementations: SQLite (wraps the existing synchronous better-sqlite3
 * `db` export in resolved promises — zero behavior change, just an async-shaped call surface) and
 * PostgreSQL (a real `pg` connection).
 *
 * Wired in via `db/index.ts`'s `db` export (a `Proxy` over whichever driver `initDb()` picked) —
 * nearly every route/service file imports `db` from there now, not from `db/client.ts` directly.
 * SQLite-dialect bugs here are theoretical (it's a thin async wrapper over the same synchronous
 * `better-sqlite3` calls); Postgres-dialect bugs are live, since real query results now flow
 * through this interface into production code.
 *
 * Design choices that keep the 444 existing call sites' *shape* (not yet their sync-ness) mostly
 * unchanged once they are converted:
 * - Callers still write positional `?` placeholders — the Postgres implementation translates them
 *   to `$1, $2, ...` internally. Nothing about how call sites pass parameters needs to change.
 * - `.run()`'s result still exposes `.lastInsertRowid` on both backends. Postgres has no native
 *   equivalent (no ROWID), so every INSERT run through this interface has `RETURNING id` appended
 *   automatically — except for the handful of tables with no plain `id` column (see
 *   TABLES_WITHOUT_ID below: a key-value table and composite-primary-key junction tables) — and
 *   `.lastInsertRowid` is populated from the returned row. The ~38 existing call sites that read
 *   `.lastInsertRowid` don't need to change at all beyond adding `await`.
 * - Transactions are explicit BEGIN/COMMIT/ROLLBACK on both backends (not better-sqlite3's own
 *   `db.transaction()` sugar, which requires a synchronous callback and can't wrap `await`ed
 *   statements) — the one place where using this interface looks different from the current
 *   `db.transaction(fn)()` call sites, all 13 of which will need that one specific rewrite.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import { Pool, type PoolClient, types as pgTypes } from "pg";

// node-postgres returns BIGINT/BIGSERIAL columns and COUNT()/SUM() aggregate results (all OID 20 —
// "int8") as a JS *string* by default, to avoid silently losing precision above
// Number.MAX_SAFE_INTEGER — but better-sqlite3 returns the same columns/aggregates as plain numbers,
// so a query result's shape otherwise differs by dialect (`{ c: "0" }` vs `{ c: 0 }`) even though
// every call site treats it as a number. Every real BIGINT column in this schema is a byte count
// (size_bytes, queue.size, disk_usage_samples.*_bytes) — always far under the safe-integer limit —
// so it's safe to just parse int8 as a number process-wide instead of auditing every COUNT()/SUM()
// call site to wrap it in Number(...) individually.
pgTypes.setTypeParser(20, (value: string) => parseInt(value, 10));

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
  /** SQLite only: holds writes (not reads) until the returned function is called, while a maintenance job on another connection has the file locked. Absent on Postgres. */
  pauseWrites?(): () => void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SQLite implementation — wraps the existing synchronous driver
// ---------------------------------------------------------------------------

/** How long a statement from outside an open SQLite transaction waits for it before going ahead. */
const GATE_TIMEOUT_MS = 10_000;

class SqliteAsyncDb implements AsyncDb {
  readonly dialect = "sqlite" as const;
  constructor(
    private db: Database.Database,
    private readonly gateTimeoutMs: number = GATE_TIMEOUT_MS
  ) {}

  // One connection serves the whole process, so BEGIN ... COMMIT on it covers every statement that runs
  // while the callback awaits something, from any request: an unrelated insert joined the transaction and
  // vanished with its rollback. A statement from outside the transaction's own async chain now waits until the
  // transaction has ended (see `gate`). That is cheap because of the rule that a transaction callback awaits only
  // database calls (tests/transactionCallbacks.test.ts checks every call site), so a transaction lasts
  // milliseconds; and bounded, so a callback that breaks the rule and waits for something that needs the
  // database cannot freeze the process (the waiter goes ahead after GATE_TIMEOUT_MS and says so).
  // A second transaction() waits its turn in `transactionQueue` instead of throwing "cannot start a
  // transaction within a transaction".
  private transactionQueue: Promise<void> = Promise.resolve();
  /** The transaction that is open now, with the promise that settles when it has ended. */
  private openTransaction: { ended: Promise<void> } | null = null;
  // Tells a transaction() started from inside a transaction callback (which would wait for its own
  // caller for ever) from one started by another request: the first throws, as it always did.
  // The marker is an object that is switched off when the transaction ends: async work started inside the
  // callback keeps this context for good (a timer, a fire-and-forget promise), and must not read as nested later.
  private readonly insideTransaction = new AsyncLocalStorage<{ active: boolean }>();

  // Writes held back while a maintenance job on another connection (VACUUM in a worker thread) has the file's write
  // lock: a write attempted meanwhile would sit in SQLite's busy handler, which sleeps the whole event loop (the
  // driver is synchronous) and then fails after its 5 s timeout. Reads go on (WAL readers are not blocked).
  private writePause: { released: Promise<void> } | null = null;

  /** Holds every write that is not part of an open transaction until the returned function is called. */
  pauseWrites(): () => void {
    if (this.writePause) return () => undefined; // already paused by someone else: that one releases it
    let resume!: () => void;
    const pause = { released: new Promise<void>((resolve) => (resume = resolve)) };
    this.writePause = pause;
    return () => {
      if (this.writePause === pause) this.writePause = null;
      resume();
    };
  }

  /**
   * Runs `action` once nothing stands in its way, with no await between the last check and the call: a statement from
   * outside the open transaction's own async chain waits for the transaction to end (and for the next queued one, which
   * can open the moment the first closes, so it checks again), and a write waits out a write pause. The transaction
   * wait is bounded; a pause is held for as long as its owner needs.
   */
  private async whenClear<T>(isWrite: boolean, action: () => T): Promise<T> {
    const blocked = () => (!!this.openTransaction && !this.insideTransaction.getStore()?.active) || (isWrite && !!this.writePause && !this.insideTransaction.getStore()?.active);
    if (!blocked()) return action();
    const deadline = Date.now() + this.gateTimeoutMs;
    while (blocked()) {
      if (this.openTransaction && !this.insideTransaction.getStore()?.active) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          console.warn(`[db] a statement waited ${this.gateTimeoutMs / 1000}s for an open transaction and went ahead: something inside the transaction is awaiting a non-database call`);
          break;
        }
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          this.openTransaction.ended,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
            timer.unref?.();
          }),
        ]);
        clearTimeout(timer);
      } else if (this.writePause) {
        await this.writePause.released;
      }
    }
    return action();
  }

  prepare(sql: string): AsyncStatement {
    const stmt = this.db.prepare(sql);
    // INSERT/UPDATE/DELETE ... RETURNING comes back through get/all, so the statement text decides, not the method.
    const writes = !stmt.reader || /^\s*(insert|update|delete|replace)\b/i.test(sql);
    return {
      run: (...params: any[]) =>
        this.whenClear(true, () => {
          const info = stmt.run(...params);
          return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
        }),
      get: (...params: any[]) => this.whenClear(writes, () => stmt.get(...params)),
      all: (...params: any[]) => this.whenClear(writes, () => stmt.all(...params)),
    };
  }

  async exec(sql: string): Promise<void> {
    await this.whenClear(true, () => this.db.exec(sql));
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.insideTransaction.getStore()?.active) throw new Error("cannot start a transaction within a transaction");
    const previous = this.transactionQueue;
    let release!: () => void;
    const finished = new Promise<void>((resolve) => (release = resolve));
    this.transactionQueue = previous.then(() => finished);
    await previous;
    // A transaction is a write: it waits for a maintenance pause too (before it takes the slot, so nothing else waits behind it for long).
    while (this.writePause) await this.writePause.released;
    const scope = { active: true };
    this.openTransaction = { ended: finished };
    try {
      this.db.exec("BEGIN");
      try {
        const result = await this.insideTransaction.run(scope, fn);
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    } finally {
      scope.active = false;
      this.openTransaction = null;
      release();
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

/** better-sqlite3 supports named parameters — `.run({ name: "x", ... })` against SQL containing
 * `@name` tokens — used in a handful of files for INSERTs with a lot of columns, where a long
 * positional `?` list gets hard to keep aligned with its values by eye. Postgres's driver has no
 * named-parameter concept at all, only positional `$1, $2, ...`, so this rewrites `@word` tokens
 * to sequential `$N`s (the same token repeated later in the SQL reuses its first `$N`, matching
 * better-sqlite3's own semantics for a repeated named param) and builds the matching positional
 * values array by looking each token up in the params object, in the order the *placeholders*
 * were assigned — not the order the object's keys happen to be defined in. */
function translateNamedParams(sql: string, params: Record<string, unknown>): { sql: string; values: unknown[] } {
  const indexByName = new Map<string, number>();
  const values: unknown[] = [];
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inString = !inString;
      out += ch;
      continue;
    }
    if (ch === "@" && !inString) {
      const match = /^@(\w+)/.exec(sql.slice(i));
      if (match) {
        const name = match[1];
        let index = indexByName.get(name);
        if (index === undefined) {
          values.push(params[name]);
          index = values.length;
          indexByName.set(name, index);
        }
        out += `$${index}`;
        i += match[0].length - 1;
        continue;
      }
    }
    out += ch;
  }
  return { sql: out, values };
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
  "season_searches",
  "queue_targets",
  "rss_sync_state",
  "indexer_status",
  "import_list_entries",
  "download_client_status",
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
    // A single plain-object argument means better-sqlite3 named-parameter style (`@name` tokens in
    // the SQL) — anything else (zero args, or one-or-more positional values) is the ordinary `?`
    // positional style. Arrays/null/Date etc. as a *single* positional param would false-positive
    // here if treated as "an object", so this only takes the named-param path for a plain object.
    if (params.length === 1 && params[0] !== null && typeof params[0] === "object" && !Array.isArray(params[0]) && !(params[0] instanceof Date)) {
      const translated = translateNamedParams(sql, params[0]);
      return runner.query(translated.sql, translated.values);
    }
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

export function createSqliteAsyncDb(sqliteDb: Database.Database, options: { gateTimeoutMs?: number } = {}): AsyncDb {
  return new SqliteAsyncDb(sqliteDb, options.gateTimeoutMs);
}

export function createPostgresAsyncDb(connectionString: string): AsyncDb {
  const pool = new Pool({ connectionString });
  return new PostgresAsyncDb(pool);
}

/**
 * SQL fragment for "the current time, as a string in the same shape schema.sql's `datetime('now')`
 * column defaults already produce" — for use *inside a query* (`WHERE expires_at > ${nowExpr(db)}`),
 * not just a column default. SQLite's `datetime('now')` only works verbatim on SQLite; call sites
 * that need "now" as part of a WHERE/SET clause (not just relying on a column's own DEFAULT) need
 * this instead of hardcoding the SQLite spelling, since a plain string comparison between a TEXT
 * column and Postgres's `now()` (a real timestamptz) fails outright rather than silently doing the
 * wrong thing — see DATABASE_MIGRATION.md's note on the 5-6 files using `datetime('now', ...)` at
 * the query level.
 */
export function nowExpr(db: Pick<AsyncDb, "dialect">): string {
  return db.dialect === "postgres" ? "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')" : "datetime('now')";
}

/**
 * Same idea as `nowExpr`, offset by a whole number of days (negative for the past, e.g. -30 for
 * "30 days ago") — for the handful of call sites that used SQLite's `datetime('now', '-N days')`
 * modifier syntax at the query level, which has no Postgres equivalent (`interval` arithmetic is the
 * right shape there). `days` must be a trusted integer the caller computed itself (not raw user
 * input) since it's interpolated directly rather than bound as a parameter — string interpolation
 * here is safe for the same reason a LIMIT/OFFSET literal is, just not something to relax.
 */
export function nowOffsetExpr(db: Pick<AsyncDb, "dialect">, days: number): string {
  const n = Math.trunc(days);
  return db.dialect === "postgres"
    ? `to_char((now() AT TIME ZONE 'UTC') + interval '${n} days', 'YYYY-MM-DD HH24:MI:SS')`
    : `datetime('now', '${n} days')`;
}

/** Same idea as `nowOffsetExpr`, but offset by a whole number of hours — for call sites (e.g. a
 * "stuck longer than N hours" threshold) where a day granularity is too coarse. Same trusted-integer
 * caveat applies. */
export function nowOffsetHoursExpr(db: Pick<AsyncDb, "dialect">, hours: number): string {
  const n = Math.trunc(hours);
  return db.dialect === "postgres"
    ? `to_char((now() AT TIME ZONE 'UTC') + interval '${n} hours', 'YYYY-MM-DD HH24:MI:SS')`
    : `datetime('now', '${n} hours')`;
}
