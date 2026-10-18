// Phase 4 — Lightweight editor: FFmpeg export pipeline + .ompj project IO.
//
// The editor screen owns the timeline (trim, crop, timed overlays). When the
// user exports, the frontend renders every overlay to a transparent PNG sized
// to the SOURCE resolution (WYSIWYG parity with the preview), hands the PNGs
// here, and this module builds a single ffmpeg invocation:
//
//   ffmpeg -ss <trim> -i src [-i ovl1.png -i ovl2.png ...]
//          -filter_complex "[0:v][1:v]overlay=...[v1];[v1][2:v]overlay=...[v2]
//                           [;...][crop][palette pipeline for gif]"
//          -c:v libx264/libvpx-vp9 ... out.mp4
//
// Progress streams out on `omp://export-progress`, completion on
// `omp://export-done`. Cancel is a real process kill (editor_export_cancel).

use base64::Engine as _;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

static CANCEL: AtomicBool = AtomicBool::new(false);
static CHILD: Mutex<Option<Child>> = Mutex::new(None);
static PNG_SEQ: AtomicU64 = AtomicU64::new(0);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Locate the bundled ffmpeg.exe (same resolution ladder as mpv-2.dll).
/// v0.9.1: also accepts the self-repaired copy in the app-data engine dir.
fn ffmpeg_path() -> Option<std::path::PathBuf> {
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

/// Diagnostics for Settings: is the export encoder available?
#[tauri::command]
pub fn editor_ffmpeg_status() -> Value {
    match ffmpeg_path() {
        Some(p) => serde_json::json!({ "found": true, "path": p.to_string_lossy() }),
        None => serde_json::json!({ "found": false, "path": "" }),
    }
}

/// v0.14.1 — engine-independent metadata probe for the editor.
/// When neither mpv nor the WebView can decode a file (broken engine DLL,
/// HEVC-only clips, …) the preview can never report duration — the editor
/// used to sit on "reading media…" forever. The bundled ffmpeg reads the
/// container without decoding for playback, so trim/scrub/export all come
/// back to life. Runs info-only (no thumbnail), ~instant for local files.
#[tauri::command]
pub fn editor_media_probe(path: String) -> Value {
    match ffmpeg_probe(&path, None, false) {
        Some(m) => serde_json::json!({
            "dur": m.duration,
            "w": m.width,
            "h": m.height,
            "vcodec": m.video_codec,
            "acodec": m.audio_codec,
        }),
        None => Value::Null,
    }
}

/* ------------------------------------------------------------------ */
/*  v0.9.0 — ffmpeg fallback probe for the library scanner             */
/* ------------------------------------------------------------------ */
/*  The scanner's primary probe runs through libmpv (vo=image). On      */
/*  machines where the engine DLL is refused, EVERY video lost its      */
/*  thumbnail and duration. The bundled ffmpeg.exe is independent of    */
/*  libmpv — so when mpv probing is unavailable, ffmpeg picks up the    */
/*  slack: one invocation extracts the still AND prints duration,       */
/*  resolution, codecs and tags on stderr.                             */

fn parse_hhmmss(s: &str) -> f64 {
    let parts: Vec<f64> = s.split(':').filter_map(|p| p.trim().parse::<f64>().ok()).collect();
    if parts.len() == 3 {
        parts[0] * 3600.0 + parts[1] * 60.0 + parts[2]
    } else if parts.len() == 2 {
        parts[0] * 60.0 + parts[1]
    } else {
        parts.first().copied().unwrap_or(0.0)
    }
}

fn spawn_quiet(cmd: &mut std::process::Command) -> Option<std::process::Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .spawn()
        .ok()
}

