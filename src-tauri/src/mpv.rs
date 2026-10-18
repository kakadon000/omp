// OMP — Open Media Player · native playback engine (libmpv)
//
// Architecture (spec: "keep native mpv integration inside a dedicated module"):
//   * mpv-2.dll is loaded at RUNTIME (GetProcAddress) — no link-time deps,
//     and the app still runs (WebView2 engine fallback) when the DLL is absent.
//   * Video renders into a child HWND owned by the main window, kept BELOW the
//     transparent webview — so HTML controls/overlays draw on top of real video,
//     and all input stays in the webview (zero hit-test tricks needed).
//   * One background thread pumps mpv events (time-pos throttled to ~4 Hz) and
//     forwards them to the UI as `omp://mpv` Tauri events.

#![allow(non_snake_case, non_camel_case_types)]

use std::ffi::{c_char, c_void, CString};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/* ------------------------------------------------------------------ */
/* Win32 — minimal FFI, no external crates                             */
/* ------------------------------------------------------------------ */

type HWND = isize;
type HMODULE = isize;
type WNDPROC = unsafe extern "system" fn(HWND, u32, usize, isize) -> isize;

const WS_CHILD: u32 = 0x4000_0000;
const WS_CLIPSIBLINGS: u32 = 0x0400_0000;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_NOZORDER: u32 = 0x0004;
const SW_SHOW: i32 = 5;
const SW_HIDE: i32 = 0;
const HWND_BOTTOM: HWND = 1;

#[repr(C)]
struct WNDCLASSW {
    style: u32,
    lpfnWndProc: WNDPROC,
    cbClsExtra: i32,
    cbWndExtra: i32,
    hInstance: HMODULE,
    hIcon: isize,
    hCursor: isize,
    hbrBackground: isize,
    lpszMenuName: *const u16,
    lpszClassName: *const u16,
}

#[link(name = "user32")]
extern "system" {
    fn RegisterClassW(cls: *const WNDCLASSW) -> u16;
    fn CreateWindowExW(
        ex: u32, class: *const u16, name: *const u16, style: u32,
        x: i32, y: i32, w: i32, h: i32,
        parent: HWND, menu: isize, inst: HMODULE, param: *mut c_void,
    ) -> HWND;
    fn DestroyWindow(h: HWND) -> i32;
    fn ShowWindow(h: HWND, cmd: i32) -> i32;
    fn SetWindowPos(h: HWND, after: HWND, x: i32, y: i32, w: i32, hh: i32, flags: u32) -> i32;
    fn DefWindowProcW(h: HWND, msg: u32, wp: usize, lp: isize) -> isize;
}

#[link(name = "gdi32")]
extern "system" {
    fn GetStockObject(i: i32) -> isize;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> HMODULE;
    fn LoadLibraryW(name: *const u16) -> HMODULE;
    fn FreeLibrary(m: HMODULE) -> i32;
    fn GetProcAddress(m: HMODULE, name: *const u8) -> *mut c_void;
}

