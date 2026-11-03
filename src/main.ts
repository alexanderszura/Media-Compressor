import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  applyTemplate, bitrateForTargetSize, estimateSizeMB, formatBytes, formatDuration, formatTime,
  joinPath, median, parseRate, parseTime, planPreview, splitPath, templateVars, TEMPLATE_VARS,
} from "./util";
import type {
  AudioTrack, CutPreviewResult, Encoder, ExportRequest, ExportResult, FfmpegStatus, InstallProgress, Mode,
  OutputFormat, OutputLocation, PreviewMode, ProbeResult, Progress, Settings, TrackRole,
} from "./types";

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}
const video = $<HTMLVideoElement>("video");
const canvas = $<HTMLCanvasElement>("tl-canvas");
const ctx = canvas.getContext("2d")!;
const inBox = $<HTMLInputElement>("in-time");
const outBox = $<HTMLInputElement>("out-time");

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

let toastTimer = 0;
function toast(msg: string, error = false): void {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("error", error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), error ? 6000 : 2500);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS: Settings = {
  filenameTemplate: "${FILENAME}-CUT${EXT}",
  ffmpegDir: "",
  outputLocation: "source",
  outputFolder: "",
  outputFormat: "same",
  fastSeek: true,
  masterTrackName: "Master",
  trackNames: [],
  autoUpdateCheck: true,
  skippedVersion: "",
  mode: "bitrate",
  videoBitrate: 4000,
  targetSizeMB: 25,
  audioBitrate: 160,
  encoder: "libx264",
  preset: "medium",
  twoPass: true,
};
let settings: Settings = { ...DEFAULT_SETTINGS };

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
interface ExportConfig {
  mode: Mode;
  videoBitrate: number;
  targetSizeMB: number;
  audioBitrate: number;
  encoder: Encoder;
  preset: string;
  twoPass: boolean;
  resolution: string; // "orig" or a height
  filename: string;
  nameKey: string; // file+cut the filename was generated/edited for
  nameEdited: boolean;
  outputDir: string; // "" = decide from settings at export time
  masterName: string;
  masterNameEdited: boolean;
}

interface Media {
  path: string;
  duration: number;
  fps: number;
  hasVideo: boolean;
  width: number;
  height: number;
  videoKbps: number;
  audio: AudioTrack[];
  videoCodec: string | null;
  firstAudioCodec: string | null;
}

/** What the <video> element is currently showing. */
type Source = "none" | "direct" | PreviewMode | "fastseek";

let media: Media | null = null;
let source: Source = "none";
let fastSeekState: "idle" | "building" | "ready" | "failed" = "idle";
const seekSamples: number[] = [];
let seekQueued: number | null = null;
let seekStartedAt = 0;
/** File behind the current source, and whether we've already retried it via the asset protocol. */
let sourcePath = "";
let triedAssetFallback = false;
let cfg: ExportConfig = freshConfig();
let inPt = 0;
let outPt = 0;
let curTime = 0;
let zoom = 1;
let viewStart = 0;
let loadToken = 0;
let exporting = false;
let lastOutput = "";
let overwriteConfirmedFor = "";
let dirty = true;

function freshConfig(): ExportConfig {
  return {
    mode: settings.mode,
    videoBitrate: settings.videoBitrate,
    targetSizeMB: settings.targetSizeMB,
    audioBitrate: settings.audioBitrate,
    encoder: settings.encoder,
    preset: settings.preset,
    twoPass: settings.twoPass,
    resolution: "orig",
    filename: "",
    nameKey: "",
    nameEdited: false,
    outputDir: "",
    masterName: "",
    masterNameEdited: false,
  };
}

/** Default output name for a kept track: Settings name for that number, else the file's own name. */
function defaultTrackName(t: AudioTrack): string {
  return settings.trackNames[t.index]?.trim() || t.title || "";
}

function defaultMasterName(): string {
  const m = audioPlan().master;
  if (m.length === 1 && media) return defaultTrackName(media.audio[m[0]]);
  return settings.masterTrackName.trim();
}

/** Output track names in output order, as sent to FFmpeg. */
function outputTitles(): string[] {
  const plan = audioPlan();
  const names = plan.master.length ? [cfg.masterName.trim()] : [];
  for (const i of plan.separate) names.push(media!.audio[i].outName.trim());
  return names;
}

/** Folder the export will be written to. */
function destinationDir(): string {
  if (cfg.outputDir) return cfg.outputDir;
  if (settings.outputLocation === "folder" && settings.outputFolder.trim()) return settings.outputFolder.trim();
  return media ? splitPath(media.path).dir : "";
}

const defaultFilename = (): string =>
  media ? applyTemplate(settings.filenameTemplate, templateVars(media.path, inPt, outPt, settings.outputFormat)) : "";

const frameDur = (): number => 1 / (media?.fps || 30);
const videoReady = (): boolean => video.readyState >= 1 && !!video.src;

// ---------------------------------------------------------------------------
// Opening files
// ---------------------------------------------------------------------------
async function browse(): Promise<void> {
  if (exporting) return;
  const p = await invoke<string | null>("pick_file");
  if (p) await openFile(p);
}

function showStageMsg(text: string, fraction: number | null = null): void {
  $("stage-msg").hidden = false;
  $("stage-msg-text").textContent = text;
  const bar = $("stage-msg-bar");
  bar.parentElement!.hidden = fraction === null;
  bar.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}
const hideStageMsg = (): void => { $("stage-msg").hidden = true; };

async function openFile(path: string): Promise<void> {
  if (exporting) return;
  const token = ++loadToken;
  showScreen("editor");
  showStageMsg("Reading file…");
  video.pause();
  video.removeAttribute("src");
  video.load();
  source = "none";
  fastSeekState = "idle";
  seekSamples.length = 0;
  seekQueued = null;
  setSeekStatus("");
  await invoke("clear_previews").catch(() => {});

  let info: ProbeResult;
  try {
    info = await invoke<ProbeResult>("probe", { path, ffmpegDir: settings.ffmpegDir });
  } catch (e) {
    if (token !== loadToken) return;
    hideStageMsg();
    toast(String(e), true);
    return;
  }
  if (token !== loadToken) return;

  const v = info.streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audioStreams = info.streams.filter((s) => s.codec_type === "audio");
  const duration = parseFloat(info.format?.duration ?? "") || parseFloat(v?.duration ?? "") || 0;

  media = {
    path,
    duration,
    fps: parseRate(v?.avg_frame_rate) || parseRate(v?.r_frame_rate) || 30,
    hasVideo: !!v,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    videoKbps: Math.round(parseInt(v?.bit_rate ?? "0") / 1000) ||
      Math.round(parseInt(info.format?.bit_rate ?? "0") / 1000),
    audio: audioStreams.map((s, i): AudioTrack => ({
      index: i,
      title: s.tags?.title ?? s.tags?.handler_name ?? "",
      lang: s.tags?.language && s.tags.language !== "und" ? s.tags.language : "",
      codec: s.codec_name ?? "?",
      channels: s.channels ?? 0,
      layout: s.channel_layout ?? "",
      bitrate: Math.round(parseInt(s.bit_rate ?? "0") / 1000),
      role: i === 0 ? "master" : "separate",
      outName: "",
    })),
    videoCodec: v?.codec_name ?? null,
    firstAudioCodec: audioStreams[0]?.codec_name ?? null,
  };
  // Generic handler names from muxers aren't useful titles.
  for (const t of media.audio) if (/^(SoundHandler|ISO Media file|Core Media Audio)/i.test(t.title)) t.title = "";
  for (const t of media.audio) t.outName = defaultTrackName(t);

  cfg = freshConfig();
  overwriteConfirmedFor = "";
  inPt = 0;
  outPt = duration;
  curTime = 0;
  zoom = 1;
  viewStart = 0;
  ($<HTMLSelectElement>("zoom")).value = "1";

  const { base, ext } = splitPath(path);
  const bits = [media.hasVideo ? `${media.width}×${media.height}` : "audio only"];
  if (media.hasVideo) bits.push(`${Math.round(media.fps * 100) / 100} fps`);
  if (media.videoCodec) bits.push(media.videoCodec.toUpperCase());
  bits.push(`${media.audio.length} audio track${media.audio.length === 1 ? "" : "s"}`);
  $("file-title").textContent = `${base}  —  ${bits.join(" · ")}`;
  document.title = `${base} – Media Compressor`;

  $("dropzone").hidden = true;
  video.hidden = false;
  updateCutUI();

  const plan = planPreview(ext, media.videoCodec, media.firstAudioCodec, (m) => video.canPlayType(m) !== "");
  if (plan.kind === "direct") {
    showStageMsg("Loading…");
    setSource(await invoke<string>("media_url", { path }), "direct", path);
  } else {
    void buildPreview(plan.mode, token);
  }
}

