// OMP desktop widget — a real second window (frameless, always-on-top,
// transparent). It renders ONLY from `omp://audio` snapshots broadcast by the
// main window's audio service and talks back through `omp://widget-cmd`,
// so it keeps working while the main window is hidden (background playback).
// Dragging: data-tauri-drag-region (core:window:allow-start-dragging).
// v0.6.2: queue tap-to-jump, shuffle/repeat toggles, position memory and a
// CSS-only playing indicator — zero extra timers, zero extra CPU when idle.

import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke, isTauri, tauriEmit, tauriListen } from "../lib/tauri";
import "./widget.css";

type Snap = {
  track: { id: string; kind: string; title: string; artist: string; album: string; thumb: string } | null;
  playing: boolean;
  time: number;
  dur: number;
  live: boolean;
  icy: string;
  queue?: { id: string; title: string; artist: string; thumb: string }[];
  qIndex: number;
  shuffle?: boolean;
  repeat?: boolean;
  volume: number;
};

const EMPTY: Snap = {
  track: null, playing: false, time: 0, dur: 0, live: false, icy: "", queue: [], qIndex: -1, volume: 0.85,
};

/* ------------------------- inline icons (stroke) ------------------------- */
type IP = { size?: number };
const svg = (size: number, d: React.ReactNode, fill = false) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={fill ? "currentColor" : "none"}
    stroke={fill ? "none" : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);
