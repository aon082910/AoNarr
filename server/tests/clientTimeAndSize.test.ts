import { describe, it, expect } from "vitest";
import { qbitTimeAndSize, sabTimeAndSize } from "../src/services/downloadClient.js";

describe("qbitTimeAndSize (DL12)", () => {
  it("reads the seconds left and the bytes left", () => {
    expect(qbitTimeAndSize({ eta: 3600, amount_left: 1_500_000_000 })).toEqual({ etaSeconds: 3600, sizeLeft: 1_500_000_000 });
  });

  it("treats qBittorrent's 'never' (8640000) and a missing value as no estimate", () => {
    expect(qbitTimeAndSize({ eta: 8_640_000, amount_left: 0 })).toEqual({ sizeLeft: 0 });
    expect(qbitTimeAndSize({})).toEqual({});
    expect(qbitTimeAndSize({ eta: -1, amount_left: -5 })).toEqual({});
  });
});

describe("sabTimeAndSize (DL12)", () => {
  it("reads hours:minutes:seconds and the MiB left", () => {
    expect(sabTimeAndSize({ timeleft: "0:10:30", mbleft: "512.5" })).toEqual({ etaSeconds: 630, sizeLeft: Math.round(512.5 * 1048576) });
    expect(sabTimeAndSize({ timeleft: "2:00:00", mbleft: "0" })).toEqual({ etaSeconds: 7200, sizeLeft: 0 });
  });

  it("reads minutes:seconds, and a day in front of the hours", () => {
    expect(sabTimeAndSize({ timeleft: "05:30" })).toEqual({ etaSeconds: 330 });
    expect(sabTimeAndSize({ timeleft: "1:02:03:04" })).toEqual({ etaSeconds: (24 + 2) * 3600 + 3 * 60 + 4 });
  });

  it("gives no estimate for text it cannot read", () => {
    expect(sabTimeAndSize({ timeleft: "unknown", mbleft: "n/a" })).toEqual({});
    expect(sabTimeAndSize({})).toEqual({});
  });

  it("gives no estimate for a slot that is not moving (0:00:00 with data still to come)", () => {
    expect(sabTimeAndSize({ timeleft: "0:00:00", mbleft: "1500.50" })).toEqual({ sizeLeft: Math.round(1500.5 * 1048576) });
    // Nothing left is a real zero.
    expect(sabTimeAndSize({ timeleft: "0:00:00", mbleft: "0.00" })).toEqual({ etaSeconds: 0, sizeLeft: 0 });
  });
});
