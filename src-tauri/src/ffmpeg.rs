//! Pure helpers that turn export options into FFmpeg argument lists.
//! Kept free of Tauri types so they can be unit-tested.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoOptions {
    /// libx264 | libx265 | h264_nvenc | hevc_nvenc | (any other ffmpeg encoder name),
    /// or "copy" to keep the original video stream untouched (trim only, no re-encode).
    pub encoder: String,
    /// x264/x265 preset (ultrafast .. veryslow). Ignored by hardware encoders.
    pub preset: String,
    /// Final video bitrate in kbit/s (already computed from target size if needed).
    pub bitrate_kbps: u32,
    pub two_pass: bool,
    /// Scale output to this height (keeping aspect). None = original.
    pub scale_height: Option<u32>,
    /// Resample to this frame rate. None = keep the source's. Ignored unless it is
    /// below `source_fps`: exports can lower the frame rate but never raise it.
    pub target_fps: Option<f64>,
    /// Frame rate of the input, as reported by ffprobe.
    pub source_fps: f64,
    /// True when the bitrate came from a target file size (tighter rate control).
    #[serde(default)]
    pub size_mode: bool,
    /// Codec of the source video stream (ffprobe name). Only used with "copy".
    #[serde(default)]
    pub source_codec: Option<String>,
}

