//! v0.15.9 — THE SELF-PIXEL-PROBE. OMP finally JUDGES ITS OWN WINDOW.
//!
//! The disease this module kills, in one sentence: the webview renders the
//! page perfectly (JS alive, rAF frames flowing, ui_ready handshake fires,
//! ui_paint_ok confirms) while the window's DirectComposition surface
//! presents NOTHING to the screen — a flat, glassy, empty rectangle that
//! every in-process check swears is healthy. The v0.15.8 CI smoke gate
//! proved rAF can never see this ("rAF proves the PAGE renders, never that
//! the WINDOW does") and that the ONLY reliable witness is a pixel probe of
//! the window itself: PrintWindow(PW_RENDERFULLCONTENT) + pixel statistics.
//! A real OMP UI is text, gradients and icons — luminance std far above 3.0
//! and hundreds of distinct colors; a dead presentation is a constant fill —
//! std < 3.0, fewer than 20 colors. Those are the same thresholds the gate
//! measured across nine launch configurations.
//!
//! So the app now probes ITSELF, from a native thread, after the handshake:
//!   HEALTHY  → every presentation-ladder marker is cleared; nothing changes.
//!   FLAT     → the presentation ladder escalates, one step per launch:
//!       1. normal mode (glass allowed)     → next boot: SAFE MODE, opaque rungs only
//!       2. safe mode, engine GPU off       → next boot: + SwiftShader (full-software ANGLE)
//!       3. SwiftShader still flat          → TERMINAL: Desktop report + a real
//!          Windows dialog naming the fix (GPU driver / WebView2 repair).
//!              No further relaunches — a hopeless machine must never loop.
//! Each step ends in a CONTROLLED SELF-RELAUNCH: markers are written first,
//! then a detached PowerShell waits 2 s for this process to fully exit and
//! starts OMP.exe again — the single-instance lock dies with the old
//! process, so the new boot is a clean first-class launch.
//!
//! CI: the smoke gate pixel-probes from OUTSIDE and launches deterministic
//! configurations — the in-app ladder must not fight it. OMP_SELFPIC=0
//! disables the whole module (every smoke launch sets it).

use tauri::AppHandle;

/// flat-window verdict thresholds — measured by the v0.15.8 smoke gate on
/// nine launch configurations (real UI vs. constant-fill presentation)
const FLAT_STD: f64 = 3.0;
const FLAT_COLORS: usize = 20;

/// this boot runs with SwiftShader forced into the engine flags
/// (decide_boot_modes set it — read by the watchdog for the terminal step)
pub(crate) static SWIFT_FORCED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
mod win {
    // raw externs, bootguard style — no windows-crate features to fight
    pub type HWND = isize;
    pub type HDC = isize;
    pub type HGDIOBJ = isize;
    pub type HBITMAP = isize;

