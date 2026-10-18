// OMP — Open Media Player · v0.9.1 self-repair + health
//
// WHY THIS EXISTS: the v0.9.0 bundle was verified byte-perfect (the installer
// ships resources/mpv-2.dll with all 206 mpv exports, yt-dlp.exe and
// ffmpeg.exe) — yet users still reported "engine not active / nothing works".
// The only remaining failure mode is MACHINE-SIDE: antivirus quarantines the
// freshly-installed binaries, or an old broken install lingers. Until now the
// app could only SAY that; it could not FIX it. This module:
//   * omp_health        — exact per-component state (present? where? size?)
//   * omp_repair_download — re-downloads the OFFICIAL yt-dlp.exe / engine DLL
//                         into a WRITABLE location (install dir for NSIS
//                         per-user installs, else %APPDATA%\app.omp.player\engine)
//                         with omp://repair progress events — no admin needed
//   * omp_open_install_folder — explorer /select on the install dir so the
//                         user can see exactly what exists (and what AV removed)

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
pub struct ComponentHealth {
    pub name: String, // "engine" | "ytdlp" | "ffmpeg"
    pub label: String,
    pub present: bool,
    pub path: String,
    pub size: u64,
    /// where the copy lives: "bundled" | "self-repaired" | "missing"
    pub origin: String,
}

#[derive(Serialize)]
pub struct OmpHealth {
    pub version: String,
    pub install_dir: String,
    pub install_writable: bool,
    pub repair_dir: String,
    pub engine_loads: bool,
    pub engine_attempts: Vec<String>,
    pub components: Vec<ComponentHealth>,
}

/// Writable fallback dir for self-repaired binaries. Uses the app data dir
/// (identifier-derived), so it works with and without an AppHandle.
pub(crate) fn engine_dir(app: Option<&AppHandle>) -> Option<std::path::PathBuf> {
    if let Some(app) = app {
        if let Ok(d) = app.path().app_data_dir() {
            return Some(d.join("engine"));
        }
    }
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|r| {
            std::path::PathBuf::from(r)
                .join("app.omp.player")
                .join("engine")
        })
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(|h| {
            std::path::PathBuf::from(h)
                .join(".local/share/app.omp.player/engine")
        })
    }
}

fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(".omp-write-test");
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

use std::path::Path;

fn component(name: &str, label: &str, candidates: &[std::path::PathBuf]) -> ComponentHealth {
    for (i, p) in candidates.iter().enumerate() {
        if p.is_file() {
            let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            return ComponentHealth {
                name: name.into(),
                label: label.into(),
                present: true,
                path: p.to_string_lossy().into_owned(),
                size,
                origin: if i == 0 { "bundled".into() } else { "self-repaired".into() },
            };
        }
    }
    ComponentHealth {
        name: name.into(),
        label: label.into(),
        present: false,
        path: candidates.first().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        size: 0,
        origin: "missing".into(),
    }
}

#[tauri::command]
pub fn omp_health(app: AppHandle) -> OmpHealth {
    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    let install_writable = !install_dir.as_os_str().is_empty() && dir_writable(&install_dir);
    let repair_dir = match install_writable {
        true => install_dir.join("resources"),
        false => engine_dir(Some(&app)).unwrap_or_else(|| install_dir.join("resources")),
    };

    let mut engine_cands: Vec<std::path::PathBuf> = Vec::new();
    if !install_dir.as_os_str().is_empty() {
        engine_cands.push(install_dir.join(r"resources\mpv-2.dll"));
        engine_cands.push(install_dir.join("mpv-2.dll"));
    }
    if let Some(ed) = engine_dir(Some(&app)) {
        engine_cands.push(ed.join("mpv-2.dll"));
    }
    let mut ytdlp_cands: Vec<std::path::PathBuf> = Vec::new();
    if !install_dir.as_os_str().is_empty() {
        ytdlp_cands.push(install_dir.join(r"resources\yt-dlp.exe"));
        ytdlp_cands.push(install_dir.join("yt-dlp.exe"));
    }
    if let Some(ed) = engine_dir(Some(&app)) {
        ytdlp_cands.push(ed.join("yt-dlp.exe"));
    }
    let mut ff_cands: Vec<std::path::PathBuf> = Vec::new();
    if !install_dir.as_os_str().is_empty() {
        ff_cands.push(install_dir.join(r"resources\ffmpeg.exe"));
        ff_cands.push(install_dir.join("ffmpeg.exe"));
    }
    if let Some(ed) = engine_dir(Some(&app)) {
        ff_cands.push(ed.join("ffmpeg.exe"));
    }

    let components = vec![
        component("engine", "mpv engine (libmpv-2.dll)", &engine_cands),
        component("ytdlp", "YouTube extractor (yt-dlp.exe)", &ytdlp_cands),
        component("ffmpeg", "Editor exporter (ffmpeg.exe)", &ff_cands),
    ];

    #[cfg(windows)]
    let engine_loads = crate::mpv::api().is_some();
    #[cfg(not(windows))]
    let engine_loads = false;
    #[cfg(windows)]
    let engine_attempts = crate::mpv::last_attempts();
    #[cfg(not(windows))]
    let engine_attempts: Vec<String> = Vec::new();

    OmpHealth {
        version: env!("CARGO_PKG_VERSION").into(),
        install_dir: install_dir.to_string_lossy().into_owned(),
        install_writable,
        repair_dir: repair_dir.to_string_lossy().into_owned(),
        engine_loads,
        engine_attempts,
        components,
    }
}

