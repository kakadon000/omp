import {
  useCallback, useEffect, useRef, useState, useSyncExternalStore,
} from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { openContextMenu } from "../components/ContextMenu";
import { customMedia, loadProgress, saveProgress, pushHistory, type Settings } from "../lib/store";
import { fmtTime, pct } from "../lib/format";
import { openMediaFile } from "../lib/tauri";
import { videoQueue, type RepeatMode } from "../lib/videoQueue";
import { robustSeek } from "../lib/media";
import type { VideoItem } from "../lib/data";

type MenuKind = "speed" | "subs" | "audio" | null;
type Aspect = "fit" | "fill" | "stretch" | "16:9" | "4:3";

const ASPECTS: { id: Aspect; label: string }[] = [
  { id: "fit", label: "Fit (letterbox)" },
  { id: "fill", label: "Fill (crop)" },
  { id: "stretch", label: "Stretch" },
  { id: "16:9", label: "Force 16:9" },
  { id: "4:3", label: "Force 4:3" },
];

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function Player({ settings }: { settings: Settings }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lastSave = useRef(0);
  const lastPreview = useRef(0);
  const boostWarned = useRef(false);
  const cueSnap = useRef<{ c: VTTCue; s: number; e: number }[] | null>(null);
  const webAudio = useRef<{
    ctx: AudioContext;
    src: MediaElementAudioSourceNode;
    gain: GainNode;
    delay: DelayNode;
    forSrc: string;
  } | null>(null);

  const custom = useSyncExternalStore(customMedia.sub, customMedia.get);
  const queue = useSyncExternalStore(videoQueue.sub, videoQueue.get);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [bufferedPct, setBufferedPct] = useState(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(settings.defaultSpeed);
  const [subs, setSubs] = useState(false);
  const [menu, setMenu] = useState<MenuKind>(null);
  const [fs, setFs] = useState(false);
  const [fsIdle, setFsIdle] = useState(false);
  const [pip, setPip] = useState(false);

  // timeline scrubbing — null = idle; 0..1000 while dragging
  const [scrubVal, setScrubVal] = useState<number | null>(null);
  const [hoverPct, setHoverPct] = useState<number | null>(null);

  // VLC-grade state
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [aspect, setAspect] = useState<Aspect>("fit");
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [adjust, setAdjust] = useState({ brightness: 100, contrast: 100, saturate: 100, hue: 0 });
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [subDelay, setSubDelay] = useState(0);
  const [audioDelay, setAudioDelay] = useState(0);
  const [showStats, setShowStats] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(true);
  const [osd, setOsd] = useState<{ id: number; msg: string } | null>(null);

  const vid = queue.items[queue.index] ?? queue.items[0];
  const src = custom.url || vid.src;
  const title = custom.url ? custom.name : vid.title;

  const osdTimer = useRef(0);
  const showOsd = useCallback((msg: string) => {
    setOsd({ id: Date.now(), msg });
    window.clearTimeout(osdTimer.current);
    osdTimer.current = window.setTimeout(() => setOsd(null), 1000);
  }, []);

  // ---- sidebar auto-hide signal -------------------------------------------
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("omp:video-state", { detail: { playing } }));
  }, [playing]);
  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent("omp:video-state", { detail: { playing: false } }));
  }, []);

  // ---- external navigation (Home "continue watching") ---------------------
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      customMedia.set({ name: "", url: "" });
      videoQueue.playId(id);
    };
    window.addEventListener("omp:play-video", on);
    return () => window.removeEventListener("omp:play-video", on);
  }, []);

  // reset per-file state when the source changes
  useEffect(() => {
    setLoopA(null);
    setLoopB(null);
    setSubDelay(0);
    cueSnap.current = null;
  }, [src]);

  // apply rate
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, src]);

  // release WebAudio graph when source changes / unmount
  useEffect(() => {
    const g = webAudio.current;
    if (g && g.forSrc !== src) {
      try { g.src.disconnect(); } catch { /* noop */ }
      webAudio.current = null;
    }
  }, [src]);
  useEffect(() => () => {
    const g = webAudio.current;
    if (g) { try { g.ctx.close(); } catch { /* noop */ } }
  }, []);

  const canBoost = (s: string) => {
    try {
      return new URL(s, location.href).origin === location.origin || s.startsWith("blob:");
    } catch { return false; }
  };

  const ensureGraph = (v: HTMLVideoElement, s: string) => {
    const g = webAudio.current;
    if (g && g.forSrc === s) { void g.ctx.resume(); return g; }
    if (g) { try { g.src.disconnect(); } catch { /* noop */ } }
    try {
      const ctx = g?.ctx ?? new AudioContext();
      void ctx.resume();
      const srcNode = ctx.createMediaElementSource(v);
      const gain = ctx.createGain();
      const delay = ctx.createDelay(10);
      srcNode.connect(gain);
      gain.connect(delay);
      delay.connect(ctx.destination);
      const next = { ctx, src: srcNode, gain, delay, forSrc: s };
      webAudio.current = next;
      return next;
    } catch {
      return null;
    }
  };

  const setVolume = (val: number) => {
    const v = videoRef.current;
    let target = clamp(val, 0, 2);
    if (target > 1) {
      if (!canBoost(src)) {
        target = 1;
        if (!boostWarned.current) {
          boostWarned.current = true;
          toast("Volume boost needs a same-origin file — capped at 100%", "info");
        }
      } else if (v) {
        const g = ensureGraph(v, src);
        if (!g) target = 1;
      }
    }
    setVol(target);
    setMuted(target === 0);
    if (v) {
      const g = webAudio.current;
      if (target > 1 && g) {
        v.volume = 1;
        v.muted = false;
        g.gain.gain.value = target;
      } else {
        if (g) g.gain.gain.value = 1;
        v.volume = target;
        v.muted = target === 0;
      }
    }
    showOsd(target === 0 ? "Muted" : `Volume ${Math.round(target * 100)}%`);
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    const next = !muted;
    v.muted = next;
    setMuted(next);
    showOsd(next ? "Muted" : `Volume ${Math.round(vol * 100)}%`);
  };

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const stopPlayback = () => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    void robustSeek(v, 0, src);
    setTime(0);
    showOsd("Stopped");
  };

  const seekBy = useCallback((delta: number, msg?: string) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    void robustSeek(v, v.currentTime + delta, src);
    setTime(v.currentTime);
    if (msg) showOsd(msg);
  }, [showOsd, src]);

  // ---- A-B loop ------------------------------------------------------------
  const abLoop = () => {
    const v = videoRef.current;
    if (!v) return;
    if (loopA === null) {
      setLoopA(v.currentTime);
      showOsd(`A-B loop: start ${fmtTime(v.currentTime)}`);
    } else if (loopB === null) {
      if (v.currentTime <= loopA) { setLoopA(null); showOsd("A-B loop cleared"); return; }
      setLoopB(v.currentTime);
      showOsd(`A-B loop on (${fmtTime(loopA)} → ${fmtTime(v.currentTime)})`);
    } else {
      setLoopA(null);
      setLoopB(null);
      showOsd("A-B loop off");
    }
  };

  // ---- snapshot --------------------------------------------------------------
  const snapshot = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) { toast("Nothing to capture yet", "err"); return; }
    try {
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const cx = c.getContext("2d");
      if (!cx) throw new Error("no 2d");
      cx.drawImage(v, 0, 0);
      c.toBlob((b) => {
        if (!b) { toast("Snapshot failed", "err"); return; }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, "0");
        a.download = `OMP-snapshot-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toast("Snapshot saved", "ok");
      }, "image/png");
    } catch {
      toast("Snapshot blocked for this file's source", "err");
    }
  };

  // ---- subtitle delay (shifts the loaded WebVTT cues) -----------------------
  const bumpSubDelay = (d: number) => {
    const v = videoRef.current;
    if (!subs) { toast("Turn subtitles on first (C)", "info"); return; }
    const tt = v?.textTracks?.[0];
    if (!tt || !tt.cues || tt.cues.length === 0) { toast("No subtitle cues loaded", "err"); return; }
    if (!cueSnap.current) {
      cueSnap.current = Array.from(tt.cues).map((c) => {
        const cue = c as VTTCue;
        return { c: cue, s: cue.startTime, e: cue.endTime };
      });
    }
    const next = clamp(+(subDelay + d).toFixed(1), -30, 30);
    for (const { c, s, e } of cueSnap.current) {
      c.startTime = Math.max(0, s + next);
      c.endTime = Math.max(0.1, e + next);
    }
    const mode = tt.mode;
    tt.mode = "hidden";
    tt.mode = mode;
    setSubDelay(next);
    showOsd(`Subtitle delay ${next > 0 ? "+" : ""}${next}s`);
  };

  // ---- audio delay (WebAudio DelayNode; needs the boost graph) --------------
  const bumpAudioDelay = (d: number) => {
    const v = videoRef.current;
    if (!v) return;
    if (!canBoost(src)) { toast("Audio delay needs a same-origin file", "info"); return; }
    const g = ensureGraph(v, src);
    if (!g) { toast("Audio engine unavailable", "err"); return; }
    const next = clamp(+(audioDelay + d).toFixed(1), 0, 10);
    g.delay.delayTime.value = next;
    setAudioDelay(next);
    showOsd(next === 0 ? "Audio delay reset" : `Audio delay +${next}s`);
  };

  // ---- fullscreen ------------------------------------------------------------
  const toggleFullscreen = () => {
    const el = stageRef.current?.closest(".player-wrap") as HTMLElement | null;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => toast("Fullscreen blocked", "err"));
  };

  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  // auto-hide controls while fullscreen + playing
  const idleTimer = useRef(0);
  useEffect(() => {
    if (!fs) { setFsIdle(false); return; }
    const bump = () => {
      setFsIdle(false);
      window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => setFsIdle(true), 2600);
    };
    bump();
    window.addEventListener("pointermove", bump);
    window.addEventListener("pointerdown", bump);
    return () => {
      window.removeEventListener("pointermove", bump);
      window.removeEventListener("pointerdown", bump);
      window.clearTimeout(idleTimer.current);
    };
  }, [fs]);

  const togglePip = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setPip(false);
      } else {
        await v.requestPictureInPicture();
        setPip(true);
      }
    } catch {
      toast("Picture-in-picture unavailable here", "err");
    }
  };

  const openExternal = async () => {
    const f = await openMediaFile();
    if (!f) return;
    customMedia.set({ name: f.name, url: f.url });
    pushHistory({ id: `custom:${f.name}`, kind: "video", name: f.name, at: Date.now() });
    toast(`Opened ${f.name}`, "ok");
  };

  const toggleSubs = () => {
    if (custom.url) { toast("Subtitles for external files arrive with the mpv engine (Phase 1.1)", "info"); return; }
    setSubs((s) => !s);
    showOsd(subs ? "Subtitles off" : "Subtitles on");
  };

  const nextVideo = (manual = true) => {
    if (custom.url) return;
    videoQueue.next(manual);
  };
  const prevVideo = () => {
    if (custom.url) return;
    videoQueue.prev();
  };

  // ---- timeline scrubbing -----------------------------------------------------
  const displayPct = scrubVal !== null ? scrubVal / 10 : pct(time, dur);
  const displayTime = scrubVal !== null && dur > 0 ? (scrubVal / 1000) * dur : time;

  const onSeekInput = (raw: number) => {
    setScrubVal(raw);
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration) || dur <= 0) return;
    const now = performance.now();
    if (now - lastPreview.current > 130) {
      lastPreview.current = now;
      void robustSeek(v, (raw / 1000) * v.duration, src);
    }
  };

  const commitSeek = useCallback(() => {
    setScrubVal((cur) => {
      if (cur === null) return null;
      const v = videoRef.current;
      if (v && Number.isFinite(v.duration) && dur > 0) {
        void robustSeek(v, (cur / 1000) * v.duration, src);
      }
      return null;
    });
  }, [dur, src]);

  useEffect(() => {
    if (scrubVal === null) return;
    const up = () => commitSeek();
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [scrubVal, commitSeek]);

  // ---- stable hotkeys (VLC-grade set) -----------------------------------------
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (document.querySelector(".modal, .overlay, .ctx-menu")) return;

    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const eat = () => { e.preventDefault(); e.stopPropagation(); };

    if (ctrl && (k === "g" || k === "G")) { eat(); setJumpOpen(true); return; }
    if (ctrl && (k === "o" || k === "O")) { eat(); void openExternal(); return; }
    if (ctrl && k === "ArrowRight") { eat(); seekBy(60, "+60s"); return; }
    if (ctrl && k === "ArrowLeft") { eat(); seekBy(-60, "−60s"); return; }
    if (e.altKey && (k === "j" || k === "J")) { eat(); bumpAudioDelay(-0.5); return; }
    if (e.altKey && (k === "k" || k === "K")) { eat(); bumpAudioDelay(0.5); return; }
    if (ctrl || e.altKey) return; // never hijack browser combos
    if (k === "?") return; // App-level overlay

    switch (k) {
      case " ": case "k": case "K": eat(); togglePlay(); break;
      case "s": case "S": eat(); stopPlayback(); break;
      case "ArrowRight": eat(); if (e.shiftKey) seekBy(3, "+3s"); else seekBy(settings.seekStep, `+${settings.seekStep}s`); break;
      case "ArrowLeft": eat(); if (e.shiftKey) seekBy(-3, "−3s"); else seekBy(-settings.seekStep, `−${settings.seekStep}s`); break;
      case "ArrowUp": eat(); setVolume(vol + 0.05); break;
      case "ArrowDown": eat(); setVolume(vol - 0.05); break;
      case "j": case "J": eat(); seekBy(-10, "−10s"); break;
      case "l": case "L":
        if (e.shiftKey) { eat(); const m: RepeatMode = videoQueue.cycleRepeat(); showOsd(m === "off" ? "Loop off" : m === "all" ? "Loop all" : "Loop one"); }
        else { eat(); seekBy(10, "+10s"); }
        break;
      case "n": case "N": eat(); nextVideo(true); break;
      case "p": case "P": eat(); prevVideo(); break;
      case "f": case "F": eat(); toggleFullscreen(); break;
      case "m": case "M": eat(); toggleMute(); break;
      case "t": case "T": eat(); snapshot(); break;
      case "b": case "B": eat(); abLoop(); break;
      case "r": case "R": eat(); { const on = videoQueue.toggleShuffle(); showOsd(on ? "Shuffle on" : "Shuffle off"); } break;
      case "c": case "C": eat(); toggleSubs(); break;
      case "g": eat(); bumpSubDelay(-0.5); break;
      case "h": eat(); bumpSubDelay(0.5); break;
      case "a": case "A": eat(); {
        const i = ASPECTS.findIndex((a) => a.id === aspect);
        const nextA = ASPECTS[(i + 1) % ASPECTS.length];
        setAspect(nextA.id);
        showOsd(`Aspect: ${nextA.label}`);
      } break;
      case "z": case "Z":
        if (e.shiftKey) { eat(); setZoom(1); setRotation(0); showOsd("Transforms reset"); }
        else { eat(); const r = (rotation + 90) % 360; setRotation(r as 0 | 90 | 180 | 270); showOsd(`Rotate ${r}°`); }
        break;
      case "i": case "I": eat(); setShowStats((s) => !s); break;
      case "q": case "Q": eat(); setQueueOpen((o) => !o); break;
      case "[": eat(); setRate((r) => clamp(+(r - 0.25).toFixed(2), 0.25, 2.5)); showOsd(`Speed ${clamp(+(rate - 0.25).toFixed(2), 0.25, 2.5)}×`); break;
      case "]": eat(); setRate((r) => clamp(+(r + 0.25).toFixed(2), 0.25, 2.5)); showOsd(`Speed ${clamp(+(rate + 0.25).toFixed(2), 0.25, 2.5)}×`); break;
      case "Backspace": eat(); setRate(1); showOsd("Speed 1×"); break;
      case "+": case "=": eat(); setZoom((z) => clamp(+(z + 0.25).toFixed(2), 1, 2.5)); showOsd(`Zoom ${clamp(+(zoom + 0.25).toFixed(2), 1, 2.5)}×`); break;
      case "-": case "_": eat(); setZoom((z) => clamp(+(z - 0.25).toFixed(2), 1, 2.5)); showOsd(`Zoom ${clamp(+(zoom - 0.25).toFixed(2), 1, 2.5)}×`); break;
      case "*": eat(); setZoom(1); showOsd("Zoom reset"); break;
      case ",": eat(); seekBy(-1 / 30); break;
      case ".": eat(); seekBy(1 / 30); break;
      case "Home": eat(); { const v = videoRef.current; if (v) void robustSeek(v, 0, src); } break;
      case "End": eat(); { const v = videoRef.current; if (v && Number.isFinite(v.duration)) void robustSeek(v, v.duration - 0.1, src); } break;
      case "Escape": setAdjustOpen(false); break;
      default:
        if (/^[0-9]$/.test(k)) {
          eat();
          const v = videoRef.current;
          if (v && Number.isFinite(v.duration) && v.duration > 0) {
            void robustSeek(v, (Number(k) / 10) * v.duration, src);
            setTime(v.currentTime);
            showOsd(`${Number(k) * 10}%`);
          }
        }
    }
  };

  useEffect(() => {
    const on = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // jump-to-time modal: Esc closes (Player's own hotkeys are paused while an
  // overlay is up, so it needs its own listener)
  const jumpEsc = useRef<(e: KeyboardEvent) => void>(() => {});
  jumpEsc.current = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); setJumpOpen(false); }
  };
  useEffect(() => {
    if (!jumpOpen) return;
    const on = (e: KeyboardEvent) => jumpEsc.current(e);
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [jumpOpen]);

  // ---- context menus ------------------------------------------------------------
  const stageMenu = (x: number, y: number) => {
    const abLabel = loopA === null ? "Set loop start" : loopB === null ? "Set loop end" : "Clear A-B loop";
    openContextMenu(x, y, [
      { label: playing ? "Pause" : "Play", icon: playing ? "pause" : "play", hint: "Space", onClick: togglePlay },
      { label: "Stop", icon: "close", hint: "S", onClick: stopPlayback },
      { sep: true },
      {
        label: "Playback speed", icon: "gauge",
        sub: [
          ...[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => ({
            label: r === 1 ? "Normal" : `${r}×`, checked: r === rate,
            onClick: () => { setRate(r); showOsd(`Speed ${r}×`); },
          })),
          { sep: true },
          { label: "Slower", hint: "[", onClick: () => { const r = clamp(+(rate - 0.25).toFixed(2), 0.25, 2.5); setRate(r); showOsd(`Speed ${r}×`); } },
          { label: "Faster", hint: "]", onClick: () => { const r = clamp(+(rate + 0.25).toFixed(2), 0.25, 2.5); setRate(r); showOsd(`Speed ${r}×`); } },
        ],
      },
      {
        label: "Jump", icon: "clock",
        sub: [
          { label: "Forward 10s", hint: "L", onClick: () => seekBy(10, "+10s") },
          { label: "Back 10s", hint: "J", onClick: () => seekBy(-10, "−10s") },
          { label: "Forward 60s", hint: "Ctrl →", onClick: () => seekBy(60, "+60s") },
          { label: "Back 60s", hint: "Ctrl ←", onClick: () => seekBy(-60, "−60s") },
          { sep: true },
          { label: "Jump to time…", hint: "Ctrl+G", onClick: () => setJumpOpen(true) },
        ],
      },
      { sep: true },
      {
        label: "Aspect ratio", icon: "crop",
        sub: ASPECTS.map((a) => ({
          label: a.label, checked: aspect === a.id,
          onClick: () => { setAspect(a.id); showOsd(`Aspect: ${a.label}`); },
        })),
      },
      {
        label: "Zoom", icon: "zoomIn",
        sub: [
          { label: "Zoom in", hint: "+", onClick: () => setZoom((z) => clamp(+(z + 0.25).toFixed(2), 1, 2.5)) },
          { label: "Zoom out", hint: "−", onClick: () => setZoom((z) => clamp(+(z - 0.25).toFixed(2), 1, 2.5)) },
          { label: "Reset", hint: "*", onClick: () => { setZoom(1); showOsd("Zoom reset"); } },
        ],
      },
      {
        label: "Rotate", icon: "rotate",
        sub: [
          { label: "Rotate 90°", hint: "Z", onClick: () => setRotation(((rotation + 90) % 360) as 0 | 90 | 180 | 270) },
          { label: "Reset transforms", hint: "Shift+Z", onClick: () => { setZoom(1); setRotation(0); showOsd("Transforms reset"); } },
        ],
      },
      { label: "Video adjustments…", icon: "sun", onClick: () => setAdjustOpen((o) => !o) },
      { sep: true },
      { label: subs ? "Subtitles: On" : "Subtitles: Off", icon: "cc", hint: "C", onClick: toggleSubs, disabled: !!custom.url },
      {
        label: "Subtitle delay", icon: "type", disabled: !subs,
        sub: [
          { label: "−0.5s", hint: "G", onClick: () => bumpSubDelay(-0.5) },
          { label: "+0.5s", hint: "H", onClick: () => bumpSubDelay(0.5) },
          { label: `Current: ${subDelay > 0 ? "+" : ""}${subDelay}s`, disabled: true },
        ],
      },
      {
        label: "Audio delay", icon: "volume",
        sub: [
          { label: "+0.5s", hint: "Alt+J", onClick: () => bumpAudioDelay(-0.5) },
          { label: "+1s", hint: "Alt+K ×2", onClick: () => bumpAudioDelay(0.5) },
          { label: "Reset", onClick: () => bumpAudioDelay(-audioDelay) },
        ],
      },
      { sep: true },
      { label: abLabel, icon: "repeat", hint: "B", onClick: abLoop },
      { label: `Loop: ${queue.repeat === "off" ? "Off" : queue.repeat === "all" ? "All" : "One"}`, icon: "repeat", hint: "Shift+L", onClick: () => { const m = videoQueue.cycleRepeat(); showOsd(m === "off" ? "Loop off" : m === "all" ? "Loop all" : "Loop one"); } },
      { label: `Shuffle: ${queue.shuffle ? "On" : "Off"}`, icon: "shuffle", hint: "R", onClick: () => { const on = videoQueue.toggleShuffle(); showOsd(on ? "Shuffle on" : "Shuffle off"); } },
      { sep: true },
      { label: "Take snapshot", icon: "image", hint: "T", onClick: snapshot },
      { label: "Picture-in-picture", icon: "pip", onClick: () => void togglePip() },
      { label: fs ? "Exit fullscreen" : "Fullscreen", icon: fs ? "exitFullscreen" : "fullscreen", hint: "F", onClick: toggleFullscreen },
      { sep: true },
      { label: "Stats for nerds", icon: "info", hint: "I", onClick: () => setShowStats((s) => !s) },
      { label: "Keyboard shortcuts", icon: "list", hint: "?", onClick: () => window.dispatchEvent(new CustomEvent("omp:show-keys")) },
    ], title);
  };

  const queueItemMenu = (e: React.MouseEvent, v: VideoItem, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      { label: "Play now", icon: "play", onClick: () => videoQueue.playAt(i) },
      { sep: true },
      { label: "Move up", onClick: () => videoQueue.move(i, -1), disabled: i === 0 },
      { label: "Move down", onClick: () => videoQueue.move(i, 1), disabled: i === queue.items.length - 1 },
      { label: "Remove", icon: "trash", danger: true, onClick: () => videoQueue.remove(i) },
      { sep: true },
      { label: "Clear queue (keep current)", onClick: () => videoQueue.clearExceptCurrent() },
      { label: "Restore default queue", onClick: () => videoQueue.restoreDefaults() },
      { sep: true },
      { label: "Copy title", onClick: () => { void navigator.clipboard?.writeText(v.title); toast("Title copied", "ok"); } },
    ], v.title);
  };

  // video transform + filters
  const filterStr = `brightness(${adjust.brightness}%) contrast(${adjust.contrast}%) saturate(${adjust.saturate}%) hue-rotate(${adjust.hue}deg)`;
  const quality = videoRef.current?.getVideoPlaybackQuality?.();

  return (
    <div className={`player-shell ${fsIdle ? "fs-idle" : ""}`}>
      <div className="player-wrap" style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div
          className="player-stage"
          ref={stageRef}
          onContextMenu={(e) => { e.preventDefault(); stageMenu(e.clientX, e.clientY); }}
        >
          <video
            key={src}
            ref={videoRef}
            src={src}
            autoPlay
            playsInline
            data-aspect={aspect}
            style={{ transform: `scale(${zoom}) rotate(${rotation}deg)`, filter: filterStr }}
            onClick={togglePlay}
            onDoubleClick={toggleFullscreen}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              // A-B loop enforcement
              if (loopB !== null && v.currentTime >= loopB) {
                void robustSeek(v, loopA ?? 0, src);
              }
              setTime(v.currentTime);
              const now = Date.now();
              if (!custom.url && now - lastSave.current > 2000) {
                lastSave.current = now;
                saveProgress(vid.id, v.currentTime, v.duration);
              }
            }}
            onProgress={() => {
              const v = videoRef.current;
              if (!v || !v.buffered.length || !Number.isFinite(v.duration) || v.duration <= 0) return;
              setBufferedPct((v.buffered.end(v.buffered.length - 1) / v.duration) * 100);
            }}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              v.volume = vol > 1 ? 1 : vol;
              v.playbackRate = rate;
              setDur(v.duration || 0);
              if (!custom.url) {
                const p = loadProgress()[vid.id];
                if (p && p.t > 3 && pct(p.t, p.d) < 97) {
                  void robustSeek(v, p.t, src);
                  toast(`Resumed at ${fmtTime(p.t)}`, "info");
                }
                pushHistory({ id: vid.id, kind: "video", name: vid.title, at: Date.now(), thumb: vid.poster });
              }
            }}
            onEnded={() => {
              if (custom.url) return;
              if (queue.repeat === "one") {
                const v = videoRef.current;
                if (v) { void robustSeek(v, 0, src); void v.play(); }
                return;
              }
              saveProgress(vid.id, 0, 0);
              const nxt = videoQueue.next(false);
              if (!nxt) setPlaying(false);
            }}
            onError={() => toast("This format needs the mpv engine — arrives in Phase 1.1", "info")}
          >
            {subs && !custom.url && (
              <track kind="subtitles" src="./media/sample-subs.vtt" srcLang="en" label="English" default />
            )}
          </video>

          {!playing && (
            <button className="stage-big-play" onClick={togglePlay} aria-label="Play">
              <Icon name="play" />
            </button>
          )}

          <div className={`pc-title ${fsIdle ? "hide" : ""}`}>
            <span className="chip"><Icon name="film" /> {title}</span>
          </div>

          {osd && <div key={osd.id} className="osd">{osd.msg}</div>}

          {showStats && (
            <div className="stats">
              <div><b>{title}</b></div>
              <div>Resolution&nbsp;&nbsp;{videoRef.current?.videoWidth ?? "?"}×{videoRef.current?.videoHeight ?? "?"}</div>
              <div>Position&nbsp;&nbsp;&nbsp;&nbsp;{fmtTime(time)} / {fmtTime(dur)} ({Math.round(pct(time, dur))}%)</div>
              <div>Speed · Vol&nbsp;&nbsp;{rate}× · {Math.round(vol * 100)}%</div>
              <div>Buffered&nbsp;&nbsp;&nbsp;{Math.round(bufferedPct)}%</div>
              {quality && <div>Frames&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{quality.totalVideoFrames} decoded · {quality.droppedVideoFrames} dropped</div>}
              <div>Loop&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{loopA !== null ? `A-B (${fmtTime(loopA)}–${fmtTime(loopB ?? dur)})` : queue.repeat}</div>
              <div className="stats-src">{src}</div>
            </div>
          )}

          {adjustOpen && (
            <div className="adjust-panel">
              <div className="ap-head">
                <span>Video adjustments</span>
                <button className="icon-btn sm" onClick={() => setAdjustOpen(false)} aria-label="Close">
                  <Icon name="close" size={13} />
                </button>
              </div>
              {([
                ["brightness", "Brightness", 50, 150],
                ["contrast", "Contrast", 50, 150],
                ["saturate", "Saturation", 0, 200],
                ["hue", "Hue shift", -180, 180],
              ] as const).map(([key, label, min, max]) => (
                <div key={key} className="ap-row">
                  <span className="ap-label">{label}</span>
                  <input
                    type="range" className="slider thin" min={min} max={max}
                    value={adjust[key]}
                    style={{ ["--fill" as string]: `${((adjust[key] - min) / (max - min)) * 100}%` }}
                    onChange={(e) => setAdjust((a) => ({ ...a, [key]: Number(e.target.value) }))}
                  />
                  <span className="ap-val">{adjust[key]}{key === "hue" ? "°" : "%"}</span>
                </div>
              ))}
              <button className="btn sm" style={{ width: "100%", marginTop: 10 }} onClick={() => setAdjust({ brightness: 100, contrast: 100, saturate: 100, hue: 0 })}>
                Reset all
              </button>
            </div>
          )}
        </div>

        {/* queue */}
        {queueOpen && !custom.url && (
          <aside className="player-queue">
            <div className="pq-head">
              <div className="section-label">Queue · {queue.items.length}</div>
              <div className="pq-actions">
                <button
                  className={`icon-btn sm tip ${queue.shuffle ? "on" : ""}`} data-tip="Shuffle (R)" data-tip-up
                  onClick={() => { const on = videoQueue.toggleShuffle(); showOsd(on ? "Shuffle on" : "Shuffle off"); }}
                  aria-label="Shuffle"
                >
                  <Icon name="shuffle" size={15} />
                </button>
                <button
                  className={`icon-btn sm tip ${queue.repeat !== "off" ? "on" : ""}`} data-tip={`Loop: ${queue.repeat} (Shift+L)`} data-tip-up
                  onClick={() => { const m = videoQueue.cycleRepeat(); showOsd(m === "off" ? "Loop off" : m === "all" ? "Loop all" : "Loop one"); }}
                  aria-label="Loop"
                >
                  <Icon name="repeat" size={15} />
                </button>
                <button className="icon-btn sm tip" data-tip="Hide queue (Q)" data-tip-up onClick={() => setQueueOpen(false)} aria-label="Hide queue">
                  <Icon name="close" size={15} />
                </button>
              </div>
            </div>
            {queue.items.map((v, i) => (
              <div
                key={v.id}
                className={`q-item ${i === queue.index ? "on" : ""}`}
                onClick={() => videoQueue.playAt(i)}
                onContextMenu={(e) => queueItemMenu(e, v, i)}
              >
                <div className="q-num">{i + 1}</div>
                <div className="q-thumb">{v.poster ? <img src={v.poster} alt="" loading="lazy" /> : <Icon name="film" />}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="q-title">{v.title}</div>
                  <div className="q-meta">{v.duration} · {v.res} · {v.codec}</div>
                </div>
                <div className="q-hover">
                  <button
                    className="icon-btn sm" aria-label="Move up"
                    onClick={(e) => { e.stopPropagation(); videoQueue.move(i, -1); }}
                    disabled={i === 0}
                  >
                    <Icon name="chevronL" size={13} />
                  </button>
                  <button
                    className="icon-btn sm" aria-label="Remove"
                    onClick={(e) => { e.stopPropagation(); videoQueue.remove(i); }}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
                {i === queue.index && <Icon name="play" size={13} />}
              </div>
            ))}
            {queue.items.length === 0 && (
              <div className="empty">
                <Icon name="list" />
                <div className="t">Queue is empty</div>
                <div className="d">Right-click any video on Home to add it, or restore the demo queue.</div>
                <button className="btn sm" onClick={() => videoQueue.restoreDefaults()}>Restore queue</button>
              </div>
            )}
            <div className="side-sep" style={{ margin: "12px 4px" }} />
            <button className="btn sm" style={{ width: "100%" }} onClick={openExternal}>
              <Icon name="plus" size={14} /> Open external file
            </button>
            <div className="pq-hint">Tip: right-click the video for the full menu · <span className="kbd">?</span> for hotkeys</div>
          </aside>
        )}
      </div>

      {/* control bar */}
      <div className={`player-bar ${fsIdle ? "fs-idle" : ""}`}>
        <div
          className="seek-wrap"
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const p = clamp(((e.clientX - r.left - 56) / (r.width - 112)) * 100, 0, 100);
            setHoverPct(Number.isFinite(p) ? p : null);
          }}
          onMouseLeave={() => setHoverPct(null)}
        >
          <span className="seek-time">{fmtTime(displayTime)}</span>
          <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
            <input
              type="range"
              className="slider thin"
              min={0}
              max={1000}
              step={1}
              value={Math.round(displayPct * 10)}
              style={{ ["--fill" as string]: `${displayPct}%`, ["--buffered" as string]: `${bufferedPct}%` }}
              onChange={(e) => onSeekInput(Number(e.target.value))}
              onPointerUp={commitSeek}
              onKeyUp={commitSeek}
              onBlur={commitSeek}
              aria-label="Seek"
            />
            {hoverPct !== null && dur > 0 && (
              <div className="seek-preview" style={{ left: `${hoverPct}%` }}>
                {fmtTime((hoverPct / 100) * dur)}
              </div>
            )}
          </div>
          <span className="seek-time right">{fmtTime(dur)}</span>
        </div>

        <div className="player-controls">
          <button className="icon-btn" onClick={prevVideo} aria-label="Previous (P)"><Icon name="prev" /></button>
          <button className="icon-btn lg" onClick={togglePlay} aria-label={playing ? "Pause (Space)" : "Play (Space)"}>
            <Icon name={playing ? "pause" : "play"} size={22} />
          </button>
          <button className="icon-btn" onClick={() => nextVideo(true)} aria-label="Next (N)"><Icon name="next" /></button>
          <button className="icon-btn tip" data-tip="Frame back (,)" onClick={() => seekBy(-1 / 30)} aria-label="Frame back"><Icon name="stepB" /></button>
          <button className="icon-btn tip" data-tip="Frame forward (.)" onClick={() => seekBy(1 / 30)} aria-label="Frame forward"><Icon name="stepF" /></button>
          <button className={`icon-btn tip ${loopA !== null ? "on" : ""}`} data-tip="A-B loop (B)" onClick={abLoop} aria-label="A-B loop"><Icon name="repeat" /></button>
          <button
            className={`icon-btn tip ${queue.repeat !== "off" ? "on" : ""}`}
            data-tip={`Loop: ${queue.repeat} (Shift+L)`}
            onClick={() => { const m = videoQueue.cycleRepeat(); showOsd(m === "off" ? "Loop off" : m === "all" ? "Loop all" : "Loop one"); }}
            aria-label="Loop mode"
          >
            <Icon name="repeat" style={{ transform: queue.repeat === "one" ? "scaleX(-1)" : undefined }} />
          </button>
          <button
            className={`icon-btn tip ${queue.shuffle ? "on" : ""}`} data-tip="Shuffle (R)"
            onClick={() => { const on = videoQueue.toggleShuffle(); showOsd(on ? "Shuffle on" : "Shuffle off"); }}
            aria-label="Shuffle"
          >
            <Icon name="shuffle" />
          </button>

          <div className="pc-grow" />

          <div className="vol-wrap">
            <button className="icon-btn sm" onClick={toggleMute} aria-label="Mute (M)">
              <Icon name={muted || vol === 0 ? "mute" : vol > 1 ? "volume" : "volume"} />
            </button>
            <input
              type="range" className="slider thin" min={0} max={200} value={Math.round(vol * 100)}
              style={{ ["--fill" as string]: `${(vol * 100) / 2}%` }}
              onChange={(e) => setVolume(Number(e.target.value) / 100)}
              aria-label="Volume (boost to 200%)"
            />
            {vol > 1 && <span className="boost-badge">+{Math.round((vol - 1) * 100)}%</span>}
          </div>

          {/* speed menu */}
          <div className="menu-wrap">
            <button
              className={`icon-btn tip ${rate !== 1 ? "on" : ""}`} data-tip="Playback speed ([ ])" data-tip-up
              onClick={() => setMenu(menu === "speed" ? null : "speed")}
              aria-label="Speed"
            >
              <Icon name="gauge" />
            </button>
            {menu === "speed" && (
              <div className="menu up" onMouseLeave={() => setMenu(null)}>
                {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                  <button key={r} className={`menu-item ${r === rate ? "sel" : ""}`} onClick={() => { setRate(r); setMenu(null); showOsd(`Speed ${r}×`); }}>
                    <span className="grow">{r === 1 ? "Normal" : `${r}×`}</span>
                    {r === rate && <Icon name="check" size={14} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* subtitles menu */}
          {!custom.url && (
            <div className="menu-wrap">
              <button
                className={`icon-btn tip ${subs ? "on" : ""}`} data-tip="Subtitles (C)" data-tip-up
                onClick={() => setMenu(menu === "subs" ? null : "subs")}
                aria-label="Subtitles"
              >
                <Icon name="cc" />
              </button>
              {menu === "subs" && (
                <div className="menu up" onMouseLeave={() => setMenu(null)}>
                  <button className={`menu-item ${!subs ? "sel" : ""}`} onClick={() => { setSubs(false); setMenu(null); }}>
                    <span className="grow">Off</span>{!subs && <Icon name="check" size={14} />}
                  </button>
                  <button className={`menu-item ${subs ? "sel" : ""}`} onClick={() => { setSubs(true); setMenu(null); }}>
                    <span className="grow">English (sample.vtt)</span>{subs && <Icon name="check" size={14} />}
                  </button>
                  <div className="menu-sep" />
                  <button className="menu-item" onClick={() => { bumpSubDelay(-0.5); setMenu(null); }}>
                    <span className="grow">Delay −0.5s</span><span className="kbd">G</span>
                  </button>
                  <button className="menu-item" onClick={() => { bumpSubDelay(0.5); setMenu(null); }}>
                    <span className="grow">Delay +0.5s</span><span className="kbd">H</span>
                  </button>
                  <div className="menu-sep" />
                  <button className="menu-item" onClick={() => toast("External subtitle loading lands in Phase 1.1", "info")}>
                    <Icon name="plus" size={14} /><span className="grow">Load file…</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* audio tracks */}
          <div className="menu-wrap">
            <button className="icon-btn tip" data-tip="Audio" data-tip-up onClick={() => setMenu(menu === "audio" ? null : "audio")} aria-label="Audio">
              <Icon name="list" />
            </button>
            {menu === "audio" && (
              <div className="menu up" onMouseLeave={() => setMenu(null)}>
                <button className="menu-item sel">
                  <span className="grow">Default (AAC 2.0)</span><Icon name="check" size={14} />
                </button>
                <button className="menu-item" onClick={() => { bumpAudioDelay(0.5); setMenu(null); }}>
                  <span className="grow">Audio delay +0.5s</span><span className="kbd">Alt+K</span>
                </button>
                <button className="menu-item" onClick={() => { bumpAudioDelay(-0.5); setMenu(null); }}>
                  <span className="grow">Audio delay −0.5s</span><span className="kbd">Alt+J</span>
                </button>
                <button className="menu-item" onClick={() => toast("Multi-track audio arrives with the mpv engine (Phase 1.1)", "info")}>
                  <span className="grow">External audio…</span>
                </button>
              </div>
            )}
          </div>

          <button
            className={`icon-btn tip ${queueOpen && !custom.url ? "on" : ""}`}
            data-tip="Queue (Q)" data-tip-up
            onClick={() => setQueueOpen((o) => !o)}
            aria-label="Toggle queue"
          >
            <Icon name="list" />
          </button>
          <button className={`icon-btn tip ${pip ? "on" : ""}`} data-tip="Picture-in-picture" data-tip-up onClick={() => void togglePip()} aria-label="Picture in picture">
            <Icon name="pip" />
          </button>
          <button className="icon-btn tip" data-tip={fs ? "Exit fullscreen (F)" : "Fullscreen (F)"} data-tip-up onClick={toggleFullscreen} aria-label="Fullscreen">
            <Icon name={fs ? "exitFullscreen" : "fullscreen"} />
          </button>
        </div>
      </div>

      {/* jump to time */}
      {jumpOpen && (
        <div className="overlay" onClick={() => setJumpOpen(false)}>
          <div className="modal" style={{ maxWidth: 340 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-title">Jump to time</div>
              <button className="icon-btn" onClick={() => setJumpOpen(false)} aria-label="Close"><Icon name="close" /></button>
            </div>
            <div className="modal-body">
              <input
                className="input" autoFocus placeholder="mm:ss or seconds — e.g. 1:30"
                defaultValue={fmtTime(time)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const v = videoRef.current;
                  const raw = e.currentTarget.value.trim();
                  if (!v || !Number.isFinite(v.duration)) return;
                  const m = raw.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/) || (raw.match(/^\d+(\.\d+)?$/) ? [null, null, null, raw] : null);
                  let t = -1;
                  if (m) {
                    if (m[1] != null) t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
                    else if (m[2] != null) t = Number(m[2]) * 60 + Number(m[3]);
                    else t = Number(m[3]);
                  }
                  if (Number.isFinite(t) && t >= 0) {
                    v.currentTime = clamp(t, 0, Math.max(0, v.duration - 0.05));
                    setTime(v.currentTime);
                    setJumpOpen(false);
                  } else toast("Could not read that time — try 1:30", "err");
                }}
              />
              <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>
                Duration {fmtTime(dur)} · press Enter to jump
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setJumpOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
