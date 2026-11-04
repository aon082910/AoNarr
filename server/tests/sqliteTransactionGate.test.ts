import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { createSqliteAsyncDb } from "../src/db/asyncDb.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function open() {
  const raw = new Database(":memory:");
  raw.exec("CREATE TABLE t (v TEXT)");
  return { raw, adb: createSqliteAsyncDb(raw, { gateTimeoutMs: 400 }) };
}

const values = (raw: Database.Database) => (raw.prepare("SELECT v FROM t ORDER BY rowid").all() as { v: string }[]).map((r) => r.v);

describe("a SQLite transaction and the statements of other requests (R21)", () => {
  it("does not take a statement from another request into the transaction, so a rollback leaves it alone", async () => {
    const { raw, adb } = open();
    const tx = adb.transaction(async () => {
      await adb.prepare("INSERT INTO t VALUES ('inside')").run();
      await sleep(60); // breaks the rule that a callback awaits only database calls, on purpose
      throw new Error("boom");
    });
    tx.catch(() => undefined);
    await sleep(15);
    // Another request's insert arrives while the transaction is open.
    const outside = adb.prepare("INSERT INTO t VALUES ('outside')").run();

    await expect(tx).rejects.toThrow("boom");
    await outside;

    expect(values(raw)).toEqual(["outside"]);
  });

  it("waits until the transaction has ended, in the order the statements came", async () => {
    const { raw, adb } = open();
    const order: string[] = [];
    const tx = adb.transaction(async () => {
      await adb.prepare("INSERT INTO t VALUES ('a')").run();
      await sleep(40);
      await adb.prepare("INSERT INTO t VALUES ('b')").run();
      order.push("transaction ends");
    });
    await sleep(10);
    const read = adb.prepare("SELECT COUNT(*) AS c FROM t").get().then((row: { c: number }) => {
      order.push(`read sees ${row.c}`);
    });
    await Promise.all([tx, read]);

    expect(order).toEqual(["transaction ends", "read sees 2"]);
    expect(values(raw)).toEqual(["a", "b"]);
  });

  it("does not hold back the statements of the transaction itself, however they are started", async () => {
    const { raw, adb } = open();
    await adb.transaction(async () => {
      await Promise.all([adb.prepare("INSERT INTO t VALUES ('x')").run(), adb.prepare("INSERT INTO t VALUES ('y')").run()]);
      const seen = (await adb.prepare("SELECT COUNT(*) AS c FROM t").get()) as { c: number };
      expect(seen.c).toBe(2); // its own uncommitted rows
      await new Promise<void>((resolve) => setImmediate(resolve));
      await adb.prepare("INSERT INTO t VALUES ('z')").run();
    });
    expect(values(raw)).toEqual(["x", "y", "z"]);
  });

  it("lets a statement from the callback's own leftovers run normally once the transaction is over", async () => {
    const { raw, adb } = open();
    let later: Promise<unknown> = Promise.resolve();
    await adb.transaction(async () => {
      // A fire-and-forget continuation started inside keeps the transaction's async context for good.
      later = sleep(30).then(() => adb.prepare("INSERT INTO t VALUES ('late')").run());
    });
    await later;
    expect(values(raw)).toEqual(["late"]);
  });

  it("goes ahead after the timeout instead of freezing when the transaction never ends", async () => {
    const { raw, adb } = open();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let finish!: () => void;
    const hold = new Promise<void>((resolve) => (finish = resolve));
    const tx = adb.transaction(async () => {
      await adb.prepare("INSERT INTO t VALUES ('held')").run();
      await hold; // something that never comes back in time
    });
    await sleep(10);
    await adb.prepare("INSERT INTO t VALUES ('freed')").run(); // waited the 400 ms, then went ahead
    expect(warn).toHaveBeenCalled();
    finish();
    await tx;
    warn.mockRestore();
    expect(values(raw)).toContain("freed");
  });

  it("makes a transaction started by another request wait its turn, as before", async () => {
    const { raw, adb } = open();
    const first = adb.transaction(async () => {
      await adb.prepare("INSERT INTO t VALUES ('first')").run();
      await sleep(30);
    });
    await sleep(5);
    const second = adb.transaction(async () => {
      await adb.prepare("INSERT INTO t VALUES ('second')").run();
    });
    await Promise.all([first, second]);
    expect(values(raw)).toEqual(["first", "second"]);
  });

  it("still refuses a transaction started from inside a transaction", async () => {
    const { adb } = open();
    await expect(adb.transaction(async () => adb.transaction(async () => undefined))).rejects.toThrow("cannot start a transaction within a transaction");
  });
});