function setSource(url: string, kind: Source, path: string): void {
  source = kind;
  sourcePath = path;
  triedAssetFallback = false;
  video.src = url;
  video.load();
}

const PREVIEW_MSG: Record<PreviewMode, string> = {
  "remux": "Preparing this file for preview (repackaging, no re-encode)…",
  "remux-aac": "Preparing this file for preview (converting the audio)…",
  "transcode": "This video format can't be played directly — creating a preview copy…",
};

/** Make a playable copy (remux/transcode) when the webview can't play the original. */
async function buildPreview(mode: PreviewMode, token = loadToken): Promise<void> {
  if (!media) return;
  showStageMsg(PREVIEW_MSG[mode], 0);
  try {
    const res = await invoke<{ url: string; path: string }>("make_preview", {
      path: media.path, mode, hevc: media.videoCodec === "hevc", kind: "preview",
      ffmpegDir: settings.ffmpegDir, duration: media.duration,
    });
    if (token !== loadToken) return;
    showStageMsg("Loading…");
    setSource(res.url, mode, res.path);
  } catch (e) {
    if (token !== loadToken || String(e) === "Cancelled") return;
    if (mode !== "transcode") {
      // e.g. a codec that won't go into MP4 as-is — fall back to a full transcode.
      void buildPreview("transcode", token);
      return;
    }
    showStageMsg(`Preview failed — you can still set cut points by time.\n${e}`);
  }
}

function onVideoMeta(): void {
  if (!media) return;
  if (media.hasVideo && video.videoWidth === 0 && source !== "transcode" && source !== "fastseek") {
    // Container opened but the video codec can't be decoded.
    void buildPreview("transcode");
    return;
  }
  if (!media.duration && isFinite(video.duration)) {
    media.duration = video.duration;
    outPt = media.duration;
  }
  hideStageMsg();
  seekQueued = null;
  video.currentTime = curTime;
  video.playbackRate = parseFloat(($<HTMLSelectElement>("speed")).value);
  updateCutUI();
}

function onVideoError(): void {
  if (!media || !video.getAttribute("src")) return;
  // If streaming from the local media server failed (e.g. blocked by the webview),
  // retry the same file through Tauri's asset protocol before re-encoding anything.
  if (!triedAssetFallback && sourcePath && video.src.startsWith("http://127.0.0.1")) {
    triedAssetFallback = true;
    video.src = convertFileSrc(sourcePath);
    video.load();
    return;
  }
  if (source === "fastseek") {
    // Fast-seek copy didn't work out; go back to what we had.
    fastSeekState = "failed";
    setSeekStatus("");
    return;
  }
  if (source !== "transcode") void buildPreview("transcode");
  else showStageMsg("Could not play the preview, but you can still set cut points by time.");
}

// --- fast-seek preview ------------------------------------------------------
function setSeekStatus(text: string, ready = false): void {
  const el = $("seek-status");
  el.hidden = !text;
  el.textContent = text;
  el.classList.toggle("ready", ready);
}

/** Called after each seek with how long it took. */
function noteSeekTime(ms: number): void {
  if (!media?.hasVideo || !settings.fastSeek || fastSeekState !== "idle") return;
  if (source === "transcode" || source === "fastseek") return; // already short-GOP
  seekSamples.push(ms);
  if (seekSamples.length > 6) seekSamples.shift();
  if (seekSamples.length >= 3 && median(seekSamples) > 220) void buildFastSeek();
}

async function buildFastSeek(): Promise<void> {
  if (!media) return;
  const token = loadToken;
  fastSeekState = "building";
  setSeekStatus("Seeking is slow on this file — building a fast-seek preview… 0%");
  try {
    const res = await invoke<{ url: string; path: string }>("make_preview", {
      path: media.path, mode: "transcode", hevc: false, kind: "fastseek",
      ffmpegDir: settings.ffmpegDir, duration: media.duration,
    });
    if (token !== loadToken) return;
    const wasPlaying = !video.paused;
    fastSeekState = "ready";
    setSource(res.url, "fastseek", res.path);
    if (wasPlaying) video.addEventListener("loadedmetadata", () => void video.play(), { once: true });
    setSeekStatus("Fast seeking on", true);
    window.setTimeout(() => { if (fastSeekState === "ready") setSeekStatus(""); }, 4000);
  } catch (e) {
    if (token !== loadToken) return;
    fastSeekState = "failed";
    setSeekStatus(String(e) === "Cancelled" ? "" : "Couldn't build fast-seek preview");
  }
}

// ---------------------------------------------------------------------------
// Playback & cut points
// ---------------------------------------------------------------------------
function seek(t: number): void {
  if (!media) return;
  stopAt = null;
  curTime = Math.min(Math.max(0, t), media.duration);
  applySeek(curTime);
  followPlayhead();
  dirty = true;
}

/**
 * Seeks are coalesced: while the decoder is still busy with one seek, only the
 * latest requested position is remembered and applied when it finishes. Firing
 * a new seek on every mouse move makes the decoder restart constantly, which is
 * what made scrubbing feel laggy.
 */
function applySeek(t: number): void {
  if (!videoReady()) return;
  if (video.seeking) {
    seekQueued = t;
    return;
  }
  seekStartedAt = performance.now();
  video.currentTime = t;
}

function onSeeked(): void {
  if (seekStartedAt) {
    const ms = performance.now() - seekStartedAt;
    seekStartedAt = 0;
    if (seekQueued === null) noteSeekTime(ms);
  }
  if (seekQueued !== null) {
    const t = seekQueued;
    seekQueued = null;
    if (Math.abs(t - video.currentTime) > 0.0005) {
      applySeek(t);
      return;
    }
  }
  if (video.paused) dirty = true;
}

function togglePlay(): void {
  if (!media || !videoReady()) return;
  if (video.paused) {
    if (video.ended || curTime >= media.duration - 0.01) seek(inPt);
    void video.play();
  } else video.pause();
}

/** When set, playback stops here (used by "Play cut"). */
let stopAt: number | null = null;

function playCut(): void {
  if (!media || !videoReady()) return;
  seek(inPt);
  stopAt = outPt;
  void video.play();
}

function step(frames: number): void {
  if (!media) return;
  video.pause();
  seek(curTime + frames * frameDur());
}

function setIn(t: number): void {
  if (!media) return;
  inPt = Math.min(Math.max(0, t), media.duration);
  if (inPt >= outPt - frameDur() / 2) outPt = media.duration;
  if (inPt >= outPt) inPt = Math.max(0, outPt - frameDur());
  updateCutUI();
}

function setOut(t: number): void {
  if (!media) return;
  outPt = Math.min(Math.max(0, t), media.duration);
  if (outPt <= inPt + frameDur() / 2) inPt = 0;
  if (outPt <= inPt) outPt = Math.min(media.duration, inPt + frameDur());
  updateCutUI();
}

function updateCutUI(): void {
  inBox.value = formatTime(inPt);
  outBox.value = formatTime(outPt);
  inBox.classList.remove("bad");
  outBox.classList.remove("bad");
  const ok = !!media && outPt - inPt >= 0.05;
  $<HTMLButtonElement>("btn-to-config").disabled = !ok;
  $("cut-info").textContent = media
    ? `Cut length ${formatDuration(outPt - inPt)} of ${formatDuration(media.duration)}`
    : "";
  dirty = true;
}

function commitTimeBox(box: HTMLInputElement, which: "in" | "out"): void {
  const t = parseTime(box.value);
  if (!media || isNaN(t) || t > media.duration + 0.001) {
    box.classList.add("bad");
    return;
  }
  if (which === "in") setIn(t);
  else setOut(t);
  seek(t);
  box.blur();
}

// ---------------------------------------------------------------------------
// Timeline (canvas)
// ---------------------------------------------------------------------------
const TICK_STEPS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

const viewDur = (): number => (media ? media.duration / zoom : 1);
function clampView(): void {
  if (!media) return;
  viewStart = Math.min(Math.max(0, viewStart), Math.max(0, media.duration - viewDur()));
}
function followPlayhead(): void {
  if (!media || zoom === 1) return;
  const vd = viewDur();
  if (curTime < viewStart || curTime > viewStart + vd) {
    viewStart = video.paused ? curTime - vd / 2 : curTime;
    clampView();
  }
}
const xOf = (t: number, w: number): number => ((t - viewStart) / viewDur()) * w;
const tOf = (x: number, w: number): number => viewStart + (x / w) * viewDur();