pub(crate) fn ffmpeg_probe(
    path: &str,
    thumb_dir: Option<&std::path::Path>,
    audio: bool,
) -> Option<crate::mpv::ProbeMeta> {
    let ff = ffmpeg_path()?;
    let want_thumb = thumb_dir.is_some();

    // still extraction: 3s in is the classic safe spot; if the clip is
    // shorter than that the output stays empty and we retry from 0
    let mut meta = None;
    let attempts: Vec<Vec<String>> = if want_thumb {
        let out = thumb_dir.unwrap().join("ff.jpg");
        let out_s = out.to_string_lossy().into_owned();
        if audio {
            // embedded album art is a video stream — map it explicitly
            vec![vec![
                "-y".into(), "-i".into(), path.into(), "-map".into(), "0:v:0".into(),
                "-frames:v".into(), "1".into(), "-q:v".into(), "3".into(), out_s.clone(),
            ]]
        } else {
            vec![
                vec![
                    "-y".into(), "-ss".into(), "3".into(), "-i".into(), path.into(),
                    "-frames:v".into(), "1".into(), "-q:v".into(), "3".into(), out_s.clone(),
                ],
                vec![
                    "-y".into(), "-i".into(), path.into(), "-frames:v".into(), "1".into(),
                    "-q:v".into(), "3".into(), out_s.clone(),
                ],
            ]
        }
    } else {
        // info-only run: ffmpeg exits non-zero without an output file, but
        // the input dump (Duration/Stream/Metadata) still lands on stderr
        vec![vec!["-i".into(), path.into()]]
    };

    let mut stderr_all = String::new();
    for args in &attempts {
        let mut cmd = std::process::Command::new(&ff);
        cmd.args(args);
        let Some(mut child) = spawn_quiet(&mut cmd) else { return None };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut err_pipe = child.stderr.take();
        let mut err_buf = String::new();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if std::time::Instant::now() > deadline {
                        let _ = child.kill();
                        return meta;
                    }
                    if let Some(pipe) = err_pipe.as_mut() {
                        use std::io::Read;
                        let mut chunk = [0u8; 8192];
                        match pipe.read(&mut chunk) {
                            Ok(0) => std::thread::sleep(std::time::Duration::from_millis(40)),
                            Ok(k) => err_buf.push_str(&String::from_utf8_lossy(&chunk[..k])),
                            Err(_) => std::thread::sleep(std::time::Duration::from_millis(40)),
                        }
                    } else {
                        std::thread::sleep(std::time::Duration::from_millis(40));
                    }
                }
                Err(_) => return meta,
            }
        }
        if let Some(mut pipe) = err_pipe.take() {
            use std::io::Read;
            let _ = pipe.read_to_string(&mut err_buf);
        }
        stderr_all.push_str(&err_buf);

        if want_thumb {
            let landed = thumb_dir
                .unwrap()
                .join("ff.jpg")
                .metadata()
                .map(|m| m.len() > 0)
                .unwrap_or(false);
            if landed {
                break;
            }
        }
    }

    // pull what we can from the ffmpeg input dump
    let mut duration = 0f64;
    let mut width = 0i64;
    let mut height = 0i64;
    let mut vcodec = String::new();
    let mut acodec = String::new();
    let mut artist = String::new();
    let mut album = String::new();
    let mut genre = String::new();
    for line in stderr_all.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("Duration:") {
            let raw = rest.split(',').next().unwrap_or("").trim();
            duration = parse_hhmmss(raw);
        } else if l.contains("Video:") && vcodec.is_empty() {
            // "Stream #0:0 ... : Video: h264 (High), yuv420p, 1920x1080 ..."
            if let Some(after) = l.split("Video:").nth(1) {
                let toks: Vec<&str> = after.split(|c| c == ',' || c == ' ').filter(|t| !t.is_empty()).collect();
                vcodec = toks.first().copied().unwrap_or("").to_string();
                for t in &toks {
                    if let Some((w, h)) = t.split_once('x') {
                        if let (Ok(w), Ok(h)) = (w.trim().parse::<i64>(), h.trim().parse::<i64>()) {
                            if w > 16 && h > 16 && w < 20000 && h < 20000 {
                                width = w;
                                height = h;
                                break;
                            }
                        }
                    }
                }
                if vcodec == "mjpeg" || vcodec == "png" {
                    // attached picture, not real video — keep fields empty
                    vcodec.clear();
                    width = 0;
                    height = 0;
                }
            }
        } else if l.contains("Audio:") && acodec.is_empty() {
            if let Some(after) = l.split("Audio:").nth(1) {
                acodec = after
                    .split(|c| c == ',' || c == ' ')
                    .find(|t| !t.is_empty())
                    .unwrap_or("")
                    .to_string();
            }
        } else if let Some((k, v)) = l.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            let val = v.trim();
            if val.is_empty() || key.contains("duration") || key.contains("stream") {
                continue;
            }
            match key.as_str() {
                "artist" | "album_artist" => artist = val.to_string(),
                "album" => album = val.to_string(),
                "genre" => genre = val.to_string(),
                _ => {}
            }
        }
    }

    let thumb = want_thumb
        && thumb_dir
            .unwrap()
            .join("ff.jpg")
            .metadata()
            .map(|m| m.len() > 0)
            .unwrap_or(false);
    let container = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    // a probe that yielded NOTHING at all (unreadable file) is not metadata
    if duration == 0.0 && width == 0 && !thumb && vcodec.is_empty() && acodec.is_empty() {
        return meta;
    }
    meta = Some(crate::mpv::ProbeMeta {
        duration,
        width,
        height,
        video_codec: vcodec,
        audio_codec: acodec,
        container,
        artist,
        album,
        genre,
        thumb,
    });
    meta
}