describe("a statement from outside waits for every transaction queued behind the open one (M1)", () => {
  it("does not run inside the second transaction, so that transaction's rollback cannot take the statement along", async () => {
    const { raw, adb } = open();
    const order: string[] = [];
    const t1 = adb.transaction(async () => {
      await adb.prepare("INSERT INTO t VALUES ('t1')").run();
      await sleep(40);
      order.push("T1 ends");
    });
    await sleep(5);
    const t2 = adb.transaction(async () => {
      order.push("T2 begins");
      await adb.prepare("INSERT INTO t VALUES ('t2')").run();
      await sleep(40);
      order.push("T2 ends");
      throw new Error("T2 fails");
    });
    t2.catch(() => undefined);
    await sleep(5);
    // Issued while T1 is open and T2 is queued behind it.
    const outsideRead = adb.prepare("SELECT COUNT(*) AS c FROM t WHERE v = 't2'").get().then((row: { c: number }) => {
      order.push(`outside read sees ${row.c} t2 rows`);
    });
    const outsideWrite = adb.prepare("INSERT INTO t VALUES ('outside')").run().then(() => {
      order.push("outside wrote");
    });

    await Promise.all([t1, outsideRead, outsideWrite]);
    await expect(t2).rejects.toThrow("T2 fails");

    expect(order).toEqual(["T1 ends", "T2 begins", "T2 ends", "outside read sees 0 t2 rows", "outside wrote"]);
    expect(values(raw)).toEqual(["t1", "outside"]); // T2 rolled back, and the outside write is not lost with it
  });

  it("runs after the second transaction when that one commits, and sees what it committed", async () => {
    const { raw, adb } = open();
    const t1 = adb.transaction(async () => {
      await adb.prepare("INSERT INTO t VALUES ('t1')").run();
      await sleep(40);
    });
    await sleep(5);
    const t2 = adb.transaction(async () => {
      await adb.prepare("INSERT INTO t VALUES ('t2')").run();
      await sleep(40);
    });
    await sleep(5);

    const [seen] = await Promise.all([adb.prepare("SELECT COUNT(*) AS c FROM t").get() as Promise<{ c: number }>, t1, t2]);

    expect(seen.c).toBe(2);
    expect(values(raw)).toEqual(["t1", "t2"]);
  });

  it("never runs inside any transaction of a longer chain, so rollbacks in the middle of it cost the outside statements nothing", async () => {
    const { raw, adb } = open();
    // All three are started together: T1 opens, T2 and T3 queue behind it. T2 and T3 both roll back.
    const transactions = ["T1", "T2", "T3"].map((name) =>
      adb
        .transaction(async () => {
          await adb.prepare("INSERT INTO t VALUES (?)").run(name.toLowerCase());
          await sleep(30);
          if (name !== "T1") throw new Error(`${name} fails`);
        })
        .catch(() => undefined)
    );
    await sleep(8);
    const outsideWrite = adb.prepare("INSERT INTO t VALUES ('outside')").run();
    // A read from outside must not see the uncommitted rows of T2 or T3 either (it would, if it ran inside one of them).
    const outsideRead = adb.prepare("SELECT COUNT(*) AS c FROM t WHERE v IN ('t2', 't3')").get() as Promise<{ c: number }>;

    const [, , , , seen] = await Promise.all([...transactions, outsideWrite, outsideRead]);

    expect((seen as { c: number }).c).toBe(0);
    expect(values(raw)).toEqual(["t1", "outside"]); // the outside write survived both rollbacks
    expect(raw.inTransaction).toBe(false);
  });
});