    pub const PW_RENDERFULLCONTENT: u32 = 0x0000_0002; // Win 8.1+ — includes DComp content
    pub const DIB_RGB_COLORS: u32 = 0;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct BitmapInfoHeader {
        pub bi_size: u32,
        pub bi_width: i32,
        pub bi_height: i32,
        pub bi_planes: u16,
        pub bi_bit_count: u16,
        pub bi_compression: u32,
        pub bi_size_image: u32,
        pub bi_x_ppm: i32,
        pub bi_y_ppm: i32,
        pub bi_clr_used: u32,
        pub bi_clr_important: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct RgbQuad {
        pub b: u8,
        pub g: u8,
        pub r: u8,
        pub reserved: u8,
    }

    #[repr(C)]
    pub struct BitmapInfo {
        pub header: BitmapInfoHeader,
        pub colors: [RgbQuad; 1],
    }

    #[link(name = "user32")]
    extern "system" {
        pub fn GetClientRect(hwnd: HWND, rect: *mut i32 /* RECT as 4 i32s */) -> i32;
        pub fn IsWindowVisible(hwnd: HWND) -> i32;
        pub fn IsIconic(hwnd: HWND) -> i32;
        pub fn GetDC(hwnd: HWND) -> HDC;
        pub fn ReleaseDC(hwnd: HWND, hdc: HDC) -> i32;
        pub fn PrintWindow(hwnd: HWND, hdc: HDC, flags: u32) -> i32;
    }

    #[link(name = "gdi32")]
    extern "system" {
        pub fn CreateCompatibleDC(hdc: HDC) -> HDC;
        pub fn CreateCompatibleBitmap(hdc: HDC, w: i32, h: i32) -> HBITMAP;
        pub fn SelectObject(hdc: HDC, obj: HGDIOBJ) -> HGDIOBJ;
        pub fn GetDIBits(
            hdc: HDC,
            bmp: HBITMAP,
            start: u32,
            lines: u32,
            bits: *mut u8,
            info: *mut BitmapInfo,
            usage: u32,
        ) -> i32;
        pub fn DeleteDC(hdc: HDC) -> i32;
        pub fn DeleteObject(obj: HGDIOBJ) -> i32;
    }
}

/// pixel statistics of one window capture, sampled every PROBE_STRIDE px
pub struct PixStats {
    pub mean: f64,
    pub std: f64,
    pub colors: usize,
    pub sampled: usize,
    pub width: i32,
    pub height: i32,
}

impl PixStats {
    pub fn flat(&self) -> bool {
        self.std < FLAT_STD || self.colors < FLAT_COLORS
    }
}

/// Capture the window's own presentation with PrintWindow(PW_RENDERFULLCONTENT)
/// — the exact API the v0.15.8 gate used from PowerShell, now called from
/// inside the app. Returns None when the capture itself was impossible
/// (window gone, zero-size) — never a false "flat".
#[cfg(windows)]
pub fn probe_hwnd(hwnd: win::HWND) -> Option<PixStats> {
    use win::*;
    unsafe {
        // RECT = left, top, right, bottom — four i32s
        let mut rc = [0i32; 4];
        if GetClientRect(hwnd, rc.as_mut_ptr()) == 0 {
            return None;
        }
        let w = rc[2] - rc[0];
        let h = rc[3] - rc[1];
        if w < 50 || h < 50 {
            return None;
        }
        let hdc_win = GetDC(hwnd);
        if hdc_win == 0 {
            return None;
        }
        let hdc = CreateCompatibleDC(hdc_win);
        let bmp = CreateCompatibleBitmap(hdc_win, w, h);
        if hdc == 0 || bmp == 0 {
            if hdc != 0 {
                DeleteDC(hdc);
            }
            if bmp != 0 {
                DeleteObject(bmp);
            }
            ReleaseDC(hwnd, hdc_win);
            return None;
        }
        let old = SelectObject(hdc, bmp);
        // PW_RENDERFULLCONTENT (2): force-render including DirectComposition
        // surfaces — proven by the v0.15.8 gate to reflect exactly what the
        // window presents (a dead presentation captures as a constant fill).
        let printed = PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT);
        // docs: the bitmap must NOT be selected into a DC when GetDIBits runs
        SelectObject(hdc, old);
        let mut result = None;
        if printed != 0 {
            let mut info = BitmapInfo {
                header: BitmapInfoHeader {
                    bi_size: std::mem::size_of::<BitmapInfoHeader>() as u32,
                    bi_width: w,
                    // negative height = top-down rows (row 0 = top of window)
                    bi_height: -h,
                    bi_planes: 1,
                    bi_bit_count: 32,
                    bi_compression: 0, // BI_RGB
                    bi_size_image: 0,
                    bi_x_ppm: 0,
                    bi_y_ppm: 0,
                    bi_clr_used: 0,
                    bi_clr_important: 0,
                },
                colors: [RgbQuad { b: 0, g: 0, r: 0, reserved: 0 }],
            };
            let buf_len = (w as usize) * (h as usize) * 4;
            let mut buf: Vec<u8> = vec![0u8; buf_len];
            let got = GetDIBits(
                hdc,
                bmp,
                0,
                h as u32,
                buf.as_mut_ptr(),
                &mut info,
                DIB_RGB_COLORS,
            );
            if got != 0 {
                result = Some(analyze(&buf, w, h));
            }
        }
        DeleteObject(bmp);
        DeleteDC(hdc);
        ReleaseDC(hwnd, hdc_win);
        result
    }
}

#[cfg(not(windows))]
pub fn probe_hwnd(_hwnd: isize) -> Option<PixStats> {
    None
}

