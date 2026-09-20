import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let findOrCreateLibraryGroup: (typeof import("../src/services/libraryGroups.js"))["findOrCreateLibraryGroup"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ findOrCreateLibraryGroup } = await import("../src/services/libraryGroups.js"));
});

beforeEach(async () => {
  await db.prepare("DELETE FROM media_items").run();
  await db.prepare("DELETE FROM library_groups").run();
});

describe("findOrCreateLibraryGroup", () => {
  it("creates a new top-level group when none exists yet", async () => {
    const id = await findOrCreateLibraryGroup("rom", "system", "Super Nintendo", null);
    const row = (await db.prepare("SELECT * FROM library_groups WHERE id = ?").get(id)) as any;
    expect(row).toMatchObject({ media_type: "rom", kind: "system", name: "Super Nintendo", parent_group_id: null });
  });

  it("finds an existing top-level group by a case-insensitive name match instead of creating a duplicate", async () => {
    const firstId = await findOrCreateLibraryGroup("rom", "system", "Super Nintendo", null);
    const secondId = await findOrCreateLibraryGroup("rom", "system", "super nintendo", null);

    expect(secondId).toBe(firstId);
    const rows = (await db.prepare("SELECT * FROM library_groups WHERE media_type = 'rom' AND kind = 'system'").all()) as any[];
    expect(rows).toHaveLength(1);
  });

  it("creates a child group scoped to its parent, and doesn't confuse two same-named children under different parents", async () => {
    const snesId = await findOrCreateLibraryGroup("rom", "system", "SNES", null);
    const nesId = await findOrCreateLibraryGroup("rom", "system", "NES", null);

    const nintendoUnderSnes = await findOrCreateLibraryGroup("rom", "maker", "Nintendo", snesId);
    const nintendoUnderNes = await findOrCreateLibraryGroup("rom", "maker", "Nintendo", nesId);

    expect(nintendoUnderSnes).not.toBe(nintendoUnderNes);
    const rows = (await db.prepare("SELECT * FROM library_groups WHERE kind = 'maker'").all()) as any[];
    expect(rows).toHaveLength(2);

    // Re-requesting the same (name, parent) pair still finds the existing one.
    const again = await findOrCreateLibraryGroup("rom", "maker", "Nintendo", snesId);
    expect(again).toBe(nintendoUnderSnes);
  });

  it("stores a logoUrl only when given", async () => {
    const id = await findOrCreateLibraryGroup("rom", "system", "Game Boy", null, "https://example.com/gb.png");
    const row = (await db.prepare("SELECT logo_url FROM library_groups WHERE id = ?").get(id)) as { logo_url: string | null };
    expect(row.logo_url).toBe("https://example.com/gb.png");
  });
});
