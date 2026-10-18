// Phase 3 — global audio session service (music + internet radio).
//
// One audio session owns the playback engine at a time:
//   * Tauri  → the native libmpv engine (same engine videos use, attached
//              with the surface HIDDEN — audio never shows a picture)
//   * Web    → an HTMLAudioElement (GitHub Pages demo)
//
// The session survives navigation: Player unmount detaches the video surface
// but Rust keeps the engine alive while audio is loaded (mpv_detach guard).
// State is mirrored to other windows (desktop widget) via `omp://audio`,
// and the widget talks back through `omp://widget-cmd`.

import { useSyncExternalStore } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { invoke, isTauri, tauriEmit, tauriListen } from "./tauri";
import { toast } from "../components/Toast";
import { onMpvEvent } from "./engine";

export type AudioTrack = {
  id: string; // stable id: file path or station url
  kind: "file" | "radio";
  src: string; // filesystem path or stream URL
  title: string;
  artist: string;
  album: string;
  genre?: string;
  thumb: string; // artwork URL (asset protocol) or ""
  duration: number; // seconds; 0 = unknown / live stream
  libId?: number; // SQLite media.id when it came from the library
};

export type AudioState = {
  track: AudioTrack | null;
  playing: boolean;
  time: number;
  dur: number;
  live: boolean; // radio stream — no duration, no seek
  icy: string; // radio "now playing" metadata
  queue: AudioTrack[];
  qIndex: number; // -1 when not queued (e.g. radio)
  shuffle: boolean;
  repeat: boolean;
  volume: number; // 0..1
};

type Listener = () => void;