/// explorer /select on the install dir — the user SEES the resources folder
/// and whatever the antivirus left behind.
#[tauri::command]
pub fn omp_open_install_folder() -> bool {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()));
    let Some(dir) = dir else { return false };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", dir.join("OMP.exe").to_string_lossy()))
            .creation_flags(0x0800_0000)
            .spawn()
            .is_ok()
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        false
    }
}

/* ------------------------------------------------------------------ */
/*  Repair downloads                                                   */
/* ------------------------------------------------------------------ */

static REPAIR_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Serialize, Clone)]
struct RepairProgress {
    kind: String,
    phase: String, // connecting | downloading | extracting | done | error
    received: u64,
    total: u64,
    msg: String,
}

fn emit(app: &AppHandle, p: RepairProgress) {
    let _ = app.emit("omp://repair", p);
}

fn pick_repair_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let install = exe.parent().ok_or("no install dir")?;
    if dir_writable(install) {
        return Ok(install.join("resources"));
    }
    let ed = engine_dir(Some(app)).ok_or("no writable location found")?;
    std::fs::create_dir_all(&ed).map_err(|e| format!("could not create {ed:?}: {e}"))?;
    Ok(ed)
}

/// Stream a URL to `dest` with omp://repair progress events.
fn download_to(
    app: &AppHandle,
    kind: &str,
    url: &str,
    dest: &Path,
) -> Result<u64, String> {
    emit(
        app,
        RepairProgress {
            kind: kind.into(),
            phase: "connecting".into(),
            received: 0,
            total: 0,
            msg: url.into(),
        },
    );
    let resp = ureq::get(url)
        .set("User-Agent", "omp-selfrepair")
        .timeout(std::time::Duration::from_secs(600))
        .call()
        .map_err(|e| format!("download failed: {e}"))?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file =
        std::fs::File::create(dest).map_err(|e| format!("could not write {dest:?}: {e}"))?;
    let mut received: u64 = 0;
    let mut last_emit = 0u64;
    let mut buf = [0u8; 65536];
    loop {
        use std::io::Read;
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                std::io::Write::write_all(&mut file, &buf[..n])
                    .map_err(|e| format!("disk write failed: {e}"))?;
                received += n as u64;
                if received - last_emit > 1_500_000 {
                    last_emit = received;
                    emit(
                        app,
                        RepairProgress {
                            kind: kind.into(),
                            phase: "downloading".into(),
                            received,
                            total,
                            msg: dest.to_string_lossy().into_owned(),
                        },
                    );
                }
            }
            Err(e) => {
                let _ = std::fs::remove_file(dest);
                return Err(format!("download interrupted: {e}"));
            }
        }
    }
    if total > 0 && received < total / 2 {
        let _ = std::fs::remove_file(dest);
        return Err(format!("download truncated ({received}/{total} bytes)"));
    }
    Ok(received)
}

#[tauri::command]
pub fn omp_repair_download(app: AppHandle, kind: String) -> bool {
    // SYNC COMMANDS RUN ON THE MAIN THREAD (the v0.6.1 widget deadlock rule)
    // — spawn and return immediately; progress flows via omp://repair events.
    if REPAIR_BUSY.swap(true, std::sync::atomic::Ordering::SeqCst) {
        emit(&app, RepairProgress {
            kind,
            phase: "error".into(),
            received: 0,
            total: 0,
            msg: "a repair is already running".into(),
        });
        return false;
    }
    let app2 = app.clone();
    let kind2 = kind.clone();
    std::thread::spawn(move || {
        let mut ok = false;
        match run_repair(&app2, &kind2) {
            Ok(path) => {
                ok = true;
                emit(&app2, RepairProgress {
                    kind: kind2.clone(),
                    phase: "done".into(),
                    received: 0,
                    total: 0,
                    msg: path,
                });
            }
            Err(msg) => emit(&app2, RepairProgress {
                kind: kind2.clone(),
                phase: "error".into(),
                received: 0,
                total: 0,
                msg,
            }),
        }
        REPAIR_BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
        // engine repaired → the UI re-probes (health + initEngine) on "done"
        if ok && kind2 == "engine" {
            let _ = app2.emit("omp://repair-refresh", true);
        }
    });
    true
}

