// OMP — mpv engine stubs for non-Windows builds (web/CI on other targets).
// The real engine lives in mpv_win.rs and is only compiled on Windows.

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct Status {
    pub available: bool,
    pub active: bool,
    pub version: Option<String>,
}

#[tauri::command]
pub fn mpv_status() -> Status {
    Status { available: false, active: false, version: None }
}

#[tauri::command]
pub fn mpv_attach(_hwdec: Option<String>) -> Status {
    mpv_status()
}

#[tauri::command]
pub fn mpv_detach() -> bool {
    false
}

#[tauri::command]
pub fn mpv_set_rect(_x: f64, _y: f64, _w: f64, _h: f64) -> bool {
    false
}

#[tauri::command]
pub fn mpv_load(_source: String, _start: Option<f64>) -> bool {
    false
}

#[tauri::command]
pub fn mpv_stop() -> bool {
    false
}

#[tauri::command]
pub fn mpv_toggle_pause() -> bool {
    false
}

#[tauri::command]
pub fn mpv_set_paused(_v: bool) -> bool {
    false
}

#[tauri::command]
pub fn mpv_seek(_t: f64, _rel: Option<bool>) -> bool {
    false
}

#[tauri::command]
pub fn mpv_set_speed(_v: f64) -> bool {
    false
}

#[tauri::command]
pub fn mpv_set_volume(_v: f64) -> bool {
    false
}

#[tauri::command]
pub fn mpv_set_muted(_v: bool) -> bool {
    false
}

#[tauri::command]
pub fn mpv_set_eq(_b: i32, _c: i32, _s: i32, _h: i32) -> bool {
    false
}

#[tauri::command]
pub fn mpv_set_transform(_aspect: String, _zoom: f64, _rotate: i32) -> bool {
    false
}

#[tauri::command]
pub fn mpv_set_ab(_a: Option<f64>, _b: Option<f64>) -> bool {
    false
}

#[tauri::command]
pub fn mpv_set_delays(_sub: f64, _audio: f64) -> bool {
    false
}

#[tauri::command]
pub fn mpv_sub_visibility(_v: bool) -> bool {
    false
}

#[tauri::command]
pub fn mpv_sub_add(_path: String) -> bool {
    false
}

#[tauri::command]
pub fn mpv_set_track(_kind: String, _id: i64) -> bool {
    false
}

#[tauri::command]
pub fn mpv_snapshot() -> Option<String> {
    None
}

pub fn shutdown_all() {}