function tickLabel(t: number, stepSec: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const sec = stepSec < 1 ? s.toFixed(stepSec < 0.1 ? 2 : 1).padStart(stepSec < 0.1 ? 5 : 4, "0")
    : String(Math.floor(s)).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function renderTimeline(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!media || !media.duration) return;

  // Ticks
  const vd = viewDur();
  const stepSec = TICK_STEPS.find((s) => (s / vd) * w >= 80) ?? 3600;
  ctx.fillStyle = "#6a6a6a";
  ctx.font = "10px Consolas, monospace";
  ctx.textBaseline = "top";
  for (let t = Math.ceil(viewStart / stepSec) * stepSec; t <= viewStart + vd; t += stepSec) {
    const x = Math.round(xOf(t, w)) + 0.5;
    ctx.fillRect(x, 0, 1, 7);
    ctx.fillText(tickLabel(t, stepSec), x + 3, 1);
  }

  // Segment
  const x1 = xOf(inPt, w);
  const x2 = xOf(outPt, w);
  ctx.fillStyle = "rgba(31,163,194,0.38)";
  ctx.fillRect(x1, 12, Math.max(1, x2 - x1), h - 12);
  ctx.fillStyle = "#e67846";
  for (const [x, dir] of [[x1, 1], [x2, -1]] as const) {
    ctx.fillRect(x - (dir === 1 ? 0 : 3), 12, 3, h - 12);
    ctx.beginPath();
    ctx.moveTo(x, 12);
    ctx.lineTo(x + dir * 9, 12);
    ctx.lineTo(x, 21);
    ctx.fill();
  }

  // Playhead
  const px = Math.round(xOf(curTime, w));
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(px - 1, 0, 2, h);
  ctx.beginPath();
  ctx.moveTo(px - 5, 0);
  ctx.lineTo(px + 5, 0);
  ctx.lineTo(px, 6);
  ctx.fill();

  $("tl-time").textContent = `${formatTime(curTime)} (${Math.round(curTime * media.fps)})`;
}

type Drag = "in" | "out" | "seek" | null;
let drag: Drag = null;
let wasPlaying = false;

function hitTest(x: number): Drag {
  const w = canvas.clientWidth;
  if (Math.abs(xOf(inPt, w) - x) <= 7) return "in";
  if (Math.abs(xOf(outPt, w) - x) <= 7) return "out";
  return "seek";
}

canvas.addEventListener("pointerdown", (e) => {
  if (!media) return;
  drag = hitTest(e.offsetX);
  wasPlaying = !video.paused;
  if (drag !== "seek") video.pause();
  canvas.setPointerCapture(e.pointerId);
  onDrag(e);
});
canvas.addEventListener("pointermove", (e) => {
  if (!media) return;
  if (!drag) {
    canvas.style.cursor = hitTest(e.offsetX) === "seek" ? "text" : "ew-resize";
    return;
  }
  onDrag(e);
});
const endDrag = (): void => {
  if (drag && drag !== "seek" && wasPlaying) void video.play();
  drag = null;
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

function onDrag(e: PointerEvent): void {
  if (!media) return;
  const t = Math.min(Math.max(0, tOf(e.offsetX, canvas.clientWidth)), media.duration);
  if (drag === "in") {
    inPt = Math.min(t, outPt - frameDur());
    updateCutUI();
    seek(inPt); // live preview of the frame you're cutting at
  } else if (drag === "out") {
    outPt = Math.max(t, inPt + frameDur());
    updateCutUI();
    seek(outPt);
  } else if (drag === "seek") {
    seek(t);
  }
}

canvas.addEventListener("wheel", (e) => {
  if (!media) return;
  e.preventDefault();
  if (e.ctrlKey) {
    const levels = [1, 2, 4, 8, 16, 32, 64];
    const i = levels.indexOf(zoom);
    const next = levels[Math.min(levels.length - 1, Math.max(0, i + (e.deltaY < 0 ? 1 : -1)))];
    const anchor = tOf(e.offsetX, canvas.clientWidth);
    setZoom(next, anchor, e.offsetX / canvas.clientWidth);
  } else if (zoom > 1) {
    viewStart += (e.deltaY + e.deltaX) / canvas.clientWidth * viewDur();
    clampView();
    dirty = true;
  } else {
    seek(curTime + Math.sign(e.deltaY) * viewDur() / 200);
  }
}, { passive: false });

function setZoom(z: number, anchorT = curTime, anchorFrac = 0.5): void {
  zoom = z;
  ($<HTMLSelectElement>("zoom")).value = String(z);
  viewStart = anchorT - viewDur() * anchorFrac;
  clampView();
  dirty = true;
}

function loop(): void {
  if (media && !video.paused) {
    curTime = video.currentTime;
    if (stopAt !== null && curTime >= stopAt) {
      video.pause();
      curTime = stopAt;
      video.currentTime = stopAt;
      stopAt = null;
    }
    followPlayhead();
    dirty = true;
  }
  if (dirty) {
    renderTimeline();
    dirty = false;
  }
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function showScreen(name: "editor" | "config"): void {
  $("editor").hidden = name !== "editor";
  $("config").hidden = name !== "config";
  if (name === "editor") dirty = true;
}

const isConfig = (): boolean => !$("config").hidden;
const modalOpen = (): boolean =>
  !$("settings-modal").hidden || !$("export-modal").hidden || !$("setup").hidden || !$("preview-modal").hidden
  || !$("update-modal").hidden;

// ---------------------------------------------------------------------------
// Config (export settings) screen
// ---------------------------------------------------------------------------
function goToConfig(): void {
  if (!media || outPt - inPt < 0.05) return;
  video.pause();
  const key = `${media.path}|${inPt}|${outPt}`;
  if (!cfg.nameEdited || cfg.nameKey !== key) {
    cfg.filename = defaultFilename();
    cfg.nameEdited = false;
  }
  cfg.nameKey = key;
  overwriteConfirmedFor = "";
  fillConfig();
  showScreen("config");
}

function fillConfig(): void {
  if (!media) return;
  const { base, dir } = splitPath(media.path);
  const dest = destinationDir();
  $("cfg-summary").textContent =
    `${base} · ${formatTime(inPt)} → ${formatTime(outPt)} (${formatDuration(outPt - inPt)})`;
  $<HTMLInputElement>("cfg-filename").value = cfg.filename;
  $("cfg-folder").textContent = dest === dir ? `Saved next to the original, in: ${dir}` : `Saved to: ${dest}`;

  $("video-card").hidden = !media.hasVideo;
  $<HTMLInputElement>("cfg-bitrate").value = String(cfg.videoBitrate);
  $<HTMLInputElement>("cfg-size").value = String(cfg.targetSizeMB);
  $<HTMLSelectElement>("cfg-encoder").value = cfg.encoder;
  $<HTMLSelectElement>("cfg-preset").value = cfg.preset;
  $<HTMLInputElement>("cfg-twopass").checked = cfg.twoPass;
  $<HTMLSelectElement>("cfg-abitrate").value = String(cfg.audioBitrate);

  const res = $<HTMLSelectElement>("cfg-res");
  const heights = [2160, 1440, 1080, 720, 480, 360].filter((h) => h < media!.height);
  res.innerHTML = `<option value="orig">Original (${media.width}×${media.height})</option>` +
    heights.map((h) => `<option value="${h}">${h}p</option>`).join("");
  res.value = heights.includes(Number(cfg.resolution)) ? cfg.resolution : "orig";
  cfg.resolution = res.value;

  renderAudioList();
  updateConfigUI();
}

function renderAudioList(): void {
  if (!media) return;
  const list = $("audio-list");
  if (!media.audio.length) {
    list.innerHTML = `<div class="empty">This file has no audio tracks.</div>`;
    return;
  }
  const plan = audioPlan();
  if (!cfg.masterNameEdited) cfg.masterName = defaultMasterName();
  const roles: [TrackRole, string][] = [["master", "Master"], ["separate", "Keep"], ["remove", "Remove"]];
  const masterLabel = plan.master.length > 1 ? `Master (Tracks ${plan.master.map((i) => i + 1).join(" + ")})` : `Track ${(plan.master[0] ?? 0) + 1}`;
  const masterRow = plan.master.length ? `<label class="master-name">
      <span>${plan.master.length > 1 ? "Master track name" : "Master track name"}</span>
      <input id="master-name" type="text" spellcheck="false" value="${esc(cfg.masterName)}" placeholder="${esc(masterLabel)}" />
    </label>` : "";
  list.innerHTML = masterRow + media.audio.map((t) => {
    const desc = [t.codec.toUpperCase(), t.layout || (t.channels ? `${t.channels} ch` : ""),
      t.bitrate ? `${t.bitrate} kbps` : "", t.lang].filter(Boolean).join(" · ");
    const out = t.role === "separate"
      ? `<input class="track-name" data-i="${t.index}" type="text" spellcheck="false" value="${esc(t.outName)}" placeholder="Track ${t.index + 1}" title="Name of this track in the exported file" />`
      : t.role === "master" ? `<span class="muted small-note">mixed into Master</span>` : "";
    return `<div class="track ${t.role}" data-i="${t.index}">
      <div class="num">${t.index + 1}</div>
      <div class="meta"><div class="t">${esc(t.title || `Track ${t.index + 1}`)}</div><div class="d">${esc(desc)}</div></div>
      <div class="out">${out}</div>
      <div class="seg">${roles.map(([r, label]) =>
        `<button data-role="${r}" class="${t.role === r ? "on" : ""}">${label}</button>`).join("")}</div>
    </div>`;
  }).join("");
}

$("audio-list").addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (!media) return;
  if (el.id === "master-name") {
    cfg.masterName = el.value;
    cfg.masterNameEdited = true;
  } else if (el.classList.contains("track-name")) {
    media.audio[Number(el.dataset.i)].outName = el.value;
  }
});