describe("pauseWrites: writes wait while a maintenance job on another connection has the file locked", () => {
  const pending = (promise: Promise<unknown>) => {
    const state = { done: false };
    void promise.then(
      () => (state.done = true),
      () => (state.done = true)
    );
    return state;
  };

  it("holds an INSERT until the pause is released, then runs it", async () => {
    const { raw, adb } = open();
    const resume = adb.pauseWrites!();

    const write = adb.prepare("INSERT INTO t VALUES ('a')").run();
    const state = pending(write);
    await sleep(40);
    expect(state.done).toBe(false);
    expect(values(raw)).toEqual([]);

    resume();
    await write;
    expect(values(raw)).toEqual(["a"]);
  });

  it("holds UPDATE, DELETE and a write through exec as well", async () => {
    const { raw, adb } = open();
    raw.exec("INSERT INTO t VALUES ('keep'), ('drop'), ('old')");
    const resume = adb.pauseWrites!();

    const update = adb.prepare("UPDATE t SET v = 'new' WHERE v = 'old'").run();
    const del = adb.prepare("DELETE FROM t WHERE v = 'drop'").run();
    const exec = adb.exec("INSERT INTO t VALUES ('via exec')");
    const states = [pending(update), pending(del), pending(exec)];
    await sleep(40);
    expect(states.map((s) => s.done)).toEqual([false, false, false]);
    expect(values(raw)).toEqual(["keep", "drop", "old"]);

    resume();
    await Promise.all([update, del, exec]);
    expect(values(raw).sort()).toEqual(["keep", "new", "via exec"]);
  });

  it("holds a write that comes back through get() or all() (RETURNING), judging by the statement and not the method", async () => {
    const { raw, adb } = open();
    raw.exec("INSERT INTO t VALUES ('x'), ('y')");
    const resume = adb.pauseWrites!();

    const inserted = adb.prepare("INSERT INTO t VALUES ('z') RETURNING v").get();
    const deleted = adb.prepare("DELETE FROM t WHERE v = 'x' RETURNING v").all();
    const states = [pending(inserted), pending(deleted)];
    await sleep(40);
    expect(states.map((s) => s.done)).toEqual([false, false]);
    expect(values(raw)).toEqual(["x", "y"]);

    resume();
    expect(await inserted).toEqual({ v: "z" });
    expect(await deleted).toEqual([{ v: "x" }]);
    expect(values(raw)).toEqual(["y", "z"]);
  });

  it("lets plain SELECTs answer while writes are held, with what is committed so far", async () => {
    const { raw, adb } = open();
    raw.exec("INSERT INTO t VALUES ('before')");
    const resume = adb.pauseWrites!();
    const held = adb.prepare("INSERT INTO t VALUES ('held')").run();
    const heldState = pending(held);

    const row = (await adb.prepare("SELECT COUNT(*) AS c FROM t").get()) as { c: number };
    const rows = (await adb.prepare("SELECT v FROM t").all()) as { v: string }[];

    expect(row.c).toBe(1);
    expect(rows).toEqual([{ v: "before" }]);
    expect(heldState.done).toBe(false);
    resume();
    await held;
    expect(((await adb.prepare("SELECT COUNT(*) AS c FROM t").get()) as { c: number }).c).toBe(2);
  });

  it("does not hold a statement inside a transaction that was already open when the pause began", async () => {
    const { raw, adb } = open();
    const tx = adb.transaction(async () => {
      await adb.prepare("INSERT INTO t VALUES ('in1')").run();
      await sleep(40); // the pause begins meanwhile
      await adb.prepare("INSERT INTO t VALUES ('in2')").run();
    });
    await sleep(10);
    const resume = adb.pauseWrites!();

    await tx; // finishes while paused: nothing inside it was held

    expect(values(raw)).toEqual(["in1", "in2"]);
    // a statement from outside is still held afterwards
    const outside = adb.prepare("INSERT INTO t VALUES ('outside')").run();
    const state = pending(outside);
    await sleep(30);
    expect(state.done).toBe(false);
    resume();
    await outside;
    expect(values(raw)).toEqual(["in1", "in2", "outside"]);
  });

  it("holds a new transaction until the pause is released, and does not start its callback before", async () => {
    const { raw, adb } = open();
    const resume = adb.pauseWrites!();
    const events: string[] = [];

    const tx = adb.transaction(async () => {
      events.push("callback runs");
      await adb.prepare("INSERT INTO t VALUES ('tx')").run();
    });
    const state = pending(tx);
    await sleep(40);
    expect(events).toEqual([]);
    expect(state.done).toBe(false);
    expect(values(raw)).toEqual([]);

    resume();
    await tx;
    expect(events).toEqual(["callback runs"]);
    expect(values(raw)).toEqual(["tx"]);
  });

  it("releases the held writes in the order they were issued", async () => {
    const { raw, adb } = open();
    const resume = adb.pauseWrites!();
    const writes = ["a", "b", "c", "d"].map((v) => adb.prepare("INSERT INTO t VALUES (?)").run(v));
    await sleep(20);
    expect(values(raw)).toEqual([]);

    resume();
    await Promise.all(writes);

    expect(values(raw)).toEqual(["a", "b", "c", "d"]);
  });

  it("releases a held transaction together with the held statements, and runs all of them", async () => {
    const { raw, adb } = open();
    const resume = adb.pauseWrites!();
    const first = adb.prepare("INSERT INTO t VALUES ('first')").run();
    const tx = adb.transaction(async () => {
      await adb.prepare("INSERT INTO t VALUES ('in tx 1')").run();
      await adb.prepare("INSERT INTO t VALUES ('in tx 2')").run();
    });
    const last = adb.prepare("INSERT INTO t VALUES ('last')").run();
    await sleep(20);

    resume();
    await Promise.all([first, tx, last]);

    expect(values(raw).sort()).toEqual(["first", "in tx 1", "in tx 2", "last"]);
  });

  describe("a second pauseWrites while one is active", () => {
    it("changes nothing for its caller: releasing it does not release the first pause", async () => {
      const { raw, adb } = open();
      const first = adb.pauseWrites!();
      const second = adb.pauseWrites!();
      const write = adb.prepare("INSERT INTO t VALUES ('a')").run();
      const state = pending(write);

      second();
      await sleep(40);
      expect(state.done).toBe(false);
      expect(values(raw)).toEqual([]);

      first();
      await write;
      expect(values(raw)).toEqual(["a"]);
    });

    it("leaves the later pause alone when an earlier release function is called again", async () => {
      const { raw, adb } = open();
      const first = adb.pauseWrites!();
      first();
      const next = adb.pauseWrites!();
      const write = adb.prepare("INSERT INTO t VALUES ('b')").run();
      const state = pending(write);

      first(); // a stale release
      await sleep(40);
      expect(state.done).toBe(false);

      next();
      await write;
      expect(values(raw)).toEqual(["b"]);
    });

    it("can be taken again once the first pause is over", async () => {
      const { adb } = open();
      adb.pauseWrites!()();
      const again = adb.pauseWrites!();
      const state = pending(adb.prepare("INSERT INTO t VALUES ('c')").run());
      await sleep(30);
      expect(state.done).toBe(false);
      again();
      await sleep(10);
      expect(state.done).toBe(true);
    });
  });

  it("is not cut short by the wait limit that bounds the transaction gate", async () => {
    const { raw, adb } = open(); // gateTimeoutMs is 400
    const resume = adb.pauseWrites!();
    const write = adb.prepare("INSERT INTO t VALUES ('patient')").run();
    const state = pending(write);

    await sleep(550);
    expect(state.done).toBe(false);
    expect(values(raw)).toEqual([]);

    resume();
    await write;
    expect(values(raw)).toEqual(["patient"]);
  });

  it("holds a write that was already waiting for a transaction when the pause began, once that transaction has ended", async () => {
    const { raw, adb } = open();
    const tx = adb.transaction(async () => {
      await adb.prepare("INSERT INTO t VALUES ('tx')").run();
      await sleep(40);
    });
    await sleep(8);
    const outsideWrite = adb.prepare("INSERT INTO t VALUES ('outside')").run();
    const outsideRead = adb.prepare("SELECT COUNT(*) AS c FROM t").get() as Promise<{ c: number }>;
    const writeState = pending(outsideWrite);
    const resume = adb.pauseWrites!();

    await tx;
    expect((await outsideRead).c).toBe(1); // a read is released with the transaction, the pause does not hold it
    await sleep(30);
    expect(writeState.done).toBe(false);
    expect(values(raw)).toEqual(["tx"]);

    resume();
    await outsideWrite;
    expect(values(raw)).toEqual(["tx", "outside"]);
  });

  it("is a SQLite-only facility: the Postgres implementation has no pauseWrites", async () => {
    const { createPostgresAsyncDb } = await import("../src/db/asyncDb.js");
    const postgres = createPostgresAsyncDb("postgres://nobody:nothing@127.0.0.1:1/none");
    try {
      expect(postgres.dialect).toBe("postgres");
      expect(postgres.pauseWrites).toBeUndefined();
    } finally {
      await postgres.close();
    }
  });
});
