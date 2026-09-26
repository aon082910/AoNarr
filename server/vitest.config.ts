import { defineConfig } from "vitest/config";

// fileParallelism: false — every test file that touches the DB shares one process-wide `db`
// singleton (see src/db/index.ts's `dbInstance` cache) that gets (re)initialized per file in
// tests/helpers/testDb.ts. Running files in parallel would race different tests' DB setups
// against that one singleton. This also matters for the Postgres CI pass, where every test file
// truncates the same live database at startup — running two files at once would let one file's
// truncation wipe out data another file is mid-test with.
export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    // Gives each test file a fresh temp AONARR_CONFIG_DIR/AONARR_DOWNLOADS_DIR before any of its
    // imports run — see tests/helpers/isolateDataDirs.ts.
    setupFiles: ["./tests/helpers/isolateDataDirs.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