$("audio-list").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-role]");
  const row = btn?.closest<HTMLElement>(".track");
  if (!btn || !row || !media) return;
  const track = media.audio[Number(row.dataset.i)];
  track.role = btn.dataset.role as TrackRole;
  renderAudioList();
  updateConfigUI();
});

function audioPlan(): { master: number[]; separate: number[]; outTracks: number } {
  const a = media?.audio ?? [];
  const master = a.filter((t) => t.role === "master").map((t) => t.index);
  const separate = a.filter((t) => t.role === "separate").map((t) => t.index);
  return { master, separate, outTracks: (master.length ? 1 : 0) + separate.length };
}

function computeVideoKbps(): { kbps: number; ok: boolean } {
  const plan = audioPlan();
  if (cfg.mode === "bitrate") return { kbps: Math.round(cfg.videoBitrate), ok: cfg.videoBitrate >= 50 };
  const r = bitrateForTargetSize({
    targetMB: cfg.targetSizeMB, duration: outPt - inPt, audioKbps: cfg.audioBitrate, audioTracks: plan.outTracks,
  });
  return { kbps: r.videoKbps, ok: r.ok };
}

function updateConfigUI(): void {
  if (!media) return;
  const duration = outPt - inPt;
  const plan = audioPlan();
  const hw = cfg.encoder.includes("nvenc");

  for (const b of document.querySelectorAll<HTMLButtonElement>("#mode-seg button"))
    b.classList.toggle("on", b.dataset.mode === cfg.mode);
  $("f-bitrate").hidden = cfg.mode !== "bitrate";
  $("f-size").hidden = cfg.mode !== "size";
  $("f-preset").hidden = hw;
  $("f-twopass").classList.toggle("disabled", hw);

  // Video readout
  const { kbps, ok } = computeVideoKbps();
  const src = media.videoKbps ? `Source ≈ ${media.videoKbps.toLocaleString()} kbps. ` : "";
  let html: string;
  if (cfg.mode === "bitrate") {
    const mb = estimateSizeMB({ videoKbps: kbps, duration, audioKbps: cfg.audioBitrate, audioTracks: plan.outTracks });
    html = `${src}Estimated size ≈ <b>${mb.toFixed(1)} MB</b>`;
  } else if (!ok) {
    html = `<span class="bad">Target is too small for a ${formatDuration(duration)} clip. Increase the size, lower the audio bitrate, or remove audio tracks.</span>`;
  } else {
    html = `${src}Video bitrate will be <b>${kbps.toLocaleString()} kbps</b>` +
      (plan.outTracks ? ` + ${plan.outTracks} × ${cfg.audioBitrate} kbps audio` : "");
    if (hw) html += `<br><span class="muted">NVENC is single-pass, so the final size may be off by a few percent.</span>`;
  }
  if (media.videoKbps && kbps > media.videoKbps * 1.05 && ok)
    html += `<br><span class="muted">That's higher than the source bitrate — the file may get bigger, not smaller.</span>`;
  $("cfg-readout").innerHTML = html;

  // Audio readout
  const parts: string[] = [];
  if (plan.master.length > 1) parts.push(`1 master track (tracks ${plan.master.map((i) => i + 1).join(" + ")} mixed)`);
  else if (plan.master.length === 1) parts.push(`master = track ${plan.master[0] + 1}`);
  if (plan.separate.length) parts.push(`${plan.separate.length} separate (${plan.separate.map((i) => `track ${i + 1}`).join(", ")})`);
  $("audio-readout").textContent = media.audio.length
    ? `Output: ${plan.outTracks} audio track${plan.outTracks === 1 ? "" : "s"}${parts.length ? " — " + parts.join(", ") : " (no audio)"}`
    : "Output will have no audio.";
  $("audio-readout").hidden = !media.audio.length;

  // Filename warning
  const { ext } = splitPath(cfg.filename);
  const warn = $("cfg-name-warn");
  const e = ext.toLowerCase();
  if (!ext) { warn.textContent = "No extension — add one such as .mp4 or .mkv."; warn.hidden = false; }
  else if (e === ".webm") { warn.textContent = ".webm needs VP9/AV1 video; use .mp4 or .mkv instead."; warn.hidden = false; }
  else if (![".mp4", ".mkv", ".mov", ".m4v"].includes(e)) { warn.textContent = `${ext} may not support H.264/H.265 + AAC. .mp4 or .mkv is safest.`; warn.hidden = false; }
  else warn.hidden = true;
  $("cfg-error").textContent = "";
}

