import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const isPostgres = process.env.AONARR_DATABASE_DRIVER === "postgres";
const srcDbDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "db");

const NEW_DEFAULT = "movie,series,anime,sports,ppv,artist,author,audiobook,comic,manga,rom,course,adult";
const OLD_SCHEMA_DEFAULT = "movie,series,anime,artist,author,audiobook,comic,manga,rom,video,course,adult";
const OLD_ROUTE_DEFAULT = "movie,series,artist,author";
const CUSTOM = "series,anime";

describe("indexers.media_types default", () => {
  it("covers every indexer-searched media type (all but yt-dlp Online Videos and RSS Podcasts) in both schemas", async () => {
    const { MEDIA_TYPES } = await import("../src/services/mediaTypes.js");
    expect(Object.keys(MEDIA_TYPES).filter((k) => k !== "video" && k !== "podcast").join(",")).toBe(NEW_DEFAULT);
    for (const file of ["schema.sql", "schema.postgres.sql"]) {
      expect(fs.readFileSync(path.join(srcDbDir, file), "utf-8")).toContain(`media_types TEXT NOT NULL DEFAULT '${NEW_DEFAULT}'`);
    }
  });
});

// db/client.ts migrates at import time, so the pre-upgrade database has to exist on disk before
// the module is first loaded.
describe.skipIf(isPostgres)("SQLite: upgrading a database created by an older schema", () => {
  let sqlite: import("better-sqlite3").Database;
  let upgrade: () => void;
  let backfillRootFolders: () => number;
  let bookRootId: number;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-dbmig-"));
    process.env.AONARR_CONFIG_DIR = dir;
    process.env.AONARR_DOWNLOADS_DIR = dir;

    const Database = (await import("better-sqlite3")).default;
    const legacy = new Database(path.join(dir, "aonarr.db"));
    legacy.pragma("foreign_keys = ON");
    const schema = fs.readFileSync(path.join(srcDbDir, "schema.sql"), "utf-8");
    expect(schema).toContain(`'${NEW_DEFAULT}'`);
    // Also from before queue rows recorded their imports and import lists had a root folder.
    const legacySchema = schema
      .replace(`'${NEW_DEFAULT}'`, `'${OLD_SCHEMA_DEFAULT}'`)
      .replace(/(download_path TEXT),\r?\n[\s\S]*?import_resume_state INTEGER NOT NULL DEFAULT 0\r?\n/, "$1\n")
      .replace(/(exclude_genres TEXT,)\r?\n\s*root_folder_id INTEGER REFERENCES root_folders\(id\) ON DELETE SET NULL,\r?\n/, "$1\n");
    expect(legacySchema).not.toContain("import_started_at");
    expect(legacySchema.match(/CREATE TABLE IF NOT EXISTS import_lists \([^;]*\);/)?.[0]).not.toContain("root_folder_id");
    legacy.exec(legacySchema);

    const itemId = legacy
      .prepare("INSERT INTO media_items (type, title, sort_title) VALUES ('movie', 'Old Movie', 'old movie')")
      .run().lastInsertRowid;
    legacy.prepare("INSERT INTO indexers (id, name, protocol, url) VALUES (1, 'Synced', 'torznab', 'http://a')").run();
    legacy.prepare("INSERT INTO indexers (id, name, protocol, url, media_types) VALUES (2, 'Added', 'torznab', 'http://b', ?)").run(OLD_ROUTE_DEFAULT);
    legacy.prepare("INSERT INTO indexers (id, name, protocol, url, media_types) VALUES (3, 'Custom', 'torznab', 'http://c', ?)").run(CUSTOM);
    legacy.prepare("INSERT INTO indexers (id, name, protocol, url) VALUES (4, 'Deleted', 'torznab', 'http://d')").run();
    legacy.prepare("DELETE FROM indexers WHERE id = 4").run();
    legacy.prepare("INSERT INTO queue (media_item_id, title, indexer_id, progress) VALUES (?, 'Old.Movie.1080p', 1, 0.4535316824913025)").run(itemId);
    legacy.prepare("INSERT INTO import_lists (name, type, url) VALUES ('Old List', 'trakt', 'https://trakt.tv/users/me/watchlist')").run();
    legacy.prepare("INSERT INTO indexer_health (indexer_id, success) VALUES (1, 1)").run();
    legacy.prepare("INSERT INTO blocklist (media_item_id, release_title, indexer_id) VALUES (?, 'Old.Movie.CAM', 2)").run(itemId);

    // irc_feeds from before announcers existed, with a feed already configured.
    legacy.exec("ALTER TABLE irc_feeds DROP COLUMN announcers");
    legacy
      .prepare("INSERT INTO irc_feeds (name, host, nickname, channel, announce_regex) VALUES ('Old Feed', 'irc.example', 'bot', '#announce', ?)")
      .run("(?<title>.+) (?<url>.+)");

    // Items an import list added without a root folder.
    bookRootId = Number(legacy.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/lib/books', 'author')").run().lastInsertRowid);
    legacy.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/lib/music-a', 'artist')").run();
    legacy.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/lib/music-b', 'artist')").run();
    const addItem = legacy.prepare("INSERT INTO media_items (type, title, sort_title, has_file) VALUES (?, ?, ?, ?)");
    addItem.run("author", "Listed Author", "listed author", 0);
    addItem.run("author", "Author On Disk", "author on disk", 1);
    addItem.run("artist", "Listed Artist", "listed artist", 0);
    legacy.close();

    const client = await import("../src/db/client.js");
    sqlite = client.db;
    upgrade = client.upgradeIndexerMediaTypesDefault;
    backfillRootFolders = client.backfillMissingRootFolders;
  });

  const mediaTypesById = () =>
    Object.fromEntries(
      (sqlite.prepare("SELECT id, media_types FROM indexers ORDER BY id").all() as { id: number; media_types: string }[]).map((r) => [r.id, r.media_types])
    );

  it("changes the column default, so indexers created without a list (Jackett/Prowlarr sync) cover sports and ppv", () => {
    const col = (sqlite.prepare("PRAGMA table_info(indexers)").all() as { name: string; dflt_value: string }[]).find((c) => c.name === "media_types");
    expect(col?.dflt_value).toBe(`'${NEW_DEFAULT}'`);
    const id = sqlite.prepare("INSERT INTO indexers (name, protocol, url) VALUES ('Synced Later', 'torznab', 'http://e')").run().lastInsertRowid;
    expect(sqlite.prepare("SELECT media_types FROM indexers WHERE id = ?").get(id)).toEqual({ media_types: NEW_DEFAULT });
    // The deleted indexer's id 4 is not handed out again.
    expect(Number(id)).toBe(5);
    sqlite.prepare("DELETE FROM indexers WHERE id = ?").run(id);
  });

  it("widens rows holding an old default and leaves a hand-picked list alone", () => {
    expect(mediaTypesById()).toEqual({ 1: NEW_DEFAULT, 2: NEW_DEFAULT, 3: CUSTOM });
  });

  it("keeps every row that references an indexer, still wired to the live table", () => {
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(sqlite.pragma("legacy_alter_table", { simple: true })).toBe(0);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    for (const table of ["queue", "indexer_health", "blocklist"]) {
      const { sql } = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
      expect(sql).toContain("REFERENCES indexers(id)");
      expect(sql).not.toContain("indexers_rebuild");
    }
    expect(sqlite.prepare("SELECT indexer_id, progress FROM queue").get()).toEqual({ indexer_id: 1, progress: 0.4535316824913025 });
    expect(sqlite.prepare("SELECT indexer_id FROM blocklist").get()).toEqual({ indexer_id: 2 });
    expect((sqlite.prepare("SELECT COUNT(*) AS c FROM indexer_health WHERE indexer_id = 1").get() as { c: number }).c).toBe(1);

    sqlite.prepare("DELETE FROM indexers WHERE id = 1").run();
    expect(sqlite.prepare("SELECT indexer_id FROM queue").get()).toEqual({ indexer_id: null });
    expect((sqlite.prepare("SELECT COUNT(*) AS c FROM indexer_health").get() as { c: number }).c).toBe(0);
  });

  it("runs only once, so a list an admin later sets to an old default's value is kept", () => {
    const tableSql = () => (sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'indexers'").get() as { sql: string }).sql;
    const before = tableSql();
    sqlite.prepare("UPDATE indexers SET media_types = ? WHERE id = 3").run(OLD_ROUTE_DEFAULT);
    upgrade();
    expect(tableSql()).toBe(before);
    expect(mediaTypesById()[3]).toBe(OLD_ROUTE_DEFAULT);
  });

  it("adds the queue import columns, leaving an existing row neither started, skipped nor due a resume", () => {
    const cols = (sqlite.prepare("PRAGMA table_info(queue)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["import_started_at", "import_skipped_reason", "import_resume_state"]));
    expect(sqlite.prepare("SELECT import_started_at, import_skipped_reason, import_resume_state FROM queue WHERE title = 'Old.Movie.1080p'").get()).toEqual({
      import_started_at: null,
      import_skipped_reason: null,
      import_resume_state: 0,
    });
  });

  it("adds import_lists.root_folder_id, cleared when its root folder is removed", () => {
    const cols = (sqlite.prepare("PRAGMA table_info(import_lists)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("root_folder_id");
    expect(sqlite.prepare("SELECT root_folder_id FROM import_lists WHERE name = 'Old List'").get()).toEqual({ root_folder_id: null });

    const folder = sqlite.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/lib/list-movies', 'movie')").run().lastInsertRowid;
    sqlite.prepare("UPDATE import_lists SET root_folder_id = ? WHERE name = 'Old List'").run(folder);
    sqlite.prepare("DELETE FROM root_folders WHERE id = ?").run(folder);
    expect(sqlite.prepare("SELECT root_folder_id FROM import_lists WHERE name = 'Old List'").get()).toEqual({ root_folder_id: null });
  });

  it("adds irc_feeds.announcers, leaving an existing feed accepting any sender", () => {
    const cols = (sqlite.prepare("PRAGMA table_info(irc_feeds)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("announcers");
    expect(sqlite.prepare("SELECT announcers FROM irc_feeds WHERE name = 'Old Feed'").get()).toEqual({ announcers: null });
  });

  describe("missing root folder backfill", () => {
    const rootOf = (title: string) =>
      (sqlite.prepare("SELECT root_folder_id FROM media_items WHERE title = ?").get(title) as { root_folder_id: number | null }).root_folder_id;

    it("gives a missing item with no root folder the only root folder of its type", () => {
      expect(rootOf("Listed Author")).toBe(bookRootId);
    });

    it("leaves it unset when the type has two root folders or none, or the item already has a file", () => {
      expect(rootOf("Listed Artist")).toBeNull();
      expect(rootOf("Old Movie")).toBeNull();
      expect(rootOf("Author On Disk")).toBeNull();
    });

    it("changes nothing when it runs again on the next startup", () => {
      expect(backfillRootFolders()).toBe(0);
      expect(rootOf("Listed Author")).toBe(bookRootId);
    });
  });
});

describe.runIf(isPostgres)("Postgres: upgrading columns created by an older schema", () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  beforeAll(async () => {
    ({ db } = await setupTestDb());
  });

  const progressType = async () =>
    ((await db
      .prepare("SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'queue' AND column_name = 'progress'")
      .get()) as { data_type: string }).data_type;

  it("creates queue.progress as double precision and the full indexers default on a fresh database", async () => {
    expect(await progressType()).toBe("double precision");
    const id = (await db.prepare("INSERT INTO indexers (name, protocol, url) VALUES ('Fresh', 'torznab', 'http://f')").run()).lastInsertRowid;
    expect(await db.prepare("SELECT media_types FROM indexers WHERE id = ?").get(id)).toEqual({ media_types: NEW_DEFAULT });
    await db.prepare("DELETE FROM indexers WHERE id = ?").run(id);
  });

  it("widens a float4 queue.progress so a full-precision client value reads back unchanged", async () => {
    const { upgradeLegacyPostgresColumns } = await import("../src/db/postgresSeed.js");
    await db.exec("ALTER TABLE queue ALTER COLUMN progress TYPE REAL");
    const itemId = (await db.prepare("INSERT INTO media_items (type, title, sort_title) VALUES ('movie', 'Stalled', 'stalled')").run()).lastInsertRowid;
    const queueId = (await db.prepare("INSERT INTO queue (media_item_id, title, progress) VALUES (?, 'Stalled.1080p', ?)").run(itemId, 0.4535316824913025)).lastInsertRowid;
    const readProgress = async () => ((await db.prepare("SELECT progress FROM queue WHERE id = ?").get(queueId)) as { progress: number }).progress;
    expect(await readProgress()).not.toBe(0.4535316824913025);

    await upgradeLegacyPostgresColumns(db);
    await upgradeLegacyPostgresColumns(db);

    expect(await progressType()).toBe("double precision");
    expect(await readProgress()).toBeCloseTo(0.4535316824913025, 6);
    await db.prepare("UPDATE queue SET progress = ? WHERE id = ?").run(0.4535316824913025, queueId);
    expect(await readProgress()).toBe(0.4535316824913025);
  });

  it("switches the indexers default and widens old-default rows once, leaving hand-picked lists alone", async () => {
    const { upgradeLegacyPostgresColumns } = await import("../src/db/postgresSeed.js");
    await db.exec(`ALTER TABLE indexers ALTER COLUMN media_types SET DEFAULT '${OLD_SCHEMA_DEFAULT}'`);
    const synced = (await db.prepare("INSERT INTO indexers (name, protocol, url) VALUES ('Synced', 'torznab', 'http://a')").run()).lastInsertRowid;
    const added = (await db.prepare("INSERT INTO indexers (name, protocol, url, media_types) VALUES ('Added', 'torznab', 'http://b', ?)").run(OLD_ROUTE_DEFAULT)).lastInsertRowid;
    const custom = (await db.prepare("INSERT INTO indexers (name, protocol, url, media_types) VALUES ('Custom', 'torznab', 'http://c', ?)").run(CUSTOM)).lastInsertRowid;
    const mediaTypes = async (id: unknown) => ((await db.prepare("SELECT media_types FROM indexers WHERE id = ?").get(id)) as { media_types: string }).media_types;
    expect(await mediaTypes(synced)).toBe(OLD_SCHEMA_DEFAULT);

    await upgradeLegacyPostgresColumns(db);

    expect(await mediaTypes(synced)).toBe(NEW_DEFAULT);
    expect(await mediaTypes(added)).toBe(NEW_DEFAULT);
    expect(await mediaTypes(custom)).toBe(CUSTOM);
    const later = (await db.prepare("INSERT INTO indexers (name, protocol, url) VALUES ('Synced Later', 'torznab', 'http://d')").run()).lastInsertRowid;
    expect(await mediaTypes(later)).toBe(NEW_DEFAULT);

    await db.prepare("UPDATE indexers SET media_types = ? WHERE id = ?").run(OLD_ROUTE_DEFAULT, custom);
    await upgradeLegacyPostgresColumns(db);
    expect(await mediaTypes(custom)).toBe(OLD_ROUTE_DEFAULT);
  });

  it("runs as part of the startup seed", async () => {
    const { seedPostgresDefaults } = await import("../src/db/postgresSeed.js");
    await db.exec("ALTER TABLE queue ALTER COLUMN progress TYPE REAL");
    await seedPostgresDefaults(db);
    expect(await progressType()).toBe("double precision");
  });

  it("adds irc_feeds.announcers to a table created before it existed", async () => {
    const { migratePostgresSchema } = await import("../src/db/postgresSchema.js");
    const hasAnnouncers = async () =>
      !!(await db
        .prepare("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'irc_feeds' AND column_name = 'announcers'")
        .get());
    expect(await hasAnnouncers()).toBe(true);
    await db.exec("ALTER TABLE irc_feeds DROP COLUMN announcers");
    expect(await hasAnnouncers()).toBe(false);

    await migratePostgresSchema(db);

    expect(await hasAnnouncers()).toBe(true);
  });

  it("adds the queue import columns and import_lists.root_folder_id to tables created before them", async () => {
    const { migratePostgresSchema } = await import("../src/db/postgresSchema.js");
    const columnsOf = async (table: string) =>
      ((await db
        .prepare("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?")
        .all(table)) as { column_name: string }[]).map((c) => c.column_name);
    await db.exec(
      "ALTER TABLE queue DROP COLUMN import_started_at, DROP COLUMN import_skipped_reason, DROP COLUMN import_resume_state; ALTER TABLE import_lists DROP COLUMN root_folder_id"
    );
    const itemId = (await db.prepare("INSERT INTO media_items (type, title, sort_title) VALUES ('movie', 'Queued', 'queued')").run()).lastInsertRowid;
    const queueId = (await db.prepare("INSERT INTO queue (media_item_id, title, status) VALUES (?, 'Queued.1080p', 'completed')").run(itemId)).lastInsertRowid;
    const listId = (await db.prepare("INSERT INTO import_lists (name, type, url) VALUES ('Old List', 'trakt', 'https://trakt.tv/users/me/watchlist')").run()).lastInsertRowid;
    expect(await columnsOf("queue")).not.toContain("import_started_at");

    await migratePostgresSchema(db);

    expect(await columnsOf("queue")).toEqual(expect.arrayContaining(["import_started_at", "import_skipped_reason", "import_resume_state"]));
    expect(await db.prepare("SELECT import_started_at, import_skipped_reason, import_resume_state FROM queue WHERE id = ?").get(queueId)).toEqual({
      import_started_at: null,
      import_skipped_reason: null,
      import_resume_state: 0,
    });
    expect(await columnsOf("import_lists")).toContain("root_folder_id");
    const folder = (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/lib/list-movies', 'movie')").run()).lastInsertRowid;
    await db.prepare("UPDATE import_lists SET root_folder_id = ? WHERE id = ?").run(folder, listId);
    await db.prepare("DELETE FROM root_folders WHERE id = ?").run(folder);
    expect(await db.prepare("SELECT root_folder_id FROM import_lists WHERE id = ?").get(listId)).toEqual({ root_folder_id: null });
  });

  it("fills a missing item's root folder at startup only when its type has exactly one", async () => {
    const { migratePostgresSchema, backfillMissingRootFolders } = await import("../src/db/postgresSchema.js");
    const bookRoot = (await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/lib/books', 'author')").run()).lastInsertRowid;
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/lib/music-a', 'artist')").run();
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES ('/lib/music-b', 'artist')").run();
    const addItem = async (type: string, title: string, hasFile: number) =>
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, has_file) VALUES (?, ?, ?, ?)").run(type, title, title.toLowerCase(), hasFile))
        .lastInsertRowid;
    const listedAuthor = await addItem("author", "Listed Author", 0);
    const authorOnDisk = await addItem("author", "Author On Disk", 1);
    const listedArtist = await addItem("artist", "Listed Artist", 0);
    const rootOf = async (id: unknown) =>
      ((await db.prepare("SELECT root_folder_id FROM media_items WHERE id = ?").get(id)) as { root_folder_id: number | null }).root_folder_id;

    await migratePostgresSchema(db);

    expect(await rootOf(listedAuthor)).toBe(Number(bookRoot));
    expect(await rootOf(authorOnDisk)).toBeNull();
    expect(await rootOf(listedArtist)).toBeNull();
    expect(await backfillMissingRootFolders(db)).toBe(0);
  });
});
