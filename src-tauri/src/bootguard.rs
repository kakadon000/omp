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

// ─────────────────────────────────────────────────────────────────────────
// v0.15.6 — PRE-BOOT WEBVIEW RECOVERY.
//
// The v0.15.5 field report (four window profiles, four IDENTICAL
// 0x8007139F) proved the killer was never window style. Tauri builds the
// splashscreen — and with it the process's ONE WebView2 browser process —
// BEFORE the setup hook runs, using wry's default browser arguments. Every
// later window must request the SAME arguments or WebView2 answers
// ERROR_INVALID_STATE (0x8007139F). v0.15.1–v0.15.5 broke that rule under
// SAFE_MODE (--disable-gpu), and SAFE_MODE is active on every fresh
// install (probe boot) and every post-crash boot (rescue) — six release
// rounds of death on the reporting machine. The differing args are gone
// from lib.rs now (see THE BROWSER-ARGS RULE there).
//
// This layer hardens the OTHER classic producers of the same error:
//   1. orphaned msedgewebview2.exe processes from a crashed session still
//      holding the OMP user-data folder with OLD browser arguments —
//      swept before anything is built;
//   2. a corrupted browser profile (EBWebView) — factory-reset after
//      repeated webview-creation failures (webview.dirty marker, written
//      by the window ladder when every rung fails, cleared by ui_ready).
//   3. (v0.15.7) a HUNG, WINDOWLESS OMP.exe leftover from a crashed
//      session — it holds the single-instance lock, so every new launch
//      is swallowed SILENTLY: no window, no report, no log. Cleared
//      before anything is built; a visible running OMP is never touched.
//
// webview_recovery() runs from run() after preflight() and before the
// Tauri builder. It is marker-gated: a healthy machine pays ZERO cost.
// Everything is plain std (tasklist / powershell / fs) — no new deps, no
// raw FFI, and it can never panic the boot.

/// what recovery did this boot ("" = nothing). setup() reads it once the
/// app exists and copies it into the boot log. Written only on Windows by
/// webview_recovery(); on other platforms it stays empty.
static RECOVERY: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub fn recovery_note() -> String {
    RECOVERY.get().map(|s| s.as_str()).unwrap_or("").to_string()
}

/// Tauri's app_data_dir() on Windows = %APPDATA%\<identifier> — the same
/// folder the boot markers (ui.ok, session.dirty, webview.dirty, …) live in.
#[cfg(windows)]
fn marker_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join("app.omp.player"))
}

/// The WebView2 browser-profile folder (user data folder): tauri defaults it
/// to %LOCALAPPDATA%\<identifier>\EBWebView. Wiping it is a browser factory
/// reset: cache, service workers, GPU shader cache and site logins are gone,
/// but the folder is recreated fresh on the next engine start.
#[cfg(windows)]
fn browser_profile_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|p| PathBuf::from(p).join("app.omp.player").join("EBWebView"))
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// One PowerShell pass over the OMP.exe process list that answers BOTH
/// questions v0.15.7 needs before the Tauri builder exists:
///   live    — is another OMP.exe running WITH a visible top-level window?
///             (the main window or the desktop widget — a healthy OMP
///             always owns one while it is usable). Such an instance owns
///             the browser profile and will receive this launch through
///             the single-instance handoff, so recovery must not touch
///             anything.
///   zombies — windowless OMP.exe processes (not this pid) older than
///             120 seconds are killed on the spot and counted. A
///             windowless OMP is either a launch still warming up (always
///             far younger than 120 s — spared) or a hung leftover from a
///             crashed session: it keeps the single-instance lock, so
///             every new launch would be swallowed SILENTLY — no window,
///             no report, no log (the "ran it, nothing happens" class).
///             The 120 s floor protects background-playback sessions whose
///             widget window is also hidden — they lose music only if
///             windowless AND frozen for two full minutes.
/// Returns (live, zombies_killed). Hard 8 s deadline like every recovery
/// step; a wedged PowerShell never stalls the boot.
#[cfg(windows)]
fn omp_recon() -> (bool, usize) {
    use std::os::windows::process::CommandExt;
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel::<(bool, usize)>();
    std::thread::spawn(move || {
        let me = std::process::id();
        let script = format!("$ps = Get-CimInstance Win32_Process -Filter 'Name=''OMP.exe''' | \
Where-Object {{ $_.ProcessId -ne {me} }}; \
$live = @($ps | Where-Object {{ $_.MainWindowHandle -ne 0 }}).Count; \
Write-Output ('LIVE=' + $live); \
$ps | Where-Object {{ $_.MainWindowHandle -eq 0 -and $_.CreationDate -lt (Get-Date).AddSeconds(-120) }} | \
ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output $_.ProcessId }}");
        let mut live = false;
        let mut killed = 0usize;
        if let Ok(out) = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let l = line.trim();
                if let Some(n) = l.strip_prefix("LIVE=") {
                    live = n.trim().parse::<u32>().map(|c| c > 0).unwrap_or(false);
                } else if l.parse::<u32>().is_ok() {
                    killed += 1;
                }
            }
        }
        let _ = tx.send((live, killed));
    });
    rx.recv_timeout(std::time::Duration::from_secs(8)).unwrap_or((false, 0))
}

