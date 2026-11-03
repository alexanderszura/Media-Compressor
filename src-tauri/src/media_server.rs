//! Tiny localhost HTTP server that streams video files with byte-range support.
//!
//! The webview's built-in asset protocol goes through a custom-scheme handler,
//! which on Windows (WebView2) is slow for range requests and makes every seek
//! lag. A real HTTP socket lets the media pipeline fetch ranges directly, so
//! seeks are near-instant. Bound to 127.0.0.1 only, and every URL carries a
//! random token so other local programs can't browse files.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct MediaServer {
    port: u16,
    token: String,
    files: Mutex<HashMap<String, PathBuf>>,
    next_id: Mutex<u64>,
}

fn random_token() -> String {
    let s = std::collections::hash_map::RandomState::new();
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = s.build_hasher();
        h.write_u64(i ^ std::process::id() as u64);
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .as_deref()
    {
        // QuickTime files are served as mp4 – Chromium plays them that way.
        Some("mp4" | "m4v" | "mov") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("ogv") => "video/ogg",
        _ => "application/octet-stream",
    }
}

impl MediaServer {
    pub fn start() -> std::io::Result<Arc<Self>> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let srv = Arc::new(MediaServer {
            port: listener.local_addr()?.port(),
            token: random_token(),
            files: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        });
        let s = srv.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let s = s.clone();
                std::thread::spawn(move || {
                    let _ = s.handle(conn);
                });
            }
        });
        Ok(srv)
    }

    /// Make `path` available and return its URL.
    pub fn url_for(&self, path: &Path) -> String {
        let mut id = self.next_id.lock().unwrap();
        let key = id.to_string();
        *id += 1;
        self.files.lock().unwrap().insert(key.clone(), path.to_path_buf());
        let ext = path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        format!("http://127.0.0.1:{}/{}/{}/media{}", self.port, self.token, key, ext)
    }

    fn lookup(&self, target: &str) -> Option<PathBuf> {
        let mut parts = target.trim_start_matches('/').split('/');
        let (tok, id) = (parts.next()?, parts.next()?);
        if tok != self.token {
            return None;
        }
        self.files.lock().unwrap().get(id).cloned()
    }

    fn handle(&self, stream: TcpStream) -> std::io::Result<()> {
        stream.set_read_timeout(Some(Duration::from_secs(60)))?;
        let _ = stream.set_nodelay(true);
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut out = stream;
        loop {
            let mut request_line = String::new();
            if reader.read_line(&mut request_line)? == 0 {
                return Ok(());
            }
            let mut parts = request_line.split_whitespace();
            let method = parts.next().unwrap_or("").to_string();
            let target = parts.next().unwrap_or("").to_string();
            let mut range: Option<String> = None;
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h)? == 0 {
                    return Ok(());
                }
                let h = h.trim_end();
                if h.is_empty() {
                    break;
                }
                if let Some((k, v)) = h.split_once(':') {
                    if k.eq_ignore_ascii_case("range") {
                        range = Some(v.trim().to_string());
                    }
                }
            }

            let Some(path) = self.lookup(&target) else {
                out.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")?;
                continue;
            };
            let mut file = match std::fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => {
                    out.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")?;
                    continue;
                }
            };
            let len = file.metadata()?.len();
            let parsed = range.as_deref().and_then(|r| parse_range(r, len));
            if range.is_some() && parsed.is_none() {
                write!(
                    out,
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\n\r\n"
                )?;
                continue;
            }
            let (start, end) = parsed.unwrap_or((0, len.saturating_sub(1)));
            let body_len = if len == 0 { 0 } else { end - start + 1 };
            let status = if parsed.is_some() { "206 Partial Content" } else { "200 OK" };
            let mut head = format!(
                "HTTP/1.1 {status}\r\nContent-Type: {}\r\nContent-Length: {body_len}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n",
                content_type(&path)
            );
            if parsed.is_some() {
                head.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
            }
            head.push_str("\r\n");
            out.write_all(head.as_bytes())?;
            if method == "HEAD" || body_len == 0 {
                continue;
            }
            file.seek(SeekFrom::Start(start))?;
            // When the player seeks it drops this connection; the write then
            // fails and we stop reading the file.
            let mut limited = file.take(body_len);
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                let n = limited.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n])?;
            }
        }
    }
}

/// Parse "bytes=a-b", "bytes=a-" or "bytes=-n" into an inclusive (start, end).
pub fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (len.saturating_sub(n), len - 1)
    } else {
        let s: u64 = a.parse().ok()?;
        let e: u64 = if b.is_empty() { len - 1 } else { b.parse::<u64>().ok()?.min(len - 1) };
        (s, e)
    };
    (start <= end && start < len).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-500", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
    }

    #[test]
    fn serves_ranges_over_http() {
        let dir = std::env::temp_dir().join("mc-srv-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.mp4");
        std::fs::write(&f, (0..=255u8).collect::<Vec<_>>()).unwrap();
        let srv = MediaServer::start().unwrap();
        let url = srv.url_for(&f);
        let path = url.splitn(4, '/').nth(3).unwrap();
        let mut s = TcpStream::connect(("127.0.0.1", srv.port)).unwrap();
        // two requests on one keep-alive connection
        for (range, expect) in [("bytes=10-12", vec![10u8, 11, 12]), ("bytes=-2", vec![254, 255])] {
            write!(s, "GET /{path} HTTP/1.1\r\nHost: x\r\nRange: {range}\r\n\r\n").unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            assert!(line.contains("206"), "{line}");
            let mut cl = 0;
            loop {
                let mut h = String::new();
                r.read_line(&mut h).unwrap();
                if h.trim().is_empty() { break; }
                if let Some(v) = h.strip_prefix("Content-Length: ") { cl = v.trim().parse().unwrap(); }
            }
            let mut body = vec![0; cl];
            r.read_exact(&mut body).unwrap();
            assert_eq!(body, expect);
        }
        let mut bad = TcpStream::connect(("127.0.0.1", srv.port)).unwrap();
        write!(bad, "GET /wrongtoken/1/media.mp4 HTTP/1.1\r\n\r\n").unwrap();
        let mut line = String::new();
        BufReader::new(bad).read_line(&mut line).unwrap();
        assert!(line.contains("404"));
    }
}

#[cfg(test)]
mod manual {
    /// Serves $MC_SERVE_FILE for 60 s and prints the URL (used to check real browser playback).
    #[test]
    #[ignore]
    fn serve_for_browser() {
        let f = std::env::var("MC_SERVE_FILE").unwrap();
        let srv = super::MediaServer::start().unwrap();
        println!("URL={}", srv.url_for(std::path::Path::new(&f)));
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}
