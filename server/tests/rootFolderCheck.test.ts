import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let baseDir: string;
let findRootFolderProblems: (typeof import("../src/services/rootFolderCheck.js"))["findRootFolderProblems"];
let validateNewRootFolder: (typeof import("../src/services/rootFolderCheck.js"))["validateNewRootFolder"];
let assertWritableRootFolder: (typeof import("../src/services/rootFolderCheck.js"))["assertWritableRootFolder"];
let HttpError: (typeof import("../src/middleware/errorHandler.js"))["HttpError"];
let config: (typeof import("../src/config.js"))["config"];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  ({ findRootFolderProblems, validateNewRootFolder, assertWritableRootFolder } = await import("../src/services/rootFolderCheck.js"));
  ({ HttpError } = await import("../src/middleware/errorHandler.js"));
  ({ config } = await import("../src/config.js"));
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-rootcheck-"));
});

beforeEach(async () => {
  await db.prepare("DELETE FROM media_items").run();
  await db.prepare("DELETE FROM root_folders").run();
});

function newFolder(name: string): string {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function post(body: Record<string, unknown>) {
  return request(app).post("/api/root-folders").set("X-Api-Key", apiKey).send(body);
}

describe("POST /api/root-folders validation (MM5)", () => {
  it("adds an existing, writable folder", async () => {
    const dir = newFolder("movies");
    const res = await post({ path: dir, mediaType: "movie" });
    expect(res.status).toBe(201);
    expect(res.body.path).toBe(dir);
  });

  it("refuses a path that does not exist instead of letting the first import create it", async () => {
    const res = await post({ path: path.join(baseDir, "typo-folder"), mediaType: "movie" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not exist/);
    expect(fs.existsSync(path.join(baseDir, "typo-folder"))).toBe(false);
  });

  it("refuses a relative path", async () => {
    const res = await post({ path: "movies", mediaType: "movie" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/absolute/);
  });

  it("refuses a file", async () => {
    const file = path.join(baseDir, "a-file.txt");
    fs.writeFileSync(file, "x");
    const res = await post({ path: file, mediaType: "movie" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a folder/);
  });

  it("answers 409, not a bare 500, for a folder that is already a root folder (also with a trailing slash)", async () => {
    const dir = newFolder("dup");
    expect((await post({ path: dir, mediaType: "movie" })).status).toBe(201);
    const res = await post({ path: `${dir}/`, mediaType: "series" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already a root folder/);
  });

  it("refuses a folder inside, or containing, another root folder", async () => {
    const parent = newFolder("media");
    const child = newFolder(path.join("media", "tv"));
    expect((await post({ path: parent, mediaType: "movie" })).status).toBe(201);
    const inside = await post({ path: child, mediaType: "series" });
    expect(inside.status).toBe(409);
    expect(inside.body.error).toMatch(/overlaps/);

    await db.prepare("DELETE FROM root_folders").run();
    expect((await post({ path: child, mediaType: "series" })).status).toBe(201);
    const containing = await post({ path: parent, mediaType: "movie" });
    expect(containing.status).toBe(409);
  });

  it("refuses the downloads folder, the config folder and the recycle bin", async () => {
    for (const forbidden of [config.downloadsDir, config.configDir, path.join(config.configDir, "recycle-bin")]) {
      fs.mkdirSync(forbidden, { recursive: true });
      const res = await post({ path: forbidden, mediaType: "movie" });
      expect(res.status, forbidden).toBe(400);
      expect(res.body.error).toMatch(/cannot also be a library folder/);
    }
  });

  it("leaves no test file behind in the folder it probed", async () => {
    const dir = newFolder("probe");
    await post({ path: dir, mediaType: "movie" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

async function addRoot(dir: string, mediaType = "movie"): Promise<number> {
  return Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(dir, mediaType)).lastInsertRowid);
}

describe("findRootFolderProblems (MM5, RB8)", () => {
  it("reports nothing for a healthy, empty new library", async () => {
    await addRoot(newFolder("fresh"));
    expect(await findRootFolderProblems()).toEqual([]);
  });

  it("reports a root folder that is gone (an unmounted share)", async () => {
    const dir = path.join(baseDir, "not-mounted");
    const id = await addRoot(dir);
    const problems = await findRootFolderProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ rootFolderId: id, kind: "missing" });
    expect(problems[0].message).toContain("Is the share mounted?");
  });

  it("reports a root folder that is a file", async () => {
    const file = path.join(baseDir, "root-is-a-file");
    fs.writeFileSync(file, "x");
    await addRoot(file);
    expect((await findRootFolderProblems())[0].kind).toBe("not_a_directory");
  });

  it("reports an empty root folder only when the library has files recorded in it", async () => {
    const dir = newFolder("empty-mount");
    const id = await addRoot(dir);
    expect(await findRootFolderProblems()).toEqual([]);

    await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status, path) VALUES ('movie', 'Gone', 'gone', ?, 1, 1, 'unknown', ?)`
      )
      .run(id, path.join(dir, "Gone (2020)", "Gone.mkv"));

    const problems = await findRootFolderProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe("empty");
    expect(problems[0].message).toContain("1 item(s)");

    fs.writeFileSync(path.join(dir, "something"), "x"); // the share came back
    expect(await findRootFolderProblems()).toEqual([]);
  });
});

describe("findRootFolderProblems with shares that do not answer (review F4)", () => {
  it("reports each as unreachable and finishes in about one timeout, not one per share", async () => {
    const dirs = [newFolder("dead-a"), newFolder("dead-b"), newFolder("dead-c")];
    for (const dir of dirs) await addRoot(dir);
    const real = fs.promises.stat;
    const spy = vi.spyOn(fs.promises, "stat").mockImplementation(((p: unknown, ...rest: unknown[]) =>
      dirs.includes(String(p)) ? new Promise(() => {}) : (real as any)(p, ...rest)) as any);
    try {
      const started = Date.now();
      const problems = await findRootFolderProblems(150);
      const took = Date.now() - started;
      expect(problems.map((p) => p.kind)).toEqual(["unreachable", "unreachable", "unreachable"]);
      expect(took).toBeLessThan(400); // three sequential timeouts would take 450
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Makes `dir` behave like a read-only mount: the real write probe (a small file created in it) fails with EROFS, and so
 * does the cheap access(W_OK) check the Health page uses. Everything else on the file system is untouched. (The tests
 * run as root, where a chmod would not stop a write.)
 */
function mountReadOnly(dir: string) {
  const realWriteFile = fs.promises.writeFile;
  const realAccess = fs.promises.access;
  const refused = () => Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
  const writeFile = vi.spyOn(fs.promises, "writeFile").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
    if (path.dirname(String(p)) === dir && path.basename(String(p)).startsWith(".aonarr-write-test-")) throw refused();
    return (realWriteFile as any)(p, ...rest);
  }) as any);
  const access = vi.spyOn(fs.promises, "access").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
    if (String(p) === dir && rest[0] === fs.constants.W_OK) throw refused();
    return (realAccess as any)(p, ...rest);
  }) as any);
  return {
    probes: () => writeFile.mock.calls.filter((call) => path.dirname(String(call[0])) === dir && path.basename(String(call[0])).startsWith(".aonarr-write-test-")).length,
    writableChecks: () => access.mock.calls.filter((call) => String(call[0]) === dir && call[1] === fs.constants.W_OK).length,
  };
}

async function addReadOnlyRoot(dir: string, mediaType = "movie"): Promise<number> {
  return Number((await db.prepare("INSERT INTO root_folders (path, media_type, read_only) VALUES (?, ?, 1)").run(dir, mediaType)).lastInsertRowid);
}

describe("read-only root folders: adding one", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a folder AoNarr cannot write into, and points to a read-only library as the way to add it anyway", async () => {
    const dir = newFolder("on-a-read-only-mount");
    const mount = mountReadOnly(dir);

    const res = await post({ path: dir, mediaType: "movie" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/is not writable by AoNarr \(EROFS\)/);
    expect(res.body.error).toMatch(/add it as a read-only library/);
    expect(mount.probes()).toBe(1);
    expect(((await db.prepare("SELECT COUNT(*) AS c FROM root_folders").get()) as { c: number }).c).toBe(0);
  });

  it("adds the same folder as a read-only library without writing anything into it", async () => {
    const dir = newFolder("served-from-a-read-only-mount");
    const mount = mountReadOnly(dir);

    const res = await post({ path: dir, mediaType: "movie", readOnly: true });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ path: dir, mediaType: "movie", readOnly: true });
    expect(mount.probes()).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
    const row = (await db.prepare("SELECT read_only FROM root_folders WHERE path = ?").get(dir)) as { read_only: number };
    expect(Number(row.read_only)).toBe(1);
  });

  it("still holds a read-only library's folder to every other rule", async () => {
    const parent = newFolder("ro-media");
    expect((await post({ path: parent, mediaType: "movie", readOnly: true })).status).toBe(201);

    const missing = await post({ path: path.join(baseDir, "ro-typo"), mediaType: "movie", readOnly: true });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/does not exist/);

    const relative = await post({ path: "movies", mediaType: "movie", readOnly: true });
    expect(relative.status).toBe(400);
    expect(relative.body.error).toMatch(/absolute/);

    const file = path.join(baseDir, "ro-a-file.txt");
    fs.writeFileSync(file, "x");
    const notAFolder = await post({ path: file, mediaType: "movie", readOnly: true });
    expect(notAFolder.status).toBe(400);
    expect(notAFolder.body.error).toMatch(/not a folder/);

    const overlapping = await post({ path: newFolder(path.join("ro-media", "tv")), mediaType: "series", readOnly: true });
    expect(overlapping.status).toBe(409);
    expect(overlapping.body.error).toMatch(/overlaps/);

    const forbidden = await post({ path: config.downloadsDir, mediaType: "movie", readOnly: true });
    expect(forbidden.status).toBe(400);
    expect(forbidden.body.error).toMatch(/cannot also be a library folder/);
  });

  it("validateNewRootFolder returns the trimmed path for a read-only library and does not probe it", async () => {
    const dir = newFolder("direct-read-only");
    const mount = mountReadOnly(dir);

    expect(await validateNewRootFolder(`  ${dir}  `, { readOnly: true })).toBe(dir);
    expect(mount.probes()).toBe(0);

    await expect(validateNewRootFolder(dir)).rejects.toMatchObject({ status: 400 });
    await expect(validateNewRootFolder(dir, { readOnly: false })).rejects.toMatchObject({ status: 400 });
    expect(mount.probes()).toBe(2);
  });
});

describe("assertWritableRootFolder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes for a folder it can write into, and leaves no probe file behind", async () => {
    const dir = newFolder("assert-writable");

    await expect(assertWritableRootFolder(dir)).resolves.toBeUndefined();

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("throws a 400 that names the folder as the caller wrote it, and the reason", async () => {
    const dir = newFolder("assert-read-only");
    mountReadOnly(dir);

    const error = await assertWritableRootFolder(dir, "/media/as-typed").catch((e) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/^"\/media\/as-typed" is not writable by AoNarr \(EROFS\)\./);
  });

  it("names the resolved path when the caller gives no other", async () => {
    const dir = newFolder("assert-default-name");
    mountReadOnly(dir);

    await expect(assertWritableRootFolder(dir)).rejects.toThrow(`"${dir}" is not writable by AoNarr (EROFS)`);
  });

  it("throws a 400 for a folder that is gone", async () => {
    const error = await assertWritableRootFolder(path.join(baseDir, "assert-gone")).catch((e) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.message).toContain("(ENOENT)");
  });
});

describe("findRootFolderProblems and read-only libraries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a writable library whose folder has turned read-only", async () => {
    const dir = newFolder("turned-read-only");
    fs.writeFileSync(path.join(dir, "something"), "x");
    const id = await addRoot(dir);
    mountReadOnly(dir);

    const problems = await findRootFolderProblems();

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ rootFolderId: id, kind: "unwritable" });
    expect(problems[0].message).toContain("(EROFS)");
    expect(problems[0].message).toContain("Is it mounted read-only?");
  });

  it("does not test a read-only library for being writable at all", async () => {
    const dir = newFolder("meant-to-be-read-only");
    fs.writeFileSync(path.join(dir, "something"), "x");
    await addReadOnlyRoot(dir);
    const mount = mountReadOnly(dir);

    expect(await findRootFolderProblems()).toEqual([]);
    expect(mount.writableChecks()).toBe(0);
  });

  it("still reports a read-only library that is gone, or that is a file", async () => {
    const gone = path.join(baseDir, "read-only-not-mounted");
    const goneId = await addReadOnlyRoot(gone);
    const file = path.join(baseDir, "read-only-is-a-file");
    fs.writeFileSync(file, "x");
    const fileId = await addReadOnlyRoot(file);

    const problems = await findRootFolderProblems();

    expect(problems.find((p) => p.rootFolderId === goneId)?.kind).toBe("missing");
    expect(problems.find((p) => p.rootFolderId === fileId)?.kind).toBe("not_a_directory");
  });

  it("still reports a read-only library that came up empty although files are recorded in it", async () => {
    const dir = newFolder("read-only-empty-mount");
    const id = await addReadOnlyRoot(dir);
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status, path) VALUES ('movie', 'Gone', 'gone', ?, 1, 1, 'unknown', ?)`)
      .run(id, path.join(dir, "Gone (2020)", "Gone.mkv"));

    const problems = await findRootFolderProblems();

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ rootFolderId: id, kind: "empty" });
  });
});
