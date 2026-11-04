import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");

describe("Unraid templates in this repository (audit RB10)", () => {
  // A restore, and any crash, ends the process; without a restart policy the container then stays stopped.
  // Unraid's default for a template container is no automatic restart.
  const files = fs.existsSync(TEMPLATES) ? fs.readdirSync(TEMPLATES).filter((f) => f.endsWith(".xml")) : [];

  it.skipIf(files.length === 0 && process.env.AONARR_REQUIRE_REPO_FILES !== "1")("every template asks Docker to restart the container unless it was stopped", () => {
    // With AONARR_REQUIRE_REPO_FILES=1 (CI, a full-repo mount) a missing templates folder fails the run instead of skipping it.
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const xml = fs.readFileSync(path.join(TEMPLATES, file), "utf-8");
      expect(xml, file).toMatch(/<ExtraParams>[^<]*--restart=unless-stopped[^<]*<\/ExtraParams>/);
    }
  });
});
