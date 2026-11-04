// Shapes shared between the UI and the Rust commands in src-tauri/src/lib.rs.

export interface ProbeStream {
  index: number;
  codec_type: "video" | "audio" | "subtitle" | "data" | "attachment";
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  channels?: number;
  channel_layout?: string;
  bit_rate?: string;
  duration?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
}

export interface ProbeResult {
  streams: ProbeStream[];
  format: { duration?: string; bit_rate?: string; size?: string; format_name?: string };
}

/** "copy" = trim only: keep the original video stream, no re-encode. */
export type Mode = "bitrate" | "size" | "copy";
export type Encoder = "libx264" | "libx265" | "h264_nvenc" | "hevc_nvenc";
export type TrackRole = "master" | "separate" | "remove";

export type OutputLocation = "source" | "folder";
export type OutputFormat = "same" | "mp4" | "mkv";
export type PreviewMode = "remux" | "remux-aac" | "transcode";

export interface Settings {
  filenameTemplate: string;
  ffmpegDir: string;
  /** Save next to the input file, or always into outputFolder. */
  outputLocation: OutputLocation;
  outputFolder: string;
  /** Container for ${EXT}: keep the input's (MP4 if it can't hold H.264/AAC), or force one. */
  outputFormat: OutputFormat;
  /** Build a frequent-keyframe preview in the background when seeking is slow. */
  fastSeek: boolean;
  /** Default name for the mixed Master track ("" = "Master (Tracks 1 + 3)"). */
  masterTrackName: string;
  /** Default names by source track number (index 0 = track 1). "" = keep the file's own name. */
  trackNames: string[];
  /** Check GitHub Releases for a new version on startup. */
  autoUpdateCheck: boolean;
  /** Version the user chose "Skip this version" for. */
  skippedVersion: string;
  mode: Mode;
  videoBitrate: number;
  targetSizeMB: number;
  audioBitrate: number;
  encoder: Encoder;
  preset: string;
  twoPass: boolean;
}

export interface AudioTrack {
  index: number; // audio-relative (0 = first audio stream)
  title: string;
  lang: string;
  codec: string;
  channels: number;
  layout: string;
  bitrate: number; // kbps, 0 if unknown
  role: TrackRole;
  /** Name written to the output when this track is kept separately. */
  outName: string;
}

export interface Progress {
  pass: number;
  passes: number;
  fraction: number;
  speed: string;
}

export interface AudioRequest {
  master: number[];
  separate: number[];
  bitrateKbps: number;
  /** Output track names in output order (master first). */
  titles: string[];
  /** Per output track: copy the source audio instead of encoding AAC (ignored for a mixed master). */
  copy?: boolean[];
}

export interface CutPreviewResult {
  videoUrl: string | null;
  audioUrls: string[];
}

export interface ExportRequest {
  input: string;
  output: string;
  start: number;
  end: number;
  ffmpegDir: string;
  video: {
    /** "copy" keeps the source video stream as-is. */
    encoder: Encoder | "copy";
    preset: string;
    bitrateKbps: number;
    twoPass: boolean;
    scaleHeight: number | null;
    sizeMode: boolean;
    sourceCodec?: string | null;
  } | null;
  audio: AudioRequest;
}

export interface FfmpegStatus {
  ok: boolean;
  path: string;
  source: "settings" | "managed" | "bundled" | "path" | "";
  version: string;
  major: number | null;
  canAutoInstall: boolean;
  error: string;
}

export interface InstallProgress {
  stage: "download" | "verify" | "extract";
  done: number;
  total: number;
}

export interface ExportResult {
  output: string;
  sizeBytes: number;
}
