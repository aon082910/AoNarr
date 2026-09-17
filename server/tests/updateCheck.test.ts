import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import { checkForUpdate } from "../src/services/updateCheck.js";

function mockLocalChangelog(content: string | { throws: true }): void {
  const original = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((p: any, opts?: any) => {
    if (typeof p === "string" && p.endsWith("CHANGELOG.md")) {
      if (typeof content === "object" && content.throws) throw new Error("ENOENT: no such file");
      return content as string;
    }
    return original(p, opts);
  });
}

function mockRemoteFetch(response: { ok: boolean; status?: number; text?: string } | { throws: Error }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if ("throws" in response) throw response.throws;
      if (!response.ok) return { ok: false, status: response.status ?? 500 } as any;
      return { ok: true, text: async () => response.text ?? "" } as any;
    })
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("checkForUpdate", () => {
  it("reports an update as available when the remote round is higher than the local one", async () => {
    mockLocalChangelog("# Changelog\n\n## Round 10 — Local Feature\nSome text.\n");
    mockRemoteFetch({ ok: true, text: "# Changelog\n\n## Round 12 — Remote Feature\nSome text.\n" });

    const result = await checkForUpdate();

    expect(result.currentRound).toBe(10);
    expect(result.currentTitle).toBe("Local Feature");
    expect(result.latestRound).toBe(12);
    expect(result.latestTitle).toBe("Remote Feature");
    expect(result.updateAvailable).toBe(true);
  });

  it("reports no update available when local and remote rounds match", async () => {
    mockLocalChangelog("## Round 20 — Same Round\n");
    mockRemoteFetch({ ok: true, text: "## Round 20 — Same Round\n" });

    const result = await checkForUpdate();

    expect(result.updateAvailable).toBe(false);
  });

  it("reports no update available when the local round is somehow ahead of remote", async () => {
    mockLocalChangelog("## Round 30 — Ahead Locally\n");
    mockRemoteFetch({ ok: true, text: "## Round 25 — Behind Remotely\n" });

    const result = await checkForUpdate();

    expect(result.updateAvailable).toBe(false);
  });

  it("treats an unreadable local changelog as no known local round, without throwing", async () => {
    mockLocalChangelog({ throws: true });
    mockRemoteFetch({ ok: true, text: "## Round 5 — Remote Only\n" });

    const result = await checkForUpdate();

    expect(result.currentRound).toBeNull();
    expect(result.currentTitle).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });

  it("treats remote content with no matching round header as unknown, not an error", async () => {
    mockLocalChangelog("## Round 5 — Local\n");
    mockRemoteFetch({ ok: true, text: "Not a changelog at all" });

    const result = await checkForUpdate();

    expect(result.latestRound).toBeNull();
    expect(result.latestTitle).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });

  it("throws when the remote fetch responds with a non-ok status", async () => {
    mockLocalChangelog("## Round 5 — Local\n");
    mockRemoteFetch({ ok: false, status: 503 });

    await expect(checkForUpdate()).rejects.toThrow(/503/);
  });

  it("propagates a network-level fetch failure instead of swallowing it", async () => {
    mockLocalChangelog("## Round 5 — Local\n");
    mockRemoteFetch({ throws: new Error("network unreachable") });

    await expect(checkForUpdate()).rejects.toThrow(/network unreachable/);
  });

  it("parses a plain hyphen separator the same as an em dash", async () => {
    mockLocalChangelog("## Round 7 - Hyphen Title\n");
    mockRemoteFetch({ ok: true, text: "## Round 7 - Hyphen Title\n" });

    const result = await checkForUpdate();

    expect(result.currentRound).toBe(7);
    expect(result.currentTitle).toBe("Hyphen Title");
  });

  it("trims surrounding whitespace from the parsed title", async () => {
    mockLocalChangelog("##   Round 9   —   Padded Title   \n");
    mockRemoteFetch({ ok: true, text: "## Round 9 — Padded Title\n" });

    const result = await checkForUpdate();

    expect(result.currentTitle).toBe("Padded Title");
  });
});
