import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

// The transaction gate and the write pause keep their state on the SQLite AsyncDb instance. Every module reaches that instance
// through the exported `db` (a Proxy, db/index.ts), so these tests go through that export, not through createSqliteAsyncDb
// as tests/sqliteTransactionGate.test.ts does.
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
const onPostgres = process.env.AONARR_DATABASE_DRIVER === "postgres";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  ({ db } = await setupTestDb());
  await db.exec("CREATE TABLE IF NOT EXISTS gate_probe (v TEXT)");
});

afterAll(async () => {
  await db.exec("DROP TABLE IF EXISTS gate_probe");
});

async function values(): Promise<string[]> {
  return ((await db.prepare("SELECT v FROM gate_probe ORDER BY rowid").all()) as { v: string }[]).map((r) => r.v);
}

describe.skipIf(onPostgres)("the gate and the write pause work through the exported db", () => {
  it("keeps a statement from another request out of a transaction, so the transaction's rollback leaves it alone", async () => {
    await db.prepare("DELETE FROM gate_probe").run();
    const tx = db.transaction(async () => {
      await db.prepare("INSERT INTO gate_probe VALUES ('inside')").run();
      await sleep(60); // breaks the rule that a transaction callback awaits only database calls, on purpose
      throw new Error("boom");
    });
    tx.catch(() => undefined);
    await sleep(15);
    const outside = db.prepare("INSERT INTO gate_probe VALUES ('outside')").run();

    await expect(tx).rejects.toThrow("boom");
    await outside;

    expect(await values()).toEqual(["outside"]);
  });

  it("holds writes made through db while pauseWrites is in force, answers reads, and releases the writes on resume", async () => {
    await db.prepare("DELETE FROM gate_probe").run();
    const resume = db.pauseWrites!();
    let done = false;
    const write = db.prepare("INSERT INTO gate_probe VALUES ('held')").run().then(() => (done = true));

    await sleep(50);
    expect(done).toBe(false);
    expect(await values()).toEqual([]); // this read was answered while the write was held

    resume();
    await write;
    expect(await values()).toEqual(["held"]);
  });
});
