//! Downloads a static FFmpeg build (BtbN/FFmpeg-Builds on GitHub) into the
//! app's data folder, verifies its SHA-256 and extracts ffmpeg + ffprobe.

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const RELEASE_BASE: &str = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/";

/// BtbN platform tag for this OS, if we can auto-install here.
/// (BtbN only publishes .zip archives for Windows; Linux builds are .tar.xz and
/// there are no macOS builds, so other platforms get manual instructions.)
pub fn platform_tag() -> Option<&'static str> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some("win64")
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        Some("winarm64")
    } else {
        None
    }
}

/// Pick the newest stable "ffmpeg-nX.Y-latest-<tag>-gpl-X.Y.zip" from the
/// checksum list, falling back to the master build. Returns (file name, sha256).
pub fn pick_asset(checksums: &str, tag: &str) -> Option<(String, String)> {
    let mut best: Option<((u32, u32), String, String)> = None;
    let mut master = None;
    for line in checksums.lines() {
        let mut it = line.split_whitespace();
        let (Some(sha), Some(name)) = (it.next(), it.next()) else { continue };
        let name = name.trim_start_matches('*');
        if name == format!("ffmpeg-master-latest-{tag}-gpl.zip") {
            master = Some((name.to_string(), sha.to_lowercase()));
            continue;
        }
        let Some(rest) = name.strip_prefix("ffmpeg-n") else { continue };
        let Some((ver, tail)) = rest.split_once("-latest-") else { continue };
        if tail != format!("{tag}-gpl-{ver}.zip") {
            continue; // skips -shared, -lgpl, other platforms
        }
        let mut nums = ver.split('.').map(|n| n.parse::<u32>().ok());
        let (Some(Some(maj)), Some(Some(min))) = (nums.next(), nums.next()) else { continue };
        if best.as_ref().map_or(true, |(v, _, _)| (maj, min) > *v) {
            best = Some(((maj, min), name.to_string(), sha.to_lowercase()));
        }
    }
    best.map(|(_, n, s)| (n, s)).or(master)
}

#[derive(Clone, Copy)]
pub enum Stage {
    Download { done: u64, total: u64 },
    Verify,
    Extract,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .try_proxy_from_env(true)
        .build()
}

fn fetch_text(url: &str) -> Result<String, String> {
    agent()
        .get(url)
        .call()
        .map_err(|e| format!("Couldn't reach GitHub ({e}). Check your internet connection."))?
        .into_string()
        .map_err(|e| e.to_string())
}

/// Download `url` to `dest`, returning the SHA-256 hex digest.
fn download(
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
    progress: &dyn Fn(Stage),
) -> Result<String, String> {
    let resp = agent()
        .get(url)
        .call()
        .map_err(|e| format!("Download failed: {e}"))?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("Download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if last_emit.elapsed() > Duration::from_millis(150) {
            progress(Stage::Download { done, total });
            last_emit = std::time::Instant::now();
        }
    }
    progress(Stage::Download { done, total: total.max(done) });
    file.flush().map_err(|e| e.to_string())?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Extract bin/ffmpeg(.exe) and bin/ffprobe(.exe) from the archive into `dest_dir`.
pub fn extract_tools(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Bad archive: {e}"))?;
    let wanted = ["ffmpeg.exe", "ffprobe.exe", "ffmpeg", "ffprobe"];
    let mut found = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        let Some(base) = name.rsplit('/').next() else { continue };
        if !name.contains("/bin/") || !wanted.contains(&base) || entry.is_dir() {
            continue;
        }
        let tmp = dest_dir.join(format!("{base}.part"));
        let mut out = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        drop(out);
        let final_path = dest_dir.join(base);
        let _ = std::fs::remove_file(&final_path);
        std::fs::rename(&tmp, &final_path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&final_path, std::fs::Permissions::from_mode(0o755));
        }
        found += 1;
    }
    if found < 2 {
        return Err("The FFmpeg archive didn't contain ffmpeg and ffprobe.".into());
    }
    Ok(())
}

/// Full install into `dest_dir`. Returns the downloaded build's file name.
pub fn install(
    dest_dir: &Path,
    tag: &str,
    cancel: &AtomicBool,
    progress: &dyn Fn(Stage),
) -> Result<String, String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let sums = fetch_text(&format!("{RELEASE_BASE}checksums.sha256"))?;
    let (name, expected) =
        pick_asset(&sums, tag).ok_or("No FFmpeg build for this platform was found.")?;
    let zip_path: PathBuf = dest_dir.join("download.zip.part");
    let result = (|| {
        let actual = download(&format!("{RELEASE_BASE}{name}"), &zip_path, cancel, progress)?;
        progress(Stage::Verify);
        if actual != expected {
            return Err(format!(
                "The download was corrupted (checksum mismatch). Please try again.\nexpected {expected}\n     got {actual}"
            ));
        }
        progress(Stage::Extract);
        extract_tools(&zip_path, dest_dir)
    })();
    let _ = std::fs::remove_file(&zip_path);
    result.map(|_| name)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUMS: &str = "\
46ee  ffmpeg-master-latest-win64-gpl-shared.zip
03c1  ffmpeg-master-latest-win64-gpl.zip
be80  ffmpeg-n8.1-latest-win64-gpl-8.1.zip
5d10  ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip
93ea  ffmpeg-n9.0-latest-win64-gpl-9.0.zip
aaaa  ffmpeg-n10.0-latest-win64-lgpl-10.0.zip
bbbb  ffmpeg-n10.0-latest-linux64-gpl-10.0.tar.xz
";

    #[test]
    fn picks_newest_stable_static_gpl() {
        assert_eq!(
            pick_asset(SUMS, "win64"),
            Some(("ffmpeg-n9.0-latest-win64-gpl-9.0.zip".into(), "93ea".into()))
        );
        assert_eq!(
            pick_asset("x  ffmpeg-master-latest-win64-gpl.zip", "win64").unwrap().0,
            "ffmpeg-master-latest-win64-gpl.zip"
        );
        assert_eq!(pick_asset(SUMS, "winarm64"), None);
    }

    /// Real download (~100 MB). Run with: cargo test -- --ignored real_install
    #[test]
    #[ignore]
    fn real_install() {
        let dir = std::env::temp_dir().join("mc-install-test");
        let _ = std::fs::remove_dir_all(&dir);
        let cancel = AtomicBool::new(false);
        let name = install(&dir, "win64", &cancel, &|s| {
            if let Stage::Download { done, total } = s {
                if done == total {
                    eprintln!("downloaded {} MB", done / 1048576);
                }
            }
        })
        .unwrap();
        eprintln!("installed {name}");
        assert!(dir.join("ffmpeg.exe").metadata().unwrap().len() > 10_000_000);
        assert!(dir.join("ffprobe.exe").metadata().unwrap().len() > 10_000_000);
        assert!(!dir.join("download.zip.part").exists());
    }
}
