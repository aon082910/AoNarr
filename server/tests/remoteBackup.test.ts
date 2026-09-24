import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

// An in-memory bucket behind a mocked S3Client, honoring the ListObjectsV2 semantics rotation
// relies on (Prefix, Delimiter, and paging — S3's real 1000-key page by default, shrunk per test
// to exercise pagination).
const bucketKeys = new Set<string>();
let listPageSize = 1000;
function handleS3Command(cmd: { kind: string; input: any }): unknown {
  if (cmd.kind === "put") {
    bucketKeys.add(cmd.input.Key);
    return {};
  }
  if (cmd.kind === "delete") {
    bucketKeys.delete(cmd.input.Key);
    return {};
  }
  const prefix: string = cmd.input.Prefix ?? "";
  const matching = [...bucketKeys]
    .filter((k) => k.startsWith(prefix))
    .filter((k) => !cmd.input.Delimiter || !k.slice(prefix.length).includes(cmd.input.Delimiter))
    .sort();
  const start = cmd.input.ContinuationToken ? Number(cmd.input.ContinuationToken) : 0;
  const page = matching.slice(start, start + listPageSize);
  const next = start + listPageSize;
  return {
    Contents: page.map((Key) => ({ Key })),
    IsTruncated: next < matching.length,
    NextContinuationToken: next < matching.length ? String(next) : undefined,
  };
}
const s3Send = vi.fn(async (cmd: { kind: string; input: any }) => handleS3Command(cmd));
vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    kind = "";
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  }
  return {
    S3Client: class {
      send(cmd: unknown) {
        return s3Send(cmd as { kind: string; input: any });
      }
    },
    PutObjectCommand: class extends Command {
      kind = "put";
    },
    ListObjectsV2Command: class extends Command {
      kind = "list";
    },
    DeleteObjectCommand: class extends Command {
      kind = "delete";
    },
  };
});

let uploadBackupToRemote: (typeof import("../src/services/remoteBackup.js"))["uploadBackupToRemote"];
let setSetting: (key: string, value: string) => void;
let localBackupPath: string;

const S3_SETTING_KEYS = ["s3Enabled", "s3Bucket", "s3AccessKeyId", "s3SecretAccessKey", "s3Region", "s3Endpoint", "s3Prefix"];

beforeAll(async () => {
  await setupTestDb();
  ({ uploadBackupToRemote } = await import("../src/services/remoteBackup.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  localBackupPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-remote-backup-")), "local.aonarrbackup");
  fs.writeFileSync(localBackupPath, "fake backup bytes");
});

beforeEach(() => {
  bucketKeys.clear();
  listPageSize = 1000;
  s3Send.mockClear();
});

afterEach(() => {
  for (const key of S3_SETTING_KEYS) setSetting(key, "");
});

function configureS3(prefix: string): void {
  setSetting("s3Enabled", "1");
  setSetting("s3Bucket", "my-backup-bucket");
  setSetting("s3AccessKeyId", "AKIA-test");
  setSetting("s3SecretAccessKey", "secret-test");
  setSetting("s3Prefix", prefix);
}

function backupName(day: number): string {
  return `aonarr-backup-2026-01-${String(day).padStart(2, "0")}T00-00-00-000Z.aonarrbackup`;
}

describe("uploadBackupToRemote", () => {
  it("does nothing when remote backup isn't enabled (the default)", async () => {
    // A nonexistent local path proves this never even gets as far as reading the file.
    await expect(uploadBackupToRemote("/definitely/does/not/exist.aonarrbackup", "backup.aonarrbackup", 7)).resolves.not.toThrow();
  });

  it("does nothing when enabled but no bucket is configured", async () => {
    setSetting("s3Enabled", "1");

    await expect(uploadBackupToRemote("/definitely/does/not/exist.aonarrbackup", "backup.aonarrbackup", 7)).resolves.not.toThrow();
  });

  it("does nothing when enabled and bucketed but credentials are missing", async () => {
    setSetting("s3Enabled", "1");
    setSetting("s3Bucket", "my-backup-bucket");

    await expect(uploadBackupToRemote("/definitely/does/not/exist.aonarrbackup", "backup.aonarrbackup", 7)).resolves.not.toThrow();
  });

  it("with an empty prefix, rotates only root-level backups and never touches another instance's nested prefix", async () => {
    configureS3("");
    for (let day = 1; day <= 7; day++) bucketKeys.add(backupName(day));
    for (let day = 1; day <= 7; day++) bucketKeys.add(`server2/${backupName(day)}`);

    await uploadBackupToRemote(localBackupPath, backupName(8), 7);

    const rootKeys = [...bucketKeys].filter((k) => !k.includes("/")).sort();
    expect(rootKeys).toEqual([2, 3, 4, 5, 6, 7, 8].map(backupName));
    expect([...bucketKeys].filter((k) => k.startsWith("server2/"))).toHaveLength(7);
  });

  it("with a prefix, ignores backups in a deeper sub-prefix and pages through the full listing", async () => {
    configureS3("/backups/");
    listPageSize = 3;
    for (let day = 1; day <= 5; day++) bucketKeys.add(`backups/${backupName(day)}`);
    for (let day = 1; day <= 5; day++) bucketKeys.add(`backups/archive/${backupName(day)}`);
    bucketKeys.add("backups/unrelated-file.db");

    await uploadBackupToRemote(localBackupPath, backupName(6), 3);

    expect([...bucketKeys].filter((k) => /^backups\/aonarr-backup-/.test(k)).sort()).toEqual(
      [4, 5, 6].map((day) => `backups/${backupName(day)}`)
    );
    expect([...bucketKeys].filter((k) => k.startsWith("backups/archive/"))).toHaveLength(5);
    expect(bucketKeys.has("backups/unrelated-file.db")).toBe(true);
    const listCalls = s3Send.mock.calls.filter(([cmd]) => cmd.kind === "list");
    expect(listCalls.length).toBeGreaterThan(1);
    expect(listCalls.every(([cmd]) => cmd.input.Delimiter === "/" && cmd.input.Prefix === "backups/")).toBe(true);
  });
});
