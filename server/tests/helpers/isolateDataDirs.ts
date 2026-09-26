import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Vitest setup file (see vitest.config.ts `setupFiles`): runs before EACH test file's own imports.
 *
 * src/config.ts reads AONARR_CONFIG_DIR/AONARR_DOWNLOADS_DIR once, at module-import time, and
 * falls back to `<cwd>/../data/config` — the real app data directory. A test file that statically
 * imports anything reaching src/config.ts (e.g. `import { buildMediaQuery } from
 * "../src/services/mediaQuery.js"`) evaluates it before its `beforeAll(setupTestDb)` gets a
 * chance to set those variables, so its SQLite database, encryption key and logs used to land in
 * that shared default directory: state then leaked between test files and between consecutive
 * suite runs (ids from an earlier run showing up in exact-match assertions), and on a developer
 * machine it wrote into the local instance's own data/config.
 *
 * Pointing both variables at a fresh temp dir here, before any test module loads, gives every
 * test file its own isolated directory no matter how it imports the app. setupTestDb() reuses
 * this same directory so config.ts and process.env always agree.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-test-"));
process.env.AONARR_TEST_DATA_DIR = dir;
process.env.AONARR_CONFIG_DIR = dir;
process.env.AONARR_DOWNLOADS_DIR = dir;
