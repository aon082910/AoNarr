import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkForUpdate, UPDATE_PUSH_GRACE_MS } from "../src/services/updateCheck.js";
import { config } from "../src/config.js";

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

const originalImageTag = config.imageTag;
const originalBuildTime = config.buildTime;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  config.imageTag = originalImageTag;
  config.buildTime = originalBuildTime;
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

function mockHubAndGithub(opts: { hub: { ok: boolean; status?: number; body?: unknown }; github?: { ok: boolean; text?: string } | "throws" }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("hub.docker.com")) {
      if (!opts.hub.ok) return { ok: false, status: opts.hub.status ?? 500 } as any;
      return { ok: true, json: async () => opts.hub.body ?? {} } as any;
    }
    if (opts.github === "throws") throw new Error("github unreachable");
    const g = opts.github ?? { ok: true, text: "## Round 372 — Remote\n" };
    if (!g.ok) return { ok: false, status: 503 } as any;
    return { ok: true, text: async () => g.text ?? "" } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("checkForUpdate on a built image (RB5)", () => {
  const BUILT = "2026-10-20T10:00:00Z";

  it("is up to date when the tag was pushed just after this image was built, whatever the changelog rounds say", async () => {
    config.imageTag = "combined";
    config.buildTime = BUILT;
    // The bundled changelog is older than GitHub's, which used to read as "update available" for ever.
    mockLocalChangelog("## Round 349 — Old\n");
    mockHubAndGithub({ hub: { ok: true, body: { tag_last_pushed: "2026-10-20T10:12:00Z" } }, github: { ok: true, text: "## Round 372 — New\n" } });

    const result = await checkForUpdate();

    expect(result.source).toBe("docker-hub");
    expect(result.updateAvailable).toBe(false);
    expect(result.currentRound).toBe(349);
    expect(result.latestRound).toBe(372);
  });

  it("reports an update when the tag was pushed well after this image was built", async () => {
    config.imageTag = "combined";
    config.buildTime = BUILT;
    mockLocalChangelog("## Round 372 — Same\n");
    const pushed = new Date(new Date(BUILT).getTime() + UPDATE_PUSH_GRACE_MS + 60_000).toISOString();
    mockHubAndGithub({ hub: { ok: true, body: { tag_last_pushed: pushed } }, github: { ok: true, text: "## Round 372 — Same\n" } });

    const result = await checkForUpdate();

    expect(result.updateAvailable).toBe(true);
    expect(result.latestPushedAt).toBe(pushed);
    expect(result.latestId).toBe(pushed);
  });

  it("still answers when GitHub is unreachable, because the rounds are only for display", async () => {
    config.imageTag = "combined";
    config.buildTime = BUILT;
    mockLocalChangelog("## Round 372 — Same\n");
    mockHubAndGithub({ hub: { ok: true, body: { last_updated: "2026-11-01T00:00:00Z" } }, github: "throws" });

    const result = await checkForUpdate();

    expect(result.updateAvailable).toBe(true);
    expect(result.latestRound).toBeNull();
  });

  it("throws when Docker Hub cannot be read, instead of guessing", async () => {
    config.imageTag = "combined";
    config.buildTime = BUILT;
    mockLocalChangelog("## Round 372 — Same\n");
    mockHubAndGithub({ hub: { ok: false, status: 429 } });

    await expect(checkForUpdate()).rejects.toThrow(/429/);
  });

  it("does not trust a build time that names no zone, and uses the changelog instead", async () => {
    config.imageTag = "combined";
    config.buildTime = "2026-10-20 10:00:00";
    mockLocalChangelog("## Round 10 — Local\n");
    const fetchMock = mockHubAndGithub({ hub: { ok: true, body: { tag_last_pushed: "2027-01-01T00:00:00Z" } }, github: { ok: true, text: "## Round 10 — Local\n" } });

    const result = await checkForUpdate();

    expect(result.source).toBe("changelog");
    expect(result.updateAvailable).toBe(false);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("hub.docker.com"))).toBe(false);
  });

  it("is up to date when the image was pushed hours after the build (build, test, push)", async () => {
    config.imageTag = "combined";
    config.buildTime = BUILT;
    mockLocalChangelog("## Round 372 — Same\n");
    mockHubAndGithub({ hub: { ok: true, body: { tag_last_pushed: "2026-10-20T14:30:00Z" } }, github: { ok: true, text: "## Round 372 — Same\n" } });

    expect((await checkForUpdate()).updateAvailable).toBe(false);
  });

  it("falls back to the changelog when the build time is not a date", async () => {
    config.imageTag = "combined";
    config.buildTime = "not-a-date";
    mockLocalChangelog("## Round 10 — Local\n");
    const fetchMock = mockHubAndGithub({ hub: { ok: true, body: {} }, github: { ok: true, text: "## Round 12 — Remote\n" } });

    const result = await checkForUpdate();

    expect(result.source).toBe("changelog");
    expect(result.updateAvailable).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("hub.docker.com"))).toBe(false);
  });
});