/// luminance mean/std + distinct-color count over a 32bpp BGRA buffer,
/// sampled every 6 px in both axes (the gate's sampling density)
fn analyze(buf: &[u8], w: i32, h: i32) -> PixStats {
    const STRIDE: usize = 6;
    let w = w as usize;
    let h = h as usize;
    let mut sum = 0.0f64;
    let mut sum2 = 0.0f64;
    let mut n = 0usize;
    let mut seen = std::collections::HashSet::new();
    let mut y = 0usize;
    while y < h {
        let mut x = 0usize;
        while x < w {
            let off = (y * w + x) * 4;
            if off + 2 < buf.len() {
                let b = buf[off] as u32;
                let g = buf[off + 1] as u32;
                let r = buf[off + 2] as u32;
                // BT.601 luminance
                let lum = (0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64) as f64;
                sum += lum;
                sum2 += lum * lum;
                n += 1;
                // 4 bits per channel — 4096 buckets, plenty for "is this
                // a real UI or a constant fill"
                seen.insert((b >> 4) | ((g >> 4) << 4) | ((r >> 4) << 8));
            }
            x += STRIDE;
        }
        y += STRIDE;
    }
    if n == 0 {
        return PixStats { mean: 0.0, std: 0.0, colors: 0, sampled: 0, width: w as i32, height: h as i32 };
    }
    let mean = sum / n as f64;
    let var = (sum2 / n as f64) - mean * mean;
    PixStats {
        mean,
        std: var.max(0.0).sqrt(),
        colors: seen.len(),
        sampled: n,
        width: w as i32,
        height: h as i32,
    }
}

// ─────────────────────────────────────────────────────────────────────────
// THE WATCHDOG — one probe decision per launch, made ~5-9 s after the
// window first appears. All-or-nothing: any probe/capture failure exits
// silently (a missing witness must never punish a working machine).

/// marker file names, in the app data dir (same folder as ui.ok etc.)
const M_FLAT: &str = "pix.flat"; // consecutive flat launches (count)
const M_SWIFT: &str = "pix.swift"; // SwiftShader lock-in (the proven cure)

#[cfg(windows)]
fn marker_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("APPDATA").map(|p| std::path::PathBuf::from(p).join("app.omp.player"))
}