const IconPlay = ({ size = 15 }: IP) => svg(size, <path d="M7 4.5v15l12-7.5z" />, true);
const IconPause = ({ size = 15 }: IP) => svg(size, <><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>, true);
const IconPrev = ({ size = 15 }: IP) => svg(size, <><path d="M19 5v14l-9-7z" fill="currentColor" stroke="none" /><rect x="5" y="5" width="2.4" height="14" rx="1" fill="currentColor" stroke="none" /></>);
const IconNext = ({ size = 15 }: IP) => svg(size, <><path d="M5 5v14l9-7z" fill="currentColor" stroke="none" /><rect x="16.6" y="5" width="2.4" height="14" rx="1" fill="currentColor" stroke="none" /></>);
const IconNote = ({ size = 26 }: IP) => svg(size, <><path d="M9 18V5l10-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></>);
const IconUp = ({ size = 12 }: IP) => svg(size, <path d="M6 14l6-6 6 6" />);
const IconDown = ({ size = 12 }: IP) => svg(size, <path d="M6 10l6 6 6-6" />);
const IconX = ({ size = 11 }: IP) => svg(size, <path d="M5 5l14 14M19 5L5 19" />);
const IconVol = ({ size = 14 }: IP) => svg(size, <><path d="M11 5L6 9H2v6h4l5 4z" fill="currentColor" stroke="none" /><path d="M15.5 8.5a5 5 0 010 7" /></>);
const IconShuffle = ({ size = 13 }: IP) => svg(size, <><path d="M16 3h5v5" /><path d="M4 20L21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" /></>);
const IconRepeat = ({ size = 13 }: IP) => svg(size, <><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 014-4h14" /><path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 01-4 4H3" /></>);

/* ------------------------------ helpers ------------------------------ */
const fmt = (t: number) => {
  if (!Number.isFinite(t) || t <= 0) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

function artUrl(p: string): string {
  if (!p) return "";
  if (/^(https?|data|blob|tauri):/.test(p) || p.startsWith("./")) return p;
  // convertFileSrc → http://asset.localhost/… on Windows (asset:// 404s there)
  if (isTauri) return convertFileSrc(p);
  return p;
}

function Widget() {
  const [snap, setSnap] = useState<Snap>(EMPTY);
  const [expanded, setExpanded] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const cmd = (a: string, extra?: Record<string, unknown>) => {
    // the audio service in the main window owns the engine — talk to it
    void tauriEmit("omp://widget-cmd", { a, ...(extra || {}) });
  };
  const scrubRef = useRef(0);

  useEffect(() => {
    if (!isTauri) return;
    let un: (() => void) | undefined;
    let dead = false;
    void tauriListen<Snap>("omp://audio", (s) => {
      if (s && typeof s === "object" && "track" in s) {
        // v0.6.2: MERGE patches — the broadcast may omit the queue (perf),
        // so keep the previous one instead of resetting to empty
        setSnap((prev) => ({ ...EMPTY, ...prev, ...s }));
      }
    }).then((fn) => { if (dead) fn(); else un = fn; });
    return () => { dead = true; un?.(); };
  }, []);

  // v0.6.2: position memory — remember where the user dragged the widget,
  // restore it every time the widget window appears
  useEffect(() => {
    if (!isTauri) return;
    let saveTimer: number | undefined;
    let unMoved: (() => void) | undefined;
    let dead = false;
    void (async () => {
      try {
        const saved = localStorage.getItem("omp.widget.pos");
        if (saved) {
          const p = JSON.parse(saved) as { x: number; y: number };
          if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) {
            void invoke("widget_set_pos", { x: p.x, y: p.y });
          }
        }
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const un = await getCurrentWindow().onMoved(({ payload }) => {
          window.clearTimeout(saveTimer);
          saveTimer = window.setTimeout(() => {
            localStorage.setItem("omp.widget.pos", JSON.stringify({ x: payload.x, y: payload.y }));
          }, 350);
        });
        if (dead) un();
        else unMoved = un;
      } catch {
        /* non-fatal: widget just keeps default placement */
      }
    })();
    return () => {
      dead = true;
      window.clearTimeout(saveTimer);
      unMoved?.();
    };
  }, []);

  const t = snap.track;
  const queue = snap.queue ?? [];
  const dur = snap.live ? 0 : snap.dur || (t ? 0 : 0);
  const displayPct = dur > 0 ? (scrub !== null ? scrub / dur : snap.time / dur) : 0;

  const commit = () => {
    if (scrub !== null) cmd("seek", { t: scrubRef.current });
    setScrub(null);
  };

  const title = t ? (snap.live && snap.icy ? snap.icy : t.title) : "Nothing playing";
  const sub = t
    ? snap.live && snap.icy
      ? t.title
      : t.kind === "radio"
        ? `${t.artist} · ${t.album}`
        : `${t.artist} — ${t.album}`
    : "Play music in OMP to see it here";
  const qIdxSafe = snap.qIndex;

  return (
    <div className="w-shell">
      <div className="w-card">
        <div className="w-drag" data-tauri-drag-region>
          <span className="w-drag-dot" />
          <span className="w-drag-title" data-tauri-drag-region>OMP · Now Playing</span>
          <span className="w-winbtns">
            <button className="w-winbtn" title={expanded ? "Shrink" : "Expand"} onClick={() => {
              const v = !expanded;
              setExpanded(v);
              void invoke("widget_set_expanded", { expanded: v });
            }}>
              {expanded ? <IconDown /> : <IconUp />}
            </button>
            <button className="w-winbtn" title="Open OMP" onClick={() => void invoke("app_show_main")}>
              ⌂
            </button>
            <button className="w-winbtn w-quit" title="Hide widget" onClick={() => void invoke("widget_toggle")}>
              <IconX />
            </button>
          </span>
        </div>

        {t ? (
          <>
            <div className="w-main">
              <div
                className={`w-art${snap.live ? " live" : ""}`}
                onDoubleClick={() => void invoke("app_show_main")}
                title="Double-click to open OMP"
              >
                {t.thumb ? <img src={artUrl(t.thumb)} alt="" /> : <IconNote />}
              </div>
              <div className="w-meta">
                <div className="w-title" title={title}>{title}</div>
                <div className="w-sub" title={sub}>{sub}</div>
                {snap.live && (
                  <span className="w-live-badge"><span className="w-live-dot" /> Live radio</span>
                )}
              </div>
              {/* v0.6.2: CSS-only playing indicator — no timers, the animation
                  just pauses when playback pauses */}
              <span className={`w-eq${snap.playing ? "" : " off"}`} aria-hidden>
                <i /><i /><i /><i />
              </span>
              <div className="w-controls">
                <button className="w-btn sm" onClick={() => cmd("prev")} aria-label="Previous">
                  <IconPrev />
                </button>
                <button className="w-btn play" onClick={() => cmd("toggle")} aria-label={snap.playing ? "Pause" : "Play"}>
                  {snap.playing ? <IconPause /> : <IconPlay />}
                </button>
                <button className="w-btn sm" onClick={() => cmd("next")} aria-label="Next">
                  <IconNext />
                </button>
              </div>
            </div>

            {!snap.live && (
              <div className="w-seekrow">
                <span className="w-time">{fmt(scrub !== null ? scrub : snap.time)}</span>
                <input
                  type="range" className="w-seek" min={0} max={Math.max(1, Math.round(dur))}
                  value={Math.round((displayPct * dur) || 0)}
                  style={{ ["--fill" as string]: `${displayPct * 100}%` }}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    scrubRef.current = v;
                    setScrub(v);
                  }}
                  onPointerUp={commit} onKeyUp={commit} onBlur={commit}
                  aria-label="Seek"
                />
                <span className="w-time r">{fmt(dur)}</span>
              </div>
            )}

            {expanded && (
              <>
                <div className="w-queue">
                  {queue.length > 1 ? (
                    queue.map((q, i) => (
                      <div
                        key={q.id + i}
                        className={`w-q-item${i === qIdxSafe ? " on" : ""}`}
                        onClick={() => cmd("jump", { i })}
                        title="Play this track"
                      >
                        <span className="w-q-art">{q.thumb ? <img src={artUrl(q.thumb)} alt="" /> : <IconNote size={13} />}</span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span className="w-q-name" style={{ display: "block" }}>{q.title}</span>
                          <span className="w-q-artist" style={{ display: "block" }}>{q.artist}</span>
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="w-q-empty">
                      {snap.live ? "Radio needs no queue — it just plays." : "Queue shows here when you play an album or playlist."}
                    </div>
                  )}
                </div>
                <div className="w-extrarow">
                  <button
                    className={`w-btn sm${snap.shuffle ? " on" : ""}`}
                    onClick={() => cmd("shuffle")}
                    title="Shuffle"
                    aria-pressed={!!snap.shuffle}
                  >
                    <IconShuffle />
                  </button>
                  <button
                    className={`w-btn sm${snap.repeat ? " on" : ""}`}
                    onClick={() => cmd("repeat")}
                    title="Repeat queue"
                    aria-pressed={!!snap.repeat}
                  >
                    <IconRepeat />
                  </button>
                  <span style={{ flex: 1 }} />
                  <button className="w-btn sm" title="Open OMP" onClick={() => void invoke("app_show_main")}>
                    ⌂
                  </button>
                </div>
                <div className="w-volrow">
                  <IconVol />
                  <input
                    type="range" className="w-seek" min={0} max={100}
                    value={Math.round(snap.volume * 100)}
                    style={{ ["--fill" as string]: `${snap.volume * 100}%` }}
                    onChange={(e) => cmd("vol", { v: Number(e.target.value) / 100 })}
                    aria-label="Volume"
                  />
                </div>
              </>
            )}
          </>
        ) : (
          <div className="w-nothing">
            <IconNote />
            <span>Nothing playing</span>
            <button className="w-open-btn" onClick={() => void invoke("app_show_main")}>Open OMP</button>
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("widget-root")!).render(
  <StrictMode>
    <Widget />
  </StrictMode>
);
