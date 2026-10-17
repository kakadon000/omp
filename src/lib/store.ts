// Minimal reactive store — settings, playback progress, history, now-playing.
// Persisted in localStorage; documented swap point for SQLite in Phase 2.

export type Theme = "dark" | "light" | "system";
export type Accent = "blue" | "teal" | "violet" | "amber" | "graphite";
export type EffectsMode = "auto" | "full" | "reduced";

export type Settings = {
  theme: Theme;
  accent: Accent;
  transparency: number; // 0..1 — glass blur strength
  effects: EffectsMode;
  hwAccel: boolean;
  defaultSpeed: number;
  seekStep: number;
  sidebarRail: boolean;
  autoHideSidebar: boolean;
};

const DEFAULTS: Settings = {
  theme: "dark",
  accent: "blue",
  transparency: 0.65,
  effects: "auto",
  hwAccel: true,
  defaultSpeed: 1,
  seekStep: 10,
  sidebarRail: false,
  autoHideSidebar: true,
};

const KEY = "omp.settings";

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/** Push settings into the document (classes/attrs) so CSS reacts. */
export function applySettings(s: Settings) {
  const root = document.documentElement;
  let t = s.theme;
  if (t === "system")
    t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  root.dataset.theme = t;
  root.dataset.accent = s.accent;
  root.style.setProperty("--glass-blur", `${Math.round(s.transparency * 36)}px`);
  const reduced =
    s.effects === "reduced" ||
    (s.effects === "auto" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  root.classList.toggle("reduced", reduced);
}

/* ------------------------- tiny pub/sub ------------------------- */
type Listener = () => void;
function makeStore<T extends object>(initial: T) {
  let state = initial;
  const subs = new Set<Listener>();
  return {
    get: () => state,
    set(patch: Partial<T>) {
      state = { ...state, ...patch };
      subs.forEach((f) => f());
    },
    sub(f: Listener) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

/* ------------------------- now playing (audio singleton) ------------------------- */
export type NowPlaying = {
  trackId: string | null;
  playing: boolean;
  time: number;
  dur: number;
};

export const nowPlaying = makeStore<NowPlaying>({
  trackId: null,
  playing: false,
  time: 0,
  dur: 0,
});

export const audio: HTMLAudioElement | null =
  typeof Audio !== "undefined" ? new Audio() : null;

let audioSrc = ""; // original track src, for the seekability fixer
if (audio) {
  audio.addEventListener("timeupdate", () =>
    nowPlaying.set({ time: audio.currentTime, dur: audio.duration || 0 })
  );
  audio.addEventListener("ended", () => nowPlaying.set({ playing: false, time: 0 }));
  audio.addEventListener("loadedmetadata", () => {
    nowPlaying.set({ dur: audio.duration || 0 });
    // small files served without Range support can't seek — swap in a blob
    void ensureSeekable(audio, audioSrc);
  });
}

export function playTrack(src: string, trackId: string) {
  if (!audio) return;
  if (nowPlaying.get().trackId !== trackId) {
    audio.src = src;
    audioSrc = src;
    nowPlaying.set({ trackId, time: 0 });
  }
  audio.play().catch(() => {});
  nowPlaying.set({ playing: true });
}

export function togglePlay() {
  if (!audio || !nowPlaying.get().trackId) return;
  if (nowPlaying.get().playing) {
    audio.pause();
    nowPlaying.set({ playing: false });
  } else {
    audio.play().catch(() => {});
    nowPlaying.set({ playing: true });
  }
}

export function seekTo(t: number) {
  if (audio && Number.isFinite(t)) audio.currentTime = t;
}

export function stopPlayback() {
  if (!audio) return;
  audio.pause();
  nowPlaying.set({ playing: false, trackId: null, time: 0, dur: 0 });
}

/* ------------------------- queue helpers ------------------------- */
import { TRACKS } from "./data";

export let queueShuffle = false;
export function setQueueShuffle(v: boolean) { queueShuffle = v; }
export let queueRepeat = false;
export function setQueueRepeat(v: boolean) { queueRepeat = v; }

export function playTrackById(id: string) {
  const t = TRACKS.find((x) => x.id === id);
  if (!t) return;
  playTrack(t.src, t.id);
}

export function nextTrack(dir: 1 | -1 = 1) {
  const cur = nowPlaying.get().trackId;
  const i = TRACKS.findIndex((t) => t.id === cur);
  let n: number;
  if (queueShuffle && TRACKS.length > 1) {
    do { n = Math.floor(Math.random() * TRACKS.length); } while (n === i);
  } else {
    n = (i + dir + TRACKS.length) % TRACKS.length;
  }
  playTrackById(TRACKS[n].id);
}

if (audio) {
  audio.addEventListener("ended", () => {
    if (queueRepeat) {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } else {
      nextTrack(1);
    }
  });
}

/* ------------------------- external file (open with…) ------------------------- */
import { ensureSeekable } from "./media";

export type CustomMedia = { name: string; url: string };
export const customMedia = makeStore<CustomMedia>({ name: "", url: "" });

/* ------------------------- progress + history ------------------------- */
export type Progress = Record<string, { t: number; d: number }>;
const PROG_KEY = "omp.progress";
const HIST_KEY = "omp.history";

export function loadProgress(): Progress {
  try {
    return JSON.parse(localStorage.getItem(PROG_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveProgress(id: string, t: number, d: number) {
  if (!id || !Number.isFinite(t) || !Number.isFinite(d) || d <= 0) return;
  const p = loadProgress();
  if (t / d > 0.97) delete p[id];
  else p[id] = { t, d };
  localStorage.setItem(PROG_KEY, JSON.stringify(p));
}

export type HistItem = { id: string; kind: "video" | "music" | "image"; name: string; at: number; thumb?: string };

export function loadHistory(): HistItem[] {
  try {
    return JSON.parse(localStorage.getItem(HIST_KEY) || "[]");
  } catch {
    return [];
  }
}

export function pushHistory(item: HistItem) {
  const h = loadHistory().filter((x) => x.id !== item.id);
  h.unshift({ ...item, at: Date.now() });
  localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 60)));
}

export function clearHistory() {
  localStorage.removeItem(HIST_KEY);
}

export function removeHistory(id: string, at: number) {
  const h = loadHistory().filter((x) => !(x.id === id && x.at === at));
  localStorage.setItem(HIST_KEY, JSON.stringify(h));
  return h;
}
