mod ffmpeg;
mod installer;
mod media_server;

use ffmpeg::{AudioOptions, PreviewMode, VideoOptions};
use media_server::MediaServer;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

// ---------------------------------------------------------------------------
// Job bookkeeping (so a running ffmpeg can be cancelled)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct JobSlot {
    child: Option<Child>,
    cancelled: bool,
}

#[derive(Default)]
struct Jobs {
    export: Arc<Mutex<JobSlot>>,
    /// Preview needed before the file can play at all (remux / transcode).
    preview: Arc<Mutex<JobSlot>>,
    /// Optional background "fast-seek" copy for long-GOP footage.
    fastseek: Arc<Mutex<JobSlot>>,
    /// "Preview" button on the export screen.
    cutpreview: Arc<Mutex<JobSlot>>,
}

impl Jobs {
    fn slot(&self, kind: &str) -> Arc<Mutex<JobSlot>> {
        match kind {
            "preview" | "proxy" => self.preview.clone(),
            "fastseek" => self.fastseek.clone(),
            "cutpreview" => self.cutpreview.clone(),
            _ => self.export.clone(),
        }
    }
}

#[derive(Default)]
struct InstallState {
    cancel: AtomicBool,
    running: AtomicBool,
}

/// Folder where the app keeps its own FFmpeg download.
static MANAGED_DIR: OnceLock<PathBuf> = OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    pass: u8,
    passes: u8,
    fraction: f64,
    speed: String,
}

// ---------------------------------------------------------------------------
// Locating ffmpeg / ffprobe
// ---------------------------------------------------------------------------

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Resolve a tool. Order: folder from Settings -> FFmpeg the app downloaded
/// -> next to this app's exe -> PATH.
fn tool_path(dir: &str, name: &str) -> PathBuf {
    tool_path_with_source(dir, name).0
}

fn tool_path_with_source(dir: &str, name: &str) -> (PathBuf, &'static str) {
    let exe = exe_name(name);
    let d = dir.trim().trim_matches('"');
    if !d.is_empty() {
        let p = Path::new(d);
        // Allow the user to paste the path to ffmpeg.exe itself.
        if p.is_file() {
            return (p.with_file_name(&exe), "settings");
        }
        return (p.join(&exe), "settings");
    }
    if let Some(m) = MANAGED_DIR.get() {
        let c = m.join(&exe);
        if c.is_file() {
            return (c, "managed");
        }
    }
    if let Ok(cur) = std::env::current_exe() {
        if let Some(parent) = cur.parent() {
            let c = parent.join(&exe);
            if c.is_file() {
                return (c, "bundled");
            }
        }
    }
    (PathBuf::from(exe), "path")
}

fn command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

fn not_found_msg(program: &Path, e: std::io::Error) -> String {
    format!(
        "Could not start {} ({e}). Install FFmpeg (e.g. `winget install Gyan.FFmpeg`) or set its folder in Settings.",
        program.display()
    )
}

fn tail(s: &str, lines: usize) -> String {
    let v: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    v[v.len().saturating_sub(lines)..].join("\n")
}

