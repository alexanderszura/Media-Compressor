//! Pure helpers that turn export options into FFmpeg argument lists.
//! Kept free of Tauri types so they can be unit-tested.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoOptions {
    /// libx264 | libx265 | h264_nvenc | hevc_nvenc | (any other ffmpeg encoder name)
    pub encoder: String,
    /// x264/x265 preset (ultrafast .. veryslow). Ignored by hardware encoders.
    pub preset: String,
    /// Final video bitrate in kbit/s (already computed from target size if needed).
    pub bitrate_kbps: u32,
    pub two_pass: bool,
    /// Scale output to this height (keeping aspect). None = original.
    pub scale_height: Option<u32>,
    /// True when the bitrate came from a target file size (tighter rate control).
    #[serde(default)]
    pub size_mode: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOptions {
    /// Audio-relative stream indexes (0 = first audio track) mixed into one "master" track.
    pub master: Vec<u32>,
    /// Audio-relative stream indexes kept as their own tracks.
    pub separate: Vec<u32>,
    pub bitrate_kbps: u32,
}

pub const PASSLOG: &str = "mc2pass";

pub fn supports_two_pass(encoder: &str) -> bool {
    matches!(encoder, "libx264" | "libx265")
}

/// Number of ffmpeg invocations needed.
pub fn pass_count(video: Option<&VideoOptions>) -> u8 {
    match video {
        Some(v) if v.two_pass && supports_two_pass(&v.encoder) => 2,
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
        match v.scale_height {
            Some(h) => {
                filters.push(format!("[0:v:0]scale=-2:{h}[vout]"));
                maps.push("[vout]".into());
            }
            None => maps.push("0:v:0".into()),
        }
    }

    if !first_pass {
        match audio.master.len() {
            0 => {}
            1 => {
                maps.push(format!("0:a:{}", audio.master[0]));
                audio_titles.push(format!("Track {}", audio.master[0] + 1));
            }
            n => {
                let ins: String = audio.master.iter().map(|i| format!("[0:a:{i}]")).collect();
                filters.push(format!(
                    "{ins}amix=inputs={n}:duration=longest:normalize=0[amaster]"
                ));
                maps.push("[amaster]".into());
                audio_titles.push(format!("Master (Tracks {})", track_list(&audio.master)));
            }
        }
        for s in &audio.separate {
            maps.push(format!("0:a:{s}"));
            audio_titles.push(format!("Track {}", s + 1));
        }
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
        a.push("-c:a".into());
        a.push("aac".into());
        a.push("-b:a".into());
        a.push(format!("{}k", audio.bitrate_kbps.max(32)));
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
    if is_mp4_family(&out_ext) {
        a.push("-movflags".into());
        a.push("+faststart".into());
    }
    a.push(output.into());
    a
}

/// Arguments for a low-res, seek-friendly H.264 preview used when the
/// webview can't play the original file (e.g. some MKV/HEVC/AVI files).
pub fn proxy_args(input: &str, output: &str) -> Vec<String> {
    [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-progress",
        "pipe:1",
        "-nostats",
        "-i",
        input,
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-vf",
        "scale=-2:'min(540,ih)'",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "28",
        "-g",
        "15",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ac",
        "2",
        "-sn",
        "-dn",
        "-movflags",
        "+faststart",
        output,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
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
            size_mode: false,
        }
    }

    fn joined(a: &[String]) -> String {
        a.join(" ")
    }

    #[test]
    fn master_mix_and_separate() {
        let au = AudioOptions { master: vec![0, 2], separate: vec![1], bitrate_kbps: 160 };
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
    fn two_pass_first_pass_has_no_audio() {
        let au = AudioOptions { master: vec![0], separate: vec![], bitrate_kbps: 128 };
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
        let au = AudioOptions { master: vec![], separate: vec![], bitrate_kbps: 128 };
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
        let au = AudioOptions { master: vec![0, 2], separate: vec![1], bitrate_kbps: 128 };
        let dur = 8.0;
        let audio_kbps = 128.0 * 2.0;
        let video_kbps = (1.0 * 1048576.0 * 8.0 * 0.97 / 1000.0 / dur - audio_kbps) as u32;
        let vo = VideoOptions { encoder: "libx264".into(), preset: "veryfast".into(),
            bitrate_kbps: video_kbps, two_pass: true, scale_height: Some(480), size_mode: true };
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

    #[test]
    fn scaling_goes_through_filter_complex() {
        let au = AudioOptions { master: vec![0], separate: vec![], bitrate_kbps: 128 };
        let mut vo = v("libx264", false);
        vo.scale_height = Some(720);
        let s = joined(&build_args("i.mp4", "o.mp4", 0.0, 1.0, Some(&vo), &au, None));
        assert!(s.contains("-filter_complex [0:v:0]scale=-2:720[vout] -map [vout] -map 0:a:0"));
    }
}
