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

export type Mode = "bitrate" | "size";
export type Encoder = "libx264" | "libx265" | "h264_nvenc" | "hevc_nvenc";
export type TrackRole = "master" | "separate" | "remove";

export interface Settings {
  filenameTemplate: string;
  ffmpegDir: string;
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
}

export interface Progress {
  pass: number;
  passes: number;
  fraction: number;
  speed: string;
}

export interface ExportRequest {
  input: string;
  output: string;
  start: number;
  end: number;
  ffmpegDir: string;
  video: {
    encoder: Encoder;
    preset: string;
    bitrateKbps: number;
    twoPass: boolean;
    scaleHeight: number | null;
    sizeMode: boolean;
  } | null;
  audio: { master: number[]; separate: number[]; bitrateKbps: number };
}

export interface ExportResult {
  output: string;
  sizeBytes: number;
}
