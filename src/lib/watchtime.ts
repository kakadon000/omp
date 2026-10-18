// v0.13.0 — watch/listen time tracking for the Home "This week" card.
// Deltas arrive from the engines' own time updates (Player mpv tick, the web
// audio element's timeupdate, and the music mpv tick). A delta only counts
// when time moves FORWARD by a small realistic step while the clock is fresh —
// so pauses (same t), seeks (backwards or big jumps) and engine rebuilds
// never poison the numbers.

const KEY = "omp.watchtime.v1";
const MAX_DAYS = 14;

export type WatchKind = "video" | "music";
type DayStat = { video: number; music: number };
type Store = Record<string, DayStat>;

let mem: Store | null = null;
let dirty = false;
let flushT: ReturnType<typeof setTimeout> | undefined;

function dayKeyOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function load(): Store {
  if (mem) return mem;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Store;
    mem = raw && typeof raw === "object" ? raw : {};
  } catch {
    mem = {};
  }
  return mem;
}

function flushNow() {
  if (flushT !== undefined) { clearTimeout(flushT); flushT = undefined; }
  if (!mem || !dirty) return;
  dirty = false;
  // prune anything older than MAX_DAYS so the key never grows
  const keep = new Set<string>();
  for (let i = 0; i < MAX_DAYS; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    keep.add(dayKeyOf(d));
  }
  for (const k of Object.keys(mem)) {
    if (!keep.has(k)) delete mem[k];
  }
  try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* storage full — stats are best-effort */ }
}

function queueFlush() {
  if (flushT !== undefined) return;
  flushT = setTimeout(flushNow, 15000);
}

// flush on the way out so the last seconds are not lost
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow();
  });
}

let last: { kind: WatchKind; t: number; at: number } | null = null;

export function addWatch(kind: WatchKind, t: number) {
  if (!Number.isFinite(t) || t < 0) return;
  const now = Date.now();
  if (
    last && last.kind === kind &&
    t > last.t && t - last.t <= 6 &&
    now - last.at < 15000
  ) {
    const st = load();
    const k = dayKeyOf(new Date());
    const cur = st[k] ?? { video: 0, music: 0 };
    cur[kind] += t - last.t;
    st[k] = cur;
    dirty = true;
    queueFlush();
  }
  last = { kind, t, at: now };
}

export type WeekDay = { day: string; label: string; video: number; music: number };

/** Last 7 days, oldest first. `label` = weekday initial, today = last entry. */
export function last7Days(): WeekDay[] {
  const st = load();
  const out: WeekDay[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = dayKeyOf(d);
    const s = st[k] ?? { video: 0, music: 0 };
    out.push({ day: k, label: "SMTWTFS"[d.getDay()], video: s.video, music: s.music });
  }
  return out;
}

/** Seconds → "3h 24m" / "45m" / "<1m". */
export function fmtHm(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 1) return "<1m";
  const h = Math.floor(m / 60);
  if (h < 1) return `${m}m`;
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}
