//! v0.15.4 — THE NEVER-SILENT GUARD.
//!
//! Four release rounds of "i ran it, nothing shows, nothing running" all
//! traced to the same hole: failures that happen BEFORE the Tauri app exists
//! (most notably a missing/broken WebView2 Runtime) killed the process
//! through a `.expect()` panic — and with `windows_subsystem = "windows"`
//! there is no console, so the panic vanished without a trace. No window,
//! no report, no log entry, nothing. The v0.15.3 black box never got a
//! chance to record: it lives inside setup(), which was never reached.
//!
//! This module closes the hole for good:
//!   preflight()         checks the WebView2 Runtime BEFORE any Tauri
//!                       machinery and, if missing, shows a real Windows
//!                       dialog (MessageBoxW — needs no webview at all),
//!                       writes OMP-report.txt to the Desktop and can open
//!                       the official Microsoft repair page.
//!   install_panic_hook() every panic in the process leaves a report on the
//!                       Desktop; pre-boot panics also pop a visible dialog.
//!   fatal()             replaces the old silent `.expect()` — any boot
//!                       failure now ends with a dialog + a report file.
//!
//! Everything here works with ZERO Tauri infrastructure: raw win32 calls
//! and env-var path resolution only. When the process cannot even build its
//! own UI, a native dialog is the only surface Windows guarantees.

use std::path::PathBuf;

/// set once the Tauri app object exists. The panic hook uses it to decide
/// whether a panic is a fatal pre-boot event (dialog warranted) or an
/// internal worker failure while the app is already running (report only —
/// no scary dialogs over the user's head).
static APP_LIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn mark_app_live() {
    APP_LIVE.store(true, std::sync::atomic::Ordering::Relaxed);
}

pub fn app_is_live() -> bool {
    APP_LIVE.load(std::sync::atomic::Ordering::Relaxed)
}

/// The official Microsoft Evergreen WebView2 download link (go.microsoft
/// redirect — stable for years). Used by every "repair" path below.
pub const WEBVIEW2_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

#[cfg(windows)]
mod win {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    pub(crate) fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, utype: u32) -> i32;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: isize,
            op: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show: i32,
        ) -> isize;
    }

    /// MB_OKCANCEL | MB_ICONWARNING. true = the user clicked OK.
    pub(crate) fn warn_box(title: &str, msg: &str) -> bool {
        unsafe {
            MessageBoxW(0, wide(msg).as_ptr(), wide(title).as_ptr(), 0x30 | 0x1) == 1
        }
    }

    pub(crate) fn open_in_browser(url: &str) {
        unsafe {
            ShellExecuteW(
                0,
                wide("open").as_ptr(),
                wide(url).as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                5,
            );
        }
    }
}

#[cfg(not(windows))]
mod win {
    pub(crate) fn warn_box(_title: &str, _msg: &str) -> bool {
        false
    }
    pub(crate) fn open_in_browser(_url: &str) {}
}

/// Folders a pre-boot report can reach without a Tauri AppHandle. Desktop
/// first — including OneDrive-redirected Desktops, which are the default on
/// most modern Windows accounts — then the profile root, then %TEMP%.
fn report_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(p) = std::env::var_os("USERPROFILE") {
        let p = PathBuf::from(p);
        v.push(p.join("Desktop"));
        v.push(p.join("OneDrive").join("Desktop"));
        v.push(p);
    }
    if let Some(p) = std::env::var_os("TEMP") {
        v.push(PathBuf::from(p));
    }
    v
}

/// The report for failures that happen BEFORE the Tauri app exists (no
/// AppHandle → no bootlog dirs, no app-data paths). Writes OMP-report.txt
/// into the first folder that accepts it. Returns the path it landed at.
pub fn write_pre_report(reason: &str, detail: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let wv = crate::bootlog::webview2_version();
    #[cfg(not(windows))]
    let wv = String::from("n/a (not windows)");
    let text = format!(
        "OMP v{}\nReported: {}\nWebView2: {wv}\nProblem: {reason}\n\n{detail}\n\n---\nThis file was written automatically, without any user action. Send it to the developer for a precise fix.\n",
        env!("CARGO_PKG_VERSION"),
        crate::bootlog::stamp(),
    );
    for dir in report_dirs() {
        if dir.is_dir() {
            let p = dir.join("OMP-report.txt");
            if std::fs::write(&p, &text).is_ok() {
                return Some(p);
            }
        }
    }
    None
}