function bindConfigInputs(): void {
  const num = (id: string, key: "videoBitrate" | "targetSizeMB"): void => {
    $<HTMLInputElement>(id).addEventListener("input", (e) => {
      cfg[key] = parseFloat((e.target as HTMLInputElement).value) || 0;
      updateConfigUI();
    });
  };
  num("cfg-bitrate", "videoBitrate");
  num("cfg-size", "targetSizeMB");
  $("mode-seg").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
    if (b) { cfg.mode = b.dataset.mode as Mode; updateConfigUI(); }
  });
  $<HTMLSelectElement>("cfg-encoder").addEventListener("change", (e) => {
    cfg.encoder = (e.target as HTMLSelectElement).value as Encoder; updateConfigUI();
  });
  $<HTMLSelectElement>("cfg-preset").addEventListener("change", (e) => { cfg.preset = (e.target as HTMLSelectElement).value; });
  $<HTMLSelectElement>("cfg-res").addEventListener("change", (e) => { cfg.resolution = (e.target as HTMLSelectElement).value; });
  $<HTMLInputElement>("cfg-twopass").addEventListener("change", (e) => { cfg.twoPass = (e.target as HTMLInputElement).checked; });
  $<HTMLSelectElement>("cfg-abitrate").addEventListener("change", (e) => {
    cfg.audioBitrate = Number((e.target as HTMLSelectElement).value); updateConfigUI();
  });
  $<HTMLInputElement>("cfg-filename").addEventListener("input", (e) => {
    cfg.filename = (e.target as HTMLInputElement).value;
    cfg.nameEdited = true;
    overwriteConfirmedFor = "";
    updateConfigUI();
  });
  $("btn-change-folder").addEventListener("click", async () => {
    const dir = await invoke<string | null>("pick_folder", { title: "Save this export to…" });
    if (dir) { cfg.outputDir = dir; overwriteConfirmedFor = ""; fillConfig(); }
  });
  $("btn-reset-name").addEventListener("click", () => {
    if (!media) return;
    cfg.filename = defaultFilename();
    cfg.nameEdited = false;
    $<HTMLInputElement>("cfg-filename").value = cfg.filename;
    updateConfigUI();
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
async function startExport(): Promise<void> {
  if (!media || exporting) return;
  const err = (m: string): void => { $("cfg-error").textContent = m; };
  const name = cfg.filename.trim();
  if (!name) return err("Enter a file name.");
  if (/[\\/:*?"<>|]/.test(name)) return err('File names can\'t contain \\ / : * ? " < > |');
  if (splitPath(name).ext.toLowerCase() === ".webm") return err("Use .mp4 or .mkv — .webm isn't supported with these encoders.");

  const dest = destinationDir();
  if (dest !== splitPath(media.path).dir && !(await invoke<boolean>("path_exists", { path: dest })))
    return err(`The output folder doesn't exist: ${dest}. Change it in Settings or with "Change…".`);
  const output = joinPath(dest, name);
  if (output.toLowerCase() === media.path.toLowerCase())
    return err("The output name is the same as the original file. Change it so the original isn't overwritten.");

  const plan = audioPlan();
  if (!media.hasVideo && plan.outTracks === 0) return err("Nothing to export — select at least one audio track.");
  const { kbps, ok } = computeVideoKbps();
  if (media.hasVideo && !ok) return err(cfg.mode === "size" ? "Target size is too small." : "Enter a video bitrate.");

  if (overwriteConfirmedFor !== output && await invoke<boolean>("path_exists", { path: output })) {
    overwriteConfirmedFor = output;
    return err(`${name} already exists. Click Export again to overwrite it.`);
  }

  const req: ExportRequest = {
    input: media.path,
    output,
    start: inPt,
    end: outPt,
    ffmpegDir: settings.ffmpegDir,
    video: media.hasVideo ? {
      encoder: cfg.encoder,
      preset: cfg.preset,
      bitrateKbps: kbps,
      twoPass: cfg.twoPass,
      scaleHeight: cfg.resolution === "orig" ? null : Number(cfg.resolution),
      sizeMode: cfg.mode === "size",
    } : null,
    audio: { master: plan.master, separate: plan.separate, bitrateKbps: cfg.audioBitrate, titles: outputTitles() },
  };

  exporting = true;
  lastOutput = output;
  $("exp-title").textContent = "Exporting…";
  $("exp-file").textContent = name;
  $("exp-bar").style.width = "0%";
  $("exp-pass").textContent = "";
  $("exp-pct").textContent = "0%";
  $("exp-speed").textContent = "";
  $("exp-error").textContent = "";
  $("exp-running-actions").hidden = false;
  $("exp-done-actions").hidden = true;
  $("export-modal").hidden = false;

  try {
    const res = await invoke<ExportResult>("export_video", { req });
    $("exp-title").textContent = "Export complete";
    $("exp-file").textContent = `${name} — ${formatBytes(res.sizeBytes)}`;
    $("exp-bar").style.width = "100%";
    $("exp-pct").textContent = "100%";
    $("exp-running-actions").hidden = true;
    $("exp-done-actions").hidden = false;
  } catch (e) {
    if (String(e) === "Cancelled") {
      $("export-modal").hidden = true;
      toast("Export cancelled");
    } else {
      $("exp-title").textContent = "Export failed";
      $("exp-error").textContent = String(e);
      $("exp-running-actions").hidden = true;
      $("exp-done-actions").hidden = false;
      $("btn-exp-reveal").hidden = true;
    }
  } finally {
    exporting = false;
  }
}

function onExportProgress(p: Progress): void {
  const overall = p.passes === 2 ? (p.pass - 1 + p.fraction) / 2 : p.fraction;
  $("exp-bar").style.width = `${(overall * 100).toFixed(1)}%`;
  $("exp-pct").textContent = `${Math.floor(overall * 100)}%`;
  $("exp-pass").textContent = p.passes === 2 ? `Pass ${p.pass} of 2${p.pass === 1 ? " (analysing)" : ""}` : "";
  $("exp-speed").textContent = p.speed && p.speed !== "N/A" ? `Speed ${p.speed}` : "";
}

// ---------------------------------------------------------------------------
// Cut preview ("Preview" on the export screen)
// A muted low-res video plus one <audio> per output track. All audio elements
// play together and stay locked to one clock; the checkboxes only mute/unmute,
// so switching tracks is instant and several can be heard at once.
// ---------------------------------------------------------------------------
const pvVideo = $<HTMLVideoElement>("pv-video");
let pvAudios: HTMLAudioElement[] = [];
let pvToken = 0;
let pvDuration = 0;

const pvClock = (): HTMLMediaElement | null => (media?.hasVideo ? pvVideo : pvAudios[0] ?? null);
const pvAll = (): HTMLMediaElement[] => [...(media?.hasVideo ? [pvVideo] : []), ...pvAudios];

async function openCutPreview(): Promise<void> {
  if (!media) return;
  const plan = audioPlan();
  if (!media.hasVideo && !plan.outTracks) {
    $("cfg-error").textContent = "Nothing to preview — select at least one audio track.";
    return;
  }
  closeCutPreview(false);
  const token = ++pvToken;
  $("preview-modal").hidden = false;
  $("pv-sub").textContent = `${formatTime(inPt)} → ${formatTime(outPt)} (${formatDuration(outPt - inPt)})`;
  $("pv-loading").hidden = false;
  $("pv-player").hidden = true;
  $("pv-error").textContent = "";
  $("pv-loading-text").textContent = "Rendering preview…";
  $("pv-bar").style.width = "0%";
  try {
    const res = await invoke<CutPreviewResult>("render_cut_preview", {
      req: {
        input: media.path, start: inPt, end: outPt, hasVideo: media.hasVideo, ffmpegDir: settings.ffmpegDir,
        audio: { master: plan.master, separate: plan.separate, bitrateKbps: cfg.audioBitrate, titles: outputTitles() },
      },
    });
    if (token !== pvToken || $("preview-modal").hidden) return;
    setupCutPlayer(res);
  } catch (e) {
    if (token !== pvToken || String(e) === "Cancelled") return;
    $("pv-loading").hidden = true;
    $("pv-error").textContent = String(e);
  }
}

function setupCutPlayer(res: CutPreviewResult): void {
  pvDuration = outPt - inPt;
  const plan = audioPlan();
  const labels: string[] = [];
  if (plan.master.length) {
    labels.push(cfg.masterName.trim() || (plan.master.length > 1
      ? `Master (Tracks ${plan.master.map((i) => i + 1).join(" + ")})` : `Track ${plan.master[0] + 1}`));
  }
  for (const i of plan.separate) labels.push(media!.audio[i].outName.trim() || `Track ${i + 1}`);

  pvAudios = res.audioUrls.map((url, i) => {
    const a = new Audio(url);
    a.preload = "auto";
    a.muted = i !== 0; // first output track (what players play by default) is on
    $("pv-audio-holder").appendChild(a);
    return a;
  });
  $("pv-tracks").innerHTML = labels.length
    ? labels.map((l, i) => `<label class="${i === 0 ? "on" : ""}"><input type="checkbox" data-i="${i}" ${i === 0 ? "checked" : ""}/> ${esc(l)}</label>`).join("")
    : `<span class="muted">No audio tracks selected.</span>`;
  $("pv-video").parentElement!.hidden = !media?.hasVideo;
  if (res.videoUrl) { pvVideo.src = res.videoUrl; pvVideo.load(); }

  $("pv-loading").hidden = true;
  $("pv-player").hidden = false;
  pvRender();
  const clock = pvClock();
  clock?.addEventListener("canplay", () => pvPlay(), { once: true });
}

function pvPlay(): void {
  const clock = pvClock();
  if (!clock) return;
  if (clock.ended || clock.currentTime >= pvDuration - 0.05) pvSeek(0);
  for (const a of pvAudios) a.currentTime = clock.currentTime;
  for (const m of pvAll()) void m.play().catch(() => {});
}

function pvPause(): void {
  for (const m of pvAll()) m.pause();
}

function pvToggle(): void {
  const c = pvClock();
  if (!c) return;
  if (c.paused) pvPlay(); else pvPause();
}

function pvSeek(t: number): void {
  for (const m of pvAll()) m.currentTime = Math.min(Math.max(0, t), pvDuration);
  pvRender();
}

/** Keep audio locked to the clock and update the controls. */
function pvTick(): void {
  if ($("preview-modal").hidden) return;
  const c = pvClock();
  if (c && !c.paused) {
    for (const a of pvAudios) {
      if (a === c) continue;
      if (Math.abs(a.currentTime - c.currentTime) > 0.08) a.currentTime = c.currentTime;
      if (a.paused && !a.ended) void a.play().catch(() => {});
    }
    if (c.currentTime >= pvDuration - 0.02 || c.ended) pvPause();
  }
  pvRender();
  requestAnimationFrame(pvTick);
}

function pvRender(): void {
  const c = pvClock();
  const t = c?.currentTime ?? 0;
  $<HTMLInputElement>("pv-seek").value = String(pvDuration ? Math.round((t / pvDuration) * 1000) : 0);
  $("pv-time").textContent = `${formatDuration(t)} / ${formatDuration(pvDuration)}`;
  $("pv-play-icon").innerHTML = `<use href="#i-${c && !c.paused ? "pause" : "play"}"/>`;
}

function closeCutPreview(hide = true): void {
  pvToken++;
  void invoke("cancel_job", { kind: "cutpreview" }).catch(() => {});
  pvPause();
  pvVideo.removeAttribute("src");
  pvVideo.load();
  for (const a of pvAudios) { a.removeAttribute("src"); a.load(); a.remove(); }
  pvAudios = [];
  if (hide) $("preview-modal").hidden = true;
}

function bindCutPreview(): void {
  $("pv-close").addEventListener("click", () => closeCutPreview());
  $("pv-play").addEventListener("click", pvToggle);
  pvVideo.addEventListener("click", pvToggle);
  $<HTMLInputElement>("pv-seek").addEventListener("input", (e) => {
    pvSeek((Number((e.target as HTMLInputElement).value) / 1000) * pvDuration);
  });
  $("pv-tracks").addEventListener("change", (e) => {
    const cb = e.target as HTMLInputElement;
    const a = pvAudios[Number(cb.dataset.i)];
    if (!a) return;
    a.muted = !cb.checked;
    cb.parentElement!.classList.toggle("on", cb.checked);
  });
  $("preview-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeCutPreview(); });
  new MutationObserver(() => { if (!$("preview-modal").hidden) requestAnimationFrame(pvTick); })
    .observe($("preview-modal"), { attributes: true, attributeFilter: ["hidden"] });
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------
function openSettings(): void {
  $<HTMLInputElement>("set-template").value = settings.filenameTemplate;
  $<HTMLInputElement>("set-ffdir").value = settings.ffmpegDir;
  $<HTMLSelectElement>("set-mode").value = settings.mode;
  $<HTMLInputElement>("set-bitrate").value = String(settings.videoBitrate);
  $<HTMLInputElement>("set-size").value = String(settings.targetSizeMB);
  $<HTMLSelectElement>("set-abitrate").value = String(settings.audioBitrate);
  $<HTMLSelectElement>("set-encoder").value = settings.encoder;
  $<HTMLSelectElement>("set-preset").value = settings.preset;
  $<HTMLInputElement>("set-twopass").checked = settings.twoPass;
  $<HTMLInputElement>(settings.outputLocation === "folder" ? "set-loc-folder" : "set-loc-source").checked = true;
  $<HTMLInputElement>("set-outdir").value = settings.outputFolder;
  $<HTMLSelectElement>("set-format").value = settings.outputFormat;
  $<HTMLInputElement>("set-fastseek").checked = settings.fastSeek;
  $<HTMLInputElement>("set-master-name").value = settings.masterTrackName;
  $<HTMLInputElement>("set-autoupdate").checked = settings.autoUpdateCheck;
  void getVersion().then((v) => ($("app-version").textContent = `You have version ${v}`)).catch(() => {});
  renderTrackNameInputs(settings.trackNames);
  $("ff-test-result").textContent = "";
  syncLocationRow();
  updateTemplatePreview();
  void refreshFfmpegStatusLine();
  $("settings-modal").hidden = false;
  $<HTMLInputElement>("set-template").focus();
}

/** Settings rows "Track 1 [name]" … — at least 4, or as many as the open file has. */
function renderTrackNameInputs(names: string[]): void {
  const n = Math.max(4, names.length, media?.audio.length ?? 0);
  $("set-track-names").innerHTML = Array.from({ length: n }, (_, i) => `<label class="tn-row">
      <span>Track ${i + 1}</span>
      <input type="text" spellcheck="false" data-i="${i}" value="${esc(names[i] ?? "")}" placeholder="${i === 0 ? "e.g. Game" : i === 1 ? "e.g. Discord" : i === 2 ? "e.g. Microphone" : "(keep file's name)"}" />
    </label>`).join("");
}

function readTrackNameInputs(): string[] {
  const names = [...document.querySelectorAll<HTMLInputElement>("#set-track-names input")].map((i) => i.value.trim());
  while (names.length && !names[names.length - 1]) names.pop();
  return names;
}

function syncLocationRow(): void {
  const folder = $<HTMLInputElement>("set-loc-folder").checked;
  $("set-outdir").closest(".row")!.classList.toggle("disabled", !folder);
}

async function refreshFfmpegStatusLine(): Promise<void> {
  const el = $("ff-status-line");
  el.textContent = "Checking FFmpeg…";
  const s = await invoke<FfmpegStatus>("ffmpeg_status", { ffmpegDir: settings.ffmpegDir });
  const from = { settings: "custom folder", managed: "installed by Media Compressor", bundled: "next to the app", path: "from PATH", "": "" }[s.source];
  el.textContent = s.ok ? `Using ${s.version.replace(/ Copyright.*$/, "")} (${from})` : "FFmpeg not found.";
  $("btn-reinstall-ff").hidden = !s.canAutoInstall;
}

function updateTemplatePreview(): void {
  const tpl = $<HTMLInputElement>("set-template").value;
  const format = $<HTMLSelectElement>("set-format").value as OutputFormat;
  const vars = media ? templateVars(media.path, inPt, outPt, format) : templateVars("C:\\Videos\\My Clip.mp4", 65.25, 130, format);
  $("set-template-preview").textContent = applyTemplate(tpl, vars);
}

async function saveSettings(): Promise<void> {
  const previous = settings;
  const num = (id: string, fallback: number): number => parseFloat($<HTMLInputElement>(id).value) || fallback;
  settings = {
    filenameTemplate: $<HTMLInputElement>("set-template").value.trim() || DEFAULT_SETTINGS.filenameTemplate,
    ffmpegDir: $<HTMLInputElement>("set-ffdir").value.trim(),
    mode: $<HTMLSelectElement>("set-mode").value as Mode,
    videoBitrate: num("set-bitrate", DEFAULT_SETTINGS.videoBitrate),
    targetSizeMB: num("set-size", DEFAULT_SETTINGS.targetSizeMB),
    audioBitrate: Number($<HTMLSelectElement>("set-abitrate").value),
    encoder: $<HTMLSelectElement>("set-encoder").value as Encoder,
    preset: $<HTMLSelectElement>("set-preset").value,
    twoPass: $<HTMLInputElement>("set-twopass").checked,
    outputLocation: ($<HTMLInputElement>("set-loc-folder").checked ? "folder" : "source") as OutputLocation,
    outputFolder: $<HTMLInputElement>("set-outdir").value.trim(),
    outputFormat: $<HTMLSelectElement>("set-format").value as OutputFormat,
    fastSeek: $<HTMLInputElement>("set-fastseek").checked,
    masterTrackName: $<HTMLInputElement>("set-master-name").value.trim(),
    trackNames: readTrackNameInputs(),
    autoUpdateCheck: $<HTMLInputElement>("set-autoupdate").checked,
    skippedVersion: previous.skippedVersion,
  };
  if (settings.outputLocation === "folder") {
    if (!settings.outputFolder) { toast("Choose a folder to save to, or pick \"Same folder as the input file\".", true); return; }
    if (!(await invoke<boolean>("path_exists", { path: settings.outputFolder }))) {
      toast(`That folder doesn't exist: ${settings.outputFolder}`, true); return;
    }
  }
  try {
    await invoke("save_settings", { settings });
  } catch (e) {
    toast(`Couldn't save settings: ${e}`, true);
  }
  // Apply new defaults to the current export (keep the user's edited filename & track roles).
  const keepName = cfg.nameEdited ? { filename: cfg.filename, nameKey: cfg.nameKey, nameEdited: true } : {};
  const keepMaster = cfg.masterNameEdited ? { masterName: cfg.masterName, masterNameEdited: true } : {};
  cfg = { ...freshConfig(), resolution: cfg.resolution, outputDir: cfg.outputDir, ...keepName, ...keepMaster };
  // New default track names apply to tracks whose name the user hasn't changed.
  for (const t of media?.audio ?? []) {
    const oldDefault = previous.trackNames[t.index]?.trim() || t.title || "";
    if (!t.outName.trim() || t.outName === oldDefault) t.outName = defaultTrackName(t);
  }
  if (isConfig()) {
    if (!cfg.nameEdited && media) cfg.filename = defaultFilename();
    fillConfig();
  }
  $("settings-modal").hidden = true;
  toast("Settings saved");
}

function bindSettings(): void {
  const tplInput = $<HTMLInputElement>("set-template");
  tplInput.addEventListener("input", updateTemplatePreview);
  $("var-chips").innerHTML = TEMPLATE_VARS.map((v) => `<button data-v="${v}">\${${v}}</button>`).join("");
  $("var-chips").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-v]");
    if (!b) return;
    const ins = `\${${b.dataset.v}}`;
    const s = tplInput.selectionStart ?? tplInput.value.length;
    const en = tplInput.selectionEnd ?? s;
    tplInput.value = tplInput.value.slice(0, s) + ins + tplInput.value.slice(en);
    tplInput.focus();
    tplInput.setSelectionRange(s + ins.length, s + ins.length);
    updateTemplatePreview();
  });
  $("btn-test-ff").addEventListener("click", async () => {
    const out = $("ff-test-result");
    out.textContent = "Checking…";
    try {
      out.textContent = await invoke<string>("check_ffmpeg", { ffmpegDir: $<HTMLInputElement>("set-ffdir").value.trim() });
    } catch (e) {
      out.textContent = String(e);
    }
  });
  $("btn-set-save").addEventListener("click", () => void saveSettings());
  for (const id of ["set-loc-source", "set-loc-folder"]) $(id).addEventListener("change", syncLocationRow);
  $("set-format").addEventListener("change", updateTemplatePreview);
  $("btn-browse-outdir").addEventListener("click", async () => {
    const dir = await invoke<string | null>("pick_folder", { title: "Save exports to…" });
    if (dir) {
      $<HTMLInputElement>("set-outdir").value = dir;
      $<HTMLInputElement>("set-loc-folder").checked = true;
      syncLocationRow();
    }
  });
  $("btn-add-track-name").addEventListener("click", () => {
    const cur = [...document.querySelectorAll<HTMLInputElement>("#set-track-names input")].map((i) => i.value);
    renderTrackNameInputs([...cur, ""]);
    ($("set-track-names").lastElementChild?.querySelector("input") as HTMLInputElement | null)?.focus();
  });
  $("btn-check-updates").addEventListener("click", () => {
    $("settings-modal").hidden = true;
    void checkForUpdates(true);
  });
  $("btn-reinstall-ff").addEventListener("click", () => {
    $("settings-modal").hidden = true;
    void runSetup(true);
  });
  $("btn-set-cancel").addEventListener("click", () => ($("settings-modal").hidden = true));
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  const typing = target.matches("input:not([type=checkbox]), select, textarea");

  if (e.key === "Escape") {
    if (!$("settings-modal").hidden) { $("settings-modal").hidden = true; return; }
    if (!$("preview-modal").hidden) { closeCutPreview(); return; }
    if (typing) { target.blur(); return; }
    if (isConfig() && !modalOpen()) { showScreen("editor"); return; }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); void browse(); return; }
  if (!$("preview-modal").hidden && e.key === " " && !typing) { e.preventDefault(); pvToggle(); return; }
  if (typing || modalOpen() || isConfig() || !media) return;

  const k = e.key;
  const frameStep = e.ctrlKey || e.metaKey;
  let handled = true;
  switch (k) {
    case " ": togglePlay(); break;
    case "i": case "I": setIn(curTime); break;
    case "o": case "O": setOut(curTime); break;
    case "ArrowLeft": video.pause(); frameStep ? step(-1) : seek(curTime - (e.shiftKey ? 10 : 1)); break;
    case "ArrowRight": video.pause(); frameStep ? step(1) : seek(curTime + (e.shiftKey ? 10 : 1)); break;
    case ",": step(-1); break;
    case ".": step(1); break;
    case "Home": seek(0); break;
    case "End": seek(media.duration); break;
    case "m": case "M": toggleMute(); break;
    case "p": case "P": playCut(); break;
    case "Enter": goToConfig(); break;
    default: handled = false;
  }
  if (handled) e.preventDefault();
});

function toggleMute(): void {
  video.muted = !video.muted;
  $("vol-icon").innerHTML = `<use href="#i-${video.muted ? "mute" : "vol"}"/>`;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function bind(): void {
  // Don't let clicked buttons keep focus (Space would "click" them again).
  document.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (b) b.blur();
  });

  $("dropzone").addEventListener("click", () => void browse());
  $("open-btn").addEventListener("click", () => void browse());
  $("settings-btn").addEventListener("click", openSettings);

  $("btn-play").addEventListener("click", togglePlay);
  $("btn-prev").addEventListener("click", () => step(-1));
  $("btn-next").addEventListener("click", () => step(1));
  $("btn-start").addEventListener("click", () => seek(0));
  $("btn-end").addEventListener("click", () => media && seek(media.duration));
  $("btn-set-in").addEventListener("click", () => setIn(curTime));
  $("btn-set-out").addEventListener("click", () => setOut(curTime));
  $("btn-goto-in").addEventListener("click", () => seek(inPt));
  $("btn-goto-out").addEventListener("click", () => seek(outPt));
  $("btn-mute").addEventListener("click", toggleMute);
  $("btn-play-cut").addEventListener("click", playCut);
  $("btn-preview").addEventListener("click", () => void openCutPreview());
  bindCutPreview();
  $("btn-to-config").addEventListener("click", goToConfig);
  $("btn-back").addEventListener("click", () => showScreen("editor"));
  $("btn-export").addEventListener("click", () => void startExport());

  for (const [box, which] of [[inBox, "in"], [outBox, "out"]] as const) {
    box.addEventListener("keydown", (e) => { if (e.key === "Enter") commitTimeBox(box, which); });
    box.addEventListener("change", () => commitTimeBox(box, which));
    box.addEventListener("input", () => box.classList.remove("bad"));
  }

  $<HTMLSelectElement>("speed").addEventListener("change", (e) => {
    video.playbackRate = parseFloat((e.target as HTMLSelectElement).value);
  });
  $<HTMLSelectElement>("zoom").addEventListener("change", (e) => setZoom(Number((e.target as HTMLSelectElement).value)));

  video.addEventListener("loadedmetadata", onVideoMeta);
  video.addEventListener("error", onVideoError);
  video.addEventListener("play", () => ($("play-icon").innerHTML = `<use href="#i-pause"/>`));
  video.addEventListener("pause", () => ($("play-icon").innerHTML = `<use href="#i-play"/>`));
  video.addEventListener("seeked", onSeeked);
  video.addEventListener("click", togglePlay);

  $("btn-exp-cancel").addEventListener("click", () => void invoke("cancel_job", { kind: "export" }));
  $("btn-exp-reveal").addEventListener("click", () => void invoke("reveal_in_folder", { path: lastOutput }));
  $("btn-exp-close").addEventListener("click", () => {
    $("export-modal").hidden = true;
    $("btn-exp-reveal").hidden = false;
    if (!$("exp-error").textContent) showScreen("editor");
  });
  $("btn-exp-another").addEventListener("click", () => {
    $("export-modal").hidden = true;
    $("btn-exp-reveal").hidden = false;
    void browse();
  });

  bindConfigInputs();
  bindSettings();
  window.addEventListener("resize", () => (dirty = true));
}

