// Phase 2 — SQLite media library bridge (Rust: src-tauri/src/library.rs).
// Real scanner, real thumbnails, real metadata. Incremental + cancellable.
// On the web demo every call resolves to null/false and the screen shows
// its empty states.

import { invoke, isTauri } from "./tauri";
import { convertFileSrc } from "@tauri-apps/api/core";

/** asset-protocol URL for a real filesystem path (web demo: path unchanged). */
export function fileSrc(path: string): string {
  return isTauri ? convertFileSrc(path) : path;
}

export type MediaKind = "video" | "audio";

export type MediaItem = {
  id: number;
  path: string;
  title: string;
  kind: MediaKind | string;
  dir: string;
  duration: number;
  width: number;
  height: number;
  vcodec: string;
  acodec: string;
  container: string;
  size: number;
  thumb: string;
  position: number;
  playCount: number;
  lastPlayed: number;
  addedAt: number;
};

export type ScanEvent = {
  phase: "walk" | "probe" | "done";
  found: number;
  done: number;
  total: number;
  current: string;
};

export type LibraryStats = {
  videos: number;
  audio: number;
  thumbs: number;
  folders: number;
  scanning: boolean;
  dbPath: string;
};

/* --------------------------- scan events --------------------------- */

type ScanHandler = (e: ScanEvent) => void;
const scanHandlers = new Set<ScanHandler>();
let scanListening = false;

async function ensureScanListener() {
  if (!isTauri || scanListening) return;
  scanListening = true;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<ScanEvent>("omp://scan", (e) => {
      scanHandlers.forEach((h) => h(e.payload));
    });
  } catch {
    scanListening = false;
  }
}

export function onScanEvent(h: ScanHandler): () => void {
  void ensureScanListener();
  scanHandlers.add(h);
  return () => {
    scanHandlers.delete(h);
  };
}

/* ---------------------------- commands ----------------------------- */

export async function listItems(query: string, kind: string, sort: string): Promise<MediaItem[]> {
  return (
    (await invoke<MediaItem[]>("library_list", {
      query,
      kind,
      sort,
    })) ?? []
  );
}

export async function continueList(): Promise<MediaItem[]> {
  return (await invoke<MediaItem[]>("library_continue")) ?? [];
}

export async function addFolder(path: string): Promise<boolean> {
  return !!(await invoke<boolean>("library_add_folder", { path }));
}

export async function rescan(): Promise<boolean> {
  return !!(await invoke<boolean>("library_rescan"));
}

export async function cancelScan(): Promise<boolean> {
  return !!(await invoke<boolean>("library_cancel_scan"));
}

export async function removeItem(id: number): Promise<boolean> {
  return !!(await invoke<boolean>("library_remove_item", { id }));
}

export async function removeFolder(path: string): Promise<boolean> {
  return !!(await invoke<boolean>("library_remove_folder", { path }));
}

export async function getFolders(): Promise<string[]> {
  return (await invoke<string[]>("library_folders")) ?? [];
}

export async function getStats(): Promise<LibraryStats | null> {
  return await invoke<LibraryStats>("library_stats");
}

export async function notePlay(path: string): Promise<void> {
  await invoke("library_note_play", { path });
}

export async function noteProgress(path: string, position: number, duration: number): Promise<void> {
  if (!Number.isFinite(position)) return;
  await invoke("library_note_progress", { path, position, duration });
}

export async function revealFile(path: string): Promise<void> {
  await invoke("library_reveal", { path });
}

/** Native folder picker (directory dialog). */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}

/* --------------------------- playback ------------------------------ */

/** Open a library file in the Player (mpv reads the real path; the WebView
 *  engine gets an asset-protocol URL). Resumes at `position`. */
export async function playItem(item: MediaItem): Promise<void> {
  const { customMedia } = await import("./store");
  const { navigate } = await import("./router");
  const resume = item.duration > 0 && item.position > 5 && item.position / item.duration < 0.95;
  customMedia.set({
    name: item.title,
    url: fileSrc(item.path),
    path: item.path,
    startAt: resume ? item.position : 0,
  });
  void notePlay(item.path);
  navigate("player");
}