unsafe extern "system" fn surf_proc(h: HWND, msg: u32, wp: usize, lp: isize) -> isize {
    DefWindowProcW(h, msg, wp, lp)
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Create the mpv child window (MUST run on the main thread).
unsafe fn create_surface(parent: HWND, class_atom: &str) -> Result<HWND, String> {
    static REGISTERED: OnceLock<()> = OnceLock::new();
    let class_w = to_wide(class_atom);
    if REGISTERED.set(()).is_ok() {
        let inst = GetModuleHandleW(std::ptr::null());
        let cls = WNDCLASSW {
            style: 0,
            lpfnWndProc: surf_proc,
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: inst,
            hIcon: 0,
            hCursor: 0,
            hbrBackground: GetStockObject(4), // BLACK_BRUSH — no white flash
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_w.as_ptr(),
        };
        if RegisterClassW(&cls) == 0 {
            return Err("RegisterClassW failed".into());
        }
    }
    let hwnd = CreateWindowExW(
        0,
        class_w.as_ptr(),
        class_w.as_ptr(),
        WS_CHILD | WS_CLIPSIBLINGS, // created hidden; shown on first rect
        0, 0, 1, 1,
        parent,
        0,
        GetModuleHandleW(std::ptr::null()),
        std::ptr::null_mut(),
    );
    if hwnd == 0 {
        return Err("CreateWindowExW failed".into());
    }
    // park the video surface BELOW the webview so HTML overlays draw on top
    SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    Ok(hwnd)
}

/* ------------------------------------------------------------------ */
/* libmpv — runtime-loaded C API                                       */
/* ------------------------------------------------------------------ */

type MpvHandle = c_void;

// mpv_format values
const FMT_STRING: i32 = 1;
const FMT_FLAG: i32 = 3;
const FMT_DOUBLE: i32 = 5;

// mpv_event_id values we care about
const EV_SHUTDOWN: i32 = 1;
const EV_END_FILE: i32 = 7;
const EV_FILE_LOADED: i32 = 8;
const EV_PROPERTY_CHANGE: i32 = 22;

#[repr(C)]
struct MpvEvent {
    event_id: i32,
    error: i32,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct MpvEventProperty {
    name: *const c_char,
    format: i32,
    data: *mut c_void,
}

pub(crate) struct MpvApi {
    create: unsafe extern "C" fn() -> *mut MpvHandle,
    initialize: unsafe extern "C" fn(*mut MpvHandle) -> i32,
    terminate_destroy: unsafe extern "C" fn(*mut MpvHandle),
    set_option_string: unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> i32,
    set_property_string: unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> i32,
    get_property_string: unsafe extern "C" fn(*mut MpvHandle, *const c_char, *mut *mut c_char) -> i32,
    free: unsafe extern "C" fn(*mut c_void),
    command: unsafe extern "C" fn(*mut MpvHandle, *const *const c_char) -> i32,
    observe_property: unsafe extern "C" fn(*mut MpvHandle, u64, *const c_char, i32) -> i32,
    wait_event: unsafe extern "C" fn(*mut MpvHandle, f64) -> *mut MpvEvent,
    wakeup: unsafe extern "C" fn(*mut MpvHandle),
    error_string: unsafe extern "C" fn(i32) -> *const c_char,
    client_api_version: unsafe extern "C" fn() -> u32,
}

unsafe fn load_api() -> Option<MpvApi> {
    // search order: plain names let Windows find the exe-dir copy;
    // absolute paths cover the `resources/` layout and dev trees
    let mut libs: Vec<HMODULE> = Vec::new();
    for name in ["mpv-2.dll", "mpv-1.dll", "libmpv-2.dll", "libmpv.dll"] {
        let wide = to_wide(name);
        let h = LoadLibraryW(wide.as_ptr());
        if h != 0 {
            libs.push(h);
            break;
        }
    }
    if libs.is_empty() {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for rel in ["mpv-2.dll", r"resources\mpv-2.dll", r"..\mpv-2.dll"] {
                    let p = dir.join(rel);
                    if p.exists() {
                        let wide = to_wide(&p.to_string_lossy());
                        let h = LoadLibraryW(wide.as_ptr());
                        if h != 0 {
                            libs.push(h);
                            break;
                        }
                    }
                }
            }
        }
    }
    let m = *libs.first()?;
    let sym = |name: &str| -> Option<*mut c_void> {
        let p = GetProcAddress(m, name.as_bytes().as_ptr());
        if p.is_null() { None } else { Some(p) }
    };
    let create: unsafe extern "C" fn() -> *mut MpvHandle = std::mem::transmute(sym("mpv_create")?);
    let initialize: unsafe extern "C" fn(*mut MpvHandle) -> i32 = std::mem::transmute(sym("mpv_initialize")?);
    let terminate_destroy: unsafe extern "C" fn(*mut MpvHandle) = std::mem::transmute(sym("mpv_terminate_destroy")?);
    let set_option_string: unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> i32 =
        std::mem::transmute(sym("mpv_set_option_string")?);
    let set_property_string: unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> i32 =
        std::mem::transmute(sym("mpv_set_property_string")?);
    let get_property_string: unsafe extern "C" fn(*mut MpvHandle, *const c_char, *mut *mut c_char) -> i32 =
        std::mem::transmute(sym("mpv_get_property_string")?);
    let free: unsafe extern "C" fn(*mut c_void) = std::mem::transmute(sym("mpv_free")?);
    let command: unsafe extern "C" fn(*mut MpvHandle, *const *const c_char) -> i32 =
        std::mem::transmute(sym("mpv_command")?);
    let observe_property: unsafe extern "C" fn(*mut MpvHandle, u64, *const c_char, i32) -> i32 =
        std::mem::transmute(sym("mpv_observe_property")?);
    let wait_event: unsafe extern "C" fn(*mut MpvHandle, f64) -> *mut MpvEvent =
        std::mem::transmute(sym("mpv_wait_event")?);
    let wakeup: unsafe extern "C" fn(*mut MpvHandle) = std::mem::transmute(sym("mpv_wakeup")?);
    let error_string: unsafe extern "C" fn(i32) -> *const c_char = std::mem::transmute(sym("mpv_error_string")?);
    let client_api_version: unsafe extern "C" fn() -> u32 = std::mem::transmute(sym("mpv_client_api_version")?);
    Some(MpvApi {
        create,
        initialize,
        terminate_destroy,
        set_option_string,
        set_property_string,
        get_property_string,
        free,
        command,
        observe_property,
        wait_event,
        wakeup,
        error_string,
        client_api_version,
    })
}

/// Engine API cache. A Mutex (not OnceLock) so `mpv_retest` can CLEAR it:
/// if the user whitelists the DLL in their antivirus after a failed probe,
/// the next api() call must re-run LoadLibraryW instead of remembering None.
static API: Mutex<Option<Arc<MpvApi>>> = Mutex::new(None);

pub(crate) fn api() -> Option<Arc<MpvApi>> {
    if let Ok(g) = API.lock() {
        if let Some(a) = g.as_ref() {
            return Some(Arc::clone(a));
        }
    }
    let loaded = unsafe { load_api() }.map(Arc::new);
    let mut g = API.lock().ok()?;
    if g.is_none() {
        *g = loaded;
    }
    g.as_ref().map(Arc::clone)
}

/// v0.6.2 — drop the cached probe so the next api() re-probes from scratch.
/// Wired to the Settings "Re-test engine" button.
pub(crate) fn reset_api() {
    if let Ok(mut g) = API.lock() {
        *g = None;
    }
}

fn err_str(a: &MpvApi, code: i32) -> String {
    unsafe {
        let p = (a.error_string)(code);
        if p.is_null() {
            format!("mpv error {code}")
        } else {
            std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned()
        }
    }
}

unsafe fn get_prop_string(a: &MpvApi, h: *mut MpvHandle, name: &str) -> Option<String> {
    let n = CString::new(name).ok()?;
    let mut out: *mut c_char = std::ptr::null_mut();
    if (a.get_property_string)(h, n.as_ptr(), &mut out) == 0 && !out.is_null() {
        let s = std::ffi::CStr::from_ptr(out).to_string_lossy().into_owned();
        (a.free)(out as *mut c_void);
        Some(s)
    } else {
        None
    }
}

unsafe fn set_prop_string(a: &MpvApi, h: *mut MpvHandle, name: &str, value: &str) -> bool {
    let Ok(n) = CString::new(name) else { return false };
    let Ok(v) = CString::new(value) else { return false };
    (a.set_property_string)(h, n.as_ptr(), v.as_ptr()) == 0
}

unsafe fn command(a: &MpvApi, h: *mut MpvHandle, args: &[&str]) -> Result<(), String> {
    let cs: Vec<CString> = args
        .iter()
        .map(|s| CString::new(*s).map_err(|_| "bad arg"))
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut ptrs: Vec<*const c_char> = cs.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    let code = (a.command)(h, ptrs.as_ptr());
    if code == 0 {
        Ok(())
    } else {
        Err(err_str(a, code))
    }
}

/* ------------------------------------------------------------------ */
/* Instance state                                                      */
/* ------------------------------------------------------------------ */

