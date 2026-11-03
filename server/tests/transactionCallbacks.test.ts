import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteAsyncDb } from "../src/db/asyncDb.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SQLite transaction() with a callback that awaits (audit RB15)", () => {
  function freshDb() {
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)");
    return createSqliteAsyncDb(raw);
  }

  it("makes a second transaction wait for the first instead of failing", async () => {
    const db = freshDb();
    const order: string[] = [];

    const a = db.transaction(async () => {
      await db.prepare("INSERT INTO t (label) VALUES ('a1')").run();
      order.push("a started");
      await sleep(40);
      await db.prepare("INSERT INTO t (label) VALUES ('a2')").run();
      order.push("a done");
    });
    await sleep(5);
    const c = db.transaction(async () => {
      order.push("c started");
      await db.prepare("INSERT INTO t (label) VALUES ('c1')").run();
    });

    await expect(Promise.all([a, c])).resolves.toBeDefined();
    expect(order).toEqual(["a started", "a done", "c started"]);
    const labels = ((await db.prepare("SELECT label FROM t ORDER BY id").all()) as { label: string }[]).map((r) => r.label);
    expect(labels).toEqual(["a1", "a2", "c1"]);
  });

  it("rolls the first transaction back without touching the one queued behind it", async () => {
    const db = freshDb();
    const a = db.transaction(async () => {
      await db.prepare("INSERT INTO t (label) VALUES ('a1')").run();
      await sleep(30);
      throw new Error("a fails");
    });
    await sleep(5);
    const c = db.transaction(async () => {
      await db.prepare("INSERT INTO t (label) VALUES ('c1')").run();
    });

    await expect(a).rejects.toThrow("a fails");
    await c;
    const labels = ((await db.prepare("SELECT label FROM t ORDER BY id").all()) as { label: string }[]).map((r) => r.label);
    expect(labels).toEqual(["c1"]);
  });

  it("does not read work left over from a finished transaction as nested inside it", async () => {
    const db = freshDb();
    let later: Promise<void> | undefined;
    await db.transaction(async () => {
      await db.prepare("INSERT INTO t (label) VALUES ('a')").run();
      // Started inside the callback, runs after COMMIT: it still inherits the callback's async context.
      later = new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          db.transaction(async () => {
            await db.prepare("INSERT INTO t (label) VALUES ('later')").run();
          }).then(() => resolve(), reject);
        }, 20)
      );
    });
    await expect(later).resolves.toBeUndefined();
    const labels = ((await db.prepare("SELECT label FROM t ORDER BY id").all()) as { label: string }[]).map((r) => r.label);
    expect(labels).toEqual(["a", "later"]);
  });

  it("still refuses a transaction started inside a transaction, instead of waiting for its own caller", async () => {
    const db = freshDb();
    await expect(
      db.transaction(async () => {
        await db.transaction(async () => {});
      })
    ).rejects.toThrow(/within a transaction/);
    // and the queue is not left blocked
    await expect(db.transaction(async () => 1)).resolves.toBe(1);
  });
});

/** The body of the first `{ ... }` block after `start`, skipping braces inside strings and comments. */
function blockAfter(source: string, start: number): string {
  const open = source.indexOf("{", start);
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") i = source.indexOf("\n", i);
    else if (ch === "/" && source[i + 1] === "*") i = source.indexOf("*/", i) + 1;
    else if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
    } else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
    i++;
  }
  return source.slice(open);
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("db.transaction() callbacks await only database calls (audit RB15)", () => {
  // The shared SQLite connection puts every statement that runs while a transaction is open inside it,
  // from any request, and a rollback undoes them too. So a callback must not wait on a network call, a
  // file operation or a timer. (routes/media.ts moves the file to the recycle bin before its transaction.)
  const SLOW = [/\bfetch\(/, /\bfs\.(?!constants)\w+/, /\bfs\.promises\b/, /\bexecFile\w*\(/, /\bsetTimeout\(/, /\bsleep\(/, /\baxios\b/, /\bspawn\(/];

  it("finds the call sites it is meant to check", () => {
    const sites = sourceFiles(SRC).flatMap((file) => {
      const source = fs.readFileSync(file, "utf-8");
      return [...source.matchAll(/\bdb\.transaction\(\s*async/g)].map((m) => ({ file, index: m.index! }));
    });
    expect(sites.length).toBeGreaterThan(15);
  });

  it("has no slow awaits inside any of them", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = fs.readFileSync(file, "utf-8");
      for (const m of source.matchAll(/\bdb\.transaction\(\s*async/g)) {
        const body = blockAfter(source, m.index!);
        for (const pattern of SLOW) {
          const hit = body.match(pattern);
          if (hit) offenders.push(`${path.relative(SRC, file)}: ${hit[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
