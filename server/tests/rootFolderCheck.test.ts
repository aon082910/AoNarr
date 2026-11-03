import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let baseDir: string;
let findRootFolderProblems: (typeof import("../src/services/rootFolderCheck.js"))["findRootFolderProblems"];
let config: (typeof import("../src/config.js"))["config"];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  ({ findRootFolderProblems } = await import("../src/services/rootFolderCheck.js"));
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
