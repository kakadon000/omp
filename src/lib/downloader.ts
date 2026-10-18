// v0.14.0 — Downloader client: jobs, live progress events, history.
// The engine is the yt-dlp.exe OMP already bundles (v0.9.0) — one binary,
// 1000+ supported platforms. Progress arrives as `omp://dl` events from
// src-tauri/src/downloader.rs; finished jobs are recorded in the library.db
// `downloads` table (via dl_history_add fired right here on "done").

import { invoke, isTauri, tauriListen } from "./tauri";

export type DlFormat = {
  id: string; ext: string; height: number; fps: number;
  vcodec: string; acodec: string; note: string; size: number;
};

export type DlInfo = {
  id: string; title: string; url: string; uploader: string;
  duration: number; thumb: string; extractor: string;
  is_live: boolean; formats: DlFormat[];
};

export type DlPhase = "queued" | "progress" | "done" | "error" | "cancelled";

export type DlJob = {
  id: string; url: string; title: string; quality: string;
  pct: number; speed: string; eta: string;
  phase: DlPhase; error: string; path: string;
};

export type DlHist = {
  url: string; title: string; path: string; quality: string; created: number;
};

export type DlStatus = { available: boolean; path: string; version: string; ffmpeg: boolean };

/* ---------------- tiny store (jobs) ---------------- */
let jobs: DlJob[] = [];
const subs = new Set<() => void>();
function emit() { subs.forEach((f) => f()); }

export const dlStore = {
  get: () => jobs,
  sub(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};

let wired = false;

/** Subscribe once per app run — routes omp://dl events into the job list. */
export async function wireDlEvents(): Promise<void> {
  if (wired || !isTauri) return;
  wired = true;
  await tauriListen<{
    id: string; phase: string; pct?: number; speed?: string; eta?: string;
    path?: string; error?: string; note?: string;
  }>("omp://dl", (d) => {
    if (!d?.id) return;
    const i = jobs.findIndex((j) => j.id === d.id);
    if (i < 0) return;
    const j = { ...jobs[i] };
    switch (d.phase) {
      case "progress":
        j.phase = "progress";
        j.pct = d.pct ?? j.pct;
        j.speed = d.speed || "";
        j.eta = d.eta || "";
        break;
      case "note":
        // [Merger] / [ExtractAudio] — show as the status line
        j.eta = d.note || j.eta;
        break;
      case "done":
        j.phase = "done";
        j.pct = 100;
        j.path = d.path || "";
        // history row — written from the frontend so the Rust side stays
        // free of database work in its worker threads
        if (j.path) void invoke("dl_history_add", { url: j.url, title: j.title, path: j.path, quality: j.quality });
        break;
      case "error":
        j.phase = "error";
        j.error = d.error || "download failed";
        break;
      case "cancelled":
        j.phase = "cancelled";
        break;
    }
    jobs = [...jobs.slice(0, i), j, ...jobs.slice(i + 1)];
    emit();
  });
}

const uid = () => `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

export async function fetchInfo(url: string): Promise<DlInfo | null> {
  const r = await invoke<string>("dl_fetch_info", { url });
  if (!r) return null;
  try { return JSON.parse(r) as DlInfo; } catch { return null; }
}

/** Queue one download. Returns the job id. */
export function startDownload(info: DlInfo, quality: string, dir: string): string {
  const id = uid();
  const job: DlJob = {
    id, url: info.url, title: info.title, quality,
    pct: 0, speed: "", eta: "", phase: "queued", error: "", path: "",
  };
  jobs = [job, ...jobs].slice(0, 24);
  emit();
  void invoke("dl_start", { id, url: info.url, quality, outDir: dir });
  return id;
}

export function cancelJob(id: string): void { void invoke("dl_cancel", { id }); }
export function removeJob(id: string): void { jobs = jobs.filter((j) => j.id !== id); emit(); }

export function dlStatus(): Promise<DlStatus | null> {
  return invoke<DlStatus>("dl_status");
}

export async function dlHistory(): Promise<DlHist[]> {
  const r = await invoke<string>("dl_history_list");
  if (!r) return [];
  try { return JSON.parse(r) as DlHist[]; } catch { return []; }
}

export function dlHistoryClear(): Promise<boolean | null> {
  return invoke<boolean>("dl_history_clear");
}

/** Default save folder: <app data>/Downloads, remembered once chosen. */
export function savedDir(): string {
  try { return localStorage.getItem("omp.dl.dir") || ""; } catch { return ""; }
}
export function rememberDir(d: string): void {
  try { localStorage.setItem("omp.dl.dir", d); } catch { /* private mode */ }
}