// ---------------------------------------------------------------------------
// App updates (GitHub Releases → latest.json, verified with the updater key)
// ---------------------------------------------------------------------------
let pendingUpdate: Update | null = null;

async function checkForUpdates(manual: boolean): Promise<void> {
  if (manual) toast("Checking for updates…");
  try {
    const update = await check({ timeout: 15000 });
    if (!update) {
      if (manual) toast(`You're on the latest version (${await getVersion()}).`);
      return;
    }
    if (!manual && settings.skippedVersion === update.version) return;
    showUpdatePrompt(update);
  } catch (e) {
    // No releases yet, offline, etc. Only bother the user if they asked.
    if (manual) toast(`Couldn't check for updates: ${e}`, true);
    else console.warn("update check failed", e);
  }
}

function showUpdatePrompt(update: Update): void {
  pendingUpdate = update;
  $("toast").hidden = true;
  $("up-title").textContent = "Update available";
  $("up-text").textContent = `Media Compressor ${update.version} is available — you have ${update.currentVersion}. `
    + "It will download, install and restart the app.";
  const notes = (update.body ?? "").trim();
  $("up-notes").hidden = !notes;
  $("up-notes").textContent = notes;
  $("up-progress").hidden = true;
  $("up-error").textContent = "";
  $("up-actions").hidden = false;
  $<HTMLButtonElement>("up-install").disabled = false;
  $("up-install").textContent = "Update now";
  $("update-modal").hidden = false;
}