struct Instance {
    h: SendPtr,
    hwnd: HWND,
    shown: bool,
    /// v0.6.2: KIND_VIDEO keeps the embedded surface + GPU VO;
    /// KIND_AUDIO is surface-less (no HWND, vo=null) so audio never
    /// depends on the video pipeline at all.
    kind: u8,
    stop: Arc<AtomicBool>,
    joined: Option<std::thread::JoinHandle<()>>,
}

const KIND_VIDEO: u8 = 0;
const KIND_AUDIO: u8 = 1;

/// mpv handles are documented thread-safe for property/command calls;
/// wrap the raw pointer so the event-pump thread can own a copy.
#[derive(Clone, Copy)]
struct SendPtr(*mut MpvHandle);
unsafe impl Send for SendPtr {}
unsafe impl Sync for SendPtr {}

static MPV: Mutex<Option<Instance>> = Mutex::new(None);

#[derive(Serialize, Clone)]
pub struct Status {
    pub available: bool,
    pub active: bool,
    pub version: Option<String>,
    /// v0.6.2: WHY the last attach failed ("mpv_initialize failed: …") —
    /// surfaces in the UI toast + Settings instead of failing silently.
    pub error: Option<String>,
}

/// "2.3" style libmpv client API version for the UI.
fn api_version_string(v: u32) -> String {
    format!("{}.{}", v / 100, v % 100)
}

/// Resolve a frontend source (relative /media/x.mp4, asset URL, http URL or
/// real path) into something mpv can open: a filesystem path or a stream URL.
fn resolve_media(src: &str) -> String {
    if src.is_empty() {
        return src.to_string();
    }
    if src.starts_with("http://") || src.starts_with("https://") {
        // mpv streams these natively (radio, IPTV, HLS)
        return src.to_string();
    }
    // asset-protocol URL → percent-encoded real path
    let decoded = percent_decode(src.split_once("/").map(|x| x.1).unwrap_or(src));
    let mut candidates: Vec<String> = vec![decoded.clone(), src.to_string()];
    if let Some(base) = src.rsplit(['/', '\\']).next() {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("resources").join("media").join(base).to_string_lossy().into_owned());
                candidates.push(dir.join("media").join(base).to_string_lossy().into_owned());
            }
        }
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("public").join("media").join(base).to_string_lossy().into_owned());
            candidates.push(cwd.join("..").join("public").join("media").join(base).to_string_lossy().into_owned());
        }
    }
    for c in &candidates {
        if !c.is_empty() && Path::new(c).is_file() {
            return c.clone();
        }
    }
    src.to_string()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/* ------------------------------------------------------------------ */
/* Event pump thread                                                   */
/* ------------------------------------------------------------------ */

