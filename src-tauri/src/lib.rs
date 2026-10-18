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

#[tauri::command]
fn close_splash(app: tauri::AppHandle) {
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
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
        let _ = w.show();
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
        let _ = w.show();
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
    if !matches!(ext.as_str(), "m3u" | "m3u8" | "txt") {
        return None;
    }
    std::fs::read_to_string(&path).ok()
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

pub fn run() {
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
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            close_splash,
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
            mpv::mpv_diag
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
            // Window materials, applied before the main window is shown.
            #[cfg(windows)]
            {
                let mica = windows_build() >= 22000;
                if let Some(w) = app.get_webview_window("main") {
                    apply_effect(&w, mica);
                }
                if let Some(s) = app.get_webview_window("splashscreen") {
                    apply_effect(&s, mica);
                }
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
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building OMP")
        .run(|_app, event| {
            // release the native engine + video surface cleanly
            if let tauri::RunEvent::Exit = event {
                mpv::shutdown_all();
            }
        });
}
