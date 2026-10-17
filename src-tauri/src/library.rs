// OMP — Open Media Player · Phase 2: SQLite media library
//
// Spec contract (Phase 2 exit condition):
//   * scans are INCREMENTAL — files already indexed with unchanged
//     size+mtime are skipped, never re-probed
//   * scans are CANCELLABLE — library_cancel_scan flips a flag the worker
//     checks between every file
//   * scans never stall playback — probing happens on a dedicated thread,
//     paced with sleeps, using a throwaway headless mpv (vo=null / vo=image)
//     that never touches the playback engine or the audio device
//   * ZERO background work while idle — nothing scans unless the user adds
//     a folder or hits Rescan
//
// Storage: one SQLite file in the app-data dir + JPEG thumbnails alongside.

#![allow(non_snake_case)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/* ------------------------------ state ------------------------------ */

static SCANNING: AtomicBool = AtomicBool::new(false);
static SCAN_CANCEL: AtomicBool = AtomicBool::new(false);

pub struct LibraryState {
    db: Mutex<Connection>,
    db_path: PathBuf,
    thumbs: PathBuf,
}

const VIDEO_EXT: &[&str] = &[
    "mp4", "mkv", "webm", "mov", "avi", "m4v", "wmv", "flv", "ts", "m2ts",
    "mpg", "mpeg", "ogv", "3gp", "3g2", "vob", "ogm", "asf", "rmvb", "divx",
];
const AUDIO_EXT: &[&str] = &[
    "mp3", "flac", "m4a", "wav", "ogg", "oga", "opus", "aac", "wma", "aiff", "alac",
];
const SKIP_DIRS: &[&str] = &[
    "$RECYCLE.BIN", "System Volume Information", "node_modules",
    ".git", "Windows", "Program Files", "Program Files (x86)",
    "Application Data", "$WINDOWS.~BT",
];

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// FNV-1a 64-bit → stable thumbnail id from a path string.
fn hash64(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

pub fn open_db(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_millis(2500))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS media (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           path TEXT UNIQUE NOT NULL,
           title TEXT NOT NULL,
           kind TEXT NOT NULL,
           dir TEXT DEFAULT '',
           duration REAL DEFAULT 0,
           width INTEGER DEFAULT 0,
           height INTEGER DEFAULT 0,
           vcodec TEXT DEFAULT '',
           acodec TEXT DEFAULT '',
           container TEXT DEFAULT '',
           size INTEGER DEFAULT 0,
           mtime INTEGER DEFAULT 0,
           probed INTEGER DEFAULT 0,
           thumb TEXT DEFAULT '',
           position REAL DEFAULT 0,
           play_count INTEGER DEFAULT 0,
           last_played INTEGER DEFAULT 0,
           added_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind);
         CREATE INDEX IF NOT EXISTS idx_media_last ON media(last_played);
         CREATE TABLE IF NOT EXISTS folders (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           path TEXT UNIQUE NOT NULL,
           added_at INTEGER NOT NULL
         );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[derive(Serialize, Clone)]
pub struct MediaItem {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub kind: String,
    pub dir: String,
    pub duration: f64,
    pub width: i64,
    pub height: i64,
    pub vcodec: String,
    pub acodec: String,
    pub container: String,
    pub size: i64,
    pub thumb: String,
    pub position: f64,
    #[allow(non_snake_case)]
    pub playCount: i64,
    #[allow(non_snake_case)]
    pub lastPlayed: i64,
    #[allow(non_snake_case)]
    pub addedAt: i64,
}

#[derive(Serialize, Clone)]
struct ScanEvent {
    phase: String,
    found: i64,
    done: i64,
    total: i64,
    current: String,
}

fn emit_scan(app: &AppHandle, phase: &str, found: i64, done: i64, total: i64, current: &str) {
    let _ = app.emit(
        "omp://scan",
        ScanEvent {
            phase: phase.into(),
            found,
            done,
            total,
            current: current.into(),
        },
    );
}

/* --------------------------- scan worker --------------------------- */

fn list_folders(conn: &Connection) -> Vec<String> {
    match conn.prepare("SELECT path FROM folders ORDER BY added_at") {
        Ok(mut s) => match s.query_map([], |r| r.get::<_, String>(0)) {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        },
        Err(_) => Vec::new(),
    }
}

fn run_scan(app: AppHandle, db_path: PathBuf, thumbs: PathBuf) {
    SCANNING.store(true, Ordering::SeqCst);
    SCAN_CANCEL.store(false, Ordering::SeqCst);
    let Ok(conn) = open_db(&db_path) else {
        SCANNING.store(false, Ordering::SeqCst);
        return;
    };

    // -- 1. walk ---------------------------------------------------------
    let folders = list_folders(&conn);
    let mut found = 0i64;
    for folder in &folders {
        for entry in walkdir::WalkDir::new(folder)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                if e.depth() == 0 {
                    return true;
                }
                let name = e.file_name().to_string_lossy();
                let keep =
                    !name.starts_with('.') && !SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(&name));
                keep
            })
            .flatten()
        {
            if SCAN_CANCEL.load(Ordering::Relaxed) {
                break;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let ext = entry
                .path()
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.to_ascii_lowercase())
                .unwrap_or_default();
            let kind = if VIDEO_EXT.contains(&ext.as_str()) {
                "video"
            } else if AUDIO_EXT.contains(&ext.as_str()) {
                "audio"
            } else {
                continue;
            };
            let path = entry.path().to_string_lossy().into_owned();
            let (size, mtime) = match entry.metadata() {
                Ok(m) => (
                    m.len() as i64,
                    m.modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0),
                ),
                Err(_) => continue,
            };
            // incremental: unchanged file with finished metadata → skip entirely
            let prior: Option<(i64, i64, i64)> = match conn
                .prepare("SELECT size, mtime, probed FROM media WHERE path = ?1")
            {
                Ok(mut s) => s
                    .query_row(params![path], |r| {
                        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
                    })
                    .optional()
                    .unwrap_or(None),
                Err(_) => None,
            };
            if prior.map(|(s, m, p)| s == size && m == mtime && p != 0).unwrap_or(false) {
                continue;
            }
            let title = entry
                .path()
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            let dir = entry
                .path()
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let _ = conn.execute(
                "INSERT INTO media (path, title, kind, dir, size, mtime, probed, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
                 ON CONFLICT(path) DO UPDATE SET
                   title=excluded.title, size=excluded.size, mtime=excluded.mtime,
                   probed=0, thumb=''",
                params![path, title, kind, dir, size, mtime, now_secs()],
            );
            found += 1;
            if found % 20 == 0 {
                emit_scan(&app, "walk", found, 0, 0, "");
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        if SCAN_CANCEL.load(Ordering::Relaxed) {
            break;
        }
    }

    // -- 2. probe pending metadata (also recovers rows from crashed runs) --
    let pending: Vec<(i64, String, String)> = match conn
        .prepare("SELECT id, path, kind FROM media WHERE probed = 0 ORDER BY added_at DESC")
    {
        Ok(mut s) => match s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))) {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        },
        Err(_) => Vec::new(),
    };
    let total = pending.len() as i64;
    emit_scan(&app, "probe", found, 0, total, "");

    let mut done = 0i64;
    for (id, path, kind) in &pending {
        if SCAN_CANCEL.load(Ordering::Relaxed) {
            break;
        }
        let want_thumb = kind == "video";
        let tmp_jpg = thumbs.join("00000001.jpg");
        let _ = std::fs::remove_file(&tmp_jpg);
        let meta = crate::mpv::probe_media(
            path,
            if want_thumb { Some(thumbs.as_path()) } else { None },
        );
        match meta {
            Some(m) => {
                let thumb_name = if m.thumb && want_thumb {
                    let target = thumbs.join(format!("{}.jpg", hash64(path)));
                    match std::fs::rename(&tmp_jpg, &target) {
                        Ok(()) => target.to_string_lossy().into_owned(),
                        Err(_) => String::new(),
                    }
                } else {
                    String::new()
                };
                let _ = conn.execute(
                    "UPDATE media SET duration=?1, width=?2, height=?3, vcodec=?4,
                       acodec=?5, container=?6, probed=1, thumb=?7 WHERE id=?8",
                    params![
                        m.duration, m.width, m.height, m.video_codec, m.audio_codec,
                        m.container, thumb_name, id
                    ],
                );
            }
            None => {
                let _ = conn.execute("UPDATE media SET probed=2 WHERE id=?1", params![id]);
            }
        }
        done += 1;
        let title = Path::new(path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        emit_scan(&app, "probe", found, done, total, &title);
        // pacing — keep the scanner feather-light so playback never stutters
        std::thread::sleep(Duration::from_millis(25));
    }

    // -- 3. prune files that vanished from scanned folders ----------------
    if !SCAN_CANCEL.load(Ordering::Relaxed) {
        for folder in &folders {
            let prefix = format!("{folder}%");
            let victims: Vec<String> = match conn.prepare("SELECT path FROM media WHERE dir LIKE ?1") {
                Ok(mut s) => match s.query_map(params![prefix], |r| r.get::<_, String>(0)) {
                    Ok(rows) => rows.filter_map(Result::ok).collect(),
                    Err(_) => Vec::new(),
                },
                Err(_) => Vec::new(),
            };
            for v in victims {
                if !Path::new(&v).is_file() {
                    let _ = conn.execute("DELETE FROM media WHERE path = ?1", params![v]);
                }
            }
        }
    }

    emit_scan(&app, "done", found, done, total, "");
    SCANNING.store(false, Ordering::SeqCst);
}