async function installUpdate(): Promise<void> {
  const update = pendingUpdate;
  if (!update) return;
  if (exporting) {
    $("up-error").textContent = "Wait for the current export to finish, then update.";
    return;
  }
  $("up-actions").hidden = true;
  $("up-progress").hidden = false;
  $("up-error").textContent = "";
  $("up-title").textContent = `Updating to ${update.version}…`;
  let total = 0;
  let done = 0;
  const mb = (n: number): string => (n / 1048576).toFixed(1);
  try {
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") {
        total = ev.data.contentLength ?? 0;
        $("up-detail").textContent = "Downloading…";
      } else if (ev.event === "Progress") {
        done += ev.data.chunkLength;
        $("up-bar").style.width = total ? `${((done / total) * 100).toFixed(1)}%` : "50%";
        $("up-pct").textContent = total ? `${Math.floor((done / total) * 100)}%` : "";
        $("up-detail").textContent = total ? `${mb(done)} MB of ${mb(total)} MB` : `${mb(done)} MB`;
      } else if (ev.event === "Finished") {
        $("up-bar").style.width = "100%";
        $("up-detail").textContent = "Installing…";
      }
    });
    $("up-detail").textContent = "Restarting…";
    await invoke("clear_previews").catch(() => {});
    await relaunch();
  } catch (e) {
    $("up-title").textContent = "Update failed";
    $("up-error").textContent = String(e);
    $("up-progress").hidden = true;
    $("up-actions").hidden = false;
    $("up-install").textContent = "Try again";
  }
}