/// Write one overlay PNG (base64 data URL body or raw base64) to a temp file.
/// Returns the absolute path; an empty string on failure.
#[tauri::command]
pub fn editor_write_png(data_b64: String) -> String {
    let body = data_b64
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(&data_b64);
    let bytes = match base64::engine::general_purpose::STANDARD.decode(body) {
        Ok(b) => b,
        Err(_) => return String::new(),
    };
    if bytes.is_empty() {
        return String::new();
    }
    let n = PNG_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "omp_ovl_{}_{}.png",
        std::process::id(),
        n
    ));
    if std::fs::write(&path, &bytes).is_err() {
        return String::new();
    }
    path.to_string_lossy().into_owned()
}

/// Persist an .ompj project file (JSON text) to `path`.
#[tauri::command]
pub fn editor_write_project(path: String, json: String) -> bool {
    std::fs::write(&path, json).is_ok()
}

/// Read an .ompj project file back as raw JSON text.
#[tauri::command]
pub fn editor_read_project(path: String) -> Option<String> {
    std::fs::read_to_string(&path).ok()
}

fn f(v: Option<&Value>, d: f64) -> f64 {
    v.and_then(|x| x.as_f64()).unwrap_or(d)
}

fn fmt_f(v: f64) -> String {
    format!("{:.3}", v)
}