fn spawn_scan(app: &AppHandle, state: &LibraryState) {
    if SCANNING.swap(true, Ordering::SeqCst) {
        return; // already running
    }
    SCANNING.store(false, Ordering::SeqCst); // spawn; run_scan re-raises
    let app = app.clone();
    let db_path = state.db_path.clone();
    let thumbs = state.thumbs.clone();
    std::thread::Builder::new()
        .name("omp-library-scan".into())
        .spawn(move || run_scan(app, db_path, thumbs))
        .ok();
}

/* ---------------------------- commands ----------------------------- */

#[tauri::command]
pub fn library_add_folder(app: AppHandle, state: State<'_, LibraryState>, path: String) -> bool {
    let _ = state.db.lock().ok().and_then(|db| {
        db.execute(
            "INSERT OR IGNORE INTO folders (path, added_at) VALUES (?1, ?2)",
            params![path, now_secs()],
        )
        .ok()
    });
    spawn_scan(&app, &state);
    true
}

#[tauri::command]
pub fn library_folders(state: State<'_, LibraryState>) -> Vec<String> {
    state
        .db
        .lock()
        .ok()
        .map(|db| list_folders(&db))
        .unwrap_or_default()
}

#[tauri::command]
pub fn library_remove_folder(state: State<'_, LibraryState>, path: String) -> bool {
    state
        .db
        .lock()
        .ok()
        .map(|db| {
            let a = db
                .execute("DELETE FROM folders WHERE path = ?1", params![path])
                .unwrap_or(0);
            let like = format!("{path}%");
            let b = db
                .execute("DELETE FROM media WHERE dir LIKE ?1", params![like])
                .unwrap_or(0);
            a > 0 || b > 0
        })
        .unwrap_or(false)
}

