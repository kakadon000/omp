// Sleep timer — pauses EVERYTHING (native mpv + the web audio element +
// the Player's web <video>) after N minutes, or right at the end of the
// current track/video. VLC/Clementine behaviour, not a hard "close app".
//
// Session-scoped on purpose: a countdown that survives an app restart is a
// bug, not a feature. The one flag (`holdEnd`) is shared by music and video —
// whichever stream ends first consumes it (you cannot be playing both at
// once, the engines take over from each other).
//
// No imports from audio.ts / Player.tsx here — components and libs listen to
// the `omp:sleep-fire` event and pause their own engine. Keeps the dependency
// graph one-directional (audio.ts → sleep.ts, never the reverse).

import { toast } from "../components/Toast";

export type SleepMode = "off" | "end" | "minutes"; // minutes → see endsAt

export type SleepState = {
  mode: SleepMode;
  /** epoch ms the countdown fires at — 0 unless mode === "minutes" */
  endsAt: number;
  /** "after this track/video" armed */
  holdEnd: boolean;
  /** live remaining ms, already clamped at 0 */
  remainingMs: number;
};

let mode: SleepMode = "off";
let endsAt = 0;
let holdEnd = false;
let ticker = 0;

const subs = new Set<() => void>();
function emit() {
  subs.forEach((f) => f());
}

function clearTicker() {
  if (ticker) {
    clearInterval(ticker);
    ticker = 0;
  }
}

function stopTimer(showToast: boolean) {
  const hadSomething = mode !== "off" || holdEnd;
  mode = "off";
  endsAt = 0;
  holdEnd = false;
  clearTicker();
  if (showToast && hadSomething) toast("Sleep timer off", "info");
  emit();
}

function fire() {
  clearTicker();
  mode = "off";
  endsAt = 0;
  holdEnd = false;
  // every engine pauses itself — sleep.ts never touches playback directly
  window.dispatchEvent(new CustomEvent("omp:sleep-fire"));
  toast("Sleep timer — paused playback. Good night 🌙", "ok");
  emit();
}

export const sleepTimer = {
  sub(cb: () => void) {
    subs.add(cb);
    return () => {
      subs.delete(cb);
    };
  },
  get(): SleepState {
    const remainingMs = mode === "minutes" ? Math.max(0, endsAt - Date.now()) : 0;
    return { mode, endsAt, holdEnd, remainingMs };
  },
  /** countdown timer: N minutes from now */
  arm(minutes: number) {
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    mode = "minutes";
    endsAt = Date.now() + minutes * 60_000;
    holdEnd = false;
    clearTicker();
    ticker = window.setInterval(() => {
      if (Date.now() >= endsAt) fire();
      else emit(); // per-second tick for the remaining-time labels
    }, 1000);
    toast(`Sleep timer — pausing in ${minutes} min`, "ok");
    emit();
  },
  /** stop right after the current track (music) or video finishes */
  armEndOfTrack() {
    mode = "end";
    endsAt = 0;
    holdEnd = true;
    clearTicker();
    toast("Sleep timer — stops after this one", "ok");
    emit();
  },
  disarm() {
    stopTimer(true);
  },
  /** toggle helper for one-tap buttons */
  toggleMinutes(minutes: number) {
    if (mode === "minutes" && Math.abs((endsAt - Date.now()) / 60_000 - minutes) < 0.5) {
      stopTimer(true);
    } else {
      sleepTimer.arm(minutes);
    }
  },
  /**
   * The ended-handler asks: "should I hold here instead of advancing?"
   * Returns true once — first stream to end consumes the hold.
   */
  consumeEndHold(): boolean {
    if (!holdEnd) return false;
    stopTimer(false);
    toast("Sleep timer — stopped here as planned", "ok");
    return true;
  },
  /** human label for buttons/tooltips: "Off" · "14:32" · "After this track" */
  label(): string {
    if (mode === "end") return "After this track";
    if (mode === "minutes") {
      const s = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      const m = Math.floor(s / 60);
      return `${m}:${String(s % 60).padStart(2, "0")}`;
    }
    return "Off";
  },
};
