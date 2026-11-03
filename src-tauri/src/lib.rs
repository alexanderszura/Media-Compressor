mod ffmpeg;

use ffmpeg::{AudioOptions, VideoOptions};
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
    proxy: Arc<Mutex<JobSlot>>,
}

impl Jobs {
    fn slot(&self, kind: &str) -> Arc<Mutex<JobSlot>> {
        if kind == "proxy" {
            self.proxy.clone()
        } else {
            self.export.clone()
        }
    }
}

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

/// Resolve a tool. Order: folder from Settings -> next to this app's exe -> PATH.
fn tool_path(dir: &str, name: &str) -> PathBuf {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let d = dir.trim().trim_matches('"');
    if !d.is_empty() {
        let p = Path::new(d);
        // Allow the user to paste the path to ffmpeg.exe itself.
        if p.is_file() {
            return p.with_file_name(&exe);
        }
        return p.join(&exe);
    }
    if let Ok(cur) = std::env::current_exe() {
        if let Some(parent) = cur.parent() {
            let c = parent.join(&exe);
            if c.is_file() {
                return c;
            }
        }
    }
    PathBuf::from(exe)
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
    "mp4", "mkv", "mov", "m4v", "webm", "avi", "wmv", "flv", "ts", "mts", "m2ts", "mpg", "mpeg",
    "3gp", "ogv",
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

#[tauri::command]
async fn make_proxy(
    app: AppHandle,
    jobs: State<'_, Jobs>,
    path: String,
    ffmpeg_dir: String,
    duration: f64,
) -> Result<String, String> {
    let slot = jobs.slot("proxy");
    {
        let mut s = slot.lock().unwrap();
        if let Some(c) = s.child.as_mut() {
            let _ = c.kill();
        }
        s.cancelled = false;
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("previews");
    tauri::async_runtime::spawn_blocking(move || {
        // Only keep one preview around.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let out = dir.join(format!("preview-{stamp}.mp4"));
        let out_s = out.to_string_lossy().into_owned();
        let program = tool_path(&ffmpeg_dir, "ffmpeg");
        let args = ffmpeg::proxy_args(&path, &out_s);
        run_ffmpeg(&app, &slot, &program, &args, &dir, duration, "proxy-progress", 1, 1)?;
        Ok(out_s)
    })
    .await
    .map_err(|e| e.to_string())?
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Jobs::default())
        .invoke_handler(tauri::generate_handler![
            pick_file,
            check_ffmpeg,
            probe,
            export_video,
            make_proxy,
            cancel_job,
            load_settings,
            save_settings,
            path_exists,
            reveal_in_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