#[tauri::command]
pub fn library_rescan(app: AppHandle, state: State<'_, LibraryState>) -> bool {
    spawn_scan(&app, &state);
    true
}

#[tauri::command]
pub fn library_cancel_scan() -> bool {
    SCAN_CANCEL.store(true, Ordering::SeqCst);
    true
}

#[derive(Serialize, Clone)]
pub struct ScanStatus {
    pub scanning: bool,
}

#[tauri::command]
pub fn library_scan_status() -> ScanStatus {
    ScanStatus { scanning: SCANNING.load(Ordering::SeqCst) }
}

fn row_to_item(r: &rusqlite::Row) -> rusqlite::Result<MediaItem> {
    Ok(MediaItem {
        id: r.get(0)?,
        path: r.get(1)?,
        title: r.get(2)?,
        kind: r.get(3)?,
        dir: r.get(4)?,
        duration: r.get(5)?,
        width: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
        height: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
        vcodec: r.get(8)?,
        acodec: r.get(9)?,
        container: r.get(10)?,
        size: r.get::<_, Option<i64>>(11)?.unwrap_or(0),
        thumb: r.get(12)?,
        position: r.get(13)?,
        playCount: r.get(14)?,
        lastPlayed: r.get(15)?,
        addedAt: r.get(16)?,
    })
}

const ITEM_COLS: &str = "id, path, title, kind, dir, duration, width, height, vcodec, acodec, \
                         container, size, thumb, position, play_count, last_played, added_at";

