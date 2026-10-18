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
import { loadSettings } from "./store";
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

// v0.6.2 perf: the queue can hold hundreds of tracks — deep-cloning and
// re-sending it at the 4 Hz progress tick was pure waste. The full snapshot
// now travels WITHOUT the queue unless the queue changed, plus a heartbeat
// every ~12 broadcasts so a freshly opened widget window syncs quickly.
// The widget merges incoming patches over its previous state, so an omitted
// queue simply means "unchanged".
let lastQueueJson = "";
let bcastCount = 0;

function snapshotSmart(): Record<string, unknown> {
  const st = audioStore.get();
  const qj = JSON.stringify(st.queue);
  const includeQueue = qj !== lastQueueJson || bcastCount % 12 === 0;
  bcastCount++;
  if (includeQueue) lastQueueJson = qj;
  const copy: Record<string, unknown> = JSON.parse(
    JSON.stringify({ ...st, queue: undefined })
  );
  if (includeQueue) copy.queue = JSON.parse(qj);
  return copy;
}

function broadcast() {
  const snap = snapshotSmart();
  if (isTauri) void tauriEmit("omp://audio", snap);
  try {
    bc?.postMessage(snap);
  } catch {
    /* channel closed */
  }
  syncMediaSession();
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

// v0.10.1 — persisted audio-EQ preset (Settings → Playback). Applied on
// engine attach AND on every track "loaded" event — the Rust side rebuilds
// the engine on audio↔video takeovers, which resets `af` to flat; re-applying
// here keeps the chosen preset sticky. One property-set per load: negligible.
export function applyAudioEq() {
  if (!isTauri || !attached) return;
  const preset = loadSettings().audioEq || "off";
  void invoke<boolean>("mpv_set_af", { preset }).catch(() => {});
}
// v0.6.2: after a failed engine bring-up, STOP retrying on every track —
// the fallback engine takes over instantly instead. Cleared by the Settings
// "Re-test engine" button (resetEngineProbe).
let engineBroken = false;
let lastEngineError = "";

export function resetEngineProbe() {
  engineBroken = false;
  attached = false;
  lastEngineError = "";
}

async function ensureEngine(): Promise<boolean> {
  if (!isTauri) return false;
  if (attached) return true;
  if (engineBroken) return false;
  const st = await invoke<{ available?: boolean; active?: boolean }>("mpv_status");
  if (!st?.available) {
    engineBroken = true;
    lastEngineError = "native engine DLL unavailable";
    return false;
  }
  // attach in AUDIO mode — surface-less (Rust reconciles the instance kind
  // if a video session is live, rebuilding the engine in the right mode)
  const r1 = await invoke<{ active?: boolean; error?: string | null }>("mpv_attach", {
    hwdec: "no",
    show: false,
  });
  if (!r1?.active) {
    // one retry — a first-attach race (window creation during boot) can
    // transiently fail; a beat later it goes through
    await new Promise((r) => setTimeout(r, 250));
    const r2 = await invoke<{ active?: boolean; error?: string | null }>("mpv_attach", {
      hwdec: "no",
      show: false,
    });
    if (!r2?.active) {
      engineBroken = true;
      lastEngineError = r2?.error || r1?.error || "engine attach failed";
      return false;
    }
  }
  attached = true;
  applyAudioEq(); // v0.10.1 — re-stick the persisted EQ preset on a fresh attach
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
    // the web fallback element must never double-play once the engine owns
    // the session (it keeps singing after "Re-test engine" revived mpv)
    if (el && !el.paused) {
      el.pause();
      el.removeAttribute("src");
    }
    let ok = await invoke<boolean>("mpv_load", { source: t.src, start: null });
    if (!ok) {
      // v0.6.2 stale-latch repair: a video session may have rebuilt or
      // released the engine since we attached (Player unmount detaches and
      // Rust never told us). Drop the latch and rebuild once before giving
      // up — this is what made music permanently dead after watching video.
      attached = false;
      if (await ensureEngine()) {
        ok = await invoke<boolean>("mpv_load", { source: t.src, start: null });
      }
    }
    if (!ok) {
      audioStore.set({ playing: false });
      toast("The engine refused this file — it may be corrupt or an unsupported stream", "err");
    } else {
      await invoke("mpv_set_volume", { v: Math.round(audioStore.get().volume * 100) });
    }
  } else if (isTauri && el) {
    // v0.6.2: RESILIENT FALLBACK — the WebView audio element CAN play any
    // local file through the asset protocol (convertFileSrc), so music no
    // longer dies just because libmpv is missing or blocked. Radio streams
    // (http) play directly. Quality is slightly lower than mpv; every
    // control (queue, shuffle, widget, media keys) keeps working.
    let src = t.src;
    if (src.startsWith("./")) {
      // bundled demo assets are served by the tauri http origin
      try {
        src = new URL(src, globalThis.location.origin).href;
      } catch {
        /* keep as-is */
      }
    } else if (!/^(https?|data|blob):/i.test(src)) {
      src = convertFileSrc(src);
    }
    el.src = src;
    el.volume = audioStore.get().volume;
    try {
      await el.play();
    } catch {
      audioStore.set({ playing: false });
      toast("Could not play this file", "err");
      return;
    }
    if (lastEngineError) {
      toast(
        `Playing with the built-in audio engine — ${lastEngineError} (Settings → Playback has diagnostics)`,
        "info"
      );
    }
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
  if (isTauri && !attached) {
    // engine went away (crash, teardown, or a fresh boot after "Re-test
    // engine") — tapping play must bring the CURRENT track back, not
    // silently do nothing
    void playInner(st.track);
    return;
  }
  if (isTauri && attached) {
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

/** Diagnostics snapshot for Settings → "Copy diagnostics". Tells us exactly
 *  which leg of the audio chain is broken when "nothing works". */
export function audioDiag(): Record<string, unknown> {
  const st = audioStore.get();
  return {
    engine: isTauri ? "libmpv" : "web element",
    attached, // service believes the engine is attached
    engineBroken,
    lastEngineError: lastEngineError || null,
    playing: st.playing,
    track: st.track
      ? { kind: st.track.kind, src: st.track.src.slice(0, 120), title: st.track.title }
      : null,
    live: st.live,
    icy: st.icy || null,
    time: Math.round(st.time * 10) / 10,
    dur: st.dur,
    queueLength: st.queue.length,
    volume: st.volume,
  };
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
  if (skipTimer !== null) {
    clearTimeout(skipTimer);
    skipTimer = null;
  }
  if (el) {
    el.pause();
    el.removeAttribute("src");
    try { el.load(); } catch { /* releases the network for radio streams */ }
  }
  currentSrc = "";
  audioStore.set({ track: null, playing: false, time: 0, dur: 0, live: false, icy: "", queue: [], qIndex: -1 });
}

function onEnded() {
  const st = audioStore.get();
  if (st.track?.kind === "radio") {
    // a live stream never "ends" on its own — reaching END_FILE means the
    // station dropped the connection. Auto-reconnect ONCE (throttled), then
    // stop honestly instead of showing a fake ON AIR forever.
    const now = Date.now();
    if (st.track && now - lastRadioReconnect > 30000) {
      lastRadioReconnect = now;
      void playInner(st.track);
    } else {
      audioStore.set({ playing: false });
      toast("The radio stream dropped — press play to reconnect", "info");
    }
    return;
  }
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

type MpvEvt = { kind: string; t?: number; d?: number; paused?: boolean; path?: string; title?: string; msg?: string };

// consecutive engine file errors — auto-skip guard so a broken track list
// doesn't machine-gun through the whole queue
let consecutiveErrors = 0;
// pending auto-skip timer — CANCELLED the moment a real file loads, so a
// transition can never both start track B and then skip away from it
let skipTimer: number | null = null;
// radio auto-reconnect throttle (max one per 30s per drop)
let lastRadioReconnect = 0;

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
        consecutiveErrors = 0;
        applyAudioEq(); // re-stick EQ after any Rust-side engine rebuild
        // a real file is playing — any pending error-skip is obsolete
        if (skipTimer !== null) {
          clearTimeout(skipTimer);
          skipTimer = null;
        }
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
      case "file-error":
        // the engine failed on THIS file (real decode error — ordinary Stop /
        // track-switch transitions arrive as "file-ended" and never hit this)
        audioStore.set({ playing: false });
        toast(`Playback failed: ${e.msg || "the engine could not decode this file"}`, "err");
        consecutiveErrors++;
        if (skipTimer !== null) clearTimeout(skipTimer);
        if (consecutiveErrors < 3 && st.queue.length > 1) {
          skipTimer = window.setTimeout(() => {
            skipTimer = null;
            next(1);
          }, 700);
        }
        break;
      case "file-ended":
        // ordinary transition: user Stop or loadfile replace (track change).
        // State settles via the new file's "loaded" event or via stopSession.
        // NEVER treat this as an error and NEVER auto-skip from here.
        break;
      case "died":
        attached = false;
        // honest state: an engine death must never leave the UI claiming
        // playback. toggle() now rebuilds the engine with the current track
        // when the latch is down, so "press play" always works.
        if (st.track) audioStore.set({ playing: false });
        break;
    }
  });

  // desktop widget → main-window service (widget has no direct store access)
  void tauriListen<{ a: string; t?: number; v?: number; i?: number }>("omp://widget-cmd", (cmd) => {
    const st = audioStore.get();
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
      case "jump":
        // v0.6.2: tap a queue row in the widget → play that track now
        if (typeof cmd.i === "number" && st.queue[cmd.i]) playTracks(st.queue, cmd.i);
        break;
      case "shuffle":
        setShuffle(!st.shuffle);
        break;
      case "repeat":
        setRepeat(!st.repeat);
        break;
    }
  });
}

