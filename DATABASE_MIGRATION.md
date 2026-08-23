# External Database Support — Scoping Document

Status: **scoped, not started**. This document exists so a future round can pick this up without
re-deriving the analysis below. It reflects the codebase as of Round 77.

## The ask

Let users choose MariaDB or PostgreSQL as an alternative to AoNarr's built-in SQLite, the way some
self-hosted apps (Nextcloud, Immich, Jellyfin's newer versions) let you point at an external DB
server instead of a local file.

## Why this isn't a bounded feature

Every other item shipped in this project has been additive: a new route, a new table, a new page.
This one is different in kind — it's a foundation swap. The numbers from the current codebase:

- **70 files** call `db.prepare(...)` directly — 37 in `routes/`, 32 in `services/`, 1 in `db/`
- **444 individual `db.prepare()` call sites**
- **40 tables**, 34 foreign keys, 48 ad-hoc `ALTER TABLE ... ADD COLUMN` migrations already
  accumulated in `db/client.ts` (see `ensureColumn()` calls) — one per feature round that added a
  column to an existing table
- **13 files** use `db.transaction(...)` for multi-statement atomicity
- better-sqlite3 is **fully synchronous** — every `.prepare().run()/.get()/.all()` call blocks
  the calling function and returns immediately with a value, no `await` anywhere in the data layer.
  This is why so many routes in this codebase read as straight-line procedural code with no promise
  chains around DB access.

There is no existing abstraction layer. `db` (the raw better-sqlite3 `Database` instance) is
imported directly from `db/client.ts` into every route and service file that touches data. Adding a
second backend isn't "add a config option" — it's introducing an abstraction boundary retroactively
into 70 files that currently have none.

## What specifically breaks going from SQLite to Postgres/MariaDB

1. **Sync → async.** `mysql2`, `mariadb`, and `pg` (the standard Node drivers for the other two) are
   all async. Every one of the 444 call sites becomes `await db.prepare(...)`, which cascades: the
   *calling* function must become `async`, which cascades to *its* caller, and so on up through
   route handlers (already async, fine) but also plain service functions that are currently sync
   and called from other sync functions (not fine — this is the actual size of the blast radius,
   not the 444 call sites themselves).

2. **SQLite-specific SQL used throughout:**
   - `datetime('now')` as a column default (52 uses) — Postgres wants `now()`, MySQL/MariaDB wants
     `NOW()` or `CURRENT_TIMESTAMP`.
   - `INSERT ... ON CONFLICT(col) DO UPDATE SET x = excluded.x` (14 uses) — this exact syntax is
     valid Postgres too (lucky), but MariaDB/MySQL requires `ON DUPLICATE KEY UPDATE x = VALUES(x)`,
     a different clause entirely. This alone makes MariaDB strictly more work than Postgres.
   - `INTEGER PRIMARY KEY AUTOINCREMENT` (33 uses, i.e. nearly every table) — Postgres wants
     `SERIAL`/`GENERATED ALWAYS AS IDENTITY`, MariaDB wants `AUTO_INCREMENT`.
   - `PRAGMA table_info(table)` (used by the migration helpers in `db/client.ts` to introspect
     columns) has no equivalent; both alternatives use `information_schema.columns` instead.
   - `WITH RECURSIVE` (1 use, `library_groups`' nested-group rollup) — supported by both Postgres
     and MariaDB 10.2+/MySQL 8+, so this one's actually low-risk.
   - SQLite's dynamic typing means TEXT columns routinely hold JSON blobs (`external_ids`,
     `media_info`, `extra_metadata`, `config`, dozens more) parsed with `JSON.parse()` in JS.
     Postgres has a real `jsonb` type that would be the correct target; MariaDB has `JSON` (stored
     as `LONGTEXT` under the hood, so closer to what SQLite already does). Neither is a blocker,
     but it's a real design decision, not a mechanical port.

3. **The migration system itself is SQLite-specific.** `db/client.ts`'s `ensureColumn()` helper
   (`ALTER TABLE ... ADD COLUMN`, called 48 times) happens to be valid syntax on all three engines
   for simple additive columns, so that part actually ports cleanly. The harder part is the
   handful of *structural* migrations already in that file — `dropCheckConstraint()` and
   `repairDanglingReference()` rebuild a table from scratch (`RENAME TO ..._pre_migration`,
   recreate, copy rows, drop) because SQLite can't drop/alter a CHECK constraint or a foreign key
   in place. Postgres and MariaDB *can* (`ALTER TABLE ... DROP CONSTRAINT`, `ALTER TABLE ...
   MODIFY`), so these would need engine-specific rewrites rather than being reused as-is — but
   they're only 3 call sites, not 48.

4. **Every route currently trusts SQLite's implicit single-writer serialization.** Because
   better-sqlite3 runs in-process and synchronously, two "check then insert" statements back to
   back (common pattern: `SELECT ... WHERE title = ?` to check for a duplicate, then `INSERT`) are
   safe from races *by accident* — nothing else can interleave between them because nothing else is
   running. A real client-server DB with concurrent connections doesn't have that guarantee; those
   patterns need either an explicit transaction or a unique constraint + conflict handling to stay
   correct. This is the least visible risk in the whole migration — it won't show up as a compile
   error or even a test failure, only as an occasional duplicate row under real concurrent load.

## Options considered

**A. Query builder with multi-dialect support (Kysely, Knex).** Write SQL-ish TypeScript, the
library translates to each engine's dialect and abstracts the driver's async API. Still requires
touching every one of the 444 call sites and adding `await` up the call chain, but removes the need
to hand-write three versions of every query. Kysely in particular is fully typed and has clean
Postgres/MySQL/SQLite dialects. **This is the realistic option** if the goal is genuinely supporting
three backends long-term.

**B. Full ORM (Prisma, Drizzle).** Bigger rewrite than a query builder — schema gets redefined in
the ORM's own schema language, which then generates migrations, rather than hand-written SQL. More
upfront work than A, but better long-term ergonomics and built-in migration tooling (which this
project currently does by hand in `client.ts`, accumulating `ensureColumn()` calls). Drizzle is the
closer fit of the two (schema-as-TypeScript, keeps hand-written SQL as an escape hatch, decent
SQLite/Postgres/MySQL support); Prisma's query engine has historically been the heavier runtime cost
for a self-hosted single-binary-style app like this one.

**C. Thin custom repository layer, hand-write three dialects.** Wrap the ~40 tables' worth of
queries behind functions, implement each function three times (or with light templating) per
engine. More total code than A or B, all of it hand-maintained, but no new dependency and full
control. Given 444 call sites already exist as ad-hoc SQL, this is really "option A without the
library" — more work for no compensating benefit.

**D. Don't migrate the query layer at all — offer PostgreSQL-compatible export/import instead of
live dual-backend support.** Keep SQLite as the only *runtime* engine, but let a user export the
whole DB in a Postgres-loadable form (this is roughly what `pg_dump`-style tools do, or what a
one-way ETL job would do) for people who want their data queryable from an external BI tool, backup
system, etc. — without AoNarr itself ever running against anything but SQLite. Far less work, but
doesn't satisfy "let users choose MariaDB/Postgres as AoNarr's own database," which is what was
actually asked for.

## Recommendation

**Option A (Kysely), Postgres first, MariaDB second — if this gets built at all.**

- Postgres over MariaDB as the first alternative target because the `ON CONFLICT ... DO UPDATE`
  syntax already used throughout the codebase is valid Postgres syntax verbatim — one whole category
  of the port (14+ call sites, likely more as the schema grows) is close to free. MariaDB's
  `ON DUPLICATE KEY UPDATE` is a genuinely different clause shape and would need every one of those
  sites rewritten with different logic, not just swapped syntax.
- Kysely over Drizzle/Prisma because it's the smallest conceptual jump from what's here today
  (hand-written SQL-shaped queries, just async and dialect-aware) — lower risk of the migration
  itself introducing bugs than adopting a full ORM's schema/migration model on top of everything
  else changing at once.
- SQLite stays the default and the only backend the Unraid Community Applications template assumes
  — this is an opt-in advanced setting for people who already run a Postgres/MariaDB server, not a
  requirement for anyone else. Nothing about the existing single-file-DB deployment story changes
  for the overwhelming majority of users.

## If pursued, suggested phasing

1. **Introduce the abstraction with zero behavior change.** Swap `db/client.ts`'s raw
   better-sqlite3 export for a Kysely instance still backed by SQLite (Kysely has a SQLite dialect
   using better-sqlite3 under the hood). Convert call sites file-by-file, each PR/round touching a
   handful of routes, all still running against SQLite the whole time. This phase is pure risk
   reduction — it's the point where the "add `await` up the call chain" cascade actually gets found
   and fixed, without also debugging a new database engine at the same time.
2. **Add the Postgres dialect and a `DATABASE_DRIVER` env var / setting.** Get the schema (rewritten
   in Kysely's migration format, or hand-translated `CREATE TABLE` statements) applying cleanly to a
   real Postgres instance. Audit the "implicit serialization" risk (point 4 above) — this is the
   step where every check-then-insert pattern needs a real look, since Postgres will actually
   surface races SQLite never could.
3. **Live-verify a full round-trip on Postgres**: every route this project has, exercised against a
   real `postgres:16` container the same way every other feature in this project has been verified
   against a real running instance — not just "the query compiles."
4. **MariaDB as a follow-up phase**, once Postgres is solid — reusing the abstraction from phase 1,
   but redoing every `ON CONFLICT` site with `ON DUPLICATE KEY UPDATE` semantics.

## Rough effort shape

Not a time estimate (this project's rounds don't map to calendar time), but a shape: phase 1 alone
is comparable in size to every round shipped in this project *combined* — it touches 70 files, not
one feature's worth. Phases 2–4 are each smaller than phase 1 individually, but assume phase 1 is
completely done and stable first; none of them are safe to start concurrently with it.

## Explicit non-goals

- **No live migration tool** (moving an existing SQLite install's data into Postgres/MariaDB) is
  assumed as part of this scope unless separately requested — this document only covers *supporting*
  an external DB as a fresh choice, not converting an existing installation's data.
- **Not** attempting to support all three engines simultaneously in one release — SQLite stays
  default throughout every phase above; Postgres is additive; MariaDB is a later, separate addition.
- **Not** in scope: connection pooling tuning, HA/replication setup, or anything about how the user
  runs their own Postgres/MariaDB server — that's entirely the user's infrastructure, same as how
  AoNarr doesn't manage the user's download client or media server today.

## Decision needed before starting

Whether to actually commit to this given the size above, and if so, whether Postgres-only (skip
MariaDB entirely, since it's the strictly larger and less-requested of the two once `ON CONFLICT`
syntax is accounted for) is an acceptable scope cut.
