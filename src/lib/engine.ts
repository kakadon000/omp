// Playback engine layer — mpv (native libmpv) vs WebView2 <video>.
// Everything the Player needs goes through here so the whole VLC-grade
// control layer (menus, hotkeys, queue) works identically on both engines.

import { invoke, isTauri } from "./tauri";

export type EngineKind = "mpv" | "web";
export type EnginePref = "auto" | "mpv" | "web";

export type EngineInfo = {
  kind: EngineKind;
  available: boolean; // libmpv DLL present
  active: boolean; // surface attached right now
  version: string | null;
};

export type MpvEvent =
  | { kind: "tick"; t: number }
  | { kind: "duration"; d: number }
  | { kind: "loaded"; d: number; tracks: string; vw: number; vh: number }
  | { kind: "pause"; paused: boolean }
  | { kind: "ended" }
  | { kind: "file-error"; msg?: string }
  | { kind: "died" };

type MpvTrack = {
  id: number;
  type: string;
  title?: string;
  lang?: string;
  codec?: string;
  default?: boolean;
  forced?: boolean;
};

export function parseTracks(json: string): MpvTrack[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as MpvTrack[]) : [];
  } catch {
    return [];
  }
}

/* ------------------------- tiny reactive store ------------------------- */
let state: EngineInfo = { kind: "web", available: false, active: false, version: null };
const subs = new Set<() => void>();
function emit() {
  subs.forEach((f) => f());
}

export const engineStore = {
  get: () => state,
  sub(f: () => void) {
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  },
};

/** Ask the shell whether libmpv is present; resolve the active engine. */
export async function initEngine(pref: EnginePref): Promise<EngineInfo> {
  if (!isTauri) {
    state = { kind: "web", available: false, active: false, version: null };
    emit();
    return state;
  }
  const st = await invoke<{ available?: boolean; version?: string | null }>("mpv_status");
  const available = !!st?.available;
  const wantMpv =
    pref === "mpv" ? available : pref === "auto" ? available : false;
  state = {
    kind: wantMpv ? "mpv" : "web",
    available,
    active: false,
    version: st?.version ?? null,
  };
  emit();
  return state;
}

/* ------------------------- event fan-out ------------------------- */
type Handler = (e: MpvEvent) => void;
const handlers = new Set<Handler>();
let listening = false;

async function ensureListener() {
  if (!isTauri || listening) return;
  listening = true;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<Record<string, unknown>>("omp://mpv", (e) => {
      const payload = e.payload as unknown as MpvEvent;
      handlers.forEach((h) => h(payload));
      // keep the store's `active` honest
      if (payload.kind === "died") {
        state = { ...state, active: false };
        emit();
      }
    });
  } catch {
    listening = false;
  }
}

export function onMpvEvent(h: Handler): () => void {
  void ensureListener();
  handlers.add(h);
  return () => {
    handlers.delete(h);
  };
}

/* ------------------------- lifecycle ------------------------- */

/** Attach the native video surface (no-op outside Tauri / on the web engine). */
export async function attachEngine(hwAccel: boolean): Promise<boolean> {
  if (!isTauri || state.kind !== "mpv") return false;
  const st = await invoke<{ active?: boolean }>("mpv_attach", {
    hwdec: hwAccel ? "auto-safe" : "no",
  });
  state = { ...state, active: !!st?.active };
  emit();
  return !!st?.active;
}

export function detachEngine() {
  if (!isTauri) return;
  void invoke("mpv_detach");
  state = { ...state, active: false };
  emit();
}
