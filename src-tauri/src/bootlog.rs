//! v0.15.3 — THE BLACK-BOX FLIGHT RECORDER.
//!
//! Three release rounds of "it's not working" with zero diagnostics forced
//! this: OMP now records EVERYTHING that happens at boot and during engine
//! operations into a rolling log, and when the app is in trouble it writes a
//! human-readable report file straight to the user's Desktop — no buttons to
//! press, no in-app UI required. A file that just appears on the Desktop can
//! be dragged into a chat, which is the only delivery path that has ever
//! actually worked with a broken UI on a broken machine.

use std::fs;
use std::io::Write as _;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// when this log line was written: UTC day-index + clock, no chrono dep
/// (v0.15.4: shared with bootguard's pre-boot reports)
pub(crate) fn stamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (day, tod) = (secs / 86400, secs % 86400);
    format!("day{} {:02}:{:02}:{:02}", day, tod / 3600, (tod % 3600) / 60, tod % 60)
}

fn logs_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("logs"))
}

/// Append one line to <app_data>/logs/boot.log (rotated at 256 KB to
/// boot.1.log). Never panics, never fails the caller — logging must be
/// incapable of making a bad boot worse.
pub fn log(app: &AppHandle, tag: &str, msg: &str) {
    let Some(dir) = logs_dir(app) else { return };
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("boot.log");
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > 256 * 1024 {
            // Windows rename fails if the target exists — clear it first
            let _ = fs::remove_file(dir.join("boot.1.log"));
            let _ = fs::rename(&path, dir.join("boot.1.log"));
        }
    }
    let line = format!("{} [{tag}] {msg}\n", stamp());
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// one-line summary of every boot marker + the safe-mode decisions
pub fn states_line(app: &AppHandle) -> String {
    let Ok(d) = app.path().app_data_dir() else {
        return "markers unreadable (no app data dir)".into();
    };
    let chk = |n: &str| if d.join(n).is_file() { "yes" } else { "no" };
    format!(
        "ui.ok={} ui.failsafe={} ui.safe={} session.dirty={} ui.fscount={} safe_mode={} safe_sticky={} safe_video={} crashed_last={}",
        chk("ui.ok"),
        chk("ui.failsafe"),
        chk("ui.safe"),
        chk("session.dirty"),
        fs::read_to_string(d.join("ui.fscount"))
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0),
        crate::SAFE_MODE.load(std::sync::atomic::Ordering::Relaxed),
        crate::SAFE_STICKY.load(std::sync::atomic::Ordering::Relaxed),
        crate::SAFE_VIDEO.load(std::sync::atomic::Ordering::Relaxed),
        crate::CRASHED_LAST.load(std::sync::atomic::Ordering::Relaxed),
    )
}

/// WebView2 runtime version, read the same way Microsoft's tooling does
/// (BLBeacon registry key). Strings like "141.0.3537.92" tell us instantly
/// whether a broken Evergreen update is the culprit.
/// (v0.15.4: shared with bootguard's pre-boot reports)
#[cfg(windows)]
pub(crate) fn webview2_version() -> String {
    for key in [
        r"HKCU\Software\Microsoft\Edge\BLBeacon",
        r"HKLM\Software\Microsoft\Edge\BLBeacon",
    ] {
        if let Ok(out) = std::process::Command::new("reg")
            .args(["query", key, "/v", "version"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            for line in s.lines() {
                if line.contains("REG_SZ") {
                    if let Some(v) = line.rsplit(' ').next() {
                        if !v.is_empty() {
                            return format!("{} ({})", v, key);
                        }
                    }
                }
            }
        }
    }
    "not found in registry".into()
}

#[cfg(not(windows))]
fn webview2_version() -> String {
    "n/a (not windows)".into()
}

/// The full diagnostic: everything I need to debug a report, as readable
/// plain text (the user pastes this into a chat — JSON is hostile).
pub fn full_report(app: &AppHandle, reason: &str) -> String {
    let diag = crate::mpv::mpv_diag();
    let mut out = String::with_capacity(4096);
    out.push_str(&format!("OMP v{}\n", env!("CARGO_PKG_VERSION")));
    out.push_str(&format!("Reported: {} — {}\n", stamp(), reason));
    out.push_str(&format!("Graphics: {}\n", states_line(app)));
    out.push_str(&format!("WebView2: {}\n", webview2_version()));
    out.push_str(&format!(
        "Engine: available={} initialized={} dll='{}' version={:?} last_error={}\n",
        diag.available, diag.initialized, diag.dll_path,
        diag.version.as_deref().unwrap_or("?"), diag.load_error
    ));
    for a in &diag.attempts {
        out.push_str(&format!("  engine probe: {a}\n"));
    }
    out.push_str("--- recent boot log ---\n");
    if let Some(dir) = logs_dir(app) {
        let mut buf = fs::read_to_string(dir.join("boot.1.log")).unwrap_or_default();
        buf.push_str(&fs::read_to_string(dir.join("boot.log")).unwrap_or_default());
        // tail: keep the report readable
        if buf.len() > 8192 {
            buf = buf[buf.len() - 8192..].to_string();
        }
        out.push_str(&buf);
    } else {
        out.push_str("boot log unavailable\n");
    }
    out
}

/// Write/refresh OMP-report.txt on the user's Desktop. This is the
/// guaranteed delivery channel: even with a COMPLETELY dead webview the
/// file appears (the caller runs on native threads), and the user can drag
/// it straight into a chat.
pub fn write_desktop_report(app: &AppHandle, reason: &str) -> bool {
    let text = full_report(app, reason);
    log(app, "report", reason);
    let desktop = app
        .path()
        .desktop_dir()
        .ok()
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| std::path::PathBuf::from(p).join("Desktop")));
    let Some(d) = desktop else {
        log(app, "report", "desktop folder could not be resolved");
        return false;
    };
    let p = d.join("OMP-report.txt");
    match fs::write(&p, &text) {
        Ok(_) => {
            log(app, "report", &format!("written to {}", p.display()));
            true
        }
        Err(e) => {
            log(app, "report", &format!("desktop write failed: {e}"));
            false
        }
    }
}

/// command — the complete report as one plain-text string (used by the crash
/// banner, the player rescue card and the Settings screen)
#[tauri::command]
pub fn omp_diag_pack(app: AppHandle) -> String {
    full_report(&app, "requested from inside the app")
}

/// command — drop the report on the Desktop (Settings → Report a problem);
/// returns the written path so the UI can point at the file
#[tauri::command]
pub fn omp_report_desktop(app: AppHandle) -> String {
    write_desktop_report(&app, "requested from Settings → Report a problem");
    app.path()
        .desktop_dir()
        .map(|d| d.join("OMP-report.txt").display().to_string())
        .unwrap_or_else(|_| "OMP-report.txt on your Desktop".into())
}