impl VideoOptions {
    pub fn is_copy(&self) -> bool {
        self.encoder == "copy"
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOptions {
    /// Audio-relative stream indexes (0 = first audio track) mixed into one "master" track.
    pub master: Vec<u32>,
    /// Audio-relative stream indexes kept as their own tracks.
    pub separate: Vec<u32>,
    pub bitrate_kbps: u32,
    /// Names for the output tracks, in output order (master first, then separate).
    /// Empty / missing entries fall back to "Master (Tracks 1 + 3)" / "Track 2".
    #[serde(default)]
    pub titles: Vec<String>,
    /// Per output track (same order as `titles`): true = copy the source audio
    /// as-is instead of encoding AAC. Ignored for a mixed master track.
    #[serde(default)]
    pub copy: Vec<bool>,
}

/// Audio part of the graph: optional amix filter, -map targets and track titles.
pub fn audio_mapping(audio: &AudioOptions) -> (Option<String>, Vec<String>, Vec<String>) {
    let mut filter = None;
    let mut maps = Vec::new();
    let mut titles = Vec::new();
    match audio.master.len() {
        0 => {}
        1 => {
            maps.push(format!("0:a:{}", audio.master[0]));
            titles.push(format!("Track {}", audio.master[0] + 1));
        }
        n => {
            let ins: String = audio.master.iter().map(|i| format!("[0:a:{i}]")).collect();
            filter = Some(format!("{ins}amix=inputs={n}:duration=longest:normalize=0[amaster]"));
            maps.push("[amaster]".into());
            titles.push(format!("Master (Tracks {})", track_list(&audio.master)));
        }
    }
    for s in &audio.separate {
        maps.push(format!("0:a:{s}"));
        titles.push(format!("Track {}", s + 1));
    }
    for (i, t) in titles.iter_mut().enumerate() {
        if let Some(custom) = audio.titles.get(i).map(|c| c.trim()).filter(|c| !c.is_empty()) {
            *t = custom.to_string();
        }
    }
    (filter, maps, titles)
}

pub const PASSLOG: &str = "mc2pass";

pub fn supports_two_pass(encoder: &str) -> bool {
    matches!(encoder, "libx264" | "libx265")
}

/// Number of ffmpeg invocations needed.
pub fn pass_count(video: Option<&VideoOptions>) -> u8 {
    match video {
        Some(v) if v.two_pass && !v.is_copy() && supports_two_pass(&v.encoder) => 2,
        _ => 1,
    }
}

fn secs(t: f64) -> String {
    format!("{:.3}", t.max(0.0))
}

fn ext_of(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn is_mp4_family(ext: &str) -> bool {
    matches!(ext, "mp4" | "m4v" | "mov")
}

fn track_list(idx: &[u32]) -> String {
    idx.iter()
        .map(|i| (i + 1).to_string())
        .collect::<Vec<_>>()
        .join(" + ")
}

fn video_codec_args(v: &VideoOptions, pass: Option<u8>, out_ext: &str) -> Vec<String> {
    if v.is_copy() {
        let mut a: Vec<String> = vec!["-c:v".into(), "copy".into()];
        if v.source_codec.as_deref() == Some("hevc") && is_mp4_family(out_ext) {
            a.extend(["-tag:v".into(), "hvc1".into()]);
        }
        return a;
    }
    let b = v.bitrate_kbps.max(1);
    let mut a: Vec<String> = Vec::new();
    let mut push = |s: &str| a.push(s.to_string());
    match v.encoder.as_str() {
        "libx264" => {
            for s in ["-c:v", "libx264", "-preset", &v.preset, "-b:v", &format!("{b}k")] {
                push(s);
            }
            if let Some(p) = pass {
                for s in ["-pass", &p.to_string(), "-passlogfile", PASSLOG] {
                    push(s);
                }
            }
        }
        "libx265" => {
            for s in ["-c:v", "libx265", "-preset", &v.preset, "-b:v", &format!("{b}k")] {
                push(s);
            }
            // stats file is relative: ffmpeg runs with cwd = a temp dir, which avoids
            // escaping Windows drive-letter colons inside x265-params.
            let params = match pass {
                Some(p) => format!("log-level=error:pass={p}:stats={PASSLOG}.log"),
                None => "log-level=error".to_string(),
            };
            push("-x265-params");
            push(&params);
            if is_mp4_family(out_ext) {
                push("-tag:v");
                push("hvc1");
            }
        }
        "h264_nvenc" | "hevc_nvenc" => {
            let max = if v.size_mode { b } else { b * 3 / 2 };
            for s in [
                "-c:v",
                &v.encoder,
                "-preset",
                "p5",
                "-rc",
                "vbr",
                "-b:v",
                &format!("{b}k"),
                "-maxrate",
                &format!("{max}k"),
                "-bufsize",
                &format!("{}k", b * 2),
            ] {
                push(s);
            }
            if v.encoder == "hevc_nvenc" && is_mp4_family(out_ext) {
                push("-tag:v");
                push("hvc1");
            }
        }
        other => {
            for s in ["-c:v", other, "-b:v", &format!("{b}k")] {
                push(s);
            }
        }
    }
    a.push("-pix_fmt".into());
    a.push("yuv420p".into());
    if pass.is_some() {
        // The null muxer (pass 1) and mp4/mkv (pass 2) default to different
        // frame-rate modes, which can give different frame counts and makes
        // x264 abort pass 2 with "Incomplete MB-tree stats file". Force CFR in both.
        a.push("-fps_mode".into());
        a.push("cfr".into());
    }
    a
}

/// Most source frames blended into one output frame (tmix buffers them all in memory).
const MAX_BLEND_FRAMES: u32 = 32;

/// Filters that resample to the target frame rate, or None when it stays unchanged.
/// `tmix` averages the source frames covered by each output frame, so a whole-number
/// drop such as 60 -> 30 still blends instead of just discarding every other frame.
/// `framerate` then blends neighbours onto the new timing for ratios like 30 -> 24.
fn resample_filter(v: &VideoOptions) -> Option<String> {
    let target = v.target_fps.filter(|f| !v.is_copy() && *f > 0.0 && *f < v.source_fps)?;
    let blend = ((v.source_fps / target).round() as u32).min(MAX_BLEND_FRAMES);
    let framerate = format!("framerate=fps={target}");
    Some(if blend > 1 { format!("tmix=frames={blend},{framerate}") } else { framerate })
}

/// Build the argument list for one ffmpeg run.
/// `pass` = Some(1) / Some(2) for two-pass encoding, None for single pass.
pub fn build_args(
    input: &str,
    output: &str,
    start: f64,
    end: f64,
    video: Option<&VideoOptions>,
    audio: &AudioOptions,
    pass: Option<u8>,
) -> Vec<String> {
    let first_pass = pass == Some(1);
    let out_ext = ext_of(output);
    let mut a: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-progress",
        "pipe:1",
        "-nostats",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    // Input seeking (fast) – ffmpeg still decodes accurately to the exact frame
    // because we re-encode.
    if start > 0.0 {
        a.push("-ss".into());
        a.push(secs(start));
    }
    a.push("-t".into());
    a.push(secs(end - start));
    a.push("-i".into());
    a.push(input.into());

    let mut filters: Vec<String> = Vec::new();
    let mut maps: Vec<String> = Vec::new();
    let mut audio_titles: Vec<String> = Vec::new();

    if let Some(v) = video {
        // Scale first: blending the smaller frames is much cheaper.
        let chain: Vec<String> = v
            .scale_height
            .filter(|_| !v.is_copy())
            .map(|h| format!("scale=-2:{h}"))
            .into_iter()
            .chain(resample_filter(v))
            .collect();
        if chain.is_empty() {
            maps.push("0:v:0".into());
        } else {
            filters.push(format!("[0:v:0]{}[vout]", chain.join(",")));
            maps.push("[vout]".into());
        }
    }

    if !first_pass {
        let (f, m, t) = audio_mapping(audio);
        filters.extend(f);
        maps.extend(m);
        audio_titles = t;
    }

    if !filters.is_empty() {
        a.push("-filter_complex".into());
        a.push(filters.join(";"));
    }
    for m in maps {
        a.push("-map".into());
        a.push(m);
    }

    if let Some(v) = video {
        a.extend(video_codec_args(v, pass, &out_ext));
    }

    if first_pass {
        for s in ["-an", "-sn", "-dn", "-f", "null", "-"] {
            a.push(s.into());
        }
        return a;
    }

    if audio_titles.is_empty() {
        a.push("-an".into());
    } else {
        let abr = format!("{}k", audio.bitrate_kbps.max(32));
        let mixed = audio.master.len() > 1;
        let copies: Vec<bool> = (0..audio_titles.len())
            .map(|i| !(mixed && i == 0) && audio.copy.get(i).copied().unwrap_or(false))
            .collect();
        if copies.iter().any(|c| *c) {
            for (i, c) in copies.iter().enumerate() {
                a.push(format!("-c:a:{i}"));
                if *c {
                    a.push("copy".into());
                } else {
                    a.extend(["aac".into(), format!("-b:a:{i}"), abr.clone()]);
                }
            }
        } else {
            a.extend(["-c:a".into(), "aac".into(), "-b:a".into(), abr]);
        }
        for (i, t) in audio_titles.iter().enumerate() {
            a.push(format!("-metadata:s:a:{i}"));
            a.push(format!("title={t}"));
            // MP4 keeps track names in the handler name (this is where OBS puts them).
            a.push(format!("-metadata:s:a:{i}"));
            a.push(format!("handler_name={t}"));
            a.push(format!("-disposition:a:{i}"));
            a.push(if i == 0 { "default" } else { "0" }.into());
        }
    }

    for s in ["-sn", "-dn", "-map_metadata", "0", "-map_chapters", "-1"] {
        a.push(s.into());
    }
    if video.is_some_and(|v| v.is_copy()) || audio.copy.iter().any(|c| *c) {
        // Copied streams keep their source timestamps; shift them so the cut starts at 0.
        a.extend(["-avoid_negative_ts".into(), "make_zero".into()]);
    }
    if is_mp4_family(&out_ext) {
        a.push("-movflags".into());
        a.push("+faststart".into());
    }
    a.push(output.into());
    a
}

/// Quick render of just the cut for the "Preview" button: a small muted video
/// plus one .m4a per output audio track (so the player can switch / combine them).
/// One ffmpeg run, single decode.
pub fn cut_preview_args(
    input: &str,
    start: f64,
    end: f64,
    has_video: bool,
    audio: &AudioOptions,
    video_out: &str,
    audio_outs: &[String],
) -> Vec<String> {
    let mut a: Vec<String> = [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if start > 0.0 {
        a.extend(["-ss".into(), secs(start)]);
    }
    a.extend(["-t".into(), secs(end - start), "-i".into(), input.into()]);
    let (filter, maps, _) = audio_mapping(audio);
    if let Some(f) = filter {
        a.extend(["-filter_complex".into(), f]);
    }
    if has_video {
        for s in [
            "-map", "0:v:0", "-vf", "scale=-2:'min(720,ih)'", "-c:v", "libx264", "-preset", "ultrafast",
            "-crf", "24", "-g", "15", "-bf", "0", "-pix_fmt", "yuv420p", "-an", "-sn", "-dn",
            "-movflags", "+faststart", video_out,
        ] {
            a.push(s.into());
        }
    }
    for (m, out) in maps.iter().zip(audio_outs) {
        for s in ["-map", m, "-vn", "-sn", "-dn", "-c:a", "aac", "-b:a", "160k", "-ac", "2", out] {
            a.push(s.into());
        }
    }
    a
}

/// How to build the in-app preview for files the webview can't play directly.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewMode {
    /// Copy video + audio into MP4 (seconds, disk-bound). e.g. MKV with H.264/AAC.
    Remux,
    /// Copy video, convert first audio track to AAC (e.g. MKV with AC3/DTS/PCM).
    RemuxAac,
    /// Full low-res H.264 re-encode with a short keyframe interval
    /// (unsupported codecs, or a "fast-seek" copy of long-GOP footage).
    Transcode,
}

pub fn preview_args(input: &str, output: &str, mode: PreviewMode, hevc: bool) -> Vec<String> {
    let mut a: Vec<String> = [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-progress", "pipe:1", "-nostats",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if mode == PreviewMode::Transcode {
        // Use the GPU video decoder when there is one (falls back to CPU automatically).
        a.extend(["-hwaccel".to_string(), "auto".to_string()]);
    }
    a.extend(["-i", input, "-map", "0:v:0?", "-map", "0:a:0?"].iter().map(|s| s.to_string()));
    let mut push = |xs: &[&str]| a.extend(xs.iter().map(|s| s.to_string()));
    match mode {
        PreviewMode::Remux | PreviewMode::RemuxAac => {
            push(&["-c:v", "copy"]);
            if hevc {
                push(&["-tag:v", "hvc1"]);
            }
            if mode == PreviewMode::Remux {
                push(&["-c:a", "copy"]);
            } else {
                push(&["-c:a", "aac", "-b:a", "192k", "-ac", "2"]);
            }
        }
        PreviewMode::Transcode => push(&[
            "-vf", "scale=-2:'min(720,ih)'",
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "fastdecode",
            "-crf", "26", "-g", "10", "-bf", "0", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        ]),
    }
    push(&["-sn", "-dn", "-map_metadata", "-1", "-f", "mp4", output]);
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(enc: &str, two: bool) -> VideoOptions {
        VideoOptions {
            encoder: enc.into(),
            preset: "medium".into(),
            bitrate_kbps: 2500,
            two_pass: two,
            scale_height: None,
            target_fps: None,
            source_fps: 60.0,
            size_mode: false,
            source_codec: None,
        }
    }

    fn joined(a: &[String]) -> String {
        a.join(" ")
    }

    #[test]
    fn master_mix_and_separate() {
        let au = AudioOptions { master: vec![0, 2], separate: vec![1], bitrate_kbps: 160, titles: vec![], copy: vec![] };
        let a = build_args("in.mkv", "out.mp4", 5.0, 20.5, Some(&v("libx264", false)), &au, None);
        let s = joined(&a);
        assert!(s.contains("-ss 5.000 -t 15.500 -i in.mkv"));
        assert!(s.contains("[0:a:0][0:a:2]amix=inputs=2:duration=longest:normalize=0[amaster]"));
        assert!(s.contains("-map 0:v:0 -map [amaster] -map 0:a:1"));
        assert!(s.contains("title=Master (Tracks 1 + 3)"));
        assert!(s.contains("title=Track 2"));
        assert!(s.contains("-movflags +faststart"));
        assert_eq!(a.last().unwrap(), "out.mp4");
    }

    #[test]
    fn custom_track_titles() {
        let au = AudioOptions { master: vec![0, 2], separate: vec![1], bitrate_kbps: 160,
            titles: vec!["Game + Mic".into(), "".into()], copy: vec![] };
        let s = joined(&build_args("in.mkv", "out.mkv", 0.0, 5.0, None, &au, None));
        assert!(s.contains("title=Game + Mic") && s.contains("title=Track 2"));
    }

    #[test]
    fn real_cut_preview() {
        use std::process::Command;
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join("mc-cutprev");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("s.mkv");
        assert!(Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6",
            "-f", "lavfi", "-i", "sine=f=300:d=6", "-f", "lavfi", "-i", "sine=f=500:d=6", "-f", "lavfi", "-i", "sine=f=700:d=6",
            "-map", "0", "-map", "1", "-map", "2", "-map", "3", "-c:v", "libx264", "-c:a", "aac"]).arg(&src).status().unwrap().success());
        let au = AudioOptions { master: vec![0, 2], separate: vec![1], bitrate_kbps: 128, titles: vec![], copy: vec![] };
        let v = dir.join("v.mp4").to_string_lossy().into_owned();
        let outs = vec![dir.join("a0.m4a").to_string_lossy().into_owned(), dir.join("a1.m4a").to_string_lossy().into_owned()];
        let args = cut_preview_args(src.to_str().unwrap(), 1.0, 4.0, true, &au, &v, &outs);
        let o = Command::new("ffmpeg").args(&args).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        for f in std::iter::once(&v).chain(outs.iter()) {
            let p = Command::new("ffprobe").args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"]).arg(f).output().unwrap();
            let d: f64 = String::from_utf8_lossy(&p.stdout).trim().parse().unwrap();
            assert!((d - 3.0).abs() < 0.15, "{f}: {d}");
        }
    }

    #[test]
    fn two_pass_first_pass_has_no_audio() {
        let au = AudioOptions { master: vec![0], separate: vec![], bitrate_kbps: 128, titles: vec![], copy: vec![] };
        let vo = v("libx264", true);
        assert_eq!(pass_count(Some(&vo)), 2);
        let p1 = joined(&build_args("in.mp4", "o.mp4", 0.0, 10.0, Some(&vo), &au, Some(1)));
        assert!(p1.contains("-pass 1"));
        assert!(p1.ends_with("-an -sn -dn -f null -"));
        assert!(!p1.contains("0:a:0"));
        assert!(!p1.contains("-ss"));
        let p2 = joined(&build_args("in.mp4", "o.mp4", 0.0, 10.0, Some(&vo), &au, Some(2)));
        assert!(p2.contains("-pass 2") && p2.contains("-map 0:a:0"));
    }

    #[test]
    fn x265_and_nvenc() {
        let au = AudioOptions { master: vec![], separate: vec![], bitrate_kbps: 128, titles: vec![], copy: vec![] };
        let s = joined(&build_args("i.mp4", "o.mkv", 0.0, 1.0, Some(&v("libx265", true)), &au, Some(2)));
        assert!(s.contains("pass=2:stats=mc2pass.log"));
        assert!(!s.contains("hvc1"));
        assert!(s.contains("-an"));
        assert_eq!(pass_count(Some(&v("h264_nvenc", true))), 1);
        let n = joined(&build_args("i.mp4", "o.mp4", 0.0, 1.0, Some(&v("hevc_nvenc", false)), &au, None));
        assert!(n.contains("-maxrate 3750k") && n.contains("hvc1"));
    }

    /// Runs real ffmpeg when available: 3 audio tracks, master = 1+3, keep 2,
    /// two-pass x264 aiming for 1 MB.
    #[test]
    fn real_ffmpeg_end_to_end() {
        use std::process::Command;
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            eprintln!("ffmpeg not installed, skipping");
            return;
        }
        let dir = std::env::temp_dir().join("mc-e2e");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.mkv");
        let ok = Command::new("ffmpeg")
            .args(["-v", "error", "-y",
                "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=12",
                "-f", "lavfi", "-i", "sine=f=440:d=12",
                "-f", "lavfi", "-i", "sine=f=660:d=12",
                "-f", "lavfi", "-i", "sine=f=880:d=12",
                "-map", "0", "-map", "1", "-map", "2", "-map", "3",
                "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"])
            .arg(&src)
            .status().unwrap().success();
        assert!(ok);
        let out = dir.join("src-CUT.mp4");
        let (input, output) = (src.to_str().unwrap(), out.to_str().unwrap());
        let au = AudioOptions { master: vec![0, 2], separate: vec![1], bitrate_kbps: 128, titles: vec![], copy: vec![] };
        let dur = 8.0;
        let audio_kbps = 128.0 * 2.0;
        let video_kbps = (1.0 * 1048576.0 * 8.0 * 0.97 / 1000.0 / dur - audio_kbps) as u32;
        let vo = VideoOptions { encoder: "libx264".into(), preset: "veryfast".into(),
            bitrate_kbps: video_kbps, two_pass: true, scale_height: Some(480),
            target_fps: None, source_fps: 30.0, size_mode: true, source_codec: None };
        for p in 1..=2u8 {
            let args = build_args(input, output, 2.0, 10.0, Some(&vo), &au, Some(p));
            let o = Command::new("ffmpeg").args(&args).current_dir(&dir).output().unwrap();
            assert!(o.status.success(), "pass {p}: {}", String::from_utf8_lossy(&o.stderr));
            assert!(String::from_utf8_lossy(&o.stdout).contains("progress=end"));
        }
        let probe = Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "stream=codec_type,height:stream_tags=title,handler_name:format=duration,size", "-of", "compact"])
            .arg(&out).output().unwrap();
        let text = String::from_utf8_lossy(&probe.stdout);
        eprintln!("{text}");
        assert_eq!(text.matches("codec_type=audio").count(), 2);
        assert!(text.contains("Master (Tracks 1 + 3)") && text.contains("Track 2"));
        assert!(text.contains("height=480"));
        let size = std::fs::metadata(&out).unwrap().len() as f64 / 1048576.0;
        eprintln!("size = {size:.3} MB");
        assert!(size < 1.05 && size > 0.5, "size {size}");
    }


    /// Preview modes against real files: MKV+AC3 (remux-aac), MOV+PCM, AVI/MPEG-4 (transcode).
    #[test]
    fn real_preview_modes() {
        use std::process::Command;
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join("mc-preview");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let make = |name: &str, extra: &[&str]| {
            let p = dir.join(name);
            let mut c = Command::new("ffmpeg");
            c.args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4",
                "-f", "lavfi", "-i", "sine=d=4", "-map", "0", "-map", "1"]).args(extra).arg(&p);
            assert!(c.status().unwrap().success(), "{name}");
            p
        };
        let cases = [
            (make("a.mkv", &["-c:v", "libx264", "-c:a", "aac"]), PreviewMode::Remux),
            (make("b.mkv", &["-c:v", "libx264", "-c:a", "ac3"]), PreviewMode::RemuxAac),
            (make("c.mov", &["-c:v", "libx264", "-c:a", "pcm_s16le"]), PreviewMode::RemuxAac),
            (make("d.avi", &["-c:v", "mpeg4", "-c:a", "mp3"]), PreviewMode::Transcode),
        ];
        for (src, mode) in cases {
            let out = src.with_extension("preview.mp4");
            let args = preview_args(src.to_str().unwrap(), out.to_str().unwrap(), mode, false);
            let o = Command::new("ffmpeg").args(&args).output().unwrap();
            assert!(o.status.success(), "{src:?} {mode:?}: {}", String::from_utf8_lossy(&o.stderr));
            let p = Command::new("ffprobe").args(["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0"])
                .arg(&out).output().unwrap();
            let codecs = String::from_utf8_lossy(&p.stdout).replace("\r\n", "\n").replace('\n', ",");
            eprintln!("{mode:?} {:?} -> {codecs}", src.file_name().unwrap());
            assert!(codecs.starts_with("h264,") && codecs.contains("aac"), "{codecs}");
        }
    }

    #[test]
    fn trim_only_copies_streams() {
        let au = AudioOptions { master: vec![0, 2], separate: vec![1], bitrate_kbps: 160, titles: vec![],
            copy: vec![true, true] };
        let mut vo = v("copy", true);
        vo.scale_height = Some(720);
        vo.target_fps = Some(30.0);
        vo.source_codec = Some("hevc".into());
        assert_eq!(pass_count(Some(&vo)), 1);
        let s = joined(&build_args("in.mkv", "out.mp4", 3.0, 9.0, Some(&vo), &au, None));
        assert!(s.contains("-map 0:v:0 -map [amaster] -map 0:a:1"), "{s}");
        assert!(s.contains("-c:v copy -tag:v hvc1"), "{s}");
        assert!(!s.contains("scale=") && !s.contains("framerate=") && !s.contains("-pix_fmt"), "{s}");
        // A mixed master has to be encoded even when copying was requested.
        assert!(s.contains("-c:a:0 aac -b:a:0 160k -c:a:1 copy"), "{s}");
        assert!(s.contains("-avoid_negative_ts make_zero"), "{s}");
    }

    /// Trim-only against real ffmpeg: output keeps the source codecs and roughly the cut length.
    #[test]
    fn real_trim_only() {
        use std::process::Command;
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join("mc-trim");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("s.mkv");
        assert!(Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=10",
            "-f", "lavfi", "-i", "sine=f=300:d=10", "-f", "lavfi", "-i", "sine=f=500:d=10",
            "-map", "0", "-map", "1", "-map", "2", "-c:v", "libx264", "-g", "30", "-c:a", "ac3"]).arg(&src).status().unwrap().success());
        let out = dir.join("o.mkv");
        let au = AudioOptions { master: vec![0], separate: vec![1], bitrate_kbps: 128, titles: vec![], copy: vec![true, true] };
        let mut vo = v("copy", false);
        vo.source_codec = Some("h264".into());
        let args = build_args(src.to_str().unwrap(), out.to_str().unwrap(), 2.0, 7.0, Some(&vo), &au, None);
        let o = Command::new("ffmpeg").args(&args).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        let p = Command::new("ffprobe").args(["-v", "error", "-show_entries", "stream=codec_name:format=duration", "-of", "csv=p=0"])
            .arg(&out).output().unwrap();
        let text = String::from_utf8_lossy(&p.stdout).into_owned();
        let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        assert_eq!(lines[..3], ["h264", "ac3", "ac3"], "{text}");
        let d: f64 = lines[3].parse().unwrap();
        // Copying can't start mid-GOP, so the cut may begin up to one GOP (1 s here) early.
        assert!(d > 4.9 && d < 6.3, "{d}");
    }

    /// Trim-only with a lower frame rate re-encodes video and audio, and the cut stays
    /// frame-accurate with both streams starting together.
    #[test]
    fn real_trim_only_with_lower_fps() {
        use std::process::Command;
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join("mc-trim-fps");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("s.mkv");
        assert!(Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=60:duration=8",
            "-f", "lavfi", "-i", "sine=f=300:d=8", "-c:v", "libx264", "-g", "120", "-c:a", "ac3"]).arg(&src).status().unwrap().success());
        let out = dir.join("o.mkv");
        let au = AudioOptions { master: vec![0], separate: vec![], bitrate_kbps: 128, titles: vec![], copy: vec![] };
        let mut vo = v("libx264", false);
        vo.target_fps = Some(30.0);
        let args = build_args(src.to_str().unwrap(), out.to_str().unwrap(), 2.5, 6.5, Some(&vo), &au, None);
        let o = Command::new("ffmpeg").args(&args).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        let p = Command::new("ffprobe").args(["-v", "error", "-show_entries", "stream=codec_name,r_frame_rate,start_time:format=duration", "-of", "csv=p=0"])
            .arg(&out).output().unwrap();
        let text = String::from_utf8_lossy(&p.stdout).into_owned();
        eprintln!("{text}");
        let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        assert!(lines[0].starts_with("h264,30/1,") && lines[1].starts_with("aac,"), "{text}");
        // Unlike a pure copy the cut is frame-accurate, despite the 2 s keyframe interval.
        let d: f64 = lines[2].parse().unwrap();
        assert!((d - 4.0).abs() < 0.15, "{d}");
        for l in &lines[..2] {
            let start: f64 = l.rsplit(',').next().unwrap().parse().unwrap();
            assert!(start.abs() < 0.1, "{l}");
        }
    }

    #[test]
    fn scaling_goes_through_filter_complex() {
        let au = AudioOptions { master: vec![0], separate: vec![], bitrate_kbps: 128, titles: vec![], copy: vec![] };
        let mut vo = v("libx264", false);
        vo.scale_height = Some(720);
        let s = joined(&build_args("i.mp4", "o.mp4", 0.0, 1.0, Some(&vo), &au, None));
        assert!(s.contains("-filter_complex [0:v:0]scale=-2:720[vout] -map [vout] -map 0:a:0"));
    }

    #[test]
    fn resample_filter_chain() {
        let at = |source: f64, target: f64| {
            let mut vo = v("libx264", false);
            vo.source_fps = source;
            vo.target_fps = Some(target);
            resample_filter(&vo)
        };
        assert_eq!(at(60.0, 30.0).unwrap(), "tmix=frames=2,framerate=fps=30");
        assert_eq!(at(60.0, 24.0).unwrap(), "tmix=frames=3,framerate=fps=24");
        assert_eq!(at(30.0, 24.0).unwrap(), "framerate=fps=24");
        assert_eq!(at(30.0, 29.97).unwrap(), "framerate=fps=29.97");
        assert_eq!(at(1000.0, 10.0).unwrap(), "tmix=frames=32,framerate=fps=10");
        assert_eq!(at(60.0, 60.0), None);
        assert_eq!(at(30.0, 60.0), None, "the frame rate can never be raised");
        assert_eq!(resample_filter(&v("libx264", false)), None);
    }

    #[test]
    fn resampling_runs_after_scaling_in_both_passes() {
        let au = AudioOptions { master: vec![0], separate: vec![], bitrate_kbps: 128, titles: vec![], copy: vec![] };
        let mut vo = v("libx264", true);
        vo.scale_height = Some(720);
        vo.target_fps = Some(30.0);
        for p in 1..=2 {
            let s = joined(&build_args("i.mp4", "o.mp4", 0.0, 1.0, Some(&vo), &au, Some(p)));
            assert!(s.contains("[0:v:0]scale=-2:720,tmix=frames=2,framerate=fps=30[vout] -map [vout]"), "{s}");
        }
    }

    /// Alternating black/white frames at 60 fps: resampling to 30 has to give mid-grey,
    /// where dropping frames would leave pure black or white. Checks the timing too.
    #[test]
    fn real_resample_blends_frames() {
        use std::process::Command;
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join("mc-resample");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("s.mkv");
        assert!(Command::new("ffmpeg").args(["-v", "error", "-y",
            "-f", "lavfi", "-i", "color=c=black:s=64x64:r=60:d=4,format=gray,geq=lum='if(mod(N,2),235,16)',format=yuv420p",
            "-f", "lavfi", "-i", "sine=d=4", "-c:v", "libx264", "-crf", "0", "-preset", "ultrafast", "-c:a", "aac"])
            .arg(&src).status().unwrap().success());
        let au = AudioOptions { master: vec![0], separate: vec![], bitrate_kbps: 128, titles: vec![], copy: vec![] };
        for (target, passes) in [(30.0, 2u8), (24.0, 1), (25.0, 1), (40.0, 1), (29.97, 1)] {
            let out = dir.join(format!("o{target}.mp4"));
            let mut vo = v("libx264", passes == 2);
            vo.bitrate_kbps = 4000;
            vo.target_fps = Some(target);
            for p in 1..=passes {
                let pass = (passes == 2).then_some(p);
                let args = build_args(src.to_str().unwrap(), out.to_str().unwrap(), 0.5, 3.5, Some(&vo), &au, pass);
                let o = Command::new("ffmpeg").args(&args).current_dir(&dir).output().unwrap();
                assert!(o.status.success(), "{target}: {}", String::from_utf8_lossy(&o.stderr));
            }
            let p = Command::new("ffprobe").args(["-v", "error", "-select_streams", "v:0", "-count_frames",
                "-show_entries", "stream=r_frame_rate,nb_read_frames", "-of", "csv=p=0"]).arg(&out).output().unwrap();
            let info = String::from_utf8_lossy(&p.stdout).trim().to_string();
            eprintln!("{target} fps -> {info}");
            let (rate, count) = info.split_once(',').unwrap();
            let (num, den) = rate.split_once('/').unwrap();
            let rate = num.parse::<f64>().unwrap() / den.parse::<f64>().unwrap();
            assert!((rate - target).abs() < 0.001, "{target}: {rate}");
            let frames: f64 = count.trim_end_matches(',').parse().unwrap();
            assert!((frames - 3.0 * target).abs() <= 2.0, "{target}: {frames} frames");

            let raw = Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&out)
                .args(["-f", "rawvideo", "-pix_fmt", "gray", "-"]).output().unwrap().stdout;
            let means: Vec<f64> = raw.chunks_exact(64 * 64)
                .map(|f| f.iter().map(|&b| b as f64).sum::<f64>() / f.len() as f64).collect();
            let mid = &means[3..means.len() - 3];
            eprintln!("{target} fps luma {:.0?}", &mid[..6.min(mid.len())]);
            assert!(mid.iter().all(|m| (60.0..190.0).contains(m)), "{target}: unblended frames {mid:?}");
        }
    }
}