#[cfg(windows)]
fn read_count(dir: &std::path::Path, name: &str) -> u32 {
    std::fs::read_to_string(dir.join(name))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

#[cfg(windows)]
fn write_marker(dir: &std::path::Path, name: &str, val: &str) {
    let _ = std::fs::write(dir.join(name), val);
}

#[cfg(windows)]
fn remove_marker(dir: &std::path::Path, name: &str) {
    let _ = std::fs::remove_file(dir.join(name));
}

/// THE LADDER ENTRY — spawned from setup() next to the 8s failsafe thread.
#[cfg(windows)]
pub(crate) fn spawn_watchdog(app: AppHandle, rung: u8, safe_mode: bool) {
    std::thread::spawn(move || {
        watchdog(app, rung, safe_mode);
    });
}

#[cfg(not(windows))]
pub(crate) fn spawn_watchdog(_app: AppHandle, _rung: u8, _safe_mode: bool) {}

#[cfg(windows)]
fn watchdog(app: AppHandle, rung: u8, safe_mode: bool) {
    // CI opt-out — the smoke gate pixel-probes from outside and must see
    // deterministic launches (the in-app ladder would relaunch mid-gate).
    if std::env::var("OMP_SELFPIC").ok().as_deref() == Some("0") {
        bootlog(&app, "selfpix", "disabled by OMP_SELFPIC=0 (CI mode)");
        return;
    }
    use tauri::Manager;
    // wait for the HANDSHAKE (ui_ready / close_splash) — not just the show:
    // the 8s failsafe force-shows never-proved windows too, and a dead
    // webview is the failsafe's verdict to deliver, not the probe's to
    // re-judge. The never-handshaked path skips the probe entirely.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !crate::HANDSHAKE_OK.load(std::sync::atomic::Ordering::Relaxed) {
        if std::time::Instant::now() > deadline {
            bootlog(&app, "selfpix", "UI never proved itself — probe skipped (the boot failsafe owns this path)");
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    // grace for the first real frames after show, then probe
    std::thread::sleep(std::time::Duration::from_secs(3));

    let Some(w) = app.get_webview_window("main") else { return };
    let hwnd = match w.hwnd() {
        Ok(h) => h.0 as isize,
        Err(_) => return,
    };

    // two samples, 2 s apart — a single flat capture could be a transient
    // moment (window mid-transition); two in a row is the disease
    let s1 = probe_visible(hwnd);
    let Some(s1) = s1 else { return };
    if !s1.flat() {
        success(&app, &s1, safe_mode);
        return;
    }
    bootlog(
        &app,
        "selfpix",
        &format!(
            "probe 1 FLAT (mean={:.1} std={:.2} colors={} {}x{}) — re-checking in 2s",
            s1.mean, s1.std, s1.colors, s1.width, s1.height
        ),
    );
    std::thread::sleep(std::time::Duration::from_secs(2));
    let s2 = probe_visible(hwnd);
    let Some(s2) = s2 else { return };
    if !s2.flat() {
        bootlog(&app, "selfpix", "probe 2 HEALTHY — first capture was transient, no escalation");
        success(&app, &s2, safe_mode);
        return;
    }
    escalate(&app, rung, safe_mode, &s2);
}

/// probe only while the main window is really on screen — a hidden window
/// (background playback) or a minimized one can be judged by nobody
#[cfg(windows)]
fn probe_visible(hwnd: isize) -> Option<PixStats> {
    unsafe {
        if win::IsWindowVisible(hwnd) == 0 || win::IsIconic(hwnd) != 0 {
            return None;
        }
    }
    probe_hwnd(hwnd)
}

/// HEALTHY — real pixels are reaching the screen. Clear the presentation
/// ladder's failure memory; keep the SwiftShader lock-in (pix.swift) once
/// earned: a cure that worked stays until a factory reset.
#[cfg(windows)]
fn success(app: &AppHandle, s: &PixStats, safe_mode: bool) {
    bootlog(
        app,
        "selfpix",
        &format!(
            "HEALTHY — the window presents real pixels (mean={:.1} std={:.2} colors={} sampled={}) rung={} safe={}",
            s.mean, s.std, s.colors, s.sampled, if safe_mode { "opaque" } else { "glass" }, safe_mode
        ),
    );
    if let Some(d) = marker_dir() {
        remove_marker(&d, M_FLAT);
    }
}

/// FLAT twice — one ladder step per launch, then a controlled relaunch.
#[cfg(windows)]
fn escalate(app: &AppHandle, rung: u8, safe_mode: bool, s: &PixStats) {
    let swift_now = SWIFT_FORCED.load(std::sync::atomic::Ordering::Relaxed);
    let _ = rung;
    bootlog(
        app,
        "selfpix",
        &format!(
            "CONFIRMED FLAT (mean={:.1} std={:.2} colors={}) — rung {rung} safe_mode={safe_mode} swiftshader={swift_now}: the webview renders but the window presents nothing",
            s.mean, s.std, s.colors
        ),
    );
    let Some(d) = marker_dir() else { return };

    if swift_now {
        // STEP 3 → TERMINAL. Every rendering mode OMP owns was tried on this
        // machine and the presentation stayed dead. Never loop: report +
        // dialog, and let the app sit there (the user can still close it).
        bootlog(app, "selfpix", "TERMINAL — even SwiftShader presented nothing; escalating no further");
        crate::bootlog::write_desktop_report(
            app,
            "OMP opened, but Windows is not showing its window — the screen area stays blank while OMP runs. \
             The self-pixel-probe tested every graphics mode this app owns: normal GPU, safe software mode, and \
             full-software SwiftShader — the window's presentation stayed empty in all of them. \
             This is a Windows graphics-presentation problem on this machine, not a crash. \
             FIX: (1) update or reinstall your graphics driver (or run Windows Update), \
             (2) repair the Microsoft WebView2 Runtime — the Evergreen Standalone Installer from \
             https://developer.microsoft.com/microsoft-edge/webview2/ , then restart the PC and open OMP again. \
             The full probe trail is in the boot log below.",
        );
        // the dialog is the surface Windows always guarantees — even with a
        // dead presentation. OK opens the official repair page.
        let open = crate::bootguard::dialog_ok(
            "OMP cannot draw on this PC",
            "OMP is running, but Windows is not showing its window — the area stays blank.\n\n\
             OMP automatically tried every graphics mode it owns (GPU, software rendering, SwiftShader) \
             and none of them can present a picture on this machine's graphics stack.\n\n\
             FIX:\n  1. Update or reinstall your graphics driver (or run Windows Update).\n  \
             2. Click OK to open Microsoft's WebView2 repair page — install the \
             'Evergreen Standalone Installer' (x64), restart the PC, then open OMP again.\n\n\
             Full details: OMP-report.txt on your Desktop.",
        );
        if open {
            crate::bootguard::open_repair_page();
        }
        return;
    }

    // STEP 1 / STEP 2 — write the next boot's grade, then relaunch ourselves.
    let n = read_count(&d, M_FLAT) + 1;
    write_marker(&d, M_FLAT, &n.to_string());
    let next = if !safe_mode {
        // normal mode presented nothing → next boot: safe mode, opaque rungs
        write_marker(&d, "ui.failsafe", "1");
        "SAFE MODE (opaque window, --disable-gpu)"
    } else {
        // safe+opaque still flat → the GPU-adjacent path is hopeless here:
        // next boot forces SwiftShader (full-software ANGLE) into the engine
        write_marker(&d, M_SWIFT, "1");
        "SAFE MODE + SwiftShader (full-software rendering)"
    };
    bootlog(
        app,
        "selfpix",
        &format!(
            "auto-fix engaged (flat launch #{n}) — relaunching into {next}; the window will close and reopen by itself"
        ),
    );
    relaunch(app);
}

/// controlled self-relaunch: markers are already on disk. A detached
/// PowerShell waits 2 s — long enough for this process to fully exit and
/// release the single-instance lock — then starts OMP.exe fresh, and THIS
/// process exits cleanly (RunEvent::Exit retires session.dirty + shuts the
/// engine down, so the next boot is graded by the ladder markers alone).
#[cfg(windows)]
fn relaunch(app: &AppHandle) {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            bootlog(app, "selfpix", &format!("relaunch aborted — current_exe unreadable: {e}"));
            return;
        }
    };
    let lit = exe.display().to_string().replace('\'', "''");
    let script = format!("Start-Sleep -Seconds 2; Start-Process -FilePath '{lit}'");
    use std::os::windows::process::CommandExt;
    let spawned = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(crate::bootguard::CREATE_NO_WINDOW)
        .spawn();
    match spawned {
        Ok(_) => {
            bootlog(app, "selfpix", "delayed restarter armed — exiting now (clean, session marked clean)");
            app.exit(0);
        }
        Err(e) => {
            bootlog(app, "selfpix", &format!("relaunch spawn failed ({e}) — staying up; markers already written, next manual open continues the ladder"));
        }
    }
}