function bindUpdates(): void {
  $("up-install").addEventListener("click", () => void installUpdate());
  $("up-later").addEventListener("click", () => ($("update-modal").hidden = true));
  $("up-skip").addEventListener("click", async () => {
    if (pendingUpdate) {
      settings.skippedVersion = pendingUpdate.version;
      await invoke("save_settings", { settings }).catch(() => {});
    }
    $("update-modal").hidden = true;
  });
}

// ---------------------------------------------------------------------------
// First-run setup: make sure FFmpeg is available, download it if not
// ---------------------------------------------------------------------------
const MIN_FFMPEG_MAJOR = 5;
let setupResolve: (() => void) | null = null;

function setupUI(o: {
  title?: string; text?: string; progress?: number | null; detail?: string; error?: string;
  buttons?: ("cancel" | "folder" | "retry")[];
}): void {
  $("setup").hidden = false;
  if (o.title !== undefined) $("setup-title").textContent = o.title;
  if (o.text !== undefined) $("setup-text").textContent = o.text;
  if (o.progress !== undefined) {
    $("setup-barwrap").hidden = o.progress === null;
    $("setup-bar").style.width = `${((o.progress ?? 0) * 100).toFixed(1)}%`;
    $("setup-pct").textContent = o.progress === null ? "" : `${Math.floor((o.progress ?? 0) * 100)}%`;
  }
  if (o.detail !== undefined) $("setup-detail").textContent = o.detail;
  if (o.error !== undefined) $("setup-error").textContent = o.error;
  const b = o.buttons ?? [];
  $("setup-cancel").hidden = !b.includes("cancel");
  $("setup-folder").hidden = !b.includes("folder");
  $("setup-retry").hidden = !b.includes("retry");
}

const ffVersion = (s: FfmpegStatus): string => s.version.replace(/^ffmpeg version\s+/, "").split(/\s/)[0];

/**
 * Check for FFmpeg; if it's missing (or too old) download it automatically.
 * Resolves once a usable FFmpeg is available. `forceInstall` re-downloads.
 */
async function runSetup(forceInstall = false): Promise<void> {
  const status = await invoke<FfmpegStatus>("ffmpeg_status", { ffmpegDir: settings.ffmpegDir });
  const tooOld = status.ok && status.major !== null && status.major < MIN_FFMPEG_MAJOR;
  if (status.ok && !tooOld && !forceInstall) {
    $("setup").hidden = true;
    return;
  }

  await new Promise<void>((resolve) => {
    setupResolve = resolve;
    if (!status.canAutoInstall) {
      setupUI({
        title: "FFmpeg is needed",
        text: "Media Compressor uses FFmpeg to read and export video, and it couldn't find it. "
          + "Install it with your package manager (macOS: brew install ffmpeg · Linux: sudo apt install ffmpeg), then click Try again.",
        progress: null, detail: "", error: status.error, buttons: ["folder", "retry"],
      });
      return;
    }
    void doInstall(tooOld ? `Found FFmpeg ${ffVersion(status)}, but version ${MIN_FFMPEG_MAJOR} or newer is needed.` : "");
  });
  setupResolve = null;
}

async function doInstall(prefix = ""): Promise<void> {
  setupUI({
    title: "Installing FFmpeg",
    text: `${prefix ? prefix + " " : ""}Media Compressor uses FFmpeg to read and export video. `
      + "Downloading it now — this only happens once (about 190 MB, from the official FFmpeg builds on GitHub).",
    progress: 0, detail: "Connecting…", error: "", buttons: ["cancel"],
  });
  try {
    const version = await invoke<string>("install_ffmpeg");
    // A previously set custom folder would take priority over the new install.
    if (settings.ffmpegDir) {
      settings.ffmpegDir = "";
      await invoke("save_settings", { settings }).catch(() => {});
    }
    setupUI({ title: "FFmpeg is ready", text: version.replace(/ Copyright.*$/, ""), progress: 1, detail: "", buttons: [] });
    window.setTimeout(() => { $("setup").hidden = true; setupResolve?.(); }, 900);
  } catch (e) {
    const cancelled = String(e) === "Cancelled";
    setupUI({
      title: cancelled ? "Download cancelled" : "Couldn't install FFmpeg",
      text: cancelled ? "FFmpeg is needed to open videos." : "Check your internet connection and try again, or point Media Compressor at an FFmpeg you already have.",
      progress: null, detail: "", error: cancelled ? "" : String(e), buttons: ["folder", "retry"],
    });
  }
}

function onInstallProgress(p: InstallProgress): void {
  if (p.stage === "download") {
    const mb = (n: number): string => (n / 1048576).toFixed(1);
    setupUI({
      progress: p.total ? p.done / p.total : null,
      detail: p.total ? `${mb(p.done)} MB of ${mb(p.total)} MB` : `${mb(p.done)} MB`,
    });
  } else {
    setupUI({ progress: 1, detail: p.stage === "verify" ? "Verifying download…" : "Extracting…", buttons: [] });
  }
}

function bindSetup(): void {
  $("setup-cancel").addEventListener("click", () => void invoke("cancel_install"));
  $("setup-retry").addEventListener("click", async () => {
    const s = await invoke<FfmpegStatus>("ffmpeg_status", { ffmpegDir: settings.ffmpegDir });
    if (s.ok && (s.major === null || s.major >= MIN_FFMPEG_MAJOR)) {
      $("setup").hidden = true;
      setupResolve?.();
    } else if (s.canAutoInstall) {
      void doInstall();
    } else {
      setupUI({ error: s.error || "Still not found." });
    }
  });
  $("setup-folder").addEventListener("click", async () => {
    const dir = await invoke<string | null>("pick_folder", { title: "Choose the folder that contains ffmpeg" });
    if (!dir) return;
    const s = await invoke<FfmpegStatus>("ffmpeg_status", { ffmpegDir: dir });
    if (!s.ok) {
      setupUI({ error: `ffmpeg and ffprobe weren't found in ${dir}.\n${s.error}` });
      return;
    }
    settings.ffmpegDir = dir;
    await invoke("save_settings", { settings }).catch(() => {});
    $("setup").hidden = true;
    setupResolve?.();
    toast(`Using FFmpeg ${ffVersion(s)}`);
  });
}

async function init(): Promise<void> {
  bind();
  requestAnimationFrame(loop);

  try {
    const saved = await invoke<Partial<Settings> | null>("load_settings");
    if (saved && typeof saved === "object") settings = { ...DEFAULT_SETTINGS, ...saved };
  } catch { /* first run */ }
  cfg = freshConfig();
  bindSetup();
  bindUpdates();

  await listen<Progress>("export-progress", (e) => onExportProgress(e.payload));
  await listen<Progress>("preview-progress", (e) => {
    if (!$("stage-msg").hidden && e.payload.fraction < 1)
      showStageMsg($("stage-msg-text").textContent ?? "", e.payload.fraction);
  });
  await listen<Progress>("fastseek-progress", (e) => {
    if (fastSeekState === "building")
      setSeekStatus(`Seeking is slow on this file — building a fast-seek preview… ${Math.floor(e.payload.fraction * 100)}%`);
  });
  await listen<InstallProgress>("ffmpeg-install-progress", (e) => onInstallProgress(e.payload));
  await listen<Progress>("cutpreview-progress", (e) => {
    $("pv-bar").style.width = `${(e.payload.fraction * 100).toFixed(1)}%`;
    $("pv-loading-text").textContent = `Rendering preview… ${Math.floor(e.payload.fraction * 100)}%`;
  });

  await runSetup();
  // Dev builds (npm run tauri dev) skip the automatic check; "Check now" still works.
  if (settings.autoUpdateCheck && !import.meta.env.DEV) window.setTimeout(() => void checkForUpdates(false), 2500);

  await getCurrentWebview().onDragDropEvent((e) => {
    const dz = $("dropzone");
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") {
      if (!exporting && !isConfig()) dz.classList.add("over");
    } else {
      dz.classList.remove("over");
      if (p.type === "drop" && p.paths.length && !exporting && !modalOpen()) void openFile(p.paths[0]);
    }
  });
}

void init();
