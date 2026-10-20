// OMP — Open Media Player · native shell
// Owns: window effects (Mica / Acrylic per Windows generation), splash handoff,
// custom titlebar window controls, and shell info for the UI.

use tauri::{AppHandle, Emitter, Manager};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Files passed on the command line (open-with / "default player" launches)
/// that arrived before the UI was ready to listen. Drained by the frontend
/// once via `pending_open_paths`.
static PENDING_OPENS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Media extensions we accept from the command line (open-with integration).
fn is_media_ext(path: &str) -> bool {
    let ext = path
        .rsplit('.')
        .next()
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "mp4" | "mkv" | "webm" | "mov" | "avi" | "m4v" | "wmv" | "flv" | "ts" | "mpg" | "mpeg"
            | "3gp" | "ogv"
            | "mp3" | "flac" | "m4a" | "wav" | "ogg" | "oga" | "opus" | "aac" | "wma"
            | "jpg" | "jpeg" | "png" | "webp" | "bmp" | "gif" | "avif" | "tif" | "tiff"
            | "m3u" | "m3u8"
            | "omptheme"
    )
}

/// First existing media file found in `argv` (skips flags and the exe path).
fn media_from_argv(argv: &[String]) -> Option<String> {
    argv.iter().skip(1).find_map(|a| {
        let a = a.trim();
        if a.is_empty() || a.starts_with('-') {
            return None;
        }
        let p = std::path::Path::new(a);
        if p.is_file() && is_media_ext(a) {
            Some(a.to_string())
        } else {
            None
        }
    })
}

/// Queue + broadcast a file opened via the command line.
fn queue_open(app: &AppHandle, path: String) {
    if let Ok(mut q) = PENDING_OPENS.lock() {
        if !q.contains(&path) {
            q.push(path.clone());
        }
    }
    let _ = app.emit("omp://open-path", path);
}

/// Phase 3: when music is playing, the main window's ✕ hides it (music keeps
/// going + the desktop widget appears) instead of quitting the whole app.
static BACKGROUND_PLAYBACK: AtomicBool = AtomicBool::new(true);

#[cfg(windows)]
#[path = "mpv.rs"]
mod mpv;
#[cfg(not(windows))]
#[path = "mpv_stub.rs"]
mod mpv;

mod library;
mod editor;
mod health;
mod downloader;
mod bootlog;
mod bootguard;

/// Detect the Windows build number from the OS plugin (e.g. "10.0.22631").
#[cfg(windows)]
fn windows_build() -> u32 {
    tauri_plugin_os::version()
        .to_string()
        .split('.')
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// Apply the right material for this Windows generation.
/// Rule from the spec: detect the environment, never assume both render the same.
#[cfg(windows)]
fn apply_effect(window: &tauri::webview::WebviewWindow, mica: bool) {
    use tauri::window::{Effect, EffectsBuilder};
    // If the requested material is unsupported, fall back silently —
    // the CSS layer already ships a translucent fallback.
    let effect = if mica { Effect::Mica } else { Effect::Acrylic };
    if window.set_effects(EffectsBuilder::new().effect(effect).build()).is_err() && mica {
        let _ = window.set_effects(EffectsBuilder::new().effect(Effect::Acrylic).build());
    }
}

/// THE v0.5.0 CPU FIX.
///
/// While the native mpv surface plays video BELOW the transparent webview,
/// any DWM material (Mica / dynamic Acrylic blur-behind) forces the whole
/// window — video frames included — through per-frame blur recomposition.
/// That was the v0.3.0/v0.4.0 CPU burn (70%). So: strip the material the
/// moment playback attaches, restore it on detach. The glass look still
/// exists on every non-playing screen; during playback solid panels win.
#[cfg(windows)]
pub(crate) fn set_playback_effects(app: &AppHandle, playing: bool) {
    if let Some(w) = app.get_webview_window("main") {
        if playing {
            // window-vibrancy 0.8 clears per material: Mica on Win11,
            // Acrylic on Win10 — the same pair apply_effect() sets.
            if windows_build() >= 22000 {
                let _ = window_vibrancy::clear_mica(&w);
            } else {
                let _ = window_vibrancy::clear_acrylic(&w);
            }
        } else {
            apply_effect(&w, windows_build() >= 22000);
        }
    }
}

#[cfg(not(windows))]
pub(crate) fn set_playback_effects(_app: &AppHandle, _playing: bool) {}

/// v0.15.1 — set once the main window has actually been shown this launch
/// (via ui_ready / close_splash / a user-driven show). The boot failsafe
/// only rescues launches where this never happened.
static BOOT_SHOWN: AtomicBool = AtomicBool::new(false);

/// v0.15.1 — safe graphics mode. Some machines (broken GPU drivers, broken
/// WebView2 updates) never paint a first webview frame: the window shows the
/// DWM material with NOTHING on it — the "see-through window" reports. Those
/// launches get help through software VIDEO (SAFE_VIDEO), the reduced-glass
/// CSS class, the plain-window ladder rungs and the boot handshake — NEVER
/// through browser arguments anymore (v0.15.6, THE BROWSER-ARGS RULE in
/// setup(): any difference between windows is fatal, ERROR_INVALID_STATE
/// 0x8007139F). Decided from markers at setup:
///   ui.ok       the UI proved itself at least once (any successful launch)
///   ui.failsafe the last launch needed the 8s failsafe (one-shot, consumed)
///   ui.safe     sticky safe mode (a rescued launch worked here)
pub(crate) static SAFE_MODE: AtomicBool = AtomicBool::new(false);

/// v0.15.1 — WHY this launch runs in safe mode. Rescue-graded (the last
/// launch failed and had to be force-shown, or a previous safe launch was
/// kept) means the machine is genuinely broken → ui_ready makes safe mode
/// STICKY. Probe-graded (fresh install / UI never proved itself) means the
/// machine is UNKNOWN → ui_ready does NOT stick safe mode, so healthy
/// machines silently graduate to normal GPU rendering on launch #2.
pub(crate) static SAFE_STICKY: AtomicBool = AtomicBool::new(false);

/// v0.15.2 — safe VIDEO mode. The webview and mpv break on the SAME broken
/// GPU drivers: a machine that needed --disable-gpu just to draw its UI runs
/// the mpv video output (D3D11 + hardware decode) into the very same wall —
/// the "nothing plays, it crashes" reports. Safe video renders through the
/// D3D11 WARP software rasterizer (built into every Windows install, draws
/// with the CPU, zero GPU-driver code) and force-disables hardware decode.
/// Derived at boot from the same evidence that drives SAFE_MODE.
pub(crate) static SAFE_VIDEO: AtomicBool = AtomicBool::new(false);

/// v0.15.2 — the last session did NOT exit cleanly (crash, hard kill, power
/// loss). Detected from the session.dirty marker a previous launch left
/// behind; grades THIS launch as a rescue for both the webview and the video
/// engine, and surfaces a recovery banner with a one-tap crash report.
pub(crate) static CRASHED_LAST: AtomicBool = AtomicBool::new(false);

/// v0.15.8 — THE CONTROLLER RULE. On Windows, WebView2 composites through
/// the controller's IsVisible flag and that flag does NOT follow the HWND:
/// wry creates the controller invisible together with the hidden window
/// (`controller.SetIsVisible(false)`), and showing the window afterwards
/// never reaches the controller — tauri 2.12.4's `WebviewWindow::show()`
/// forwards to WindowMessage::Show (HWND only), and wry's parent subclass
/// handles WM_SIZE/WM_MOVE/focus but has NO WM_SHOWWINDOW branch. The page
/// kept running perfectly — JS, rAF, the whole handshake — while WebView2
/// never presented a single frame: the flat gray/black "ran but nothing"
/// window. The CI smoke gate reproduced it in every mode on a machine where
/// Edge renders fine, which is what cracked the case. Every show of a
/// window created hidden must therefore show BOTH halves: the HWND and
/// the webview controller.
fn show_webview_window(app: &AppHandle, label: &str) -> bool {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        // the webview half, via the stable AsRef<Webview> accessor —
        // Manager::get_webview exists only under the `unstable` feature
        let _ = w.as_ref().show();
        true
    } else {
        false
    }
}

