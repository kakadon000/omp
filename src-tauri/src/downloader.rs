// v0.14.0 — Downloader: real video downloads on 1000+ platforms.
//
// OMP has shipped the official yt-dlp.exe since v0.9.0 (the mpv ytdl hook
// uses it to PLAY YouTube links). This module turns that same binary into a
// full downloader engine:
//
//   dl_fetch_info → `yt-dlp -J <url>`       (metadata + format list)
//   dl_start      → `yt-dlp -f <sel> ...`   (download with --newline progress)
//   dl_cancel     → real process kill
//   dl_history_*  → SQLite `downloads` table (the library.db)
//
// Merging separate video+audio streams and MP3 extraction go through the
// BUNDLED ffmpeg.exe (--ffmpeg-location), exactly like the editor export.
// Progress flows to the UI as `omp://dl` events:
//   { id, phase: "progress"|"done"|"error", pct, speed, eta, path, error }

use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Live downloads — (job id, child). A Vec keeps the static init const-safe
/// and is plenty for the four-job cap.
static JOBS: Mutex<Vec<(String, Child)>> = Mutex::new(Vec::new());

/// Job ids whose cancel() was requested — lets the watcher tell a cancel
/// apart from a genuine failure when it sees the entry gone / failed.
static CANCELLED: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn quiet(cmd: &mut Command) {
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// Locate the bundled ffmpeg.exe (same ladder as editor.rs — the merger and
/// MP3 extraction need it).
fn ffmpeg_loc() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for rel in ["ffmpeg.exe", r"resources\ffmpeg.exe", r"..\resources\ffmpeg.exe"] {
        let p = dir.join(rel);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(ed) = crate::health::engine_dir(None) {
        let p = ed.join("ffmpeg.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn valid_url(s: &str) -> bool {
    let l = s.trim().to_ascii_lowercase();
    l.starts_with("http://") || l.starts_with("https://")
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Status pill for the Downloader screen.
#[tauri::command]
pub fn dl_status() -> Value {
    let ytdlp = crate::ytdlp_path();
    let mut version = String::new();
    if let Some(exe) = &ytdlp {
        let mut cmd = Command::new(exe);
        cmd.arg("--version");
        quiet(&mut cmd);
        if let Ok(mut child) = cmd.spawn() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            let out = child.stdout.take();
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if std::time::Instant::now() > deadline {
                            let _ = child.kill();
                            break;
                        }
                        thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
            if let Some(mut o) = out {
                let mut buf = String::new();
                use std::io::Read;
                let _ = o.read_to_string(&mut buf);
                version = buf.trim().split_whitespace().next().unwrap_or("").to_string();
            }
        }
    }
    serde_json::json!({
        "available": ytdlp.is_some(),
        "path": ytdlp.as_ref().map(|p| p.to_string_lossy()).unwrap_or_default(),
        "version": version,
        "ffmpeg": ffmpeg_loc().is_some(),
    })
}

/// Metadata + format list for one URL. Runs with a hard 45s timeout so a
/// dead network can never hang the UI. Returns a trimmed JSON document.
#[tauri::command]
pub fn dl_fetch_info(url: String) -> Result<String, String> {
    let u = url.trim().to_string();
    if !valid_url(&u) {
        return Err("paste a full https:// link".into());
    }
    let exe = crate::ytdlp_path().ok_or_else(|| "yt-dlp is not available in this install — Settings → Engine & tools can repair it".to_string())?;
    let mut cmd = Command::new(&exe);
    cmd.args([
        "-J", "--no-playlist", "--no-warnings",
    ])
    .arg(&u);
    quiet(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start yt-dlp: {e}"))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "could not read the extractor output".to_string())?;
    let mut buf = String::new();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                use std::io::Read;
                let _ = stdout.read_to_string(&mut buf);
                if !status.success() && buf.trim().is_empty() {
                    return Err("that link could not be resolved (private, deleted, or unsupported?)".into());
                }
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    return Err("resolving the link timed out (network too slow?)".into());
                }
                let mut chunk = [0u8; 8192];
                use std::io::Read;
                match stdout.read(&mut chunk) {
                    Ok(0) => thread::sleep(std::time::Duration::from_millis(60)),
                    Ok(k) => buf.push_str(&String::from_utf8_lossy(&chunk[..k])),
                    Err(_) => thread::sleep(std::time::Duration::from_millis(60)),
                }
            }
            Err(e) => return Err(format!("yt-dlp wait failed: {e}")),
        }
    }
    let line = buf.lines().find(|l| l.trim_start().starts_with('{')).ok_or("no metadata came back for that link")?;
    let v: Value = serde_json::from_str(line.trim()).map_err(|e| format!("bad metadata: {e}"))?;

    // formats → a compact list the UI can render (drop storyboards, sort by
    // height, cap at 14 rows)
    let mut fmts: Vec<(i64, Value)> = Vec::new();
    if let Some(arr) = v["formats"].as_array() {
        for f in arr {
            let vc = f["vcodec"].as_str().unwrap_or("none");
            let ac = f["acodec"].as_str().unwrap_or("none");
            if vc == "none" && ac == "none" {
                continue; // storyboard images
            }
            let h = f["height"].as_i64().unwrap_or(if ac != "none" && vc == "none" { -1 } else { 0 });
            fmts.push((h, f.clone()));
        }
    }
    fmts.sort_by(|a, b| b.0.cmp(&a.0));
    let fmts: Vec<Value> = fmts
        .into_iter()
        .take(14)
        .map(|(_, f)| {
            serde_json::json!({
                "id": f["format_id"].as_str().unwrap_or(""),
                "ext": f["ext"].as_str().unwrap_or(""),
                "height": f["height"].as_i64().unwrap_or(0),
                "fps": f["fps"].as_i64().unwrap_or(0),
                "vcodec": f["vcodec"].as_str().unwrap_or(""),
                "acodec": f["acodec"].as_str().unwrap_or(""),
                "note": f["format_note"].as_str().unwrap_or(""),
                "size": f["filesize"].as_f64().or_else(|| f["filesize_approx"].as_f64()).unwrap_or(0.0),
            })
        })
        .collect();

    let out = serde_json::json!({
        "id": v["id"].as_str().unwrap_or(""),
        "title": v["title"].as_str().unwrap_or("Untitled"),
        "url": v["webpage_url"].as_str().unwrap_or(u.as_str()),
        "uploader": v["uploader"].as_str().or_else(|| v["channel"].as_str()).unwrap_or(""),
        "duration": v["duration"].as_f64().unwrap_or(0.0),
        "thumb": v["thumbnail"].as_str().unwrap_or(""),
        "extractor": v["extractor_key"].as_str().unwrap_or(""),
        "is_live": v["is_live"].as_bool().unwrap_or(false),
        "formats": fmts,
    });
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

/// Map a quality chip to a yt-dlp format selector.
fn selector(quality: &str) -> &'static str {
    match quality {
        "1080" => "bv*[height<=1080]+ba/b[height<=1080]/b",
        "720" => "bv*[height<=720]+ba/b[height<=720]/b",
        "480" => "bv*[height<=480]+ba/b[height<=480]/b",
        _ => "bv*+ba/b", // best
    }
}