/** Docker Hub's tag page, the registry's token / manifest / config blob answers and GitHub's changelog. */
function mockRegistry(opts: {
  pushed: string;
  tagManifest?: unknown;
  manifests?: Record<string, unknown>;
  blobs?: Record<string, unknown>;
  registryFails?: boolean;
}): ReturnType<typeof vi.fn> {
  const json = (body: unknown) => ({ ok: true, json: async () => body }) as any;
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("hub.docker.com")) return json({ tag_last_pushed: opts.pushed });
    if (u.includes("raw.githubusercontent.com")) return { ok: true, text: async () => "## Round 372 — Same\n" } as any;
    if (opts.registryFails) return { ok: false, status: 429 } as any;
    if (u.includes("auth.docker.io")) return json({ token: "t" });
    const manifestAt = u.match(/\/manifests\/(.+)$/);
    if (manifestAt) {
      const name = decodeURIComponent(manifestAt[1]);
      return json(name === "combined" ? opts.tagManifest : opts.manifests?.[name]);
    }
    const blobAt = u.match(/\/blobs\/(.+)$/);
    if (blobAt) return json(opts.blobs?.[decodeURIComponent(blobAt[1])]);
    throw new Error(`unexpected request ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const OUR_ARCH = process.arch === "arm64" ? "arm64" : "amd64";
const OTHER_ARCH = OUR_ARCH === "amd64" ? "arm64" : "amd64";

describe("checkForUpdate reads the tag's own build time from the registry", () => {
  const BUILT = "2026-10-20T10:00:00Z";
  const single = (configDigest: string) => ({ config: { digest: configDigest } });

  it("notices a rebuild pushed within six hours of the running one, which the push time could not tell", async () => {
    config.imageTag = "combined";
    config.buildTime = BUILT;
    mockLocalChangelog("## Round 372 — Same\n");
    mockRegistry({
      pushed: "2026-10-20T14:30:00Z", // 4.5 h after our build: inside the old grace
      tagManifest: single("sha256:cfg"),
      blobs: { "sha256:cfg": { created: "2026-10-20T12:30:00Z", config: { Env: ["PATH=/bin", "AONARR_BUILD_TIME=2026-10-20T12:00:00Z"] } } },
    });

    const result = await checkForUpdate();

    expect(result.updateAvailable).toBe(true);
    expect(result.latestId).toBe("2026-10-20T12:00:00Z");
  });

  it("is up to date when the tag is this very build, however long after it the push came", async () => {
    config.imageTag = "combined";
    config.buildTime = BUILT;
    mockLocalChangelog("## Round 372 — Same\n");
    mockRegistry({
      pushed: "2026-10-21T10:00:00Z",
      tagManifest: single("sha256:cfg"),
      blobs: { "sha256:cfg": { config: { Env: [`AONARR_BUILD_TIME=${BUILT}`] } } },
    });

    expect((await checkForUpdate()).updateAvailable).toBe(false);
  });

  it("takes the manifest of this machine's platform out of a multi-platform tag", async () => {
    config.imageTag = "combined";
    config.buildTime = BUILT;
    mockLocalChangelog("## Round 372 — Same\n");
    mockRegistry({
      pushed: "2026-10-20T10:30:00Z",
      tagManifest: {
        manifests: [
          { digest: "sha256:other", platform: { os: "linux", architecture: OTHER_ARCH } },
          { digest: "sha256:att", platform: { os: "unknown", architecture: "unknown" } },
          { digest: "sha256:ours", platform: { os: "linux", architecture: OUR_ARCH } },
        ],
      },
      manifests: { "sha256:other": single("sha256:cfg-other"), "sha256:ours": single("sha256:cfg-ours") },
      blobs: {
        "sha256:cfg-other": { config: { Env: ["AONARR_BUILD_TIME=2027-01-01T00:00:00Z"] } },
        "sha256:cfg-ours": { config: { Env: [`AONARR_BUILD_TIME=${BUILT}`] } },
      },
    });

    expect((await checkForUpdate()).updateAvailable).toBe(false);
  });

  it("falls back to the image's created time, an hour apart being the same build", async () => {
    config.imageTag = "combined";
    config.buildTime = BUILT;
    mockLocalChangelog("## Round 372 — Same\n");
    mockRegistry({ pushed: "2026-10-20T10:30:00Z", tagManifest: single("sha256:cfg"), blobs: { "sha256:cfg": { created: "2026-10-20T10:20:00Z", config: { Env: [] } } } });
    expect((await checkForUpdate()).updateAvailable).toBe(false);

    mockRegistry({ pushed: "2026-10-20T14:30:00Z", tagManifest: single("sha256:cfg"), blobs: { "sha256:cfg": { created: "2026-10-20T13:00:00Z", config: { Env: [] } } } });
    expect((await checkForUpdate()).updateAvailable).toBe(true);
  });

  it("falls back to the push time when the registry cannot be read", async () => {
    config.imageTag = "combined";
    config.buildTime = BUILT;
    mockLocalChangelog("## Round 372 — Same\n");
    mockRegistry({ pushed: "2026-10-20T14:30:00Z", registryFails: true });
    const result = await checkForUpdate();
    expect(result.updateAvailable).toBe(false);
    expect(result.latestId).toBe("2026-10-20T14:30:00Z");

    mockRegistry({ pushed: new Date(new Date(BUILT).getTime() + UPDATE_PUSH_GRACE_MS + 60_000).toISOString(), registryFails: true });
    expect((await checkForUpdate()).updateAvailable).toBe(true);
  });
});

describe("the changelog bundled into the image (RB5)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverCopy = path.join(here, "..", "CHANGELOG.md");
  const rootCopy = path.join(here, "..", "..", "CHANGELOG.md");
  // Skipped visibly (not returned from) when a test container mounts only server/: the run then says "skipped".
  it.skipIf(!fs.existsSync(rootCopy) && process.env.AONARR_REQUIRE_REPO_FILES !== "1")("server/CHANGELOG.md is the same file as the repository's CHANGELOG.md, so the server image cannot ship a stale one", () => {
    expect(fs.existsSync(rootCopy), "AONARR_REQUIRE_REPO_FILES=1 needs the whole repository mounted").toBe(true);
    expect(fs.readFileSync(serverCopy, "utf-8").replace(/\r\n/g, "\n")).toBe(fs.readFileSync(rootCopy, "utf-8").replace(/\r\n/g, "\n"));
  });
});