/// THE PREFLIGHT. Runs before a single piece of Tauri machinery is built.
/// If the WebView2 Runtime is missing or broken, OMP would previously die
/// inside `.expect()` with zero visible output; now it tells the user
/// exactly what is wrong, in a dialog Windows can always draw.
#[cfg(windows)]
pub fn preflight() {
    match tauri::webview_version() {
        Ok(v) => {
            // runtime present — the version lands in the boot log once the
            // app exists; nothing else to do here.
            if v.is_empty() {
                // an EMPTY version string is its own kind of broken — treat
                // it as missing so the user gets the repair dialog instead
                // of a silent white death later.
                let _ = write_pre_report(
                    "OMP cannot start — the WebView2 Runtime reports no version",
                    "The WebView2 runtime is registered but reports an empty version string — an almost-certainly-broken install.\n\n\
                     FIX: install the Evergreen Standalone Installer (x64) from the official Microsoft page, restart the PC, then open OMP again.",
                );
                missing_runtime();
            }
        }
        Err(e) => {
            let _ = write_pre_report(
                "OMP cannot start — the WebView2 Runtime is missing or broken",
                &format!(
                    "The WebView2 runtime check failed: {e}\n\n\
                     OMP's entire interface is drawn by the Microsoft WebView2 \
                     Runtime, a free Windows component. It is missing or broken \
                     on this machine, so no OMP window can exist.\n\n\
                     FIX: install the Evergreen Standalone Installer (x64) from \
                     {WEBVIEW2_URL} — restart the PC — open OMP again.\n\n\
                     The installer OMP ships with (OMP_…-setup.exe) normally \
                     installs this component automatically; using the .msi file \
                     instead, or an antivirus blocking the install, leaves it out."
                ),
            );
            missing_runtime();
        }
    }
}

#[cfg(windows)]
fn missing_runtime() -> ! {
    let open = win::warn_box(
        "OMP cannot start",
        "OMP needs the Microsoft WebView2 Runtime, which is missing or broken on this machine.\n\n\
         Click OK to open the official Microsoft download page — install the\n\
         'Evergreen Standalone Installer' (x64), restart the PC, then open OMP again.\n\n\
         A report was also saved to your Desktop as OMP-report.txt.",
    );
    if open {
        win::open_in_browser(WEBVIEW2_URL);
    }
    std::process::exit(3);
}

#[cfg(not(windows))]
pub fn preflight() {}

/// The panic hook — installed as the FIRST line of run(), before anything
/// can panic. Every panic in the process leaves a report on the Desktop;
/// pre-boot panics (the silent-death class) also pop a visible dialog.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".into());
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".into());
        let _ = write_pre_report(
            "OMP crashed while starting",
            &format!("PANIC at {loc}\n{msg}\n\nIf this repeats on every launch, send the file to the developer — the location above usually names the exact failing component."),
        );
        if !app_is_live() {
            win::warn_box(
                "OMP — problem",
                &format!(
                    "OMP hit an internal error and cannot continue.\n\n{msg}\n({loc})\n\n\
                     A report was saved to your Desktop as OMP-report.txt."
                ),
            );
        }
    }));
}

/// The replacement for the old silent `.expect()`: any failure building the
/// app ends here — with a dialog, a report and a real exit code.
pub fn fatal(reason: &str, detail: &str) -> ! {
    let _ = write_pre_report(reason, detail);
    win::warn_box(
        "OMP cannot start",
        &format!(
            "{reason}\n\n{detail}\n\nA report was saved to your Desktop as OMP-report.txt."
        ),
    );
    std::process::exit(2);
}

/// Escalation helper for the boot failsafe: shown only when boots fail
/// REPEATEDLY (streak >= 2). A visible Windows message beats a file the
/// user may never notice.
pub fn repair_prompt() {
    let open = win::warn_box(
        "OMP still cannot start",
        "OMP failed to start repeatedly on this machine.\n\n\
         The most common cause is a broken Microsoft WebView2 Runtime.\n\n\
         Click OK to open the official Microsoft repair page — install the\n\
         'Evergreen Standalone Installer' (x64), restart the PC, then open OMP again.\n\n\
         The full details were saved to your Desktop as OMP-report.txt.",
    );
    if open {
        win::open_in_browser(WEBVIEW2_URL);
    }
}