/// Kill every msedgewebview2.exe whose command line is bound to OMP's user
/// data folder. Runs BEFORE any window exists in THIS process, so the only
/// webview processes that can match belong to crashed past sessions (or to
/// another live OMP — excluded by omp_recon() upstream). Returns
/// the number of processes terminated. PowerShell is the only always-present
/// builtin that can read another process's command line (wmic is gone on
/// current Windows 11); the script uses single quotes only so the arg needs
/// no nested double-quote escaping. Hard 8 s deadline: a wedged PowerShell
/// must never stall the boot.
#[cfg(windows)]
fn sweep_webview_zombies() -> usize {
    use std::os::windows::process::CommandExt;
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel::<usize>();
    std::thread::spawn(move || {
        let script = "Get-CimInstance Win32_Process -Filter 'Name=''msedgewebview2.exe''' | \
Where-Object { $_.CommandLine -match 'app\\.omp\\.player' } | \
ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }";
        let n = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .filter(|l| l.trim().parse::<u32>().is_ok())
                    .count()
            })
            .unwrap_or(0);
        let _ = tx.send(n);
    });
    rx.recv_timeout(std::time::Duration::from_secs(8)).unwrap_or(0)
}

/// Factory-reset the WebView2 browser profile. std first (fast path), then a
/// PowerShell Remove-Item retry that clears read-only bits std chokes on.
/// Ok(false) = nothing to delete. Never deletes anything outside EBWebView.
#[cfg(windows)]
fn reset_browser_profile() -> Result<bool, String> {
    let Some(p) = browser_profile_dir() else {
        return Err("LOCALAPPDATA not resolvable".into());
    };
    if !p.exists() {
        return Ok(false);
    }
    if std::fs::remove_dir_all(&p).is_ok() && !p.exists() {
        return Ok(true);
    }
    use std::os::windows::process::CommandExt;
    // single-quoted PS path — escape embedded single quotes the PS way
    let lit = p.display().to_string().replace('\'', "''");
    let script = format!("Remove-Item -LiteralPath '{lit}' -Recurse -Force -ErrorAction SilentlyContinue");
    let retried = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if retried && !p.exists() {
        Ok(true)
    } else {
        Err("EBWebView folder is locked even after the zombie sweep".into())
    }
}

/// THE ENTRY POINT — called from run() before the Tauri builder. Gated on
/// trouble markers so healthy machines pay nothing:
///   session.dirty / ui.failsafe → the last session ended badly → sweep
///                                 orphaned engine processes;
///   webview.dirty (count)       → the window ladder failed entirely in a
///                                 past launch → sweep + profile reset, at
///                                 most 3 times (after that we stop wiping
///                                 logins and the report asks for a manual
///                                 delete — a reset loop we cannot prove is
///                                 helping must not eat logins forever).
#[cfg(windows)]
pub fn webview_recovery() {
    let Some(md) = marker_dir() else { return };
    if !md.is_dir() {
        return; // never ran on this machine — nothing to recover
    }
    let has = |n: &str| md.join(n).is_file();
    let dirty_session = has("session.dirty") || has("ui.failsafe");
    let wv_dirty: u32 = std::fs::read_to_string(md.join("webview.dirty"))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    if !dirty_session && wv_dirty == 0 {
        return; // healthy machine — zero cost, zero risk
    }

    let mut notes: Vec<String> = Vec::new();

    // v0.15.7 — visible-instance check AND windowless-zombie clear in one
    // pass. A windowless OMP.exe is NOT a live instance: if it is older
    // than 120 s it is a hung leftover, and leaving it alive means the
    // single-instance plugin swallows THIS launch with zero output.
    let (another_live, omp_zombies) = omp_recon();
    if another_live {
        // A live instance owns the browser profile — sweeping or resetting
        // anything under it would only break the running OMP. This second
        // process will be closed by the single-instance plugin right after
        // the builder comes up.
        let _ = RECOVERY.set("another OMP.exe is alive — recovery skipped".into());
        return;
    }
    if omp_zombies > 0 {
        notes.push(format!(
            "cleared {omp_zombies} hung windowless OMP.exe leftover(s) that would have silently blocked this launch"
        ));
    }
    let killed = sweep_webview_zombies();
    if killed > 0 {
        notes.push(format!("swept {killed} orphaned msedgewebview2.exe"));
    }

    if wv_dirty > 0 && wv_dirty <= 3 {
        match reset_browser_profile() {
            Ok(true) => notes.push("browser profile (EBWebView) factory-reset".into()),
            Ok(false) => notes.push("browser profile absent — reset not needed".into()),
            Err(e) => notes.push(format!("browser profile reset FAILED: {e}")),
        }
    } else if wv_dirty > 3 {
        notes.push("webview.dirty past 3 — leaving the profile alone".into());
    }

    if !notes.is_empty() {
        let _ = RECOVERY.set(notes.join(" · "));
    }
}

#[cfg(not(windows))]
pub fn webview_recovery() {}
