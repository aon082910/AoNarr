// Runs INSIDE the aonarr-e2e container (docker cp'd to /tmp, deleted afterwards by seed.mjs):
//   node /tmp/aonarr-e2e-apply.mjs /tmp/aonarr-e2e-plan.json
// It uses the container's own better-sqlite3 (the host copy in server/node_modules is a Linux build
// that cannot load on Windows) to apply a plan the host-side seed generated, in ONE transaction, and
// creates the sparse placeholder files the has_file rows point at. Nothing here talks to the network.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire("/app/package.json");
const Database = require("better-sqlite3");

const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

// Root-folder directories first: the disk-usage samples below are anchored to their real statfs.
for (const d of plan.dirs ?? []) fs.mkdirSync(d, { recursive: true });

const db = new Database("/config/aonarr.db");
db.pragma("busy_timeout = 20000");
db.pragma("foreign_keys = ON");

const sqlTs = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const applied = {};

const run = db.transaction(() => {
  for (const op of plan.ops) {
    if (op.kind === "insert") {
      const stmt = db.prepare(`INSERT INTO ${op.table} (${op.cols.join(", ")}) VALUES (${op.cols.map(() => "?").join(", ")})`);
      for (const row of op.rows) stmt.run(...row);
      applied[op.table] = (applied[op.table] ?? 0) + op.rows.length;
    } else if (op.kind === "sql") {
      db.prepare(op.sql).run(...(op.params ?? []));
    } else if (op.kind === "disk_samples") {
      // One sample per folder per day, shaped so free space shrinks steadily up to the REAL value
      // statfs reports now: the storage forecast then agrees with what the live pages show, instead
      // of mixing invented and measured numbers.
      const folders = db.prepare(`SELECT id, path FROM root_folders WHERE id IN (${op.folderIds.map(() => "?").join(",")})`).all(...op.folderIds);
      const stmt = db.prepare("INSERT INTO disk_usage_samples (root_folder_id, free_bytes, total_bytes, sampled_at) VALUES (?, ?, ?, ?)");
      for (const f of folders) {
        let stat;
        try {
          stat = fs.statfsSync(f.path);
        } catch {
          continue;
        }
        const realFree = stat.bavail * stat.bsize;
        const total = stat.blocks * stat.bsize;
        const perDay = op.perDayBytes[f.id] ?? 1e9;
        for (let k = op.days; k >= 1; k--) {
          stmt.run(f.id, Math.round(realFree + k * perDay), total, sqlTs(op.fixedNowMs - k * 86_400_000 + 3 * 3_600_000));
          applied.disk_usage_samples = (applied.disk_usage_samples ?? 0) + 1;
        }
      }
    } else {
      throw new Error(`unknown op kind ${op.kind}`);
    }
  }
});
run();

// Sparse files: apparent size only, no disk used. They exist so size/disk widgets and the library
// size roll-up have something real to stat; they are not valid media and must never be probed.
let files = 0;
for (const f of plan.files ?? []) {
  fs.mkdirSync(path.dirname(f.path), { recursive: true });
  const fd = fs.openSync(f.path, "w");
  fs.ftruncateSync(fd, f.size);
  fs.closeSync(fd);
  if (f.mtimeMs) fs.utimesSync(f.path, new Date(f.mtimeMs), new Date(f.mtimeMs));
  files++;
}

db.pragma("wal_checkpoint(PASSIVE)");
db.close();
console.log(JSON.stringify({ applied, files, dirs: (plan.dirs ?? []).length }));