fn pump(h: SendPtr, app: AppHandle, stop: Arc<AtomicBool>) {
    let h = h.0;
    let Some(a) = api() else { return };
    let a = a.as_ref(); // &MpvApi — the Arc stays alive in the shadowed binding
    let mut last_tick = Instant::now() - std::time::Duration::from_secs(1);
    unsafe {
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let ev = (a.wait_event)(h, 0.4);
            if ev.is_null() {
                continue;
            }
            let id = (*ev).event_id;
            let data = (*ev).data;
            match id {
                EV_SHUTDOWN => {
                    // v0.6.2: the core is gone — self-remove the stale instance
                    // so mpv_status().active goes false and the next play
                    // cleanly re-attaches (previously the dead instance stayed
                    // registered and every later mpv_load failed forever).
                    let mut drop_hwnd: HWND = 0;
                    if let Ok(mut g) = MPV.lock() {
                        let mine = g.as_ref().map(|i| i.h.0 == h).unwrap_or(false);
                        if mine {
                            drop_hwnd = g.as_ref().map(|i| i.hwnd).unwrap_or(0);
                            *g = None;
                        }
                    }
                    if drop_hwnd != 0 {
                        // the surface was created on the main thread — destroy
                        // it there too (Win32 rule, background threads can't)
                        // (already inside the pump's unsafe block)
                        let _ = app.run_on_main_thread(move || {
                            DestroyWindow(drop_hwnd);
                        });
                    }
                    let _ = app.emit("omp://mpv", serde_json::json!({ "kind": "died" }));
                    break;
                }
                EV_END_FILE => {
                    let reason = if data.is_null() { -1 } else { *(data as *const i32) };
                    let payload = if reason == 0 {
                        serde_json::json!({ "kind": "ended" })
                    } else {
                        serde_json::json!({ "kind": "file-error", "msg": format!("stopped ({reason})") })
                    };
                    let _ = app.emit("omp://mpv", payload);
                }
                EV_FILE_LOADED => {
                    let dur = get_prop_string(a, h, "duration")
                        .and_then(|s| s.parse::<f64>().ok())
                        .unwrap_or(0.0);
                    let tracks = get_prop_string(a, h, "track-list").unwrap_or_default();
                    let (vw, vh) = get_prop_string(a, h, "video-params")
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                        .map(|v| {
                            (
                                v.get("w").and_then(|x| x.as_i64()).unwrap_or(0),
                                v.get("h").and_then(|x| x.as_i64()).unwrap_or(0),
                            )
                        })
                        .unwrap_or((0, 0));
                    // Phase 3: the actual resolved path — lets the audio service
                    // know when a video loadfile took the engine over
                    let path = get_prop_string(a, h, "path").unwrap_or_default();
                    let _ = app.emit(
                        "omp://mpv",
                        serde_json::json!({
                            "kind": "loaded", "d": dur, "tracks": tracks, "vw": vw, "vh": vh,
                            "path": path
                        }),
                    );
                    // pause state requested before load applies now — push it
                    let paused = get_prop_string(a, h, "pause")
                        .map(|s| s == "yes" || s == "true")
                        .unwrap_or(false);
                    let _ = app.emit("omp://mpv", serde_json::json!({ "kind": "pause", "paused": paused }));
                }
                EV_PROPERTY_CHANGE => {
                    if data.is_null() {
                        continue;
                    }
                    let p = data as *const MpvEventProperty;
                    let name = std::ffi::CStr::from_ptr((*p).name).to_string_lossy().into_owned();
                    match (name.as_str(), (*p).format) {
                        ("time-pos", FMT_DOUBLE) => {
                            if last_tick.elapsed().as_millis() >= 250 {
                                last_tick = Instant::now();
                                let t = *((*p).data as *const f64);
                                let _ = app.emit("omp://mpv", serde_json::json!({ "kind": "tick", "t": t }));
                            }
                        }
                        ("pause", FMT_FLAG) => {
                            let paused = *((*p).data as *const i32) != 0;
                            let _ = app.emit("omp://mpv", serde_json::json!({ "kind": "pause", "paused": paused }));
                        }
                        ("duration", FMT_DOUBLE) => {
                            let d = *((*p).data as *const f64);
                            let _ = app.emit("omp://mpv", serde_json::json!({ "kind": "duration", "d": d }));
                        }
                        ("icy-title", FMT_STRING) => {
                            // internet radio now-playing metadata (Phase 3)
                            if !(*p).data.is_null() {
                                let t = std::ffi::CStr::from_ptr((*p).data as *const c_char)
                                    .to_string_lossy()
                                    .into_owned();
                                if !t.is_empty() {
                                    let _ = app.emit("omp://mpv", serde_json::json!({ "kind": "icy", "title": t }));
                                }
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* Tauri commands                                                      */
/* ------------------------------------------------------------------ */

fn with_instance<T>(f: impl FnOnce(&Instance, &MpvApi) -> T) -> Option<T> {
    let guard = MPV.lock().ok()?;
    let inst = guard.as_ref()?;
    let a = api()?;
    Some(f(inst, &a))
}

#[tauri::command]
pub fn mpv_status() -> Status {
    let a = api();
    let active = MPV.lock().map(|g| g.is_some()).unwrap_or(false);
    Status {
        available: a.is_some(),
        active,
        version: a.map(|a| unsafe { api_version_string((a.client_api_version)()) }),
        error: None,
    }
}

/// v0.6.2 — Settings "Re-test engine": forget the cached LoadLibrary probe
/// so a repaired environment (DLL whitelisted in antivirus, driver updated,
/// installer re-run) is picked up without restarting OMP.
#[tauri::command]
pub fn mpv_retest() -> bool {
    reset_api();
    api().is_some()
}

#[tauri::command]
pub fn mpv_attach(app: AppHandle, hwdec: Option<String>, show: Option<bool>) -> Status {
    let video = show.unwrap_or(true);
    let mut st = mpv_status();
    if !st.available {
        st.error = Some("The libmpv engine DLL is missing or refused to load in this install".into());
        return st;
    }
    // v0.6.2: the engine is GLOBAL — reconcile the instance KIND with the
    // request. Audio sessions run surface-less (no child HWND, no wid,
    // vo=null): audio never depended on the GPU, so machines whose video VO
    // fails can still play every audio format. A kind mismatch (video
    // requested while an audio instance is live, or the reverse) releases
    // the old instance and rebuilds in the right mode.
    if st.active {
        let want = if video { KIND_VIDEO } else { KIND_AUDIO };
        let have = with_instance(|i, _| i.kind).unwrap_or(want);
        if have == want {
            if video {
                if let Some(hwnd) = with_instance(|i, _| i.hwnd) {
                    unsafe {
                        ShowWindow(hwnd, SW_SHOW);
                    }
                }
                // video is back on screen — same CPU rule as a fresh attach
                crate::set_playback_effects(&app, true);
            }
            return st;
        }
        detach_impl();
        st = mpv_status();
    }

    let app2 = app.clone();

    // video mode parks a child HWND below the webview; audio mode is
    // surface-less (hwnd stays 0)
    let hwnd: HWND = if video {
        let Some(main) = app.get_webview_window("main") else {
            st.error = Some("main window not found".into());
            return st;
        };
        let Ok(parent) = main.hwnd() else {
            st.error = Some("could not read the main window handle".into());
            return st;
        };
        let parent_hwnd = parent.0 as isize;
        // create the child window on the main (event-loop) thread
        let (tx, rx) = std::sync::mpsc::channel();
        let spawn = app.run_on_main_thread(move || unsafe {
            let _ = tx.send(create_surface(parent_hwnd, "OMP_MPV_SURF"));
        });
        if spawn.is_err() {
            st.error = Some("could not schedule the video surface".into());
            return st;
        }
        match rx.recv() {
            Ok(Ok(h)) => h,
            _ => {
                st.error = Some("video surface creation failed".into());
                return st;
            }
        }
    } else {
        0
    };

    let Some(a) = api() else { return st };
    unsafe {
        let h = (a.create)();
        if h.is_null() {
            if hwnd != 0 {
                DestroyWindow(hwnd);
            }
            st.error = Some("mpv_create failed — the DLL loaded but could not build a core".into());
            return st;
        }
        if video {
            // wid embed: set BEFORE initialize — numeric HWND string
            let n_wid = CString::new("wid").unwrap();
            let wid_str: CString = CString::new(hwnd.to_string()).unwrap();
            (a.set_option_string)(h, n_wid.as_ptr(), wid_str.as_ptr());
        }
        for (k, v) in [
            // v0.6.2 CRITICAL FIX: idle=yes. mpv's default (idle=no) makes an
            // EMPTY core shut itself down right after initialization — the
            // classic libmpv trap. Audio attaches happened WITHOUT a file, so
            // the core died before the first loadfile ever arrived and every
            // music session was born dead on affected builds.
            ("idle", "yes"),
            ("osc", "no"),
            ("osd-level", "0"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            ("input-cursor", "no"),
            ("cursor-autohide", "no"),
            ("keep-open", "no"),
            ("sub-auto", "fuzzy"),
            ("audio-file-auto", "fuzzy"),
            ("ytdl", "no"),
            ("terminal", "no"),
            ("msg-level", "all=warn"),
        ] {
            let n = CString::new(k).unwrap();
            let v = CString::new(v).unwrap();
            (a.set_option_string)(h, n.as_ptr(), v.as_ptr());
        }
        if video {
            for (k, v) in [
                ("vo", "gpu-next,gpu"),
                // "auto-safe" refuses hwdec on non-whitelisted drivers → silent
                // software decode → CPU burn. "auto" still falls back to SW when
                // genuinely unsupported, but takes the GPU path far more often.
                ("hwdec", hwdec.as_deref().unwrap_or("auto")),
                ("hwdec-codecs", "all"),
                // software-decode fast paths (no-ops when hardware decode engages)
                ("vd-lavc-fast", "yes"),
                ("vd-lavc-skiploopfilter", "nonref"),
            ] {
                let n = CString::new(k).unwrap();
                let v = CString::new(v).unwrap();
                (a.set_option_string)(h, n.as_ptr(), v.as_ptr());
            }
        } else {
            for (k, v) in [
                // surface-less audio: no video output at all, no album-art window
                ("vo", "null"),
                ("audio-display", "no"),
                ("force-window", "no"),
            ] {
                let n = CString::new(k).unwrap();
                let v = CString::new(v).unwrap();
                (a.set_option_string)(h, n.as_ptr(), v.as_ptr());
            }
        }
        let code = (a.initialize)(h);
        if code != 0 {
            let why = err_str(&a, code);
            (a.terminate_destroy)(h);
            if hwnd != 0 {
                DestroyWindow(hwnd);
            }
            st.error = Some(format!("mpv_initialize failed: {why}"));
            return st;
        }
        let n = CString::new("time-pos").unwrap();
        (a.observe_property)(h, 1, n.as_ptr(), FMT_DOUBLE);
        let n = CString::new("pause").unwrap();
        (a.observe_property)(h, 2, n.as_ptr(), FMT_FLAG);
        let n = CString::new("duration").unwrap();
        (a.observe_property)(h, 3, n.as_ptr(), FMT_DOUBLE);
        // internet radio now-playing (fires only when the stream provides it)
        let n = CString::new("icy-title").unwrap();
        (a.observe_property)(h, 4, n.as_ptr(), FMT_STRING);

        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let hp = SendPtr(h);
        let thread = std::thread::spawn(move || pump(hp, app2, stop2));

        let mut guard = MPV.lock().unwrap();
        *guard = Some(Instance {
            h: SendPtr(h),
            hwnd,
            shown: false,
            kind: if video { KIND_VIDEO } else { KIND_AUDIO },
            stop,
            joined: Some(thread),
        });
        drop(guard);

        // v0.5.0 CPU fix — now that the surface is genuinely attached:
        // strip the DWM material (Mica/Acrylic) while video plays under the
        // transparent webview. Blur-behind over 60fps video was forcing a
        // full-window blur recomposition every single frame. Restored on
        // mpv_detach. Only for VISIBLE (video) attaches — audio sessions
        // keep the glass; there is no video to fight the material.
        if video {
            crate::set_playback_effects(&app, true);
        }
    }
    mpv_status()
}

#[tauri::command]
pub fn mpv_detach(app: AppHandle) -> bool {
    // Phase 3: the engine is GLOBAL. If music is what's loaded, navigating
    // away (Player unmount) must NOT kill it — hide the video surface and
    // keep the engine running. Only video/idle sessions fully release.
    if is_audio_active() {
        if let Some(hwnd) = with_instance(|i, _| i.hwnd) {
            if hwnd != 0 {
                unsafe {
                    ShowWindow(hwnd, SW_HIDE);
                }
            }
        }
        return true;
    }
    // v0.5.0 CPU fix mirror: bring the Mica/Acrylic glass back for the UI
    crate::set_playback_effects(&app, false);
    let released = detach_impl();
    if released {
        // v0.6.2: the JS audio service latches `attached=true` and never saw
        // a "died" event for command-driven teardowns — after watching video
        // (Player unmount → full detach) every later mpv_load hit an empty
        // engine and music stayed broken until restart. Broadcast died so
        // the latch resets; playInner also self-repairs on load failure.
        let _ = app.emit("omp://mpv", serde_json::json!({ "kind": "died" }));
    }
    released
}

/// On-demand engine stats for the "Stats for nerds" overlay.
/// Read only while the overlay is open — zero polling cost when closed.
#[derive(Serialize)]
pub struct EngineStats {
    pub hwdec: String,      // "d3d11va", "nvdec", ... or "no"/"" for software
    pub vo: String,         // active video output driver
    pub vf_fps: f64,        // estimated rendering fps
    pub fps: f64,           // container fps
    pub dropped: u64,       // dropped frame count
    pub audio: String,      // active audio device shorthand
    pub avsync: f64,
    pub bitrate: f64,       // video bitrate kbps
    pub path: String,       // currently loaded media path (ownership checks)
}

#[tauri::command]
pub fn mpv_stats() -> Option<EngineStats> {
    let s = with_instance(|inst, a| unsafe {
        let h = inst.h.0;
        let prop = |name: &str| -> String {
            get_prop_string(a, h, name).unwrap_or_default()
        };
        EngineStats {
            hwdec: prop("hwdec-current"),
            vo: prop("current-vo"),
            vf_fps: prop("estimated-vf-fps").parse().unwrap_or(0.0),
            fps: prop("container-fps").parse().unwrap_or(0.0),
            dropped: prop("dropped-frame-count").parse().unwrap_or(0),
            audio: prop("current-ao"),
            avsync: prop("avsync").parse().unwrap_or(0.0),
            bitrate: prop("video-bitrate").parse().unwrap_or(0.0),
            path: prop("path"),
        }
    });
    s
}

/// v0.6.1 — engine diagnostics for the Settings screen. When libmpv fails to
/// load on a user machine (blocked DLL, missing Vulkan loader, AV quarantine)
/// every symptom used to be silent: no music, no thumbnails, a vague warning.
/// This reports the EXACT probe result: which path exists, which loaded, and
/// the raw Win32 error code of the failure.
#[derive(Serialize)]
pub struct EngineDiag {
    pub available: bool,     // DLL loaded + symbols resolved (cached decision)
    pub initialized: bool,   // an mpv instance exists right now
    pub dll_path: String,    // the path that LOADED ("" when none)
    pub probed_path: String, // the candidate we tried last in this call
    pub load_error: u32,     // GetLastError of the failed LoadLibraryW (0 = ok)
    pub version: Option<String>,
}

#[tauri::command]
pub fn mpv_diag() -> EngineDiag {
    #[cfg(windows)]
    unsafe {
        // nested fn (not a closure): closures keep their captures borrowed
        // until end of scope, which clashed with reading the results below.
        unsafe fn try_load(
            path: &str,
            probed: &mut String,
            loaded: &mut Option<String>,
            last_err: &mut u32,
        ) -> bool {
            *probed = path.to_string();
            let wide = to_wide(path);
            let h = LoadLibraryW(wide.as_ptr());
            if h != 0 {
                *loaded = Some(path.to_string());
                FreeLibrary(h);
                true
            } else {
                // std's last_os_error is the reliable GetLastError read
                *last_err = std::io::Error::last_os_error()
                    .raw_os_error()
                    .unwrap_or(0) as u32;
                false
            }
        }

        let mut last_err: u32 = 0;
        let mut probed = String::new();
        let mut loaded: Option<String> = None;

        // re-probe every candidate WITHOUT caching, purely for diagnostics
        try_load("mpv-2.dll", &mut probed, &mut loaded, &mut last_err);
        if loaded.is_none() {
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    for rel in ["mpv-2.dll", "resources\\mpv-2.dll", "..\\mpv-2.dll"] {
                        let p = dir.join(rel);
                        if p.exists()
                            && try_load(&p.to_string_lossy(), &mut probed, &mut loaded, &mut last_err)
                        {
                            break;
                        }
                    }
                }
            }
        }

        let a = api();
        EngineDiag {
            available: a.is_some(),
            initialized: MPV.lock().map(|g| g.is_some()).unwrap_or(false),
            dll_path: loaded.unwrap_or_default(),
            probed_path: probed,
            load_error: if a.is_some() { 0 } else { last_err },
            version: a.map(|a| api_version_string((a.client_api_version)())),
        }
    }
    #[cfg(not(windows))]
    {
        EngineDiag {
            available: api().is_some(),
            initialized: false,
            dll_path: String::new(),
            probed_path: String::new(),
            load_error: 0,
            version: None,
        }
    }
}

/// True when the engine has an AUDIO file loaded —
/// drives "close keeps the music playing" background behaviour.
/// Embedded album art counts as audio; any real video track counts as video.
pub(crate) fn is_audio_active() -> bool {
    with_instance(|inst, a| unsafe {
        // idle-active: nothing queued at all
        let idle = get_prop_string(a, inst.h.0, "idle-active")
            .map(|s| s == "yes" || s == "true")
            .unwrap_or(true);
        if idle {
            return false;
        }
        let tracks = get_prop_string(a, inst.h.0, "track-list").unwrap_or_default();
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&tracks) else {
            return false;
        };
        let Some(arr) = v.as_array() else { return false };
        // any real (non-albumart) video track → this is video, not audio
        !arr.iter().any(|t| {
            t.get("type").and_then(|x| x.as_str()) == Some("video")
                && t.get("albumart").and_then(|x| x.as_bool()) != Some(true)
        })
    })
    .unwrap_or(false)
}

fn detach_impl() -> bool {
    let taken = MPV.lock().ok().and_then(|mut g| g.take());
    if let Some(inst) = taken {
        inst.stop.store(true, Ordering::Relaxed);
        if let Some(a) = api() {
            unsafe { (a.wakeup)(inst.h.0) };
            if let Some(j) = inst.joined {
                let _ = j.join();
            }
            unsafe { (a.terminate_destroy)(inst.h.0) };
        }
        if inst.hwnd != 0 {
            unsafe {
                DestroyWindow(inst.hwnd);
            }
        }
        true
    } else {
        false
    }
}

/// App exit: release everything.
pub fn shutdown_all() {
    detach_impl();
}

#[tauri::command]
pub fn mpv_set_rect(app: AppHandle, x: f64, y: f64, w: f64, h: f64) -> bool {
    let Some(main) = app.get_webview_window("main") else { return false };
    let Ok(scale) = main.scale_factor() else { return false };
    let px = (x * scale).round() as i32;
    let py = (y * scale).round() as i32;
    let pw = ((w * scale).round() as i32).max(1);
    let ph = ((h * scale).round() as i32).max(1);
    with_instance(|inst, _| {
        // surface-less audio instance — nothing to position
        if inst.hwnd == 0 {
            return false;
        }
        unsafe {
            SetWindowPos(inst.hwnd, 0, px, py, pw, ph, SWP_NOZORDER | SWP_NOACTIVATE);
            if !inst.shown {
                ShowWindow(inst.hwnd, SW_SHOW);
                if let Some(mut g) = MPV.lock().ok() {
                    if let Some(i) = g.as_mut() {
                        i.shown = true;
                    }
                }
            }
        }
        true
    })
    .unwrap_or(false)
}

#[tauri::command]
pub fn mpv_load(source: String, start: Option<f64>) -> bool {
    let path = resolve_media(&source);
    with_instance(|inst, a| unsafe {
        if let Some(s) = start {
            if s > 0.5 {
                set_prop_string(a, inst.h.0, "start", &format!("{s:.3}"));
            }
        }
        let r = command(a, inst.h.0, &["loadfile", &path, "replace"]);
        // clear so the next load starts from 0
        set_prop_string(a, inst.h.0, "start", "none");
        r.is_ok()
    })
    .unwrap_or(false)
}

#[tauri::command]
pub fn mpv_stop() -> bool {
    with_instance(|inst, a| unsafe { command(a, inst.h.0, &["stop"]).is_ok() }).unwrap_or(false)
}

#[tauri::command]
pub fn mpv_toggle_pause() -> bool {
    with_instance(|inst, a| unsafe { command(a, inst.h.0, &["cycle", "pause"]).is_ok() }).unwrap_or(false)
}

#[tauri::command]
pub fn mpv_set_paused(v: bool) -> bool {
    with_instance(|inst, a| unsafe {
        set_prop_string(a, inst.h.0, "pause", if v { "yes" } else { "no" })
    })
    .unwrap_or(false)
}

#[tauri::command]
pub fn mpv_seek(t: f64, rel: Option<bool>) -> bool {
    let mode = if rel.unwrap_or(false) { "relative" } else { "absolute" };
    with_instance(|inst, a| unsafe {
        command(a, inst.h.0, &["seek", &format!("{t:.3}"), mode, "exact"]).is_ok()
    })
    .unwrap_or(false)
}

#[tauri::command]
pub fn mpv_set_speed(v: f64) -> bool {
    with_instance(|inst, a| unsafe { set_prop_string(a, inst.h.0, "speed", &format!("{v:.3}")) })
        .unwrap_or(false)
}

#[tauri::command]
pub fn mpv_set_volume(v: f64) -> bool {
    with_instance(|inst, a| unsafe {
        set_prop_string(a, inst.h.0, "mute", "no")
            && set_prop_string(a, inst.h.0, "volume", &format!("{v:.1}"))
    })
    .unwrap_or(false)
}

#[tauri::command]
pub fn mpv_set_muted(v: bool) -> bool {
    with_instance(|inst, a| unsafe {
        set_prop_string(a, inst.h.0, "mute", if v { "yes" } else { "no" })
    })
    .unwrap_or(false)
}

/// Video adjustments — GPU shader eq, ~zero CPU (vs. CSS filters).
#[tauri::command]
pub fn mpv_set_eq(b: i32, c: i32, s: i32, h: i32) -> bool {
    with_instance(|inst, a| unsafe {
        set_prop_string(a, inst.h.0, "brightness", &b.to_string())
            & set_prop_string(a, inst.h.0, "contrast", &c.to_string())
            & set_prop_string(a, inst.h.0, "saturation", &s.to_string())
            & set_prop_string(a, inst.h.0, "hue", &h.to_string())
    })
    .unwrap_or(false)
}

#[tauri::command]
pub fn mpv_set_transform(aspect: String, zoom: f64, rotate: i32) -> bool {
    with_instance(|inst, a| unsafe {
        // UI aspect ids → mpv: fit=letterbox, fill=panscan crop, stretch=ignore AR
        let _ = match aspect.as_str() {
            "fill" => {
                set_prop_string(a, inst.h.0, "video-aspect-override", "no")
                    && set_prop_string(a, inst.h.0, "panscan", "1.0")
                    && set_prop_string(a, inst.h.0, "keepaspect", "yes")
            }
            "stretch" => {
                set_prop_string(a, inst.h.0, "panscan", "0.0")
                    && set_prop_string(a, inst.h.0, "keepaspect", "no")
            }
            "16:9" | "4:3" => {
                set_prop_string(a, inst.h.0, "panscan", "0.0")
                    && set_prop_string(a, inst.h.0, "keepaspect", "yes")
                    && set_prop_string(a, inst.h.0, "video-aspect-override", &aspect)
            }
            _ => {
                set_prop_string(a, inst.h.0, "panscan", "0.0")
                    && set_prop_string(a, inst.h.0, "keepaspect", "yes")
                    && set_prop_string(a, inst.h.0, "video-aspect-override", "no")
            }
        };
        // zoom is linear 1..2.5 → mpv video-zoom is log2 scale
        let z = (zoom.max(1.0)).log2();
        set_prop_string(a, inst.h.0, "video-zoom", &format!("{z:.4}"))
            && set_prop_string(a, inst.h.0, "video-rotate", &rotate.to_string())
    })
    .unwrap_or(false)
}

#[tauri::command]
pub fn mpv_set_ab(a: Option<f64>, b: Option<f64>) -> bool {
    with_instance(|inst, api| unsafe {
        let sa = a.map(|v| format!("{v:.3}")).unwrap_or_else(|| "no".into());
        let sb = b.map(|v| format!("{v:.3}")).unwrap_or_else(|| "no".into());
        set_prop_string(api, inst.h.0, "ab-loop-a", &sa)
            && set_prop_string(api, inst.h.0, "ab-loop-b", &sb)
    })
    .unwrap_or(false)
}

#[tauri::command]
pub fn mpv_set_delays(sub: f64, audio: f64) -> bool {
    with_instance(|inst, a| unsafe {
        set_prop_string(a, inst.h.0, "sub-delay", &format!("{sub:.2}"))
            && set_prop_string(a, inst.h.0, "audio-delay", &format!("{audio:.2}"))
    })
    .unwrap_or(false)
}

#[tauri::command]
pub fn mpv_sub_visibility(v: bool) -> bool {
    with_instance(|inst, a| unsafe {
        set_prop_string(a, inst.h.0, "sub-visibility", if v { "yes" } else { "no" })
    })
    .unwrap_or(false)
}

#[tauri::command]
pub fn mpv_sub_add(path: String) -> bool {
    with_instance(|inst, a| unsafe {
        command(a, inst.h.0, &["sub-add", &path, "select"]).is_ok()
    })
    .unwrap_or(false)
}

#[tauri::command]
pub fn mpv_set_track(kind: String, id: i64) -> bool {
    with_instance(|inst, a| unsafe { set_prop_string(a, inst.h.0, &kind, &id.to_string()) })
        .unwrap_or(false)
}

#[tauri::command]
pub fn mpv_snapshot() -> Option<String> {
    let base = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
    let dir = Path::new(&base).join("Pictures").join("OMP");
    let _ = std::fs::create_dir_all(&dir);
    let stamp = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64)
        % 100_000_000;
    let file = dir.join(format!("OMP-snapshot-{stamp}.png"));
    let target = file.to_string_lossy().into_owned();
    with_instance(|inst, a| unsafe {
        command(a, inst.h.0, &["screenshot-to-file", &target, "subtitles"]).is_ok()
    })?;
    Some(target)
}

/* ------------------------------------------------------------------ */
/* Headless metadata probe (Phase 2 library)                           */
/*                                                                     */
/* Uses a THROWAWAY libmpv instance with vo=image / ao=null:           */
/*   * demux open  → FILE_LOADED   → duration, tracks, video-params    */
/*   * 1 decoded frame at ~25% → vo=image writes the thumbnail         */
/* No window, no audio, no network. Zero impact on live playback —     */
/* this runs on the library scanner thread, not the playback engine.   */
/* ------------------------------------------------------------------ */

pub(crate) struct ProbeMeta {
    pub duration: f64,
    pub width: i64,
    pub height: i64,
    pub video_codec: String,
    pub audio_codec: String,
    pub container: String,
    /// embedded tag metadata (Phase 3 audio library)
    pub artist: String,
    pub album: String,
    pub genre: String,
    /// true when a thumbnail image was written into `thumb_dir`
    pub thumb: bool,
}

#[cfg(windows)]
pub(crate) fn probe_media(path: &str, thumb_dir: Option<&Path>, audio: bool) -> Option<ProbeMeta> {
    let a = api()?;
    let a = a.as_ref(); // &MpvApi — Arc binding stays alive to the end of scope
    let want_thumb = thumb_dir.is_some();
    if want_thumb {
        let _ = std::fs::create_dir_all(thumb_dir.unwrap());
    }
    let h = unsafe { (a.create)() };
    if h.is_null() {
        return None;
    }
    let mut out = None;
    unsafe {
        let mut opts: Vec<(&str, String)> = vec![
            ("vo", if want_thumb { "image" } else { "null" }.into()),
            ("ao", "null".into()),
            ("frames", "1".into()),
            // audio: embedded album art is the first frame — seek must stay at 0
            ("start", if audio { "0".into() } else { "+25%".into() }),
            ("hwdec", "no".into()),
            ("pause", "no".into()),
            ("terminal", "no".into()),
            ("msg-level", "all=error".into()),
            ("keep-open", "no".into()),
            ("osc", "no".into()),
            ("input-default-bindings", "no".into()),
            ("input-vo-keyboard", "no".into()),
            ("ytdl", "no".into()),
        ];
        if let Some(dir) = thumb_dir {
            opts.push(("vo-image-outdir", dir.to_string_lossy().into_owned()));
            opts.push(("vo-image-format", "jpg".into()));
            opts.push(("vo-image-quality", "86".into()));
        }
        let mut ok = true;
        for (k, v) in &opts {
            let cs = CString::new(*k).unwrap();
            let vs = CString::new(v.as_str()).unwrap();
            if (a.set_option_string)(h, cs.as_ptr(), vs.as_ptr()) != 0 {
                // vo=image unsupported on this build → degrade to vo=null but keep probing
                if *k == "vo" {
                    let cs2 = CString::new("vo").unwrap();
                    let vs2 = CString::new("null").unwrap();
                    let _ = (a.set_option_string)(h, cs2.as_ptr(), vs2.as_ptr());
                }
                if *k == "ao" {
                    ok = false;
                }
            }
        }
        if ok && (a.initialize)(h) == 0 {
            let path_c = CString::new(path).ok()?;
            let cmd = CString::new("loadfile").unwrap();
            let rep = CString::new("replace").unwrap();
            let args = [cmd.as_ptr(), path_c.as_ptr(), rep.as_ptr(), std::ptr::null()];
            let _ = (a.command)(h, args.as_ptr());

            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
            let mut duration = 0f64;
            let mut width = 0i64;
            let mut height = 0i64;
            let mut vcodec = String::new();
            let mut acodec = String::new();
            let mut container = String::new();
            let mut artist = String::new();
            let mut album = String::new();
            let mut genre = String::new();
            loop {
                if std::time::Instant::now() > deadline {
                    break;
                }
                let ev = (a.wait_event)(h, 0.25);
                if ev.is_null() {
                    continue;
                }
                match (*ev).event_id {
                    EV_FILE_LOADED => {
                        duration = get_prop_string(a, h, "duration")
                            .and_then(|s| s.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        if let Ok(v) = get_prop_string(a, h, "video-params")
                            .unwrap_or_default()
                            .parse::<serde_json::Value>()
                        {
                            width = v.get("w").and_then(|x| x.as_i64()).unwrap_or(0);
                            height = v.get("h").and_then(|x| x.as_i64()).unwrap_or(0);
                        }
                        if let Ok(tracks) = serde_json::from_str::<serde_json::Value>(
                            &get_prop_string(a, h, "track-list").unwrap_or_default(),
                        ) {
                            if let Some(arr) = tracks.as_array() {
                                for t in arr {
                                    let ty = t.get("type").and_then(|x| x.as_str()).unwrap_or("");
                                    let codec =
                                        t.get("codec").and_then(|x| x.as_str()).unwrap_or("");
                                    if ty == "video" && vcodec.is_empty() && codec != "mjpeg" && codec != "png" {
                                        vcodec = codec.to_string();
                                    }
                                    if ty == "audio" && acodec.is_empty() {
                                        acodec = codec.to_string();
                                    }
                                }
                            }
                        }
                        container = get_prop_string(a, h, "file-format").unwrap_or_default();
                        // Phase 3: tag metadata (ID3/FLAC/Vorbis). ffmpeg demuxers
                        // hand tags over lowercase; try common casings as fallback.
                        artist = tag_lookup(a, h, &["artist", "Artist", "ARTIST", "album_artist", "albumartist"]);
                        album = tag_lookup(a, h, &["album", "Album", "ALBUM"]);
                        genre = tag_lookup(a, h, &["genre", "Genre", "GENRE"]);
                    }
                    EV_END_FILE | EV_SHUTDOWN => break,
                    _ => {}
                }
            }
            let mut thumb = false;
            if want_thumb {
                if let Some(dir) = thumb_dir {
                    // vo=image writes exactly one jpg for our frames=1 run
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for e in entries.flatten() {
                            let p = e.path();
                            if p.extension().and_then(|x| x.to_str()) == Some("jpg") {
                                thumb = true;
                                break;
                            }
                        }
                    }
                }
            }
            out = Some(ProbeMeta {
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
        }
        (a.terminate_destroy)(h);
    }
    out
}

/// Read a tag via metadata/by-key with case fallbacks. Empty when absent.
#[cfg(windows)]
unsafe fn tag_lookup(a: &MpvApi, h: *mut MpvHandle, keys: &[&str]) -> String {
    for k in keys {
        let prop = format!("metadata/by-key/{k}");
        if let Some(v) = get_prop_string(a, h, &prop) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                return v;
            }
        }
    }
    String::new()
}

#[cfg(not(windows))]
pub(crate) fn probe_media(_path: &str, _thumb_dir: Option<&Path>, _audio: bool) -> Option<ProbeMeta> {
    None
}