/// v0.15.1 — the ONE place that surfaces the main window during boot.
/// Idempotent and polite: focus is only taken on the FIRST show, retries
/// never yank the window back in front of the user.
fn show_main(app: &AppHandle) {
    if let Some(m) = app.get_webview_window("main") {
        let first = !BOOT_SHOWN.load(Ordering::Relaxed);
        let _ = show_webview_window(app, "main");
        if first {
            let _ = m.set_focus();
        }
    }
    BOOT_SHOWN.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn close_splash(app: tauri::AppHandle) {
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
    show_main(&app);
    // v0.15.0 — the UI answered: from now on every launch skips the splash.
    if let Ok(d) = app.path().app_data_dir() {
        let _ = std::fs::write(d.join("ui.ok"), b"ok");
    }
}

/// v0.15.1 — THE BOOT HANDSHAKE. The webview calls this (with retries, from
/// an inline pre-React script AND from React) as soon as something real has
/// rendered. The main window only becomes visible here — showing it earlier
/// is what painted the see-through blur window on slow/broken machines.
/// Idempotent: every retry just re-shows an already-shown window.
#[tauri::command]
fn ui_ready(app: tauri::AppHandle) -> serde_json::Value {
    show_main(&app);
    let safe = SAFE_MODE.load(Ordering::Relaxed);
    // v0.15.3 — the interface is ALIVE: the consecutive-failsafe streak ends
    if let Ok(d) = app.path().app_data_dir() {
        let _ = std::fs::remove_file(d.join("ui.fscount"));
        // v0.15.6 — the machine's webview demonstrably works again: the
        // next-boot profile-reset marker is obsolete
        let _ = std::fs::remove_file(d.join("webview.dirty"));
    }
    bootlog::log(&app, "handshake", &format!("ui_ready — interface alive (safe={safe}) · {}", bootlog::states_line(&app)));
    if let Ok(d) = app.path().app_data_dir() {
        let _ = std::fs::write(d.join("ui.ok"), b"ok");
        // this launch answered — a pending one-shot rescue flag is obsolete
        let _ = std::fs::remove_file(d.join("ui.failsafe"));
        if safe {
            if SAFE_STICKY.load(Ordering::Relaxed) {
                // software rendering demonstrably works on a known-broken
                // machine — keep it forever
                let _ = std::fs::write(d.join("ui.safe"), b"ok");
            } else {
                // healthy machine probing — hand it back to the GPU path
                let _ = std::fs::remove_file(d.join("ui.safe"));
            }
        }
    }
    serde_json::json!({ "safe": safe, "crashed": CRASHED_LAST.load(Ordering::Relaxed) })
}

/// v0.15.1 — PAINT VERIFICATION. The handshake proves the page's JavaScript
/// is alive, NOT that frames reach the screen: a broken compositor (the
/// nastiest blank-window failure) runs JS fine and still paints nothing.
/// The inline script watches requestAnimationFrame once the window is
/// visible and reports back.
#[tauri::command]
fn ui_paint_ok(app: AppHandle) {
    // frames confirmed on this launch's graphics path — clear any doubt
    bootlog::log(&app, "paint", "frames confirmed reaching the screen");
    if !SAFE_MODE.load(Ordering::Relaxed) {
        if let Ok(d) = app.path().app_data_dir() {
            let _ = std::fs::remove_file(d.join("ui.failsafe"));
        }
    }
}

#[tauri::command]
fn ui_paint_suspect(app: AppHandle) {
    // window visible, compositor produced nothing for 5s — mark the machine
    // so the NEXT launch runs software rendering
    bootlog::log(&app, "paint", "SUSPECT — no rAF frame within 5s of window show");
    if !SAFE_MODE.load(Ordering::Relaxed) {
        if let Ok(d) = app.path().app_data_dir() {
            let _ = std::fs::write(d.join("ui.failsafe"), b"1");
        }
    }
}

#[tauri::command]
fn win_min(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

#[tauri::command]
fn win_max_toggle(app: tauri::AppHandle) -> bool {
    if let Some(w) = app.get_webview_window("main") {
        let maxed = w.is_maximized().unwrap_or(false);
        if maxed {
            let _ = w.unmaximize();
        } else {
            let _ = w.maximize();
        }
        return w.is_maximized().unwrap_or(false);
    }
    false
}

#[tauri::command]
fn win_close(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.close();
    }
}

/// Shell info for the UI: OS generation drives html[data-win] styling
/// (Windows 10 gets square corners + acrylic, Windows 11 gets Mica + rounded).
#[tauri::command]
fn shell_info() -> serde_json::Value {
    #[cfg(windows)]
    {
        let build = windows_build();
        let v = tauri_plugin_os::version().to_string();
        serde_json::json!({
            "os": "windows",
            "win": if build >= 22000 { "11" } else { "10" },
            "version": v,
            "effects": if build >= 22000 { "mica" } else { "acrylic" },
        })
    }
    #[cfg(not(windows))]
    {
        serde_json::json!({
            "os": std::env::consts::OS,
            "win": "other",
            "version": "0.1.0",
            "effects": "css",
        })
    }
}

/// Phase 3 — desktop widget (a real second window, alive while the main
/// window is hidden, driven by the same omp://mpv events).
///
/// v0.6.1 FIX: window creation inside a *synchronous* command deadlocks the
/// Windows event loop (the builder waits for the loop while the loop waits
/// for the command) — the widget came up white/frozen. The command is now
/// async per the Tauri contract, and the close-to-background path builds the
/// widget from a background thread so the event loop is never blocked.
fn build_widget(app: &tauri::AppHandle) -> bool {
    if let Some(w) = app.get_webview_window("widget") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            return false;
        }
        // controller rule here too — the widget was created visible so its
        // controller is alive, but showing BOTH halves keeps the whole class
        // of "HWND visible, webview invisible" impossible everywhere
        let _ = show_webview_window(app, "widget");
        let _ = w.set_focus();
        return true;
    }
    let widget = tauri::WebviewWindowBuilder::new(
        app,
        "widget",
        tauri::WebviewUrl::App("widget.html".into()),
    )
    .title("OMP — Now Playing")
    .inner_size(340.0, 132.0)
    .min_inner_size(300.0, 100.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    // v0.6.1: shadow OFF for the transparent window — DWM re-renders the
    // shadow on every move and made dragging feel laggy/glitchy, and the
    // frameless-window shadow also drew a 1 px white border. The card draws
    // its own soft shadow in CSS instead.
    .shadow(false)
    .focused(false)
    .visible(true);
    // v0.15.1 — safe graphics mode applies to the widget too — through the
    // reduced-glass CSS class ONLY (v0.15.6): browser arguments must NEVER
    // differ between windows of this process. The splashscreen owns the
    // process's single WebView2 environment; a second request with different
    // args dies with ERROR_INVALID_STATE (0x8007139F).
    let widget = if SAFE_MODE.load(Ordering::Relaxed) {
        widget.initialization_script("document.documentElement.classList.add('reduced');")
    } else {
        widget
    };
    match widget.build() {
        Ok(_) => true,
        Err(e) => {
            eprintln!("OMP widget window: {e}");
            false
        }
    }
}