#[cfg(windows)]
fn bootlog(app: &AppHandle, tag: &str, msg: &str) {
    crate::bootlog::log(app, tag, msg);
}

#[cfg(test)]
mod tests {
    use super::analyze;

    #[test]
    fn flat_fill_is_flat() {
        // a constant #1c1c1c fill — the measured dead-presentation capture
        let px = [0x1cu8, 0x1c, 0x1c, 0xff];
        let mut buf = Vec::with_capacity(100 * 100 * 4);
        for _ in 0..100 * 100 {
            buf.extend_from_slice(&px);
        }
        let s = analyze(&buf, 100, 100);
        assert!(s.flat(), "constant fill must read flat: {:?}", s);
    }

    #[test]
    fn real_ui_is_not_flat() {
        // text-like noise: high-frequency luminance + many colors
        let mut buf = Vec::with_capacity(100 * 100 * 4);
        let mut x = 0u32;
        for i in 0..100 * 100 {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            let r = (x >> 24) as u8;
            let g = (x >> 16) as u8;
            let b = (x >> 8) as u8;
            buf.extend_from_slice(&[b, g, r, 0xff]);
            let _ = i;
        }
        let s = analyze(&buf, 100, 100);
        assert!(!s.flat(), "text-like content must not read flat: {:?}", s);
    }
}