/// Build and spawn the ffmpeg render. `project` is the raw .ompj JSON with
/// `overlays` pre-filtered to exactly the overlays that were rendered into
/// `overlays` (same order). Returns false when busy/missing ffmpeg/bad input.
#[tauri::command]
pub fn editor_export(
    app: AppHandle,
    project: Value,
    overlays: Vec<String>,
    out_path: String,
    format: String,
    quality: String,
) -> bool {
    let ffmpeg = match ffmpeg_path() {
        Some(p) => p,
        None => {
            let _ = app.emit(
                "omp://export-done",
                serde_json::json!({ "ok": false, "error": "ffmpeg.exe not found next to OMP" }),
            );
            return true;
        }
    };
    // one render at a time
    {
        let guard = CHILD.lock().unwrap();
        if guard.is_some() {
            return false;
        }
    }
    if out_path.is_empty() {
        let _ = app.emit(
            "omp://export-done",
            serde_json::json!({ "ok": false, "error": "no output path" }),
        );
        return true;
    }

    let src_path = project
        .get("srcPath")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if src_path.is_empty() || !std::path::Path::new(&src_path).is_file() {
        let _ = app.emit(
            "omp://export-done",
            serde_json::json!({ "ok": false, "error": "source video missing on disk" }),
        );
        return true;
    }

    let trim_s = f(project.get("trim").and_then(|t| t.get("s")), 0.0);
    let trim_e = f(project.get("trim").and_then(|t| t.get("e")), 0.0);
    let src_dur = f(project.get("dur"), 0.0);
    let total = if trim_e > trim_s {
        trim_e - trim_s
    } else if src_dur > 0.0 {
        src_dur
    } else {
        0.0
    };

    let w = f(project.get("vw"), 1920.0).max(16.0);
    let h = f(project.get("vh"), 1080.0).max(16.0);

    let crop = project.get("crop").and_then(|c| {
        let x = f(c.get("x"), -1.0);
        let y = f(c.get("y"), -1.0);
        let cw = f(c.get("w"), 0.0);
        let ch = f(c.get("h"), 0.0);
        if cw > 0.005 && ch > 0.005 && x >= 0.0 && y >= 0.0 {
            Some((x, y, cw, ch))
        } else {
            None
        }
    });

    // Overlays visible inside the trim window (PNG paths align by index).
    let mut ovs: Vec<(String, f64, f64, f64, f64)> = Vec::new(); // path, x px, y px, rel_s, rel_e
    if let Some(arr) = project.get("overlays").and_then(|o| o.as_array()) {
        for (i, o) in arr.iter().enumerate() {
            let pth = match overlays.get(i) {
                Some(p) if !p.is_empty() => p.clone(),
                _ => continue,
            };
            let s = f(o.get("start"), 0.0);
            let e = f(o.get("end"), f64::MAX / 2.0);
            let rel_s = (s - trim_s).max(0.0);
            let rel_e = if e > 1e8 { total.max(rel_s + 0.1) } else { e - trim_s };
            if rel_e <= 0.02 || rel_s >= total - 0.02 {
                continue; // outside the exported window
            }
            let x = (f(o.get("x"), 0.0) * w).round().clamp(0.0, w - 2.0);
            let y = (f(o.get("y"), 0.0) * h).round().clamp(0.0, h - 2.0);
            ovs.push((pth, x, y, rel_s, rel_e.min(total.max(rel_s + 0.1))));
        }
    }

    // ---------- build the argument list ----------
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
    ];
    if trim_s > 0.05 {
        args.push("-ss".into());
        args.push(fmt_f(trim_s));
    }
    args.push("-i".into());
    args.push(src_path);
    if total > 0.05 && (total + 0.25 < src_dur || src_dur <= 0.0) {
        args.push("-t".into());
        args.push(fmt_f(total));
    }
    for (pth, ..) in &ovs {
        args.push("-i".into());
        args.push(pth.clone());
    }

    let fmt = format.to_lowercase();
    let is_gif = fmt == "gif";
    let need_filter = !ovs.is_empty() || crop.is_some() || is_gif;

    if need_filter {
        let mut graph = String::new();
        let mut cur = "0:v".to_string();
        for (i, (_, x, y, rs, re)) in ovs.iter().enumerate() {
            let in_idx = i + 1;
            let out_lbl = format!("v{}", i);
            graph.push_str(&format!(
                "[{cur}][{in_idx}:v]overlay=x={x}:y={y}:enable='between(t,{rs},{re})'[{out_lbl}];",
                cur = cur,
                in_idx = in_idx,
                x = *x as i64,
                y = *y as i64,
                rs = fmt_f(*rs),
                re = fmt_f(*re),
                out_lbl = out_lbl,
            ));
            cur = out_lbl;
        }
        if let Some((cx, cy, cw, ch)) = crop {
            let out_lbl = if cur == "0:v" { "vc".to_string() } else { format!("{}c", cur) };
            graph.push_str(&format!(
                "[{cur}]crop={cw}:{ch}:{cx}:{cy}[{out_lbl}];",
                cur = cur,
                cw = (cw * w).round() as i64,
                ch = (ch * h).round() as i64,
                cx = (cx * w).round() as i64,
                cy = (cy * h).round() as i64,
                out_lbl = out_lbl,
            ));
            cur = out_lbl;
        }
        if is_gif {
            let gw = 720i64.min(w as i64) | 1;
            graph.push_str(&format!(
                "[{cur}]fps=14,scale={gw}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5[vout]",
                cur = cur,
                gw = gw,
            ));
            args.push("-filter_complex".into());
            args.push(graph);
            args.push("-map".into());
            args.push("[vout]".into());
        } else {
            graph.pop(); // trailing ';' before -map
            args.push("-filter_complex".into());
            args.push(graph);
            args.push("-map".into());
            args.push(format!("[{}]", cur));
        }
    }

    match fmt.as_str() {
        "webm" => {
            let crf = match quality.as_str() {
                "high" => "30",
                "low" => "36",
                _ => "33",
            };
            args.extend(
                [
                    "-c:v", "libvpx-vp9", "-crf", crf, "-b:v", "0", "-cpu-used", "4",
                    "-row-mt", "1", "-deadline", "realtime", "-pix_fmt", "yuv420p",
                    "-c:a", "libopus", "-b:a", "160k",
                ]
                .iter()
                .map(|s| s.to_string()),
            );
        }
        "gif" => {
            args.extend(["-an".to_string(), "-loop".into(), "0".into()]);
        }
        // mp4 (default)
        _ => {
            let (crf, preset) = match quality.as_str() {
                "high" => ("18", "medium"),
                "low" => ("28", "veryfast"),
                _ => ("23", "fast"),
            };
            args.extend(
                [
                    "-c:v", "libx264", "-preset", preset, "-crf", crf,
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart",
                ]
                .iter()
                .map(|s| s.to_string()),
            );
        }
    }
    args.push(out_path.clone());

    // ---------- spawn ----------
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    // reset cancel BEFORE spawn so a cancel can never be wiped by a late reset
    CANCEL.store(false, Ordering::SeqCst);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit(
                "omp://export-done",
                serde_json::json!({ "ok": false, "error": format!("ffmpeg failed to start: {}", e) }),
            );
            return true;
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *CHILD.lock().unwrap() = Some(child);

    let app_p = app.clone();
    let out_p = out_path.clone();
    thread::spawn(move || {
        // progress pump — `-progress pipe:1` emits `out_time_us=<int>` lines
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(us) = line.strip_prefix("out_time_us=") {
                    if let Ok(us) = us.parse::<f64>() {
                        let elapsed = (us / 1_000_000.0).max(0.0);
                        let pct = if total > 0.3 {
                            (elapsed / total * 100.0).min(99.5)
                        } else {
                            50.0
                        };
                        let _ = app_p.emit(
                            "omp://export-progress",
                            serde_json::json!({ "pct": pct, "elapsed": elapsed, "total": total }),
                        );
                    }
                } else if line == "progress=end" {
                    let _ = app_p.emit(
                        "omp://export-progress",
                        serde_json::json!({ "pct": 99.9, "elapsed": total, "total": total }),
                    );
                }
            }
        }
        // stderr tail (for the error message if it dies)
        let tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let tail2 = tail.clone();
        let err_t = thread::spawn(move || {
            if let Some(err) = stderr {
                let reader = BufReader::new(err);
                for line in reader.lines().map_while(Result::ok) {
                    let mut t = tail2.lock().unwrap();
                    if t.len() >= 6 {
                        t.remove(0);
                    }
                    t.push(line);
                }
            }
        });

        // Poll for exit WITHOUT holding the CHILD lock across wait() —
        // editor_export_cancel must always be able to lock + kill.
        // (try_wait loop: a held lock here would deadlock cancel.)
        let status = loop {
            thread::sleep(std::time::Duration::from_millis(120));
            let st = {
                let mut g = CHILD.lock().unwrap();
                match g.as_mut() {
                    Some(c) => c.try_wait().ok().flatten(),
                    None => None,
                }
            };
            if let Some(s) = st {
                break Some(s);
            }
            // cancel() takes the child out before killing — empty map = cancelled
            if CHILD.lock().unwrap().is_none() {
                break None;
            }
        };
        let _ = CHILD.lock().unwrap().take();
        let _ = err_t.join();

        let cancelled = CANCEL.load(Ordering::SeqCst);
        let ok = matches!(status, Some(s) if s.success());
        if ok {
            let _ = app_p.emit(
                "omp://export-done",
                serde_json::json!({ "ok": true, "out": out_p }),
            );
        } else if cancelled {
            let _ = app_p.emit(
                "omp://export-done",
                serde_json::json!({ "ok": false, "cancelled": true }),
            );
        } else {
            let msg = tail.lock().unwrap().last().cloned().unwrap_or_default();
            let _ = app_p.emit(
                "omp://export-done",
                serde_json::json!({ "ok": false, "error": msg }),
            );
        }
    });
    true
}

/// Kill the running export (real process kill).
#[tauri::command]
pub fn editor_export_cancel() -> bool {
    CANCEL.store(true, Ordering::SeqCst);
    if let Some(mut c) = CHILD.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
        return true;
    }
    false
}