#[tauri::command]
async fn widget_toggle(app: tauri::AppHandle) -> bool {
    build_widget(&app)
}

/// Expanded ↔ mini widget size, applied from inside the widget UI.
#[tauri::command]
fn widget_set_expanded(app: tauri::AppHandle, expanded: bool) -> bool {
    if let Some(w) = app.get_webview_window("widget") {
        let (wt, ht) = if expanded { (340.0, 432.0) } else { (340.0, 132.0) };
        let _ = w.set_size(tauri::LogicalSize::new(wt, ht));
        return true;
    }
    false
}

/// v0.6.2 — widget position memory: the widget UI saves where the user dragged
/// it (localStorage) and replays it here on every show. Clamped so at least
/// 60 px of the widget stays reachable even if the monitor layout changed.
#[tauri::command]
fn widget_set_pos(app: tauri::AppHandle, x: f64, y: f64) -> bool {
    if let Some(w) = app.get_webview_window("widget") {
        let mut px = x.round() as i32;
        let mut py = y.round() as i32;
        if let Ok(Some(mon)) = w.current_monitor() {
            let mp = mon.position();
            let ms = mon.size();
            let ws = w.outer_size().unwrap_or(tauri::PhysicalSize::new(360, 150));
            let ww = ws.width as i32;
            let min_x = mp.x - (ww - 60).max(0);
            let max_x = mp.x + ms.width as i32 - 60;
            let min_y = mp.y;
            let max_y = mp.y + ms.height as i32 - 60;
            if max_x > min_x {
                px = px.clamp(min_x, max_x);
            }
            if max_y > min_y {
                py = py.clamp(min_y, max_y);
            }
        }
        let _ = w.set_position(tauri::PhysicalPosition::new(px, py));
        return true;
    }
    false
}

/// Widget → bring the (possibly hidden) main window back.
#[tauri::command]
fn app_show_main(app: tauri::AppHandle) -> bool {
    if let Some(w) = app.get_webview_window("main") {
        let _ = show_webview_window(&app, "main");
        let _ = w.unminimize();
        let _ = w.set_focus();
        return true;
    }
    false
}

/// Real quit — used by the widget menu. Releases the engine first.
#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    mpv::shutdown_all();
    app.exit(0);
}

/// Called from Settings: toggle the close-keeps-music behaviour.
#[tauri::command]
fn set_background_playback(v: bool) {
    BACKGROUND_PLAYBACK.store(v, Ordering::Relaxed);
}

/// Paths passed on the command line before the UI was listening
/// (double-click "open with OMP" while booting). Drained once by the UI.
#[tauri::command]
fn pending_open_paths() -> Vec<String> {
    PENDING_OPENS
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default()
}

/// Open the Windows "Default apps" page — used by the Settings row that
/// helps the user make OMP the default player for video/audio/images.
#[tauri::command]
fn open_default_apps() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:defaultapps"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .is_ok()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Read a text playlist (.m3u / .m3u8) from disk for the IPTV importer.
/// Plain text in, plain text out — parsing lives in the frontend so the
/// parser is shared by the web demo too.
#[tauri::command]
fn online_read_file(path: String) -> Option<String> {
    let ext = path
        .rsplit('.')
        .next()
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "m3u" | "m3u8" | "txt" | "omptheme") {
        return None;
    }
    std::fs::read_to_string(&path).ok()
}

/// Phase 6 — persist an .omptheme file (Theme Studio export). Extension-gated
/// like the other file IO: we only ever write theme files from the UI.
#[tauri::command]
fn export_theme_file(path: String, contents: String) -> bool {
    let ext = path
        .rsplit('.')
        .next()
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "omptheme" {
        return false;
    }
    std::fs::write(&path, contents).is_ok()
}

/// Phase 6 — "Check for updates": fetch the latest GitHub release tag and
/// compare it with the running version. Async so the network round-trip never
/// blocks the UI (sync commands run on the main thread — v0.6.1 rule).
#[derive(serde::Serialize)]
struct UpdateInfo {
    latest: String,
    url: String,
    newer: bool,
}

/// "v0.10.0-rc1" → [0, 10, 0]; tolerates build suffixes and junk parts.
fn parse_ver(v: &str) -> Vec<u32> {
    v.trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .split('.')
        .map(|p| p.trim().parse::<u32>().unwrap_or(0))
        .collect()
}

