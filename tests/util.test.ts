import { describe, expect, it } from "vitest";
import {
  applyTemplate, bitrateForTargetSize, estimateSizeMB, formatCutVar, formatTime, parseRate,
  parseTime, splitPath, templateVars,
} from "../src/util";

describe("time", () => {
  it("formats and parses", () => {
    expect(formatTime(83.456)).toBe("00:01:23.456");
    expect(formatTime(3725.5)).toBe("01:02:05.500");
    expect(formatCutVar(65.25)).toBe("00.01.05.250");
    expect(parseTime("00:01:23.456")).toBeCloseTo(83.456);
    expect(parseTime("1:05")).toBe(65);
    expect(parseTime("12.5")).toBe(12.5);
    expect(parseTime("abc")).toBeNaN();
    expect(parseRate("30000/1001")).toBeCloseTo(29.97, 2);
  });
});

describe("filename template", () => {
  it("handles Windows paths and the user's format", () => {
    const p = "C:\\Users\\Me\\Videos\\Game Clip.mp4";
    expect(splitPath(p)).toMatchObject({ dir: "C:\\Users\\Me\\Videos", name: "Game Clip", ext: ".mp4", sep: "\\" });
    const vars = templateVars(p, 5, 70.5);
    expect(applyTemplate("${FILENAME}-CUT${EXT}", vars)).toBe("Game Clip-CUT.mp4");
    expect(applyTemplate("${FILENAME}_${CUT_FROM}-${CUT_TO}${EXT}", vars))
      .toBe("Game Clip_00.00.05.000-00.01.10.500.mp4");
    expect(applyTemplate("a:b${EXT}", vars)).toBe("a_b.mp4");
    expect(applyTemplate("", vars)).toBe("Game Clip-CUT.mp4");
  });
});

describe("size math", () => {
  it("round-trips target size", () => {
    const r = bitrateForTargetSize({ targetMB: 25, duration: 60, audioKbps: 160, audioTracks: 1 });
    expect(r.ok).toBe(true);
    const mb = estimateSizeMB({ videoKbps: r.videoKbps, duration: 60, audioKbps: 160, audioTracks: 1 });
    expect(mb).toBeGreaterThan(24.9);
    expect(mb).toBeLessThanOrEqual(25);
    expect(bitrateForTargetSize({ targetMB: 1, duration: 600, audioKbps: 160, audioTracks: 2 }).ok).toBe(false);
  });
});