/* ------------------- Windows media keys / media overlay ------------------- */
// navigator.mediaSession → WebView2 surfaces play/pause/prev/next + metadata
// (title · artist · cover art) in the Windows media flyout, and hardware
// media keyboard keys light up. Cheap, standard, no native code.

function syncMediaSession() {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = (navigator as unknown as { mediaSession: MediaSession }).mediaSession;
  try {
    const st = audioStore.get();
    const t = st.track;
    if (!t) {
      ms.metadata = null;
      ms.playbackState = "paused";
      return;
    }
    ms.playbackState = st.playing ? "playing" : "paused";
    const art = trackArt(t);
    ms.metadata = new MediaMetadata({
      title: st.live && st.icy ? st.icy : t.title,
      artist: t.artist,
      album: t.album,
      artwork: art ? [{ src: art, sizes: "512x512", type: "image/jpeg" }] : [],
    });
  } catch {
    /* metadata glitches are non-fatal */
  }
}

if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
  try {
    const ms = (navigator as unknown as { mediaSession: MediaSession }).mediaSession;
    ms.setActionHandler("play", () => void toggle());
    ms.setActionHandler("pause", () => void toggle());
    ms.setActionHandler("previoustrack", () => next(-1));
    ms.setActionHandler("nexttrack", () => next(1));
    ms.setActionHandler("seekto", (d: MediaSessionActionDetails) => {
      if (typeof d.seekTime === "number") seek(d.seekTime);
    });
  } catch {
    /* older WebView — ignore */
  }
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