#[tauri::command]
pub fn library_list(
    state: State<'_, LibraryState>,
    query: String,
    kind: String,
    sort: String,
) -> Vec<MediaItem> {
    let order = match sort.as_str() {
        "title" => "title COLLATE NOCASE ASC",
        "duration" => "duration DESC",
        "recent" => "CASE WHEN last_played > 0 THEN last_played ELSE 0 END DESC, added_at DESC",
        "plays" => "play_count DESC, last_played DESC",
        _ => "added_at DESC",
    };
    let like = format!("%{}%", query.replace('%', ""));
    let sql = match kind.as_str() {
        "video" => format!(
            "SELECT {ITEM_COLS} FROM media WHERE kind='video' AND (title LIKE ?1 OR path LIKE ?1) \
             ORDER BY {order} LIMIT 2000"
        ),
        "audio" => format!(
            "SELECT {ITEM_COLS} FROM media WHERE kind='audio' AND (title LIKE ?1 OR path LIKE ?1) \
             ORDER BY {order} LIMIT 2000"
        ),
        _ => format!(
            "SELECT {ITEM_COLS} FROM media WHERE (title LIKE ?1 OR path LIKE ?1) \
             ORDER BY {order} LIMIT 2000"
        ),
    };
    state
        .db
        .lock()
        .ok()
        .and_then(|db| {
            let mut s = db.prepare(&sql).ok()?;
            let rows = s
                .query_map(params![like], row_to_item)
                .ok()?
                .filter_map(Result::ok)
                .collect::<Vec<_>>();
            Some(rows)
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn library_continue(state: State<'_, LibraryState>) -> Vec<MediaItem> {
    let sql = format!(
        "SELECT {ITEM_COLS} FROM media
         WHERE duration > 0 AND position > 5 AND position / duration < 0.95
         ORDER BY last_played DESC LIMIT 12"
    );
    state
        .db
        .lock()
        .ok()
        .and_then(|db| {
            let mut s = db.prepare(&sql).ok()?;
            let rows = s
                .query_map([], row_to_item)
                .ok()?
                .filter_map(Result::ok)
                .collect::<Vec<_>>();
            Some(rows)
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn library_remove_item(state: State<'_, LibraryState>, id: i64) -> bool {
    state
        .db
        .lock()
        .ok()
        .map(|db| {
            // drop the thumbnail file too
            if let Ok(Some(thumb)) = db
                .prepare("SELECT thumb FROM media WHERE id = ?1")
                .and_then(|mut s| s.query_row(params![id], |r| r.get::<_, String>(0)).optional())
            {
                if !thumb.is_empty() {
                    let _ = std::fs::remove_file(thumb);
                }
            }
            db.execute("DELETE FROM media WHERE id = ?1", params![id])
                .map(|n| n > 0)
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

/// Ensure a row exists for a manually played file (outside scanned folders).
fn ensure_row(db: &Connection, path: &str) {
    let ext = Path::new(path)
        .extension()
        .and_then(|x| x.to_str())
        .map(|x| x.to_ascii_lowercase())
        .unwrap_or_default();
    let kind = if AUDIO_EXT.contains(&ext.as_str()) { "audio" } else { "video" };
    let title = Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let dir = Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let _ = db.execute(
        "INSERT OR IGNORE INTO media (path, title, kind, dir, probed, added_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)",
        params![path, title, kind, dir, now_secs()],
    );
}

#[tauri::command]
pub fn library_note_play(state: State<'_, LibraryState>, path: String) -> bool {
    state
        .db
        .lock()
        .ok()
        .map(|db| {
            ensure_row(&db, &path);
            db.execute(
                "UPDATE media SET play_count = play_count + 1, last_played = ?2 WHERE path = ?1",
                params![path, now_secs()],
            )
            .unwrap_or(0);
            true
        })
        .unwrap_or(false)
}

#[tauri::command]
pub fn library_note_progress(
    state: State<'_, LibraryState>,
    path: String,
    position: f64,
    duration: f64,
) -> bool {
    state
        .db
        .lock()
        .ok()
        .map(|db| {
            ensure_row(&db, &path);
            let pos = if duration > 0.0 && position / duration > 0.97 {
                0.0
            } else {
                position
            };
            db.execute(
                "UPDATE media SET position = ?2, last_played = ?3 WHERE path = ?1",
                params![path, pos, now_secs()],
            )
            .unwrap_or(0);
            true
        })
        .unwrap_or(false)
}

#[derive(Serialize, Clone)]
pub struct LibraryStats {
    pub videos: i64,
    pub audio: i64,
    pub thumbs: i64,
    pub folders: i64,
    pub scanning: bool,
    pub dbPath: String,
}

#[tauri::command]
pub fn library_stats(state: State<'_, LibraryState>) -> LibraryStats {
    let scanning = SCANNING.load(Ordering::SeqCst);
    let db_path = state.db_path.to_string_lossy().into_owned();
    let db_path_in = db_path.clone();
    state
        .db
        .lock()
        .ok()
        .map(|db| {
            let count = |sql: &str| -> i64 {
                db.prepare(sql)
                    .and_then(|mut s| s.query_row([], |r| r.get(0)))
                    .unwrap_or(0)
            };
            LibraryStats {
                videos: count("SELECT COUNT(*) FROM media WHERE kind='video'"),
                audio: count("SELECT COUNT(*) FROM media WHERE kind='audio'"),
                thumbs: count("SELECT COUNT(*) FROM media WHERE thumb != ''"),
                folders: count("SELECT COUNT(*) FROM folders"),
                scanning,
                dbPath: db_path_in,
            }
        })
        .unwrap_or(LibraryStats {
            videos: 0,
            audio: 0,
            thumbs: 0,
            folders: 0,
            scanning,
            dbPath: db_path,
        })
}

/// Reveal a file in Explorer (or the parent dir elsewhere).
#[tauri::command]
pub fn library_reveal(path: String) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .is_ok()
    }
    #[cfg(not(windows))]
    {
        if let Some(dir) = Path::new(&path).parent() {
            let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
        }
        true
    }
}

impl LibraryState {
    pub fn new(db: Connection, db_path: PathBuf, thumbs: PathBuf) -> Self {
        Self {
            db: Mutex::new(db),
            db_path,
            thumbs,
        }
    }
}
