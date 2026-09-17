import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readEnvOrFile } from "../src/services/env.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("readEnvOrFile", () => {
  it("returns undefined when neither the plain var nor the _FILE var is set", () => {
    delete process.env.AONARR_TEST_VAR;
    delete process.env.AONARR_TEST_VAR_FILE;
    expect(readEnvOrFile("AONARR_TEST_VAR")).toBeUndefined();
  });

  it("returns the plain env var when no _FILE variant is set", () => {
    process.env.AONARR_TEST_VAR = "plain-value";
    expect(readEnvOrFile("AONARR_TEST_VAR")).toBe("plain-value");
  });

  it("prefers the _FILE variant over the plain env var when both are set", () => {
    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-env-")), "secret.txt");
    fs.writeFileSync(filePath, "file-value");
    process.env.AONARR_TEST_VAR = "plain-value";
    process.env.AONARR_TEST_VAR_FILE = filePath;

    expect(readEnvOrFile("AONARR_TEST_VAR")).toBe("file-value");
  });

  it("trims trailing whitespace/newlines from the file's contents", () => {
    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-env-")), "secret.txt");
    fs.writeFileSync(filePath, "file-value-with-newline\n");
    process.env.AONARR_TEST_VAR_FILE = filePath;

    expect(readEnvOrFile("AONARR_TEST_VAR")).toBe("file-value-with-newline");
  });

  it("returns undefined (not a thrown error) when the _FILE variant points at a nonexistent file", () => {
    process.env.AONARR_TEST_VAR_FILE = "/definitely/does/not/exist.txt";
    process.env.AONARR_TEST_VAR = "plain-value";

    expect(readEnvOrFile("AONARR_TEST_VAR")).toBeUndefined();
  });
});
