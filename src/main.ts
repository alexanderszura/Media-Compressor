import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  applyTemplate, bitrateForTargetSize, estimateSizeMB, formatBytes, formatDuration, formatTime,
  parseRate, parseTime, splitPath, templateVars, TEMPLATE_VARS,
} from "./util";
import type {
  AudioTrack, Encoder, ExportRequest, ExportResult, Mode, ProbeResult, Progress, Settings, TrackRole,
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
}

let media: Media | null = null;
let cfg: ExportConfig = freshConfig();
let inPt = 0;
let outPt = 0;
let curTime = 0;
let zoom = 1;
let viewStart = 0;
let usingProxy = false;
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
  };
}

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
  invoke("cancel_job", { kind: "proxy" }).catch(() => {});
  showScreen("editor");
  showStageMsg("Reading file…");

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
    })),
  };
  // Generic handler names from muxers aren't useful titles.
  for (const t of media.audio) if (/^(SoundHandler|ISO Media file)/i.test(t.title)) t.title = "";

  cfg = freshConfig();
  overwriteConfirmedFor = "";
  inPt = 0;
  outPt = duration;
  curTime = 0;
  zoom = 1;
  viewStart = 0;
  ($<HTMLSelectElement>("zoom")).value = "1";
  usingProxy = false;

  const { base } = splitPath(path);
  const bits = [media.hasVideo ? `${media.width}×${media.height}` : "audio only"];
  if (media.hasVideo) bits.push(`${Math.round(media.fps * 100) / 100} fps`);
  bits.push(`${media.audio.length} audio track${media.audio.length === 1 ? "" : "s"}`);
  $("file-title").textContent = `${base}  —  ${bits.join(" · ")}`;
  document.title = `${base} – Media Compressor`;

  $("dropzone").hidden = true;
  video.hidden = false;
  showStageMsg("Loading preview…");
  video.src = convertFileSrc(path);
  video.load();
  updateCutUI();
}

function onVideoMeta(): void {
  if (!media) return;
  if (media.hasVideo && video.videoWidth === 0 && !usingProxy) {
    // Container opened but the codec can't be decoded (e.g. HEVC without extension).
    void makeProxy();
    return;
  }
  if (!media.duration && isFinite(video.duration)) {
    media.duration = video.duration;
    outPt = media.duration;
  }
  hideStageMsg();
  video.currentTime = curTime;
  video.playbackRate = parseFloat(($<HTMLSelectElement>("speed")).value);
  updateCutUI();
}

function onVideoError(): void {
  if (!media || !video.src) return;
  if (!usingProxy) void makeProxy();
  else showStageMsg("Could not play the preview, but you can still set cut points by time.");
}