/// Start one download. Spawns yt-dlp and returns immediately; progress lands
/// on `omp://dl`. One URL = one job id (the UI generates it).
#[tauri::command]
pub fn dl_start(
    app: AppHandle,
    id: String,
    url: String,
    quality: String,
    out_dir: String,
) -> bool {
    let u = url.trim().to_string();
    if !valid_url(&u) {
        let _ = app.emit("omp://dl", serde_json::json!({ "id": id, "phase": "error", "error": "not a valid link" }));
        return true;
    }
    let Some(exe) = crate::ytdlp_path() else {
        let _ = app.emit("omp://dl", serde_json::json!({ "id": id, "phase": "error", "error": "yt-dlp is missing — Settings → Engine & tools" }));
        return true;
    };
    {
        let guard = match JOBS.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        if guard.len() >= 4 {
            let _ = app.emit("omp://dl", serde_json::json!({ "id": id, "phase": "error", "error": "too many downloads running — finish one first" }));
            return true;
        }
    }
    if out_dir.trim().is_empty() {
        let _ = app.emit("omp://dl", serde_json::json!({ "id": id, "phase": "error", "error": "no download folder" }));
        return true;
    }
    let audio = quality == "audio";
    let template = std::path::Path::new(out_dir.trim())
        .join("%(title)s [%(id)s].%(ext)s")
        .to_string_lossy()
        .into_owned();

    let mut cmd = Command::new(&exe);
    cmd.arg("--newline")
        .arg("--progress")
        .arg("--no-playlist")
        .arg("--no-warnings")
        .arg("--windows-filenames")
        .arg("--no-simulate")
        .arg("--print")
        .arg("after_move:filepath");
    // ONLY add the flag when we have the binary — a dangling flag would eat
    // the next argument and corrupt the whole command line
    if let Some(ff) = ffmpeg_loc() {
        cmd.arg("--ffmpeg-location").arg(ff.to_string_lossy().into_owned());
    }
    if audio {
        cmd.arg("-x").arg("--audio-format").arg("mp3").arg("--audio-quality").arg("0");
        cmd.arg("-f").arg("ba/b");
    } else {
        cmd.arg("-f").arg(selector(&quality));
    }
    cmd.arg("-o").arg(template).arg(&u);
    quiet(&mut cmd);

    // reset cancel BEFORE spawn — same ordering rule as the editor export
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit("omp://dl", serde_json::json!({ "id": id, "phase": "error", "error": format!("yt-dlp failed to start: {e}") }));
            return true;
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    match JOBS.lock() {
        Ok(mut g) => {
            g.push((id.clone(), child));
        }
        Err(_) => return false,
    }

    // shared final-path slot: the stdout reader fills it, the watcher sends it
    let final_path: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    // stdout pump — parse --newline progress lines into omp://dl events
    if let Some(out) = stdout {
        let app2 = app.clone();
        let id2 = id.clone();
        let path_slot = final_path.clone();
        thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                let l = line.trim();
                if l.is_empty() {
                    continue;
                }
                if !l.starts_with('[') {
                    // --print after_move:filepath lands here — a bare path
                    *path_slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(l.to_string());
                    continue;
                }
                if !l.starts_with("[download]") {
                    // [Merger] / [ExtractAudio] / [VideoRemuxer] …
                    let _ = app2.emit("omp://dl", serde_json::json!({ "id": id2, "phase": "note", "note": l }));
                    continue;
                }
                let pct = l
                    .split_whitespace()
                    .find(|t| t.ends_with('%'))
                    .and_then(|t| t.trim_end_matches('%').parse::<f64>().ok());
                let speed = l
                    .split(" at ")
                    .nth(1)
                    .and_then(|s| s.split_whitespace().next())
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                let eta = l
                    .split("ETA ")
                    .nth(1)
                    .map(|s| s.trim().to_string())
                    .unwrap_or_default();
                if let Some(pct) = pct {
                    let _ = app2.emit(
                        "omp://dl",
                        serde_json::json!({ "id": id2, "phase": "progress", "pct": pct.min(100.0), "speed": speed, "eta": eta }),
                    );
                }
            }
        });
    }
    // stderr drain — keeps the pipe from filling; last lines feed the error
    let err_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(err) = stderr {
        let tail = err_tail.clone();
        thread::spawn(move || {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                let mut t = match tail.lock() {
                    Ok(t) => t,
                    Err(p) => p.into_inner(),
                };
                if t.len() >= 5 {
                    t.remove(0);
                }
                t.push(line);
            }
        });
    }

    // watcher — polls exit, detects cancel, emits the terminal event
    let app3 = app.clone();
    let id3 = id.clone();
    thread::spawn(move || {
        let mut status_ok: Option<bool> = None;
        loop {
            thread::sleep(std::time::Duration::from_millis(200));
            let probe = match JOBS.lock() {
                Ok(mut g) => {
                    let idx = g.iter().position(|(k, _)| k == &id3);
                    match idx {
                        Some(i) => match g[i].1.try_wait() {
                            Ok(Some(st)) => {
                                g.remove(i);
                                Some(st.success())
                            }
                            Ok(None) => None,
                            Err(_) => {
                                g.remove(i);
                                Some(false)
                            }
                        },
                        None => Some(false), // entry vanished → cancelled or killed
                    }
                }
                Err(_) => Some(false),
            };
            if let Some(ok) = probe {
                status_ok = Some(ok);
                break;
            }
        }
        let ok = status_ok.unwrap_or(false);
        let was_cancelled = match CANCELLED.lock() {
            Ok(mut c) => {
                let had = c.iter().any(|k| k == &id3);
                c.retain(|k| k != &id3);
                had
            }
            Err(_) => false,
        };
        let path = final_path
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .unwrap_or_default();
        if ok {
            let _ = app3.emit(
                "omp://dl",
                serde_json::json!({ "id": id3, "phase": "done", "pct": 100.0, "path": path }),
            );
        } else if was_cancelled {
            let _ = app3.emit("omp://dl", serde_json::json!({ "id": id3, "phase": "cancelled" }));
        } else {
            let tail = err_tail.lock().unwrap_or_else(|p| p.into_inner()).last().cloned().unwrap_or_default();
            let _ = app3.emit(
                "omp://dl",
                serde_json::json!({ "id": id3, "phase": "error", "error": if tail.is_empty() { "download failed".to_string() } else { tail } }),
            );
        }
    });
    true
}

