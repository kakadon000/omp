// OMP — Open Media Player · native shell
// Owns: window effects (Mica / Acrylic per Windows generation), splash handoff,
// custom titlebar window controls, and shell info for the UI.

use tauri::{AppHandle, Manager};

use std::sync::atomic::{AtomicBool, Ordering};

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
#[tauri::command]
fn widget_toggle(app: tauri::AppHandle) -> bool {
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
        &app,
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
    .shadow(true)
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

pub fn run() {
    tauri::Builder::default()
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
            widget_toggle,
            widget_set_expanded,
            app_show_main,
            app_quit,
            set_background_playback
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
                    // the widget is the recovery UI — make sure it's up
                    let _ = widget_toggle(window.app_handle().clone());
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