fn run_repair(app: &AppHandle, kind: &str) -> Result<String, String> {
    let dir = pick_repair_dir(app)?;
    match kind {
        "ytdlp" => {
            let dest = dir.join("yt-dlp.exe");
            let got = download_to(
                app,
                kind,
                "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
                &dest,
            )?;
            if got < 8_000_000 {
                let _ = std::fs::remove_file(&dest);
                return Err(format!("downloaded file suspiciously small ({got} bytes)"));
            }
            emit(app, RepairProgress { kind: kind.into(), phase: "done".into(), received: got, total: got, msg: dest.to_string_lossy().into_owned() });
            Ok(dest.to_string_lossy().into_owned())
        }
        "engine" => {
            #[cfg(windows)]
            if crate::mpv::api().is_some() {
                return Err("the engine already loads — no repair needed".into());
            }
            // 1) discover the latest official mpv-dev archive
            emit(app, RepairProgress { kind: kind.into(), phase: "connecting".into(), received: 0, total: 0, msg: "looking up the official mpv build".into() });
            let api: serde_json::Value = ureq::get("https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest")
                .set("User-Agent", "omp-selfrepair")
                .timeout(std::time::Duration::from_secs(30))
                .call()
                .map_err(|e| format!("release lookup failed: {e}"))?
                .into_json()
                .map_err(|e| e.to_string())?;
            let asset = api["assets"]
                .as_array()
                .ok_or("release has no assets")?
                .iter()
                .find(|a| {
                    let n = a["name"].as_str().unwrap_or("");
                    n.starts_with("mpv-dev-x86_64-") && n.ends_with(".7z") && !n.contains("v3")
                })
                .ok_or("no suitable mpv-dev asset in the latest release")?;
            let url = asset["browser_download_url"]
                .as_str()
                .ok_or("asset has no download url")?
                .to_string();
            // 2) download the archive (~35 MB)
            let archive = dir.join("omp-mpv-dev.7z");
            let got = download_to(app, kind, &url, &archive)?;
            // 3) extract ONLY libmpv-2.dll
            emit(app, RepairProgress { kind: kind.into(), phase: "extracting".into(), received: got, total: got, msg: "extracting libmpv-2.dll".into() });
            let dll_dest = dir.join("mpv-2.dll");
            let mut found = false;
            {
                let mut sz = sevenz_rust::SevenZReader::open(&archive, sevenz_rust::Password::empty())
                    .map_err(|e| format!("could not open the mpv archive: {e}"))?;
                sz.for_each_entries(|entry, reader| {
                    if entry.name().ends_with("libmpv-2.dll") {
                        match std::fs::File::create(&dll_dest)
                            .and_then(|mut f| std::io::copy(reader, &mut f).map(|_| ()))
                        {
                            Ok(_) => found = true,
                            Err(e) => return Err(sevenz_rust::Error::from(e)),
                        }
                    }
                    Ok(true)
                })
                .map_err(|e| format!("could not read the mpv archive: {e}"))?;
            }
            let _ = std::fs::remove_file(&archive);
            if !found {
                return Err("libmpv-2.dll was not inside the downloaded archive".into());
            }
            let size = std::fs::metadata(&dll_dest).map(|m| m.len()).unwrap_or(0);
            if size < 20_000_000 {
                let _ = std::fs::remove_file(&dll_dest);
                return Err("extracted engine dll suspiciously small — discarded".into());
            }
            // 4) re-probe immediately
            #[cfg(windows)]
            crate::mpv::reset_api();
            let mut msg = format!("{} — self-repair complete", dll_dest.to_string_lossy());
            #[cfg(windows)]
            {
                let ok = crate::mpv::api().is_some();
                if !ok {
                    return Err(format!(
                        "the engine dll landed at {dll_dest:?} but still refuses to load — Windows may be blocking it; add OMP to your antivirus allowlist"
                    ));
                }
                msg = format!("{} — engine loads now", dll_dest.to_string_lossy());
            }
            Ok(msg)
        }
        other => Err(format!("unknown repair kind: {other}")),
    }
}