/// Kill a running download (real process kill, same rule as editor cancel).
#[tauri::command]
pub fn dl_cancel(id: String) -> bool {
    let mut removed = false;
    if let Ok(mut g) = JOBS.lock() {
        if let Some(i) = g.iter().position(|(k, _)| k == &id) {
            let mut c = g.remove(i).1;
            let _ = c.kill();
            let _ = c.wait();
            removed = true;
        }
    }
    // remember the cancel even if the child already exited between polls
    if let Ok(mut c) = CANCELLED.lock() {
        if !c.iter().any(|k| k == &id) {
            c.push(id);
        }
    }
    removed
}

/* ------------------------------------------------------------------ */
/*  downloads history — the `downloads` table in the library.db        */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn dl_history_add(
    state: State<'_, crate::library::LibraryState>,
    url: String,
    title: String,
    path: String,
    quality: String,
) -> bool {
    let Ok(conn) = state.db_lock() else { return false };
    conn.execute(
        "INSERT OR REPLACE INTO downloads(url, title, path, quality, created) VALUES(?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![url, title, path, quality, now_secs()],
    )
    .is_ok()
}

#[tauri::command]
pub fn dl_history_list(state: State<'_, crate::library::LibraryState>) -> String {
    let Ok(conn) = state.db_lock() else { return "[]".into() };
    let mut out: Vec<Value> = Vec::new();
    if let Ok(mut st) = conn.prepare(
        "SELECT url, title, path, quality, created FROM downloads ORDER BY created DESC LIMIT 120",
    ) {
        if let Ok(rows) = st.query_map([], |r| {
            Ok(serde_json::json!({
                "url": r.get::<_, String>(0).unwrap_or_default(),
                "title": r.get::<_, String>(1).unwrap_or_default(),
                "path": r.get::<_, String>(2).unwrap_or_default(),
                "quality": r.get::<_, String>(3).unwrap_or_default(),
                "created": r.get::<_, i64>(4).unwrap_or(0),
            }))
        }) {
            for row in rows.flatten() {
                out.push(row);
            }
        }
    }
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}

#[tauri::command]
pub fn dl_history_clear(state: State<'_, crate::library::LibraryState>) -> bool {
    let Ok(conn) = state.db_lock() else { return false };
    conn.execute("DELETE FROM downloads", []).is_ok()
}