async function makeProxy(): Promise<void> {
  if (!media) return;
  const token = loadToken;
  usingProxy = true;
  showStageMsg("This format can't be previewed directly — creating a preview copy…", 0);
  try {
    const p = await invoke<string>("make_proxy", {
      path: media.path, ffmpegDir: settings.ffmpegDir, duration: media.duration,
    });
    if (token !== loadToken) return;
    showStageMsg("Loading preview…");
    video.src = convertFileSrc(p);
    video.load();
  } catch (e) {
    if (token !== loadToken || String(e) === "Cancelled") return;
    showStageMsg(`Preview failed: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Playback & cut points
// ---------------------------------------------------------------------------
function seek(t: number): void {
  if (!media) return;
  curTime = Math.min(Math.max(0, t), media.duration);
  if (videoReady()) video.currentTime = curTime;
  followPlayhead();
  dirty = true;
}

function togglePlay(): void {
  if (!media || !videoReady()) return;
  if (video.paused) {
    if (video.ended || curTime >= media.duration - 0.01) seek(inPt);
    void video.play();
  } else video.pause();
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
const modalOpen = (): boolean => !$("settings-modal").hidden || !$("export-modal").hidden;

// ---------------------------------------------------------------------------
// Config (export settings) screen
// ---------------------------------------------------------------------------
function goToConfig(): void {
  if (!media || outPt - inPt < 0.05) return;
  video.pause();
  const key = `${media.path}|${inPt}|${outPt}`;
  if (!cfg.nameEdited || cfg.nameKey !== key) {
    cfg.filename = applyTemplate(settings.filenameTemplate, templateVars(media.path, inPt, outPt));
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
  $("cfg-summary").textContent =
    `${base} · ${formatTime(inPt)} → ${formatTime(outPt)} (${formatDuration(outPt - inPt)})`;
  $<HTMLInputElement>("cfg-filename").value = cfg.filename;
  $("cfg-folder").textContent = `Saved next to the original, in: ${dir}`;

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
  const roles: [TrackRole, string][] = [["master", "Master"], ["separate", "Keep"], ["remove", "Remove"]];
  list.innerHTML = media.audio.map((t) => {
    const desc = [t.codec.toUpperCase(), t.layout || (t.channels ? `${t.channels} ch` : ""),
      t.bitrate ? `${t.bitrate} kbps` : "", t.lang].filter(Boolean).join(" · ");
    return `<div class="track ${t.role}" data-i="${t.index}">
      <div class="num">${t.index + 1}</div>
      <div class="meta"><div class="t">${esc(t.title || `Track ${t.index + 1}`)}</div><div class="d">${esc(desc)}</div></div>
      <div class="seg">${roles.map(([r, label]) =>
        `<button data-role="${r}" class="${t.role === r ? "on" : ""}">${label}</button>`).join("")}</div>
    </div>`;
  }).join("");
}

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
  $("btn-reset-name").addEventListener("click", () => {
    if (!media) return;
    cfg.filename = applyTemplate(settings.filenameTemplate, templateVars(media.path, inPt, outPt));
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

  const { dir, sep } = splitPath(media.path);
  const output = dir ? `${dir}${sep}${name}` : name;
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
    audio: { master: plan.master, separate: plan.separate, bitrateKbps: cfg.audioBitrate },
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
  $("ff-test-result").textContent = "";
  updateTemplatePreview();
  $("settings-modal").hidden = false;
  $<HTMLInputElement>("set-template").focus();
}

function updateTemplatePreview(): void {
  const tpl = $<HTMLInputElement>("set-template").value;
  const vars = media ? templateVars(media.path, inPt, outPt) : templateVars("C:\\Videos\\My Clip.mp4", 65.25, 130);
  $("set-template-preview").textContent = applyTemplate(tpl, vars);
}

async function saveSettings(): Promise<void> {
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
  };
  try {
    await invoke("save_settings", { settings });
  } catch (e) {
    toast(`Couldn't save settings: ${e}`, true);
  }
  // Apply new defaults to the current export (keep the user's edited filename & track roles).
  const keepName = cfg.nameEdited ? { filename: cfg.filename, nameKey: cfg.nameKey, nameEdited: true } : {};
  cfg = { ...freshConfig(), resolution: cfg.resolution, ...keepName };
  if (isConfig()) {
    if (!cfg.nameEdited && media) cfg.filename = applyTemplate(settings.filenameTemplate, templateVars(media.path, inPt, outPt));
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
    if (typing) { target.blur(); return; }
    if (isConfig() && !modalOpen()) { showScreen("editor"); return; }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); void browse(); return; }
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
  video.addEventListener("seeked", () => { if (video.paused) { curTime = video.currentTime; dirty = true; } });
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

async function init(): Promise<void> {
  bind();
  requestAnimationFrame(loop);

  try {
    const saved = await invoke<Partial<Settings> | null>("load_settings");
    if (saved && typeof saved === "object") settings = { ...DEFAULT_SETTINGS, ...saved };
  } catch { /* first run */ }
  cfg = freshConfig();

  await listen<Progress>("export-progress", (e) => onExportProgress(e.payload));
  await listen<Progress>("proxy-progress", (e) => {
    if (usingProxy && !$("stage-msg").hidden && e.payload.fraction < 1)
      showStageMsg("This format can't be previewed directly — creating a preview copy…", e.payload.fraction);
  });

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