#[tauri::command]
async fn check_update(current: String) -> Option<UpdateInfo> {
    let resp = ureq::get("https://api.github.com/repos/kakadon000/omp/releases/latest")
        .set("User-Agent", "omp-app")
        .set("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(12))
        .call()
        .ok()?;
    let data: serde_json::Value = resp.into_json().ok()?;
    let tag = data.get("tag_name")?.as_str()?.trim().to_string();
    let url = data
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://github.com/kakadon000/omp/releases")
        .to_string();
    if tag.is_empty() {
        return None;
    }
    let cur = parse_ver(&current);
    let lat = parse_ver(&tag);
    // Vec<u32> compare handles 0.9.1 < 0.10.0 and 0.9 < 0.9.1 correctly.
    let newer = lat > cur;
    let latest = tag.trim_start_matches(['v', 'V']).to_string();
    Some(UpdateInfo { latest, url, newer })
}

/// Open an https URL in the system browser (YouTube Music, playlist exports,
/// "get an API key" links). https-only — we never launch local executables.
#[tauri::command]
fn open_url(url: String) -> bool {
    if !url.starts_with("https://") {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .is_ok()
    }
    #[cfg(not(windows))]
    {
        let _ = url; // shell opening is a Windows-only affordance for now
        false
    }
}

/// v0.9.0 — locate the BUNDLED yt-dlp extractor (exe dir / resources layout).
/// v0.9.1 — also accepts the self-repaired copy in %APPDATA%\app.omp.player\engine
/// (the repair center downloads there when the install dir is not writable).
/// Also shared with mpv.rs: when present, the engine gets native playback of
/// YouTube and 1000+ other sites through mpv's ytdl hook.
pub(crate) fn ytdlp_path() -> Option<std::path::PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for rel in [r"resources\yt-dlp.exe", "yt-dlp.exe"] {
                let p = dir.join(rel);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    if let Some(ed) = health::engine_dir(None) {
        let p = ed.join("yt-dlp.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// v0.9.0 — YouTube / youtu.be link detector (for clean refusals when the
/// extractor is missing, instead of feeding HTML to the demuxer).
pub(crate) fn is_youtube_url(s: &str) -> bool {
    let l = s.trim().to_ascii_lowercase();
    (l.starts_with("http://") || l.starts_with("https://"))
        && (l.contains("youtube.com/") || l.contains("youtu.be/"))
}

/// v0.9.0 — extractor availability for Settings + the Online screen.
#[derive(serde::Serialize)]
pub struct YtdlpStatus {
    pub available: bool,
    pub path: String,
}

#[tauri::command]
fn online_ytdlp_status() -> YtdlpStatus {
    match ytdlp_path() {
        Some(p) => YtdlpStatus {
            available: true,
            path: p.to_string_lossy().into_owned(),
        },
        None => YtdlpStatus {
            available: false,
            path: String::new(),
        },
    }
}

/// v0.9.0 — keyless YouTube search through the bundled yt-dlp:
/// `yt-dlp --flat-playlist --dump-json "ytsearchN:query"` → one JSON line per
/// result. Runs with a hard timeout so a dead network can't hang the UI.
#[tauri::command]
fn online_yt_search(query: String, max: Option<u32>) -> Result<String, String> {
    let exe = ytdlp_path().ok_or_else(|| "yt-dlp is not bundled in this install".to_string())?;
    let q = query.trim();
    if q.is_empty() {
        return Err("empty query".into());
    }
    let n = max.unwrap_or(20).clamp(1, 40);
    use std::io::Read;
    use std::process::Stdio;
    #[cfg(windows)]
    let mut child = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(&exe)
            .args([
                "--flat-playlist",
                "--dump-json",
                "--no-warnings",
                "--quiet",
                "--no-progress",
                &format!("ytsearch{}:{}", n, q),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("could not start yt-dlp: {e}"))?
    };
    #[cfg(not(windows))]
    let mut child = std::process::Command::new(&exe)
        .args([
            "--flat-playlist",
            "--dump-json",
            "--no-warnings",
            "--quiet",
            "--no-progress",
            &format!("ytsearch{}:{}", n, q),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
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
                let _ = stdout.read_to_string(&mut buf);
                if !status.success() && buf.trim().is_empty() {
                    return Err(format!("yt-dlp exited with {status}"));
                }
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    return Err("search timed out (network too slow?)".into());
                }
                // drain incrementally so a chatty pipe can't deadlock
                let mut chunk = [0u8; 8192];
                match stdout.read(&mut chunk) {
                    Ok(0) => std::thread::sleep(std::time::Duration::from_millis(60)),
                    Ok(k) => buf.push_str(&String::from_utf8_lossy(&chunk[..k])),
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(60)),
                }
            }
            Err(e) => return Err(format!("yt-dlp wait failed: {e}")),
        }
    }

    // flat-playlist entries → the same shape the YouTube Data API path emits
    let mut out: Vec<serde_json::Value> = Vec::new();
    for line in buf.lines() {
        let l = line.trim();
        if !l.starts_with('{') {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else {
            continue;
        };
        let id = v["id"].as_str().unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let url = v["url"]
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={id}"));
        out.push(serde_json::json!({
            "id": id,
            "title": v["title"].as_str().unwrap_or("Untitled"),
            "thumb": format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"),
            "duration": v["duration"].as_f64().unwrap_or(0.0),
            "views": v["view_count"].as_u64().unwrap_or(0),
            "channel": v["channel"]
                .as_str()
                .or_else(|| v["uploader"].as_str())
                .unwrap_or(""),
            "published": "",
            "live": v["is_live"].as_bool().unwrap_or(false),
            "url": url,
        }));
    }
    if out.is_empty() {
        return Err("no results (or the extractor could not reach YouTube)".into());
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

/// v0.9.1 — KEYLESS YouTube search with zero bundled processes: the same
/// innerTube endpoint the YouTube web app itself uses. This is the in-built
/// YouTube API the UI calls first — it works even when antivirus removed
/// yt-dlp.exe, it spawns nothing, and it never needs a Data API key.
/// Result rows are shaped EXACTLY like online_yt_search so the frontend maps
/// both with one function.
#[tauri::command]
fn online_innertube_search(query: String, max: Option<u32>) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("empty query".into());
    }
    let n = max.unwrap_or(20).clamp(1, 40) as usize;
    let body = serde_json::json!({
        "context": {
            "client": {
                "clientName": "WEB",
                "clientVersion": "2.20240726.00.00",
                "hl": "en",
                "gl": "US"
            }
        },
        "query": q
    });
    let resp = ureq::post("https://www.youtube.com/youtubei/v1/search?prettyPrint=false")
        .set("Content-Type", "application/json")
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
        .set("Accept-Language", "en-US,en;q=0.9")
        .timeout(std::time::Duration::from_secs(20))
        .send_string(&body.to_string())
        .map_err(|e| format!("YouTube search failed: {e}"))?;
    let data: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;

    // layout-proof extraction: walk the whole response and collect every
    // videoRenderer object (search layouts change; the payload key does not)
    fn collect(node: &serde_json::Value, out: &mut Vec<serde_json::Value>) {
        match node {
            serde_json::Value::Object(map) => {
                if let Some(vr) = map.get("videoRenderer") {
                    out.push(vr.clone());
                }
                for v in map.values() {
                    collect(v, out);
                }
            }
            serde_json::Value::Array(arr) => {
                for v in arr {
                    collect(v, out);
                }
            }
            _ => {}
        }
    }
    let mut renderers: Vec<serde_json::Value> = Vec::new();
    collect(&data, &mut renderers);

    fn runs_text(v: &serde_json::Value) -> String {
        if let Some(s) = v["simpleText"].as_str() {
            return s.to_string();
        }
        v["runs"]
            .as_array()
            .map(|rs| {
                rs.iter()
                    .map(|r| r["text"].as_str().unwrap_or("").to_string())
                    .collect::<String>()
            })
            .unwrap_or_default()
    }
    fn text_to_secs(s: &str) -> f64 {
        let mut secs = 0f64;
        for part in s.split(':') {
            secs = secs * 60.0 + part.trim().parse::<f64>().unwrap_or(0.0);
        }
        secs
    }
    fn text_to_views(s: &str) -> u64 {
        let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
        digits.parse().unwrap_or(0)
    }

    let mut out: Vec<serde_json::Value> = Vec::new();
    for vr in renderers.iter().take(n) {
        let id = vr["videoId"].as_str().unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let title = runs_text(&vr["title"]);
        if title.is_empty() {
            continue;
        }
        let channel = {
            let c = runs_text(&vr["ownerText"]);
            let c = if c.is_empty() { runs_text(&vr["longBylineText"]) } else { c };
            if c.is_empty() { runs_text(&vr["shortBylineText"]) } else { c }
        };
        let len_text = runs_text(&vr["lengthText"]);
        let views_text = runs_text(&vr["viewCountText"]);
        let badges = vr["badges"].as_array().map(|a| a.len()).unwrap_or(0);
        let live = len_text.is_empty()
            && (badges > 0
                || views_text.to_ascii_lowercase().contains("watching"));
        let duration = if live { 0.0 } else { text_to_secs(&len_text) };
        out.push(serde_json::json!({
            "id": id,
            "title": title,
            "thumb": format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"),
            "duration": duration,
            "views": text_to_views(&views_text),
            "channel": channel,
            "published": runs_text(&vr["publishedTimeText"]),
            "live": live,
            "url": format!("https://www.youtube.com/watch?v={id}"),
        }));
    }
    if out.is_empty() {
        return Err("YouTube returned no results (network or consent wall?)".into());
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────────
// v0.15.7 — THE GPU POLICY RULE (part 2 of the engine rule).
//
// v0.15.6 made the browser-args rule absolute: NO per-window
// additional_browser_args anywhere, because any difference between two
// webview creations of this process is fatal (ERROR_INVALID_STATE,
// 0x8007139F — six release rounds of it). That fixed window creation, but
// the v0.15.6 field test surfaced the cost: SAFE_MODE no longer had ANY
// way to take the GPU out of the webview's rendering loop. A machine with
// a broken GPU compositor runs the webview's JavaScript on the CPU just
// fine — the handshake passes, ui_ready fires, no failsafe, no report —
// while the screen stays BLACK. That is the original v0.15.1-era disease,
// alive again with no cure shipped.
//
// The way back is the one channel that CANNOT create an args mismatch:
// the WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS environment variable. The
// WebView2 loader documents (WebView2.h, CreateCoreWebView2Environment-
// WithOptions) that when this variable is present it REPLACES the
// additionalBrowserArguments of EVERY environment creation in the
// process — no merging, no per-window variation possible. It is set (or
// removed) here, before the Tauri builder exists, before the config
// splashscreen, before ANY window:
//   safe mode   → wry's exact default flags + --disable-gpu
//                 (default string verified against wry-v0.57.0
//                 src/webview2/mod.rs; tauri never sets the autoplay
//                 attribute, so the wry default is static for us)
//   normal mode → variable removed; every window carries wry's identical
//                 default string (v0.15.6 behavior, unchanged)
// Both modes are uniform BY CONSTRUCTION — one process, one rule, zero
// exceptions, 0x8007139F impossible in either.
//
// decide_boot_modes() is the single decision point for how THIS boot
// runs. It reads the same on-disk markers setup() used to read (the same
// folder — tauri's app_data_dir() = %APPDATA%\app.omp.player), stores the
// decision into the SAFE_* statics and MUST run before Builder::build().
// setup() consumes the statics and never re-derives them.
fn decide_boot_modes() {
    #[cfg(windows)]
    {
        let markers = std::env::var_os("APPDATA")
            .map(|p| std::path::PathBuf::from(p).join("app.omp.player"));
        let has = |name: &str| {
            markers
                .as_ref()
                .map(|d| d.join(name).is_file())
                .unwrap_or(false)
        };
        let booted_once = has("ui.ok");
        let rescued = has("ui.failsafe");
        let safe_sticky = has("ui.safe");
        let crashed_last = has("session.dirty");

        // identical formula to the one setup() used through v0.15.6 —
        // safe graphics when: the last launch needed the failsafe, OR a
        // previous safe launch succeeded (sticky), OR the UI has NEVER
        // come up on this machine (fresh-install probe), OR the last
        // session did not exit cleanly (crash memory rescue).
        let safe = rescued || safe_sticky || !booted_once || crashed_last;
        SAFE_MODE.store(safe, Ordering::Relaxed);
        // only a PROVEN-broken machine keeps safe mode after a success —
        // a probe launch (fresh install) graduates back to the GPU path
        SAFE_STICKY.store(rescued || safe_sticky || crashed_last, Ordering::Relaxed);
        // v0.15.2 — the video engine follows the webview: same wall, same fix
        SAFE_VIDEO.store(
            SAFE_MODE.load(Ordering::Relaxed) || SAFE_STICKY.load(Ordering::Relaxed),
            Ordering::Relaxed,
        );
        CRASHED_LAST.store(crashed_last, Ordering::Relaxed);

        // THE ENGINE FLAGS — fixed for the whole process lifetime; every
        // WebView2 environment creation in this process reads them.
        if safe {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu",
            );
        } else {
            std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
        }
    }
}

pub fn run() {
    // v0.15.4 — NEVER SILENT. Every previous "nothing at all happens" report
    // traced to deaths BEFORE the Tauri app existed: a missing/broken WebView2
    // Runtime (or any window-creation failure) hit `.expect()`, the panic
    // vanished behind windows_subsystem="windows" (no console), and the
    // process evaporated with no window, no report and no log entry. From
    // this version on, NO failure path is invisible:
    //   preflight  — the WebView2 Runtime is probed before anything is built;
    //                if it cannot answer, a native Windows dialog explains
    //                the fix and OMP-report.txt lands on the Desktop.
    //   panic hook — any panic leaves a Desktop report; pre-boot panics also
    //                pop a real dialog.
    //   fatal()    — the old `.expect()` is gone: a failed boot ends with a
    //                dialog naming the failure + a Desktop report.
    bootguard::install_panic_hook();
    bootguard::preflight();
    // v0.15.6 — PRE-BOOT WEBVIEW RECOVERY, still before ANY Tauri machinery:
    // sweeps msedgewebview2.exe orphans left by crashed sessions and, after
    // repeated webview-creation failures, factory-resets the browser profile.
    // Marker-gated — a healthy machine pays nothing. Details in bootguard.rs.
    bootguard::webview_recovery();
    // v0.15.7 — decide how THIS boot runs (safe mode, engine flags) BEFORE
    // anything that can create a webview. THE GPU POLICY RULE, above.
    decide_boot_modes();
    let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
    tauri::Builder::default()
        // MUST be the first plugin: catches second launches (double-clicking
        // more media files) and forwards their paths to the running app
        // instead of spawning a second OMP process.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(p) = media_from_argv(&argv) {
                queue_open(app, p);
            }
            // a second launch means the user wants OMP on screen
            if let Some(w) = app.get_webview_window("main") {
                let _ = show_webview_window(app, "main");
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            close_splash,
            ui_ready,
            ui_paint_ok,
            ui_paint_suspect,
            win_min,
            win_max_toggle,
            win_close,
            shell_info,
            mpv::mpv_status,
            mpv::mpv_attach,
            mpv::mpv_detach,
            mpv::mpv_set_rect,
            mpv::mpv_load,
            mpv::mpv_stop,
            mpv::mpv_toggle_pause,
            mpv::mpv_set_paused,
            mpv::mpv_seek,
            mpv::mpv_set_speed,
            mpv::mpv_set_volume,
            mpv::mpv_set_muted,
            mpv::mpv_set_eq,
            mpv::mpv_set_af,
            mpv::mpv_set_transform,
            mpv::mpv_set_ab,
            mpv::mpv_set_delays,
            mpv::mpv_sub_visibility,
            mpv::mpv_sub_add,
            mpv::mpv_set_track,
            mpv::mpv_snapshot,
            mpv::mpv_stats,
            mpv::mpv_retest,
            library::library_add_folder,
            library::library_folders,
            library::library_remove_folder,
            library::library_rescan,
            library::library_cancel_scan,
            library::library_scan_status,
            library::library_list,
            library::library_continue,
            library::library_remove_item,
            library::library_note_play,
            library::library_note_progress,
            library::library_stats,
            library::library_reveal,
            library::playlist_create,
            library::playlists_all,
            library::playlist_delete,
            library::playlist_add,
            library::playlist_remove_item,
            library::playlist_items,
            editor::editor_ffmpeg_status,
            editor::editor_media_probe,
            editor::editor_write_png,
            editor::editor_write_project,
            editor::editor_read_project,
            editor::editor_export,
            editor::editor_export_cancel,
            widget_toggle,
            widget_set_expanded,
            widget_set_pos,
            app_show_main,
            app_quit,
            set_background_playback,
            pending_open_paths,
            open_default_apps,
            online_read_file,
            open_url,
            export_theme_file,
            check_update,
            online_ytdlp_status,
            online_yt_search,
            online_innertube_search,
            health::omp_health,
            health::omp_repair_download,
            health::omp_open_install_folder,
            downloader::dl_status,
            downloader::dl_fetch_info,
            downloader::dl_start,
            downloader::dl_cancel,
            downloader::dl_history_add,
            downloader::dl_history_list,
            downloader::dl_history_clear,
            mpv::mpv_diag,
            bootlog::omp_diag_pack,
            bootlog::omp_report_desktop
        ])
        .on_window_event(|window, event| {
            // Phase 3: closing the main window while music plays → hide it and
            // surface the desktop widget instead of killing playback.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main"
                    && BACKGROUND_PLAYBACK.load(Ordering::Relaxed)
                    && mpv::is_audio_active()
                {
                    api.prevent_close();
                    let _ = window.hide();
                    // the widget is the recovery UI — make sure it's up.
                    // Built from a background thread: window creation from
                    // inside this event-loop handler would deadlock Windows.
                    let app2 = window.app_handle().clone();
                    std::thread::spawn(move || {
                        let _ = build_widget(&app2);
                    });
                }
            }
        })
        .setup(|app| {
            // v0.15.1 — BOOT MARKERS. Marker files in the app data dir decide
            // how this launch boots:
            //   ui.ok       the UI proved itself at least once (any launch)
            //   ui.failsafe the last launch needed the failsafe (one-shot)
            //   ui.safe     sticky safe-graphics mode (software rendering)
            let data_dir = app.path().app_data_dir().ok();
            let has_marker = |name: &str| {
                data_dir
                    .as_ref()
                    .map(|d| d.join(name).is_file())
                    .unwrap_or(false)
            };
            let booted_once = has_marker("ui.ok");
            // v0.15.7 — SAFE_MODE / SAFE_STICKY / SAFE_VIDEO / CRASHED_LAST are
            // decided BEFORE the builder (decide_boot_modes, THE GPU POLICY
            // RULE) because the webview engine flags must be fixed before the
            // FIRST webview exists — the config splashscreen included. This
            // hook only consumes the decision; it never re-derives it.
            let crashed_last = CRASHED_LAST.load(Ordering::Relaxed);
            // consume the one-shot rescue marker (ui_ready re-decides it)
            if let Some(d) = &data_dir {
                let _ = std::fs::remove_file(d.join("ui.failsafe"));
            }
            // v0.15.3 — FLIGHT RECORDER: every boot decision lands in the log
            let apph = app.handle().clone();
            bootlog::log(&apph, "boot", &format!("OMP v{} starting", env!("CARGO_PKG_VERSION")));
            bootlog::log(&apph, "boot", &bootlog::states_line(&apph));
            // v0.15.7 — the exact engine flags this whole boot runs with
            // (set process-wide by decide_boot_modes before any webview)
            let flags = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
                .unwrap_or_else(|_| "engine defaults (no override)".into());
            bootlog::log(&apph, "boot", &format!("webview engine flags: {flags}"));
            // v0.15.6 — what the pre-boot recovery swept/reset before we got here
            let rec = bootguard::recovery_note();
            if !rec.is_empty() {
                bootlog::log(&apph, "boot", &format!("pre-boot webview recovery: {rec}"));
            }
            // v0.15.3 — CONSECUTIVE-FAILSAFE ESCALATION. ui.fscount counts how
            // many launches in a row never painted. At 2+, even the safe-mode
            // glass stack is distrusted: the window becomes a plain opaque
            // window with NO DWM material — the most conservative surface
            // Windows can draw. If even that fails, the Desktop report fires.
            let fs_count: u32 = data_dir
                .as_ref()
                .and_then(|d| std::fs::read_to_string(d.join("ui.fscount")).ok())
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);
            let plain_window = fs_count >= 2;
            if plain_window {
                bootlog::log(&apph, "boot", &format!("{fs_count} consecutive failed boots — launching a PLAIN opaque window (no transparency, no material)"));
            }
            // v0.15.3 — crash recovery writes the report BEFORE anything can
            // fail: even a dead webview cannot stop the Desktop file
            if crashed_last {
                bootlog::write_desktop_report(
                    &apph,
                    "OMP did not close cleanly last time. This launch already runs in maximum-compatibility mode (software UI + software video). If anything still misbehaves, send this file to the developer.",
                );
            }
            // v0.15.1 — the main window is built HERE (not in tauri.conf.json)
            // so its surface can adapt to the machine. The window stays
            // INVISIBLE until the webview proves it rendered something
            // (ui_ready) — no more see-through windows with nothing painted
            // inside.
            // v0.15.5 — THE WINDOW LADDER. The first real field report (the
            // v0.15.4 OMP-report.txt) showed WebView2 dying with HRESULT
            // 0x8007139F while creating the MAIN window — while the
            // splashscreen, created moments earlier, succeeded. v0.15.5
            // answered with a ladder of window styles; the v0.15.5 field
            // report answered back: ALL FOUR rungs failed IDENTICALLY — so
            // the style was never the problem. The real difference between
            // the working splash and every dying rung was THE BROWSER
            // ARGUMENTS (see THE BROWSER-ARGS RULE below). The ladder stays:
            // it is still the right answer for machines that reject fancy
            // window surfaces — but the args poison is gone.
            // ============================================================
            // v0.15.6 — THE BROWSER-ARGS RULE. NO additional_browser_args on
            // ANY window, on ANY rung, in ANY mode. Forever.
            //
            // Tauri creates the config-defined splashscreen — and with it
            // the process's ONE WebView2 browser process — BEFORE this setup
            // hook runs, with wry's DEFAULT arguments. WebView2 allows one
            // browser process per user-data folder, started with the FIRST
            // environment's options; a later environment request carrying
            // DIFFERENT additional arguments is answered with
            // ERROR_INVALID_STATE — HRESULT 0x8007139F, the exact error in
            // both field reports.
            //
            // v0.15.1–v0.15.5 passed --disable-gpu here whenever SAFE_MODE
            // was active — and SAFE_MODE is active on EVERY fresh install
            // (the probe boot, !booted_once) and EVERY post-crash boot
            // (rescue, session.dirty). On the reporting machine that meant
            // every launch since v0.15.1 died before the window existed —
            // six release rounds, one self-inflicted wound.
            //
            // Even hand-typed copies of wry's default string are NOT safe:
            // wry appends autoplay/proxy arguments per webview, so any
            // explicit string misses the real effective set. The only
            // correct value is NONE — identical to the splashscreen.
            //
            // Only per-webview SURFACE things may vary: window styles (this
            // ladder) and initialization scripts (per-webview, environment-
            // safe). SAFE_MODE keeps its meaning through SAFE_VIDEO (mpv
            // WARP), the reduced-glass CSS class and these rungs.
            // ============================================================
            let build_rung = |app: &tauri::App, rung: u8| -> Result<tauri::WebviewWindow, tauri::Error> {
                // rung 1: the full glass profile
                // rung 2: no shadow
                // rung 3: no transparency — plain opaque frameless window
                // rung 4: native decorations — the most vanilla surface
                let transp = rung <= 2 && !plain_window;
                let mut b = tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("OMP — Open Media Player")
                .inner_size(1220.0, 780.0)
                .min_inner_size(860.0, 560.0)
                .decorations(rung >= 4)
                .transparent(transp)
                .visible(false)
                .center()
                .shadow(rung <= 2);
                if SAFE_MODE.load(Ordering::Relaxed) {
                    // reduced glass from frame 1 — a per-webview script,
                    // NOT an environment option: this is allowed to vary
                    b = b.initialization_script(
                        "document.documentElement.classList.add('reduced');document.documentElement.dataset.safegfx='1';",
                    );
                }
                b.build()
            };
            let saved_rung: Option<u8> = data_dir
                .as_ref()
                .and_then(|d| std::fs::read_to_string(d.join("ui.winrung")).ok())
                .and_then(|s| s.trim().parse().ok())
                .filter(|n| (1..=4).contains(n));
            // v0.15.8 — THE OPAQUE SAFE RULE. Safe graphics exists for machines
            // whose compositor cannot be trusted — and the new CI smoke gate
            // PROVED the remaining trap on a real Windows machine: a glass
            // window (rung 1) whose webview is fully alive — rAF frames fire,
            // the handshake lands, ui.ok is written — while the DWM backdrop
            // behind the transparent surface shows a flat gray/black fill
            // forever. Nothing fails, nothing escalates, no report: the user
            // sees "ran but nothing, black" on every launch. The lesson: rAF
            // proves the PAGE renders, never that the WINDOW does. So safe
            // mode never builds glass at all — the ladder is restricted to
            // the opaque rungs (3: opaque frameless, 4: native decorations),
            // where the visible surface is the webview's own software-rendered
            // texture over a solid background. Glass stays a healthy-machine
            // feature; a sticky rung < 3 is ignored under safe mode and the
            // opaque rung re-wins (and is re-saved) this boot.
            let safe_gfx = SAFE_MODE.load(Ordering::Relaxed);
            let mut rungs: Vec<u8> = match saved_rung {
                Some(r) if !(safe_gfx && r < 3) => {
                    bootlog::log(&apph, "boot", &format!("sticky window profile: rung {r} (ui.winrung)"));
                    vec![r]
                }
                _ => vec![1, 2, 3, 4],
            };
            // the sticky profile is tried first; if IT fails this time, fall
            // through the whole ladder before giving up
            if saved_rung.is_some() {
                rungs.extend((1u8..=4).filter(|r| Some(*r) != saved_rung));
            }
            if safe_gfx {
                rungs.retain(|r| *r >= 3);
                bootlog::log(&apph, "boot", "safe graphics — window ladder restricted to the opaque rungs (3, 4); glass is a healthy-machine feature");
            }
            let mut win_rung: Option<u8> = None;
            let mut rung_errors: Vec<String> = Vec::new();
            for rung in rungs {
                match build_rung(app, rung) {
                    Ok(_) => {
                        if Some(rung) != saved_rung {
                            if let Some(d) = &data_dir {
                                let _ = std::fs::write(d.join("ui.winrung"), rung.to_string());
                            }
                        }
                        bootlog::log(&apph, "boot", &format!("main window created — rung {rung} wins"));
                        win_rung = Some(rung);
                        break;
                    }
                    Err(e) => {
                        bootlog::log(&apph, "boot", &format!("window rung {rung} FAILED: {e}"));
                        rung_errors.push(format!("profile {rung}: {e}"));
                        std::thread::sleep(std::time::Duration::from_millis(250));
                    }
                }
            }
            let Some(win_rung) = win_rung else {
                // v0.15.6 — remember the catastrophe: the next boot sweeps
                // zombie engine processes and factory-resets the browser
                // profile (EBWebView) BEFORE Tauri builds anything. Cleared
                // again by ui_ready once the interface proves itself. Capped
                // at 3 attempts so a lost cause never eats logins forever.
                if let Some(d) = &data_dir {
                    let n: u32 = std::fs::read_to_string(d.join("webview.dirty"))
                        .ok()
                        .and_then(|s| s.trim().parse().ok())
                        .unwrap_or(0)
                        + 1;
                    let _ = std::fs::write(d.join("webview.dirty"), n.to_string());
                }
                bootlog::log(&apph, "boot", "ALL window profiles failed — webview.dirty set for next-boot recovery");
                return Err(format!(
                    "OMP could not create its main window on any of {} window profiles ({}) — if this persists, close OMP, then simply open it again: the next launch clears leftover engine processes and resets the browser profile automatically",
                    rung_errors.len(),
                    rung_errors.join(" | ")
                )
                .into());
            };
            // Window materials. The DWM material is OS-side — it is NOT
            // affected by the webview's software rendering, so safe mode keeps
            // the glass look. v0.15.0 — the splash window gets NO Mica/Acrylic:
            // its material fills the window rect with sharp corners and
            // defeats the rounded glass card.
            #[cfg(windows)]
            {
                let mica = windows_build() >= 22000;
                if let Some(w) = app.get_webview_window("main") {
                    // v0.15.3 — plain-window mode skips DWM materials entirely;
                    // v0.15.5 — ladder rungs 3/4 built an OPAQUE window, so the
                    // material must be skipped for them too
                    if win_rung <= 2 && !plain_window {
                        apply_effect(&w, mica);
                    }
                }
            }
            // Splash choreography — first launch (the UI never proved itself
            // on this machine) shows the splash while the webview warms up.
            // EVERY launch after shows nothing until ui_ready lands: the
            // window then appears with real content already painted.
            if !booted_once {
                if app.get_webview_window("splashscreen").is_some() {
                    // the controller rule applies to the splash too: it is
                    // created hidden by the config and must show both halves
                    let _ = show_webview_window(app.app_handle(), "splashscreen");
                }
            }
            // FAILSAFE — the boot can never trap the app or show an empty
            // window forever. If after 8s the webview never proved itself:
            // retire the splash, force-surface the main window and mark the
            // machine so the NEXT launch runs software rendering.
            {
                let app2 = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    if let Some(s) = app2.get_webview_window("splashscreen") {
                        let _ = s.close();
                    }
                    if !BOOT_SHOWN.load(Ordering::Relaxed) {
                        if let Ok(d) = app2.path().app_data_dir() {
                            let _ = std::fs::write(d.join("ui.failsafe"), b"1");
                            // v0.15.3 — count consecutive dead boots; setup() escalates to a plain opaque window at 2+
                            let n: u32 = std::fs::read_to_string(d.join("ui.fscount"))
                                .ok()
                                .and_then(|s| s.trim().parse().ok())
                                .unwrap_or(0)
                                + 1;
                            let _ = std::fs::write(d.join("ui.fscount"), n.to_string());
                        }
                        // v0.15.3 — the report lands on the Desktop even when
                        // the webview is completely dead, with escalation-aware
                        // guidance (WebView2 repair advice at streak >= 2)
                        let streak = fs_count + 1;
                        let reason = if streak >= 2 {
                            "The OMP interface failed to boot AGAIN — even in maximum-compatibility mode. The WebView2 runtime itself is the prime suspect. FIX: install the Microsoft WebView2 Runtime from https://developer.microsoft.com/microsoft-edge/webview2/ (Evergreen Standalone Installer, x64), then restart the PC and open OMP. Or simply send this file to the developer — it contains the full boot log."
                        } else {
                            "The OMP interface failed to boot this time. The next launch will automatically retry in maximum-compatibility mode (software rendering). If OMP opens on the next try, you can ignore this file — otherwise send it to the developer."
                        };
                        bootlog::write_desktop_report(&app2, reason);
                        bootlog::log(&app2, "failsafe", &format!("8s elapsed, UI never proved itself — force-showing the window (streak now {streak})"));
                        // v0.15.4 — repeated failure gets a VISIBLE Windows
                        // dialog, not just a file the user may never notice
                        if streak >= 2 {
                            bootguard::repair_prompt();
                        }
                        show_main(&app2);
                    }
                });
            }
            // "Open with OMP" / default-player launch: collect media paths
            // from OUR command line before the UI mounts; the UI drains them
            // via pending_open_paths once its listeners are up.
            let own_args: Vec<String> = std::env::args().collect();
            if let Some(p) = media_from_argv(&own_args) {
                if let Ok(mut q) = PENDING_OPENS.lock() {
                    q.push(p);
                }
            }
            // Phase 2: SQLite media library (opened lazily; no scan at boot —
            // the spec forbids background disk work while idle)
            if let Ok(data_dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&data_dir);
                let thumbs = data_dir.join("thumbs");
                let _ = std::fs::create_dir_all(&thumbs);
                let db_path = data_dir.join("library.db");
                match library::open_db(&db_path) {
                    Ok(conn) => {
                        app.manage(library::LibraryState::new(conn, db_path, thumbs));
                    }
                    Err(e) => eprintln!("OMP library: db open failed: {e}"),
                }
            }
            // v0.15.2 — arm crash memory. If the process dies without reaching
            // the clean-exit handler, this marker survives on disk and the NEXT
            // launch boots in maximum-compatibility mode (software UI + software
            // video) with a recovery banner.
            if let Some(d) = &data_dir {
                let _ = std::fs::write(d.join("session.dirty"), b"1");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
    }));
    let app = match built {
        Ok(Ok(app)) => app,
        Ok(Err(e)) => {
            // fatal() never returns: dialog + Desktop report + exit(2)
            bootguard::fatal(
                "OMP failed to start — its interface could not be created.",
                &format!(
                    "The window system reported: {e}\n\
                     The most common cause is a broken or missing WebView2 Runtime — the \
                     component every OMP window is drawn with. Installing Microsoft's \
                     Evergreen Standalone Installer (x64) and restarting the PC fixes it.\
                     \n\nOtherwise, send the report to the developer — it names the exact failure."
                ),
            )
        }
        Err(_) => {
            // the panic hook already wrote the report and showed the dialog
            std::process::exit(101);
        }
    };
    bootguard::mark_app_live();
    app.run(|app, event| {
            // release the native engine + video surface cleanly
            if let tauri::RunEvent::Exit = event {
                bootlog::log(app, "exit", "clean exit — engine released, session marked clean");
                mpv::shutdown_all();
                // v0.15.2 — clean goodbye: retire the crash-memory marker so
                // the next launch is graded normally. A crash never reaches
                // this line, leaving the marker behind to trigger the rescue.
                if let Ok(d) = app.path().app_data_dir() {
                    let _ = std::fs::remove_file(d.join("session.dirty"));
                }
            }
        });
}
