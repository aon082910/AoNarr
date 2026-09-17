import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let uploadBackupToRemote: (typeof import("../src/services/remoteBackup.js"))["uploadBackupToRemote"];
let setSetting: (key: string, value: string) => void;

const S3_SETTING_KEYS = ["s3Enabled", "s3Bucket", "s3AccessKeyId", "s3SecretAccessKey", "s3Region", "s3Endpoint", "s3Prefix"];

beforeAll(async () => {
  await setupTestDb();
  ({ uploadBackupToRemote } = await import("../src/services/remoteBackup.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

afterEach(() => {
  for (const key of S3_SETTING_KEYS) setSetting(key, "");
});

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
});