/// Run ffmpeg, streaming `-progress` output as events. Blocks until done.
#[allow(clippy::too_many_arguments)]
fn run_ffmpeg(
    app: &AppHandle,
    slot: &Arc<Mutex<JobSlot>>,
    program: &Path,
    args: &[String],
    cwd: &Path,
    duration: f64,
    event: &str,
    pass: u8,
    passes: u8,
) -> Result<(), String> {
    let mut child = command(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| not_found_msg(program, e))?;

    let stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    {
        let mut s = slot.lock().unwrap();
        if s.cancelled {
            let _ = child.kill();
        }
        s.child = Some(child);
    }

    // Some FFmpeg builds (seen with 6.1) log a fatal encoder/filter error and then
    // hang instead of exiting. Watchdog: if anything was written to stderr (we run
    // with -loglevel error) and progress then stalls, kill the process.
    let watch = Arc::new(Mutex::new((Instant::now(), false, false))); // (last progress, saw error, finished)
    let w_err = watch.clone();
    let err_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        let mut reader = BufReader::new(&mut stderr);
        let mut line = String::new();
        while reader.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
            if !line.trim().is_empty() {
                w_err.lock().unwrap().1 = true;
            }
            buf.push_str(&line);
            line.clear();
        }
        let _ = reader.read_to_string(&mut buf);
        buf
    });
    let w_dog = watch.clone();
    let dog_slot = slot.clone();
    let hung = Arc::new(Mutex::new(false));
    let hung_flag = hung.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let (last, saw_err, finished) = *w_dog.lock().unwrap();
        if finished {
            break;
        }
        if saw_err && last.elapsed() > Duration::from_secs(15) {
            *hung_flag.lock().unwrap() = true;
            if let Some(c) = dog_slot.lock().unwrap().child.as_mut() {
                let _ = c.kill();
            }
            break;
        }
    });

    let mut out_us: f64 = 0.0;
    let mut speed = String::new();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        watch.lock().unwrap().0 = Instant::now();
        let line = line.trim();
        if let Some(v) = line.strip_prefix("out_time_us=") {
            if let Ok(n) = v.parse::<f64>() {
                out_us = n;
            }
        } else if let Some(v) = line.strip_prefix("speed=") {
            speed = v.trim().to_string();
        } else if let Some(state) = line.strip_prefix("progress=") {
            let fraction = if state == "end" {
                1.0
            } else if duration > 0.0 {
                (out_us / 1_000_000.0 / duration).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let _ = app.emit(
                event,
                Progress { pass, passes, fraction, speed: speed.clone() },
            );
        }
    }

    let child = slot.lock().unwrap().child.take();
    let status = match child {
        Some(mut c) => c.wait().map_err(|e| e.to_string())?,
        None => return Err("FFmpeg process was lost".into()),
    };
    watch.lock().unwrap().2 = true;
    let stderr_text = err_thread.join().unwrap_or_default();

    if slot.lock().unwrap().cancelled {
        return Err("Cancelled".into());
    }
    if !status.success() || *hung.lock().unwrap() {
        let t = tail(&stderr_text, 12);
        return Err(if t.is_empty() {
            format!("FFmpeg exited with {status}")
        } else {
            t
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "mov", "m4v", "webm", "avi", "wmv", "asf", "flv", "f4v", "ts", "mts", "m2ts",
    "m2t", "mpg", "mpeg", "m2v", "vob", "mod", "tod", "3gp", "3g2", "ogv", "divx", "xvid", "dv",
    "mxf", "rm", "rmvb", "nut", "y4m", "hevc", "h264", "264", "265", "ivf", "gif",
];

#[tauri::command]
async fn pick_file(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Open video")
        .add_filter("Video files", VIDEO_EXTS)
        .add_filter("All files", &["*"])
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn check_ffmpeg(ffmpeg_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut found = Vec::new();
        for name in ["ffmpeg", "ffprobe"] {
            let p = tool_path(&ffmpeg_dir, name);
            let out = command(&p)
                .arg("-version")
                .output()
                .map_err(|e| not_found_msg(&p, e))?;
            let first = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .to_string();
            found.push(first);
        }
        Ok(found.join("\n"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn probe(path: String, ffmpeg_dir: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = tool_path(&ffmpeg_dir, "ffprobe");
        let out = command(&p)
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
            ])
            .arg(&path)
            .output()
            .map_err(|e| not_found_msg(&p, e))?;
        if !out.status.success() {
            return Err(format!(
                "ffprobe could not read this file:\n{}",
                tail(&String::from_utf8_lossy(&out.stderr), 6)
            ));
        }
        serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportRequest {
    input: String,
    output: String,
    start: f64,
    end: f64,
    ffmpeg_dir: String,
    video: Option<VideoOptions>,
    audio: AudioOptions,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    output: String,
    size_bytes: u64,
}

fn same_path(a: &str, b: &str) -> bool {
    let ca = std::fs::canonicalize(a).unwrap_or_else(|_| PathBuf::from(a));
    let cb = std::fs::canonicalize(b).unwrap_or_else(|_| PathBuf::from(b));
    if cfg!(windows) {
        ca.to_string_lossy().to_lowercase() == cb.to_string_lossy().to_lowercase()
    } else {
        ca == cb
    }
}

#[tauri::command]
async fn export_video(
    app: AppHandle,
    jobs: State<'_, Jobs>,
    req: ExportRequest,
) -> Result<ExportResult, String> {
    if req.end <= req.start {
        return Err("The cut end must be after the cut start.".into());
    }
    if same_path(&req.input, &req.output) {
        return Err("The output file name is the same as the input. Pick a different name.".into());
    }
    let slot = jobs.slot("export");
    {
        let mut s = slot.lock().unwrap();
        if s.child.is_some() {
            return Err("An export is already running.".into());
        }
        s.cancelled = false;
    }

    tauri::async_runtime::spawn_blocking(move || {
        let program = tool_path(&req.ffmpeg_dir, "ffmpeg");
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let work = std::env::temp_dir().join(format!("media-compressor-{stamp}"));
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;

        let duration = req.end - req.start;
        let passes = ffmpeg::pass_count(req.video.as_ref());
        let mut result = Ok(());
        for p in 1..=passes {
            let pass = if passes == 2 { Some(p) } else { None };
            let args = ffmpeg::build_args(
                &req.input,
                &req.output,
                req.start,
                req.end,
                req.video.as_ref(),
                &req.audio,
                pass,
            );
            result = run_ffmpeg(
                &app, &slot, &program, &args, &work, duration, "export-progress", p, passes,
            );
            if result.is_err() {
                break;
            }
        }
        let _ = std::fs::remove_dir_all(&work);

        match result {
            Ok(()) => {
                let size_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
                Ok(ExportResult { output: req.output, size_bytes })
            }
            Err(e) => {
                let _ = std::fs::remove_file(&req.output);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn previews_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("previews"))
}

#[derive(Serialize)]
struct PreviewResult {
    url: String,
    path: String,
}

/// Build a playable preview copy. `kind` is "preview" (needed to play at all)
/// or "fastseek" (optional background copy with frequent keyframes).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn make_preview(
    app: AppHandle,
    jobs: State<'_, Jobs>,
    server: State<'_, Arc<MediaServer>>,
    path: String,
    mode: PreviewMode,
    hevc: bool,
    kind: String,
    ffmpeg_dir: String,
    duration: f64,
) -> Result<PreviewResult, String> {
    let slot = jobs.slot(&kind);
    {
        let mut s = slot.lock().unwrap();
        if let Some(c) = s.child.as_mut() {
            let _ = c.kill();
        }
        s.cancelled = false;
    }
    let dir = previews_dir(&app)?;
    let server = server.inner().clone();
    let event = format!("{kind}-progress");
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let out = dir.join(format!("{kind}-{stamp}.mp4"));
        let out_s = out.to_string_lossy().into_owned();
        let program = tool_path(&ffmpeg_dir, "ffmpeg");
        let args = ffmpeg::preview_args(&path, &out_s, mode, hevc);
        if let Err(e) = run_ffmpeg(&app, &slot, &program, &args, &dir, duration, &event, 1, 1) {
            let _ = std::fs::remove_file(&out);
            return Err(e);
        }
        Ok(PreviewResult { url: server.url_for(&out), path: out_s })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CutPreviewRequest {
    input: String,
    start: f64,
    end: f64,
    has_video: bool,
    ffmpeg_dir: String,
    audio: AudioOptions,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CutPreviewResult {
    video_url: Option<String>,
    /// One URL per output audio track, in output order.
    audio_urls: Vec<String>,
}

/// Render just the cut (low-res video + each output audio track as its own file)
/// so the user can hear the Master mix / kept tracks before exporting.
#[tauri::command]
async fn render_cut_preview(
    app: AppHandle,
    jobs: State<'_, Jobs>,
    server: State<'_, Arc<MediaServer>>,
    req: CutPreviewRequest,
) -> Result<CutPreviewResult, String> {
    if req.end <= req.start {
        return Err("The cut end must be after the cut start.".into());
    }
    let slot = jobs.slot("cutpreview");
    {
        let mut s = slot.lock().unwrap();
        if let Some(c) = s.child.as_mut() {
            let _ = c.kill();
        }
        s.cancelled = false;
    }
    let dir = previews_dir(&app)?.join("cut");
    let server = server.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let video_out = dir.join(format!("cut-{stamp}.mp4"));
        let n_audio = ffmpeg::audio_mapping(&req.audio).1.len();
        let audio_outs: Vec<PathBuf> =
            (0..n_audio).map(|i| dir.join(format!("cut-{stamp}-a{i}.m4a"))).collect();
        let audio_strs: Vec<String> =
            audio_outs.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        if !req.has_video && n_audio == 0 {
            return Err("Nothing to preview — select at least one audio track.".into());
        }
        let args = ffmpeg::cut_preview_args(
            &req.input,
            req.start,
            req.end,
            req.has_video,
            &req.audio,
            &video_out.to_string_lossy(),
            &audio_strs,
        );
        let program = tool_path(&req.ffmpeg_dir, "ffmpeg");
        run_ffmpeg(&app, &slot, &program, &args, &dir, req.end - req.start, "cutpreview-progress", 1, 1)?;
        Ok(CutPreviewResult {
            video_url: req.has_video.then(|| server.url_for(&video_out)),
            audio_urls: audio_outs.iter().map(|p| server.url_for(p)).collect(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete preview copies of previously opened files.
#[tauri::command]
fn clear_previews(app: AppHandle, jobs: State<'_, Jobs>) {
    for kind in ["preview", "fastseek", "cutpreview"] {
        let slot = jobs.slot(kind);
        let mut s = slot.lock().unwrap();
        s.cancelled = true;
        if let Some(c) = s.child.as_mut() {
            let _ = c.kill();
        }
    }
    if let Ok(dir) = previews_dir(&app) {
        // Files may still be locked for a moment on Windows; best effort.
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// URL the <video> element uses to stream a file from the local media server.
#[tauri::command]
fn media_url(server: State<'_, Arc<MediaServer>>, path: String) -> String {
    server.url_for(Path::new(&path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegStatus {
    ok: bool,
    path: String,
    source: String,
    version: String,
    major: Option<u32>,
    can_auto_install: bool,
    error: String,
}

fn version_of(p: &Path) -> Result<String, String> {
    let out = command(p).arg("-version").output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("{} -version failed", p.display()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").to_string())
}

/// "ffmpeg version 8.1-full_build..." -> Some(8); "N-12345-g..." (git builds) -> None
fn parse_major(version_line: &str) -> Option<u32> {
    let v = version_line.split_whitespace().nth(2)?;
    let v = v.trim_start_matches('n');
    v.split(['.', '-']).next()?.parse().ok()
}

#[tauri::command]
async fn ffmpeg_status(ffmpeg_dir: String) -> FfmpegStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let (ff, source) = tool_path_with_source(&ffmpeg_dir, "ffmpeg");
        let probe = tool_path(&ffmpeg_dir, "ffprobe");
        let can_auto_install = installer::platform_tag().is_some();
        match (version_of(&ff), version_of(&probe)) {
            (Ok(v), Ok(_)) => FfmpegStatus {
                ok: true,
                path: ff.to_string_lossy().into_owned(),
                source: source.into(),
                major: parse_major(&v),
                version: v,
                can_auto_install,
                error: String::new(),
            },
            (a, b) => FfmpegStatus {
                ok: false,
                path: ff.to_string_lossy().into_owned(),
                source: source.into(),
                version: String::new(),
                major: None,
                can_auto_install,
                error: a.err().or(b.err()).unwrap_or_default(),
            },
        }
    })
    .await
    .unwrap_or(FfmpegStatus {
        ok: false,
        path: String::new(),
        source: String::new(),
        version: String::new(),
        major: None,
        can_auto_install: false,
        error: "status check failed".into(),
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    stage: &'static str,
    done: u64,
    total: u64,
}

/// Download FFmpeg into the app's data folder (Windows).
#[tauri::command]
async fn install_ffmpeg(app: AppHandle, state: State<'_, Arc<InstallState>>) -> Result<String, String> {
    let tag = installer::platform_tag()
        .ok_or("Automatic install isn't available on this OS. Install FFmpeg with your package manager.")?;
    let dir = MANAGED_DIR.get().cloned().ok_or("App data folder unavailable")?;
    let state = state.inner().clone();
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("FFmpeg is already being installed.".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let st = state.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let emit = |s: installer::Stage| {
            let p = match s {
                installer::Stage::Download { done, total } => InstallProgress { stage: "download", done, total },
                installer::Stage::Verify => InstallProgress { stage: "verify", done: 0, total: 0 },
                installer::Stage::Extract => InstallProgress { stage: "extract", done: 0, total: 0 },
            };
            let _ = app.emit("ffmpeg-install-progress", p);
        };
        let name = installer::install(&dir, tag, &st.cancel, &emit)?;
        version_of(&dir.join(exe_name("ffmpeg")))
            .map_err(|e| format!("Installed {name}, but it won't run: {e}"))
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    state.running.store(false, Ordering::SeqCst);
    res
}

#[tauri::command]
fn cancel_install(state: State<'_, Arc<InstallState>>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
async fn pick_folder(app: AppHandle, title: String) -> Option<String> {
    app.dialog()
        .file()
        .set_title(title)
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn cancel_job(jobs: State<'_, Jobs>, kind: String) {
    let slot = jobs.slot(&kind);
    let mut s = slot.lock().unwrap();
    s.cancelled = true;
    if let Some(c) = s.child.as_mut() {
        let _ = c.kill();
    }
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("settings.json"))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> serde_json::Value {
    settings_file(&app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let p = settings_file(&app)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(p, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg("-R").arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = Path::new(&path).parent().map(|p| p.to_path_buf()).unwrap_or_default();
        Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let server = MediaServer::start().expect("could not start local media server");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Jobs::default())
        .manage(server)
        .manage(Arc::new(InstallState::default()))
        .setup(|app| {
            if let Ok(d) = app.path().app_local_data_dir() {
                let _ = MANAGED_DIR.set(d.join("ffmpeg"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_file,
            pick_folder,
            check_ffmpeg,
            ffmpeg_status,
            install_ffmpeg,
            cancel_install,
            probe,
            media_url,
            export_video,
            make_preview,
            render_cut_preview,
            clear_previews,
            cancel_job,
            load_settings,
            save_settings,
            path_exists,
            reveal_in_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let jobs = app.state::<Jobs>();
                for kind in ["export", "preview", "fastseek", "cutpreview"] {
                    if let Some(c) = jobs.slot(kind).lock().unwrap().child.as_mut() {
                        let _ = c.kill();
                    }
                }
                if let Ok(dir) = previews_dir(app) {
                    let _ = std::fs::remove_dir_all(dir);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_ffmpeg_versions() {
        use super::parse_major;
        assert_eq!(parse_major("ffmpeg version 8.1-full_build-www.gyan.dev Copyright"), Some(8));
        assert_eq!(parse_major("ffmpeg version n9.0-12-gabc Copyright"), Some(9));
        assert_eq!(parse_major("ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright"), Some(4));
        assert_eq!(parse_major("ffmpeg version N-117000-g1234 Copyright"), None);
    }
}
