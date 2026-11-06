import { describe, expect, it } from "vitest";
import {
  applyTemplate, bitrateForTargetSize, canCopyAudio, customFpsError, estimateSizeMB, formatCutVar, formatFps, formatTime,
  fpsChoices, joinPath, median,
  outputExt, parseRate, parseTime, planPreview, splitPath, templateVars,
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

describe("frame rate choices", () => {
  it("only offers rates below the recorded one", () => {
    expect(fpsChoices(60)).toEqual([50, 48, 30, 25, 24, 20, 15, 10]);
    expect(fpsChoices(30)).toEqual([25, 24, 20, 15, 10]);
    expect(fpsChoices(59.94)).toEqual([50, 48, 30, 25, 24, 20, 15, 10]);
    expect(fpsChoices(30.01)).toEqual([25, 24, 20, 15, 10]);
    expect(fpsChoices(10)).toEqual([]);
  });

  it("only accepts custom rates below the recorded one", () => {
    expect(formatFps(30000 / 1001)).toBe(29.97);
    expect(customFpsError(40, 60)).toBe("");
    expect(customFpsError(29.97, 30)).toBe("");
    expect(customFpsError(1, 60)).toBe("");
    expect(customFpsError(60, 60)).toContain("below the recorded 60 fps");
    expect(customFpsError(90, 60)).not.toBe("");
    expect(customFpsError(59.94, 60000 / 1001)).not.toBe("");
    expect(customFpsError(0.5, 60)).not.toBe("");
    expect(customFpsError(0, 60)).not.toBe("");
    expect(customFpsError(NaN, 60)).not.toBe("");
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

describe("output & preview planning", () => {
  it("picks output extension", () => {
    expect(outputExt(".mkv")).toBe(".mkv");
    expect(outputExt(".avi")).toBe(".mp4");
    expect(outputExt(".MOV")).toBe(".MOV");
    expect(outputExt(".mkv", "mp4")).toBe(".mp4");
    expect(templateVars("C:\\a\\b.wmv", 0, 1).EXT).toBe(".mp4");
    expect(joinPath("D:\\Clips", "x.mp4")).toBe("D:\\Clips\\x.mp4");
    expect(joinPath("/home/me/", "x.mp4")).toBe("/home/me/x.mp4");
  });

  it("plans previews from codecs", () => {
    const chrome = (m: string) => !/hvc1|ac-3|ec-3/.test(m); // no HEVC / AC3
    expect(planPreview(".mp4", "h264", "aac", chrome)).toEqual({ kind: "direct" });
    expect(planPreview(".mkv", "h264", "aac", chrome)).toEqual({ kind: "preview", mode: "remux" });
    expect(planPreview(".mkv", "h264", "ac3", chrome)).toEqual({ kind: "preview", mode: "remux-aac" });
    expect(planPreview(".mov", "h264", "pcm_s16le", chrome)).toEqual({ kind: "preview", mode: "remux-aac" });
    expect(planPreview(".mp4", "hevc", "aac", chrome)).toEqual({ kind: "preview", mode: "transcode" });
    expect(planPreview(".mp4", "hevc", "aac", () => true)).toEqual({ kind: "direct" });
    expect(planPreview(".avi", "mpeg4", "mp3", chrome)).toEqual({ kind: "preview", mode: "transcode" });
    expect(planPreview(".webm", "vp9", "opus", chrome)).toEqual({ kind: "direct" });
    expect(median([300, 100, 200])).toBe(200);
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

describe("trim-only audio copy", () => {
  it("copies only codecs the output container can hold", () => {
    expect(canCopyAudio("aac", ".mp4")).toBe(true);
    expect(canCopyAudio("pcm_s16le", ".mp4")).toBe(false);
    expect(canCopyAudio("pcm_s16le", ".MOV")).toBe(true);
    expect(canCopyAudio("dts", ".mkv")).toBe(true);
    expect(canCopyAudio("aac", ".avi")).toBe(false);
  });
});
