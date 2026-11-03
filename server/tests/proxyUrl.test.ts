import { describe, it, expect } from "vitest";
import { proxyUrlProblem, redactProxyUrl } from "../src/services/networkAddress.js";
import { settingValueProblem } from "../src/services/settingsRegistry.js";

describe("proxyUrlProblem", () => {
  it("accepts the schemes the dispatcher can use, and an empty value", () => {
    for (const url of ["socks5://host:1080", "socks4://host:1080", "http://host:3128", "https://host:3128", "socks5://u:p@host", ""]) {
      expect(proxyUrlProblem(url), url).toBeNull();
    }
  });

  it("refuses text that is not a URL and schemes it cannot use", () => {
    expect(proxyUrlProblem("notaurl")).toContain("must be a URL");
    expect(proxyUrlProblem("socks5//typo")).toContain("must be a URL");
    expect(proxyUrlProblem("ftp://host:21")).toContain("must start with");
  });
});

describe("redactProxyUrl", () => {
  it("replaces the user name and password", () => {
    expect(redactProxyUrl("socks5://vpnuser:s3cret@host:1080")).toBe("socks5://***@host:1080");
    expect(redactProxyUrl("socks5://host:1080")).toBe("socks5://host:1080");
  });
});

describe("the settings route refuses a proxy URL nothing can use (review F5)", () => {
  it("rejects a bad URL and accepts a good or empty one", () => {
    expect(settingValueProblem("socks5ProxyUrl", "notaurl")).toContain("socks5ProxyUrl");
    expect(settingValueProblem("socks5ProxyUrl", "socks5://host:1080")).toBeNull();
    expect(settingValueProblem("socks5ProxyUrl", "")).toBeNull();
  });
});

describe("whole-number settings match what their readers parse (review F12)", () => {
  it("refuses forms parseInt would read differently", () => {
    for (const value of ["1e1", "0x10", "-1", "1.5", "7 days"]) {
      expect(settingValueProblem("backupKeepCount", value), value).not.toBeNull();
    }
    expect(settingValueProblem("backupKeepCount", "10")).toBeNull();
  });

  it("keeps 0 for the recycle bin retention (the page allowed it) and refuses 0 stalled hours (read as the default)", () => {
    expect(settingValueProblem("recycleBinRetentionDays", "0")).toBeNull();
    expect(settingValueProblem("stalledDownloadHours", "0")).not.toBeNull();
    expect(settingValueProblem("stalledDownloadHours", "6")).toBeNull();
  });
});