function makeStore<T extends object>(initial: T) {
  let state = initial;
  const subs = new Set<Listener>();
  return {
    get: () => state,
    set(patch: Partial<T>) {
      state = { ...state, ...patch };
      subs.forEach((f) => f());
      broadcast();
    },
    sub(f: Listener) {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
  };
}

/* ------------------------------- state ------------------------------- */

const VOL_KEY = "omp.audio.volume";

export const audioStore = makeStore<AudioState>({
  track: null,
  playing: false,
  time: 0,
  dur: 0,
  live: false,
  icy: "",
  queue: [],
  qIndex: -1,
  shuffle: false,
  repeat: false,
  volume: (() => {
    const v = parseFloat(localStorage.getItem(VOL_KEY) || "0.85");
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.85;
  })(),
});

/* --------- mirror state to the desktop widget (other windows) --------- */
let bc: BroadcastChannel | null = null;
try {
  bc = "BroadcastChannel" in globalThis ? new BroadcastChannel("omp-audio") : null;
} catch {
  bc = null;
}

function snapshot() {
  return JSON.parse(JSON.stringify(audioStore.get()));
}

function broadcast() {
  if (!isTauri) return;
  void tauriEmit("omp://audio", snapshot());
  try {
    bc?.postMessage(snapshot());
  } catch {
    /* channel closed */
  }
}

/* ------------------------------ engine ------------------------------ */

// web fallback element — independent from the old store.ts demo singleton
const el: HTMLAudioElement | null = typeof Audio !== "undefined" ? new Audio() : null;
if (el) {
  el.addEventListener("timeupdate", () => {
    audioStore.set({ time: el.currentTime, dur: Number.isFinite(el.duration) ? el.duration : 0 });
  });
  el.addEventListener("ended", () => onEnded());
  el.addEventListener("loadedmetadata", () => {
    audioStore.set({ dur: Number.isFinite(el.duration) ? el.duration : 0 });
  });
}

let attached = false;
async function ensureEngine(): Promise<boolean> {
  if (!isTauri) return false;
  if (attached) return true;
  const st = await invoke<{ available?: boolean; active?: boolean }>("mpv_status");
  if (!st?.available) return false;
  if (!st?.active) {
    // attach the engine with a HIDDEN surface (audio never shows a picture)
    const r1 = await invoke<{ active?: boolean }>("mpv_attach", { hwdec: "no", show: false });
    if (!r1?.active) {
      // one retry — a first-attach race (window creation during boot) can
      // transiently fail; a beat later it goes through
      await new Promise((r) => setTimeout(r, 250));
      const r2 = await invoke<{ active?: boolean }>("mpv_attach", { hwdec: "no", show: false });
      if (!r2?.active) return false;
    }
  }
  attached = true;
  return true;
}

// when a VIDEO loadfile replaces our audio, the loaded event carries its path
let currentSrc = "";

function fmtAsset(src: string): string {
  // library thumbs are absolute paths → asset protocol URL for the webview.
  // convertFileSrc picks the RIGHT scheme per platform (http://asset.localhost
  // on Windows WebView2, asset:// on Linux/macOS) — hand-rolled asset:// URLs
  // silently 404 on Windows and were the broken-artwork bug in v0.6.0.
  if (!src || /^(https?|data|blob|tauri):/.test(src) || src.startsWith("./")) return src;
  if (isTauri) return convertFileSrc(src);
  return src;
}

export function trackArt(t: AudioTrack | null): string {
  if (!t) return "";
  return t.thumb ? fmtAsset(t.thumb) : "";
}

async function playInner(t: AudioTrack) {
  currentSrc = t.src;
  audioStore.set({
    track: t,
    playing: true,
    time: 0,
    dur: t.kind === "radio" ? 0 : t.duration || 0,
    live: t.kind === "radio",
    icy: "",
  });
  const engineOk = await ensureEngine();
  if (engineOk) {
    const ok = await invoke<boolean>("mpv_load", { source: t.src, start: null });
    if (!ok) {
      audioStore.set({ playing: false });
      toast("The engine refused this file — it may be corrupt or an unsupported stream", "err");
    } else {
      await invoke("mpv_set_volume", { v: Math.round(audioStore.get().volume * 100) });
    }
  } else if (isTauri) {
    // v0.6.1: NO silent web fallback inside the app — an HTMLAudioElement
    // cannot play a raw filesystem path, so "playing" would be a lie with
    // zero sound. Surface the real problem instead.
    audioStore.set({ playing: false });
    toast("Native engine unavailable — open Settings → Playback for diagnostics", "err");
  } else if (el) {
    el.src = t.src;
    el.volume = audioStore.get().volume;
    void el.play().catch(() => {});
  }
  // library play-count + progress notes (files only)
  if (t.kind === "file" && isTauri) void invoke("library_note_play", { path: t.src });
}

/* ---------------------------- public API ---------------------------- */

export function playTracks(queue: AudioTrack[], index: number) {
  const t = queue[index];
  if (!t) return;
  audioStore.set({ queue, qIndex: index });
  void playInner(t);
}

export function playRadio(track: AudioTrack) {
  const st = audioStore.get();
  if (st.track?.id === track.id && st.playing) {
    // second tap on the live station → pause it
    void toggle();
    return;
  }
  audioStore.set({ queue: [track], qIndex: 0 });
  void playInner(track);
}

export async function toggle() {
  const st = audioStore.get();
  if (!st.track) return;
  const engineOk = isTauri && attached;
  if (engineOk) {
    await invoke("mpv_toggle_pause");
    // optimistic; the pause event settles the truth
    audioStore.set({ playing: !st.playing });
  } else if (el) {
    if (el.paused) {
      void el.play().catch(() => {});
      audioStore.set({ playing: true });
    } else {
      el.pause();
      audioStore.set({ playing: false });
    }
  }
}

export function seek(t: number) {
  const st = audioStore.get();
  if (!st.track || st.live) return;
  if (isTauri && attached) {
    void invoke("mpv_seek", { t, rel: false });
    audioStore.set({ time: t });
  } else if (el) {
    el.currentTime = t;
    audioStore.set({ time: t });
  }
}

export function setVolume(v: number) {
  const vol = Math.min(1, Math.max(0, v));
  localStorage.setItem(VOL_KEY, String(vol));
  audioStore.set({ volume: vol });
  if (isTauri && attached) void invoke("mpv_set_volume", { v: Math.round(vol * 100) });
  else if (el) el.volume = vol;
}

export function setShuffle(v: boolean) {
  audioStore.set({ shuffle: v });
}
export function setRepeat(v: boolean) {
  audioStore.set({ repeat: v });
}

/** React hook — subscribes a component to the audio session state. */
export function audioUse(): AudioState {
  return useSyncExternalStore(audioStore.sub, audioStore.get);
}

export function next(dir: 1 | -1 = 1) {
  const st = audioStore.get();
  const q = st.queue;
  if (q.length === 0) return;
  let n: number;
  if (st.shuffle && q.length > 1) {
    do {
      n = Math.floor(Math.random() * q.length);
    } while (n === st.qIndex);
  } else if (st.qIndex < 0) {
    n = 0;
  } else {
    n = st.qIndex + dir;
    if (n >= q.length) n = st.repeat ? 0 : q.length - 1;
    if (n < 0) n = 0;
  }
  playTracks(q, n);
}

export function stopSession() {
  if (isTauri && attached) void invoke("mpv_stop");
  else if (el) {
    el.pause();
    el.removeAttribute("src");
  }
  currentSrc = "";
  audioStore.set({ track: null, playing: false, time: 0, dur: 0, live: false, icy: "", queue: [], qIndex: -1 });
}

function onEnded() {
  const st = audioStore.get();
  if (st.repeat && st.qIndex >= 0) {
    seek(0);
    if (!st.playing) void toggle();
    return;
  }
  const last = st.qIndex >= st.queue.length - 1;
  if (last && !st.repeat) {
    audioStore.set({ playing: false });
    return;
  }
  next(1);
}

/* --------------------- engine events (Tauri only) -------------------- */

type MpvEvt = { kind: string; t?: number; d?: number; paused?: boolean; path?: string; title?: string };

if (isTauri) {
  onMpvEvent((e: MpvEvt) => {
    const st = audioStore.get();
    if (!st.track) return; // engine belongs to video — ignore
    switch (e.kind) {
      case "tick":
        audioStore.set({ time: e.t ?? 0, dur: st.dur || 0 });
        if (st.track.kind === "file" && (e.t ?? 0) > 0) {
          const now = Date.now();
          if (now - lastNote > 4000) {
            lastNote = now;
            void invoke("library_note_progress", { path: st.track.src, position: e.t, duration: st.dur });
          }
        }
        break;
      case "loaded":
        // ownership reconciliation: a video loadfile took the engine over
        if (e.path && e.path !== currentSrc && !e.path.endsWith(currentSrc.split(/[\\/]/).pop() || "#")) {
          audioStore.set({ track: null, playing: false, time: 0, dur: 0, live: false, icy: "" });
          currentSrc = "";
        } else if (e.d) {
          audioStore.set({ dur: e.d });
        }
        break;
      case "pause":
        audioStore.set({ playing: !e.paused });
        break;
      case "ended":
        onEnded();
        break;
      case "icy":
        audioStore.set({ icy: e.title ?? "" });
        break;
      case "died":
        attached = false;
        break;
    }
  });

  // desktop widget → main-window service (widget has no direct store access)
  void tauriListen<{ a: string; t?: number; v?: number }>("omp://widget-cmd", (cmd) => {
    switch (cmd.a) {
      case "toggle":
        void toggle();
        break;
      case "next":
        next(1);
        break;
      case "prev":
        next(-1);
        break;
      case "seek":
        if (typeof cmd.t === "number") seek(cmd.t);
        break;
      case "vol":
        if (typeof cmd.v === "number") setVolume(cmd.v);
        break;
    }
  });
}

let lastNote = 0;

/* ------------------------- internet radio ------------------------- */

export type Station = { id: string; name: string; url: string; genre: string; custom?: boolean };

export const RADIO_PRESETS: Station[] = [
  { id: "soma-groove", name: "SomaFM · Groove Salad", url: "https://ice1.somafm.com/groovesalad-128-mp3", genre: "Downtempo" },
  { id: "soma-drone", name: "SomaFM · Drone Zone", url: "https://ice1.somafm.com/dronezone-128-mp3", genre: "Ambient" },
  { id: "soma-beat", name: "SomaFM · Beat Blender", url: "https://ice1.somafm.com/beatblender-128-mp3", genre: "Deep House" },
  { id: "rp-main", name: "Radio Paradise · Main Mix", url: "https://stream.radioparadise.com/mp3-128", genre: "Eclectic Rock" },
  { id: "rp-mellow", name: "Radio Paradise · Mellow", url: "https://stream.radioparadise.com/mellow-128", genre: "Mellow Mix" },
];

const RADIO_KEY = "omp.radio.stations";

export function loadStations(): Station[] {
  let custom: Station[] = [];
  try {
    custom = JSON.parse(localStorage.getItem(RADIO_KEY) || "[]");
  } catch {
    custom = [];
  }
  return [...RADIO_PRESETS, ...custom.filter((s) => s && s.url)];
}

export function addStation(name: string, url: string, genre: string): Station | null {
  const clean = url.trim();
  if (!/^https?:\/\//i.test(clean)) return null;
  const st: Station = {
    id: `radio-${Date.now().toString(36)}`,
    name: name.trim() || clean.replace(/^https?:\/\//, "").slice(0, 40),
    url: clean,
    genre: genre.trim() || "Custom",
    custom: true,
  };
  const all = loadStations();
  localStorage.setItem(RADIO_KEY, JSON.stringify([...all.filter((s) => s.custom), st]));
  return st;
}

export function removeStation(id: string) {
  const all = loadStations();
  localStorage.setItem(RADIO_KEY, JSON.stringify(all.filter((s) => s.custom && s.id !== id)));
}

export function stationToTrack(s: Station): AudioTrack {
  return {
    id: s.url,
    kind: "radio",
    src: s.url,
    title: s.name,
    artist: "Internet radio",
    album: s.genre,
    genre: s.genre,
    thumb: "",
    duration: 0,
  };
}

/* ---------------------- library track conversion ---------------------- */

export type LibItem = {
  id: number | string;
  path: string;
  title: string;
  kind: string;
  duration: number;
  thumb: string;
  artist?: string;
  album?: string;
  genre?: string;
};

export function libItemToTrack(m: LibItem): AudioTrack {
  const file = m.path.split(/[\\/]/).pop() || m.title;
  return {
    id: m.path,
    kind: "file",
    src: m.path,
    title: m.title || file,
    artist: m.artist || "Unknown artist",
    album: m.album || "Unknown album",
    genre: m.genre || "",
    thumb: m.thumb || "",
    duration: m.duration || 0,
    libId: typeof m.id === "number" ? m.id : undefined,
  };
}
