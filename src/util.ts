// Pure helpers (no DOM / Tauri) so they can be unit tested with `npm test`.

const pad = (n: number, w = 2): string => String(Math.floor(n)).padStart(w, "0");

interface TimeParts { h: number; m: number; s: number; ms: number }

function splitSeconds(sec: number): TimeParts {
  let ms = Math.round(Math.max(0, sec || 0) * 1000);
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  return { h, m, s, ms };
}

/** 83.456 -> "00:01:23.456" */
export function formatTime(sec: number): string {
  const { h, m, s, ms } = splitSeconds(sec);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/** Filename-safe variant used for ${CUT_FROM}/${CUT_TO}: "00.01.23.456" */
export function formatCutVar(sec: number): string {
  const { h, m, s, ms } = splitSeconds(sec);
  return `${pad(h)}.${pad(m)}.${pad(s)}.${pad(ms, 3)}`;
}

/** Short human duration: "1:08.5", "1:02:03" */
export function formatDuration(sec: number): string {
  const { h, m, s, ms } = splitSeconds(sec);
  if (h) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}.${Math.floor(ms / 100)}`;
}

/** Accepts "HH:MM:SS.mmm", "MM:SS", "SS.s". Returns NaN if invalid. */
export function parseTime(str: string): number {
  const t = String(str).trim().replace(",", ".");
  if (!/^\d+(:\d+){0,2}(\.\d+)?$/.test(t)) return NaN;
  return t.split(":").reduce((acc, part) => acc * 60 + parseFloat(part), 0);
}

/** "30000/1001" -> 29.97 */
export function parseRate(r: string | undefined | null): number {
  if (!r || typeof r !== "string") return 0;
  const [a, b] = r.split("/").map(Number);
  if (!b) return a || 0;
  return a / b;
}

export interface PathParts { dir: string; sep: string; base: string; name: string; ext: string }

/** Split a Windows or POSIX path. ext includes the dot (".mp4"). */
export function splitPath(path: string): PathParts {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const dir = i >= 0 ? path.slice(0, i) : "";
  const sep = i >= 0 ? path[i] : path.includes("\\") ? "\\" : "/";
  const base = path.slice(i + 1);
  const dot = base.lastIndexOf(".");
  const name = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return { dir, sep, base, name, ext };
}

export const TEMPLATE_VARS = ["FILENAME", "CUT_FROM", "CUT_TO", "EXT"] as const;
export type TemplateVar = (typeof TEMPLATE_VARS)[number];
export type TemplateVars = Record<TemplateVar, string>;

/** Remove characters Windows does not allow in file names. */
export function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim();
}

/** Apply "${FILENAME}-CUT${EXT}" style templates. */
export function applyTemplate(template: string, vars: TemplateVars): string {
  const out = String(template || "").replace(/\$\{([A-Z_]+)\}/g, (m, key: string) =>
    key in vars ? vars[key as TemplateVar] : m
  );
  const clean = sanitizeFilename(out);
  return clean || sanitizeFilename(`${vars.FILENAME}-CUT${vars.EXT}`);
}

/** Containers that can hold H.264/H.265 video + AAC audio from our encoders. */
export const SAFE_OUTPUT_EXTS = [".mp4", ".mkv", ".mov", ".m4v"];

/** Extension used for ${EXT}. "same" keeps the input's when it's safe, else .mp4. */
export function outputExt(inputExt: string, format: "same" | "mp4" | "mkv" = "same"): string {
  if (format === "mp4") return ".mp4";
  if (format === "mkv") return ".mkv";
  return SAFE_OUTPUT_EXTS.includes(inputExt.toLowerCase()) ? inputExt : ".mp4";
}

export function templateVars(
  inputPath: string, start: number, end: number, format: "same" | "mp4" | "mkv" = "same"
): TemplateVars {
  const { name, ext } = splitPath(inputPath);
  return { FILENAME: name, EXT: outputExt(ext, format), CUT_FROM: formatCutVar(start), CUT_TO: formatCutVar(end) };
}

/** Join a folder and file name using the folder's own separator. */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** Median of a list (0 for empty). */
export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// --- preview planning ------------------------------------------------------
// ffprobe codec name -> MIME string for HTMLMediaElement.canPlayType (MP4 container).
export const VIDEO_MIME: Record<string, string> = {
  h264: 'video/mp4; codecs="avc1.640028"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  vp9: 'video/mp4; codecs="vp09.00.10.08"',
  av1: 'video/mp4; codecs="av01.0.05M.08"',
};
export const AUDIO_MIME: Record<string, string> = {
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  mp3: 'audio/mp4; codecs="mp4a.69"',
  opus: 'audio/mp4; codecs="opus"',
  flac: 'audio/mp4; codecs="flac"',
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
};

export type PreviewPlan =
  | { kind: "direct" }
  | { kind: "preview"; mode: "remux" | "remux-aac" | "transcode" };

/**
 * Decide how to preview a file. `canPlay` is video.canPlayType wrapped to a boolean,
 * so this reflects what the user's webview can actually decode.
 */
export function planPreview(
  ext: string, videoCodec: string | null, audioCodec: string | null, canPlay: (mime: string) => boolean
): PreviewPlan {
  const e = ext.toLowerCase();
  const vOk = !videoCodec || (!!VIDEO_MIME[videoCodec] && canPlay(VIDEO_MIME[videoCodec]));
  const aOk = !audioCodec || (!!AUDIO_MIME[audioCodec] && canPlay(AUDIO_MIME[audioCodec]));
  if (e === ".webm" && ["vp8", "vp9", "av1", null].includes(videoCodec)) return { kind: "direct" };
  if ([".mp4", ".m4v", ".mov"].includes(e) && vOk && aOk) return { kind: "direct" };
  if (!vOk) return { kind: "preview", mode: "transcode" };
  return { kind: "preview", mode: aOk ? "remux" : "remux-aac" };
}

// --- size / bitrate math -------------------------------------------------
// "MB" here means MiB (1024*1024 bytes), which is what Windows Explorer shows.
const BYTES_PER_MB = 1024 * 1024;
const CONTAINER_OVERHEAD = 0.03; // reserve ~3% for muxing overhead

export interface SizeInput { duration: number; audioKbps: number; audioTracks: number }

/** Video kbps needed to hit a target size. */
export function bitrateForTargetSize(
  { targetMB, duration, audioKbps, audioTracks }: SizeInput & { targetMB: number }
): { videoKbps: number; ok: boolean } {
  if (!(duration > 0) || !(targetMB > 0)) return { videoKbps: 0, ok: false };
  const totalKbps = (targetMB * BYTES_PER_MB * 8 * (1 - CONTAINER_OVERHEAD)) / 1000 / duration;
  const videoKbps = Math.floor(totalKbps - audioKbps * audioTracks);
  return { videoKbps: Math.max(0, videoKbps), ok: videoKbps >= 50 };
}

/** Estimated output size in MB for a given bitrate setup. */
export function estimateSizeMB(
  { videoKbps, duration, audioKbps, audioTracks }: SizeInput & { videoKbps: number }
): number {
  const kbps = (videoKbps || 0) + audioKbps * audioTracks;
  return (kbps * 1000 * duration) / 8 / BYTES_PER_MB / (1 - CONTAINER_OVERHEAD);
}

export function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + " GB";
  if (b >= BYTES_PER_MB) return (b / BYTES_PER_MB).toFixed(1) + " MB";
  return Math.max(1, Math.round(b / 1024)) + " KB";
}
