import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

beforeAll(async () => {
  await setupTestDb();
});

// Regression coverage for a real bug: a provider's "<providerKey>Events" setting being truly unset
// (never saved) and being explicitly saved as an empty string ("every event deliberately
// unchecked") both read as falsy — isEventEnabledFor used to treat both the same way ("no
// preference — every event"), so unchecking the very last event for a provider silently kept every
// event enabled instead of actually silencing it.
describe("isEventEnabledFor", () => {
  it("defaults to enabled when the setting was never saved at all", async () => {
    const { isEventEnabledFor } = await import("../src/services/notifications.js");
    expect(isEventEnabledFor("neverConfigured", "grabbed")).toBe(true);
  });

  it("is disabled for every event once explicitly saved as an empty selection", async () => {
    const { isEventEnabledFor } = await import("../src/services/notifications.js");
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("discordEvents", "");
    expect(isEventEnabledFor("discord", "grabbed")).toBe(false);
    expect(isEventEnabledFor("discord", "imported")).toBe(false);
  });

  it("only enables the specific events listed in a partial selection", async () => {
    const { isEventEnabledFor } = await import("../src/services/notifications.js");
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("slackEvents", "grabbed,failed");
    expect(isEventEnabledFor("slack", "grabbed")).toBe(true);
    expect(isEventEnabledFor("slack", "failed")).toBe(true);
    expect(isEventEnabledFor("slack", "imported")).toBe(false);
  });
});
