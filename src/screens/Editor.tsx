import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { invoke, isTauri, openMediaFile } from "../lib/tauri";
import { engineStore, onMpvEvent, attachEngine, detachEngine } from "../lib/engine";
import { audioStore, stopSession } from "../lib/audio";
import { fmtTime } from "../lib/format";
import type { Settings } from "../lib/store";
import {
  editorStore, exportStore, mutate, setProject, patchMeta, markClean,
  undo, redo, undoRedoState, newProject, startExport, cancelExport,
  saveProjectAs, openProjectDialog, ffmpegStatus,
} from "../lib/editor";
import type { OmpProject, Ovl, OvlType } from "../lib/editor";

type Tool = "select" | "crop" | "rect" | "circle" | "arrow" | "text";

const COLORS = ["#ffffff", "#0b0d12", "#4cc2ff", "#45d0c8", "#b6a6ff", "#ffc76b", "#ff7a78", "#6fd598"];

const TOOLS: { t: Tool; icon: string; label: string }[] = [
  { t: "select", icon: "square", label: "Select" },
  { t: "crop", icon: "crop", label: "Crop" },
  { t: "rect", icon: "square", label: "Rectangle" },
  { t: "circle", icon: "circle", label: "Circle" },
  { t: "arrow", icon: "arrow", label: "Arrow" },
  { t: "text", icon: "type", label: "Text" },
];

const uid = () => `o${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

export function Editor({ settings }: { settings: Settings }) {
  const ed = useSyncExternalStore(editorStore.sub, editorStore.get);
  const exp = useSyncExternalStore(exportStore.sub, exportStore.get);
  const eng = useSyncExternalStore(engineStore.sub, engineStore.get);
  const p = ed.project;
  const isMpv = isTauri && eng.kind === "mpv";
  const hasVideo = !!p?.srcPath;
  const { canUndo, canRedo } = undoRedoState();

  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLORS[2]);
  const [sw, setSw] = useState(8); // per-mille of frame height
  const [fs, setFs] = useState(36);
  const [selId, setSelId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(p?.dur || 0);
  const [playing, setPlaying] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(
    p?.vw ? { w: p.vw, h: p.vh } : null
  );
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [exportOpen, setExportOpen] = useState(false);
  const [format, setFormat] = useState<"mp4" | "webm" | "gif">("mp4");
  const [quality, setQuality] = useState<"high" | "medium" | "low">("high");
  const [ffMpeg, setFfMpeg] = useState<{ found: boolean; path: string } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const videoBoxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragRef = useRef<{ id: string; mode: "move" | "resize"; sx: number; sy: number; o: Ovl } | null>(null);
  const trimRef = useRef<{ part: "l" | "r" | "body"; sx: number; os: number; oe: number } | null>(null);
  const cropRef = useRef<{ part: "move" | "nw" | "ne" | "sw" | "se"; sx: number; sy: number; c: NonNullable<OmpProject["crop"]> } | null>(null);
  const trimTrackRef = useRef<HTMLDivElement>(null);

  const sel = p?.overlays.find((o) => o.id === selId) || null;
  const aspect = dims ? dims.w / dims.h : 16 / 9;
  const crop = p?.crop ?? null;
  // crop TOOL edits the rectangle over the FULL frame; other tools see the
  // cropped preview. Mapping helpers use cropEff (null while cropping).
  const cropEff = tool === "crop" ? null : crop;

  /* ---------------- video source: open / restore ---------------- */
  const openVideo = async () => {
    if (isTauri) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const path = await open({
          multiple: false,
          filters: [{ name: "Video", extensions: ["mp4", "mkv", "webm", "mov", "avi", "m4v", "wmv", "flv", "ts", "mpg", "mpeg", "ogv", "3gp"] }],
        });
        if (typeof path !== "string") return;
        setProject(newProject(path, path.split(/[\\/]/).pop() || "Project"));
        setT(0); setDur(0); setDims(null); setPlaying(false); setSelId(null);
        return;
      } catch { return; }
    }
    const f = await openMediaFile();
    if (!f?.url) return;
    setProject(newProject(f.url, f.name));
    setT(0); setDur(0); setDims(null); setPlaying(false); setSelId(null);
  };

  // restore autosave once if there is no project yet
  useEffect(() => {
    if (editorStore.get().project) return;
    import("../lib/editor").then(({ loadAutosave, setProject }) => {
      const p = loadAutosave();
      if (p) setProject(p);
    });
  }, []);

  /* ---------------- native engine lifecycle ---------------- */
  useEffect(() => {
    if (!isTauri || !isMpv || !p?.srcPath) return;
    if (audioStore.get().track) {
      stopSession();
      toast("Music paused — the editor needs the engine", "info");
    }
    let dead = false;
    void (async () => {
      const ok = await attachEngine(settings.hwAccel);
      if (ok && !dead) {
        void invoke("mpv_load", { source: p.srcPath, start: editorStore.get().project?.trim.s ?? 0 });
      } else if (!dead) {
        toast("Native engine unavailable — editor preview disabled", "err");
      }
    })();
    return () => { dead = true; detachEngine(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMpv, p?.srcPath]);

  // mpv-live: the native surface renders BELOW the webview — only while the
  // editor actually previews a video through mpv.
  useEffect(() => {
    document.documentElement.classList.toggle("mpv-live", isMpv && hasVideo);
    return () => document.documentElement.classList.remove("mpv-live");
  }, [isMpv, hasVideo]);

  /* ---------------- surface rect: aspect-fit box (or crop sub-rect) -------- */
  useEffect(() => {
    const push = () => {
      const el = stageRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setStage((prev) =>
        Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5
          ? prev
          : { w: r.width, h: r.height }
      );
      const box = videoBoxRef.current;
      if (!box) return;
      const br = box.getBoundingClientRect();
      if (br.width < 2 || br.height < 2) return;
      void invoke("mpv_set_rect", {
        x: Math.round(br.left), y: Math.round(br.top),
        w: Math.round(br.width), h: Math.round(br.height),
      });
    };
    push();
    const ro = new ResizeObserver(push);
    if (stageRef.current) ro.observe(stageRef.current);
    window.addEventListener("resize", push);
    const iv = window.setInterval(push, 700);
    return () => { ro.disconnect(); window.removeEventListener("resize", push); window.clearInterval(iv); };
  }, [isMpv, hasVideo, dims, crop, tool]);

  // aspect-fit box geometry: contain (vw,vh) inside the stage rect
  const fitBox = (() => {
    if (!stage.w || !stage.h) return { left: 0, top: 0, width: 0, height: 0 };
    let w = stage.w, h = stage.h;
    if (w / h > aspect) w = h * aspect; else h = w / aspect;
    return { left: (stage.w - w) / 2, top: (stage.h - h) / 2, width: w, height: h };
  })();

  // the box the user sees & annotates: full frame in crop mode (so the
  // rectangle is editable over the whole picture), crop region otherwise
  const viewBox = (() => {
    const f = fitBox;
    if (!crop || tool === "crop") return f;
    return {
      left: f.left + crop.x * f.width,
      top: f.top + crop.y * f.height,
      width: crop.w * f.width,
      height: crop.h * f.height,
    };
  })();

  /* ---------------- engine events → editor state ---------------- */
  useEffect(() => {
    if (!isMpv || !hasVideo) return;
    return onMpvEvent((e) => {
      const cur = editorStore.get().project;
      if (!cur) return;
      switch (e.kind) {
        case "tick": {
          setT(e.t);
          const { s, e: te } = cur.trim;
          if (te > s + 0.2 && e.t >= te - 0.03) void invoke("mpv_seek", { t: s });
          break;
        }
        case "duration":
          setDur(e.d);
          if (!cur.dur) patchMeta({ dur: e.d });
          break;
        case "loaded": {
          setDur(e.d ?? 0);
          patchMeta({ dur: e.d ?? 0, vw: e.vw, vh: e.vh });
          setDims(e.vw ? { w: e.vw, h: e.vh } : null);
          if (!cur.trim.e || cur.trim.e > (e.d ?? 0)) {
            mutate((pp) => ({ ...pp, trim: { s: 0, e: e.d ?? 0 } }), false);
          }
          break;
        }
        case "pause":
          setPlaying(!e.paused);
          break;
        case "ended":
          void invoke("mpv_seek", { t: cur.trim.s });
          void invoke("mpv_set_paused", { v: false });
          break;
        case "file-error":
          if (e.msg && e.msg.includes("stopped")) break;
          toast(`Preview failed: ${e.msg ?? "unknown error"}`, "err");
          break;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMpv, hasVideo]);

  /* ---------------- web demo fallback (browser build) ---------------- */
  useEffect(() => {
    if (isTauri || !hasVideo) return;
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      setT(v.currentTime);
      const cur = editorStore.get().project;
      if (cur && cur.trim.e > cur.trim.s + 0.2 && v.currentTime >= cur.trim.e - 0.03) {
        v.currentTime = cur.trim.s;
      }
    };
    const onMeta = () => {
      setDur(v.duration || 0);
      setDims({ w: v.videoWidth || 16, h: v.videoHeight || 9 });
      const cur = editorStore.get().project;
      if (cur && !cur.trim.e) mutate((pp) => ({ ...pp, trim: { s: 0, e: v.duration || 0 } }), false);
    };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onMeta);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onMeta);
    };
  }, [isTauri, hasVideo, p?.srcPath]);

  const togglePlay = () => {
    if (isMpv && hasVideo) void invoke("mpv_set_paused", { v: playing });
    else if (!isTauri && videoRef.current) {
      if (playing) videoRef.current.pause();
      else void videoRef.current.play();
    }
  };

  const seekTo = (ts: number) => {
    const d = dur || p?.dur || 0;
    const c = Math.max(0, Math.min(d, ts));
    setT(c);
    if (isMpv && hasVideo) void invoke("mpv_seek", { t: c });
    else if (!isTauri && videoRef.current) videoRef.current.currentTime = c;
  };

  /* ---------------- overlays ---------------- */
  const mapToView = (o: Ovl) => {
    const c = cropEff;
    if (!c) return { left: o.x, top: o.y, w: o.w, h: o.h };
    return {
      left: (o.x - c.x) / c.w,
      top: (o.y - c.y) / c.h,
      w: o.w / c.w,
      h: o.h / c.h,
    };
  };
  const mapFromView = (vx: number, vy: number) => {
    const c = cropEff;
    if (!c) return { x: vx, y: vy };
    return { x: c.x + vx * c.w, y: c.y + vy * c.h };
  };

  const addOvl = (type: OvlType, vx: number, vy: number) => {
    const pt = mapFromView(vx, vy);
    const w = type === "circle" ? 0.14 : 0.22;
    const h = type === "circle" ? 0.14 : type === "arrow" ? 0.18 : type === "text" ? 0.06 : 0.16;
    mutate((pp) => {
      const start = t || pp.trim.s;
      const o: Ovl = {
        id: uid(), type,
        x: Math.max(0, Math.min(1 - w, pt.x - w / 2)),
        y: Math.max(0, Math.min(1 - h, pt.y - h / 2)),
        w, h, color, sw, fs,
        text: type === "text" ? "Your text" : undefined,
        start,
        end: Math.min(pp.trim.e || pp.dur || start + 5, start + 5),
      };
      setSelId(o.id);
      if (type === "text") setEditingId(o.id);
      return { ...pp, overlays: [...pp.overlays, o] };
    });
  };

  const canvasClick = (e: React.MouseEvent) => {
    if (!p) return;
    if (tool === "select") { setSelId(null); return; }
    if (tool === "crop") {
      if (!p.crop) mutate((pp) => ({ ...pp, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } }), false);
      return;
    }
    const r = videoBoxRef.current?.getBoundingClientRect();
    if (!r) return;
    const vx = (e.clientX - r.left) / r.width;
    const vy = (e.clientY - r.top) / r.height;
    addOvl(tool, vx, vy);
  };

  const onOvlDown = (e: React.PointerEvent, o: Ovl) => {
    if (tool !== "select") return;
    e.stopPropagation();
    setSelId(o.id);
    dragRef.current = { id: o.id, mode: "move", sx: e.clientX, sy: e.clientY, o: { ...o } };
  };
  const onOvlResizeDown = (e: React.PointerEvent, o: Ovl) => {
    e.stopPropagation();
    setSelId(o.id);
    dragRef.current = { id: o.id, mode: "resize", sx: e.clientX, sy: e.clientY, o: { ...o } };
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      const r = videoBoxRef.current?.getBoundingClientRect();
      if (!d || !r) return;
      const dx = (e.clientX - d.sx) / r.width;
      const dy = (e.clientY - d.sy) / r.height;
      // view-space delta → frame-space delta (crop scales coordinates)
      const c = cropEff;
      const fdx = c ? dx * c.w : dx;
      const fdy = c ? dy * c.h : dy;
      mutate((pp) => {
        const o = pp.overlays.find((x) => x.id === d.id);
        if (!o) return null;
        const next = { ...o };
        if (d.mode === "move") {
          next.x = Math.max(-0.2, Math.min(1.0, d.o.x + fdx));
          next.y = Math.max(-0.2, Math.min(1.0, d.o.y + fdy));
        } else {
          next.w = Math.max(0.02, d.o.w + fdx);
          next.h = Math.max(0.02, d.o.h + fdy);
        }
        return { ...pp, overlays: pp.overlays.map((x) => (x.id === d.id ? next : x)) };
      }, false);
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropEff]);

  const patchSel = (patch: Partial<Ovl>) => {
    if (!sel) return;
    mutate((pp) => ({
      ...pp,
      overlays: pp.overlays.map((o) => (o.id === sel.id ? { ...o, ...patch } : o)),
    }), false);
  };

  const deleteSel = () => {
    if (!sel) return;
    mutate((pp) => ({ ...pp, overlays: pp.overlays.filter((o) => o.id !== sel.id) }));
    setSelId(null);
  };

  const duplicateSel = () => {
    if (!sel) return;
    mutate((pp) => {
      const c: Ovl = { ...sel, id: uid(), x: Math.min(0.95, sel.x + 0.03), y: Math.min(0.95, sel.y + 0.03) };
      setSelId(c.id);
      return { ...pp, overlays: [...pp.overlays, c] };
    });
  };

  /* ---------------- crop dragging ---------------- */
  const onCropDown = (e: React.PointerEvent, part: "move" | "nw" | "ne" | "sw" | "se") => {
    if (!crop) return;
    e.stopPropagation();
    cropRef.current = { part, sx: e.clientX, sy: e.clientY, c: { ...crop } };
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = cropRef.current;
      const r = videoBoxRef.current?.getBoundingClientRect();
      if (!d || !r) return;
      // in crop mode the videoBox IS the full frame — deltas are frame-space
      const dx = (e.clientX - d.sx) / r.width;
      const dy = (e.clientY - d.sy) / r.height;
      mutate((pp) => {
        if (!pp.crop) return null;
        let { x, y, w, h } = d.c;
        const min = 0.08;
        if (d.part === "move") {
          x = Math.max(0, Math.min(1 - w, x + dx));
          y = Math.max(0, Math.min(1 - h, y + dy));
        } else {
          if (d.part.includes("w")) { x = Math.max(0, Math.min(x + w - min, x + dx)); w = d.c.w + (d.c.x - x); }
          if (d.part.includes("e")) { w = Math.max(min, Math.min(1 - x, d.c.w + dx)); }
          if (d.part.includes("n")) { y = Math.max(0, Math.min(y + h - min, y + dy)); h = d.c.h + (d.c.y - y); }
          if (d.part.includes("s")) { h = Math.max(min, Math.min(1 - y, d.c.h + dy)); }
        }
        return { ...pp, crop: { x, y, w, h } };
      }, false);
    };
    const up = () => { cropRef.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetCrop = () => mutate((pp) => ({ ...pp, crop: null }));

  /* ---------------- trim dragging ---------------- */
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = trimRef.current;
      if (!d || !dur) return;
      const dt = ((e.clientX - d.sx) / (trimTrackRef.current?.clientWidth || 600)) * dur;
      if (d.part === "l") mutate((pp) => ({ ...pp, trim: { ...pp.trim, s: Math.max(0, Math.min(d.oe - 0.5, d.os + dt)) } }), false);
      else if (d.part === "r") mutate((pp) => ({ ...pp, trim: { ...pp.trim, e: Math.min(dur, Math.max(d.os + 0.5, d.oe + dt)) } }), false);
      else {
        const span = d.oe - d.os;
        const ns = Math.max(0, Math.min(dur - span, d.os + dt));
        mutate((pp) => ({ ...pp, trim: { s: ns, e: ns + span } }), false);
      }
    };
    const up = () => { trimRef.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dur]);

  /* ---------------- export ---------------- */
  useEffect(() => {
    if (!exportOpen || ffMpeg) return;
    void ffmpegStatus().then(setFfMpeg);
  }, [exportOpen, ffMpeg]);

  const runExport = async () => {
    if (!p) return;
    const ext = format;
    let outPath: string | null = null;
    if (isTauri) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      outPath = await save({
        defaultPath: `${p.name || "export"}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (typeof outPath !== "string") return;
    }
    const ok = await startExport(p, outPath || `${p.name}.${ext}`, format, quality);
    if (!ok) toast("Export could not start", "err");
  };

  /* ---------------- keyboard ---------------- */
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      else if (e.key === "Delete" || e.key === "Backspace") deleteSel();
      else if (e.key === " ") { e.preventDefault(); togglePlay(); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, sel]);

  /* ---------------- empty state ---------------- */
  if (!p || !hasVideo) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <div>
            <div className="page-title" style={{ fontSize: 22 }}>Editor</div>
            <div className="page-sub">Trim, crop, shapes, arrows, text — timed keyframes · exports with FFmpeg</div>
          </div>
        </div>
        <div className="card ed-empty">
          <span className="icon-btn lg" style={{ background: "var(--accent-dim)", color: "var(--accent)", borderRadius: 99 }}>
            <Icon name="scissors" size={26} />
          </span>
          <div style={{ fontSize: 15.5, fontWeight: 600, marginTop: 10 }}>Start a new edit</div>
          <div style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 4, maxWidth: 420, textAlign: "center" }}>
            Open any video OMP can play — MKV, HEVC, AVI, WebM, MP4 — then trim, crop and
            annotate. Projects save as <b>.ompj</b> and reopen exactly where you left them.
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button className="btn accent" onClick={openVideo}><Icon name="film" size={15} /> Open video</button>
            <button className="btn" onClick={() => { void openProjectDialog().then((r) => { if (!r) toast("Could not open that project", "err"); }); }}>
              <Icon name="folder" size={15} /> Open .ompj project
            </button>
          </div>
        </div>
      </div>
    );
  }

  const ovlVisible = (o: Ovl) => t >= o.start - 0.02 && t <= o.end + 0.02;

  return (
    <div className="ed-root">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div className="page-title" style={{ fontSize: 22, display: "flex", alignItems: "center", gap: 8 }}>
            {p.name}
            {ed.dirty && <span className="chip" style={{ fontSize: 10, padding: "1px 8px" }}>unsaved</span>}
          </div>
          <div className="page-sub" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {p.overlays.length} overlays · trim {fmtTime(p.trim.s)}→{fmtTime(p.trim.e || dur)}{crop ? " · cropped" : ""}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={openVideo}><Icon name="film" size={15} /> New</button>
        <button className="btn" onClick={() => { void openProjectDialog(); }}><Icon name="folder" size={15} /> Open</button>
        <button className="btn" onClick={() => { void saveProjectAs(p).then((r) => { if (r) { markClean(); toast(`Saved ${r.split(/[\\/]/).pop()}`, "ok"); } }); }}>
          <Icon name="save" size={15} /> Save
        </button>
        <button className="btn" onClick={() => { if (undo()) setSelId(null); }} disabled={!canUndo} aria-label="Undo"><Icon name="undo" size={15} /></button>
        <button className="btn" onClick={() => { if (redo()) setSelId(null); }} disabled={!canRedo} aria-label="Redo"><Icon name="redo" size={15} /></button>
        <button className="btn accent" onClick={() => setExportOpen(true)} disabled={exp.running}><Icon name="download" size={15} /> Export</button>
      </div>

      <div className="editor-grid">
        {/* tools */}
        <div className="card ed-tools">
          {TOOLS.map((tl) => (
            <button
              key={tl.t}
              className={`ed-tool ${tool === tl.t ? "on" : ""}`}
              onClick={() => { setTool(tl.t); if (tl.t !== "select") setSelId(null); }}
            >
              <Icon name={tl.icon} /> {tl.label}
            </button>
          ))}
          <div className="side-sep" style={{ margin: "8px 4px" }} />
          <div className="prop-label">Color</div>
          <div className="swatch-row">
            {COLORS.map((c) => (
              <button key={c} className={`swatch ${(sel ? sel.color : color) === c ? "on" : ""}`}
                style={{ background: c }}
                onClick={() => { setColor(c); if (sel) patchSel({ color: c }); }}
                aria-label={`Color ${c}`} />
            ))}
          </div>
          <div className="prop-label" style={{ marginTop: 10 }}>Stroke · {sel ? sel.sw : sw}‰</div>
          <input type="range" className="slider" min={2} max={30} value={sel ? sel.sw : sw}
            style={{ ["--fill" as string]: `${(((sel ? sel.sw : sw) - 2) / 28) * 100}%` }}
            onChange={(e) => { const v = Number(e.target.value); setSw(v); if (sel) patchSel({ sw: v }); }} />
          <div className="prop-label" style={{ marginTop: 10 }}>Font · {sel ? sel.fs : fs}‰</div>
          <input type="range" className="slider" min={12} max={120} value={sel ? sel.fs : fs}
            style={{ ["--fill" as string]: `${(((sel ? sel.fs : fs) - 12) / 108) * 100}%` }}
            onChange={(e) => { const v = Number(e.target.value); setFs(v); if (sel) patchSel({ fs: v }); }} />
          <div className="side-sep" style={{ margin: "10px 4px" }} />
          {tool === "crop" && crop && (
            <button className="btn sm" onClick={resetCrop}><Icon name="close" size={13} /> Reset crop</button>
          )}
        </div>

        {/* stage */}
        <div className="ed-stage">
          <div className="ed-canvas-wrap" ref={stageRef} onClick={canvasClick}
            style={{ cursor: tool !== "select" && tool !== "crop" ? "crosshair" : "default" }}>
            {/* video box = exact mpv surface rect (or web <video> box) */}
            <div
              ref={videoBoxRef}
              className={`ed-video-box ${isMpv && hasVideo ? "mpv" : ""}`}
              style={{ left: viewBox.left, top: viewBox.top, width: viewBox.width, height: viewBox.height, position: "absolute" }}
              onPointerDown={(e) => { if (tool === "crop" && crop) onCropDown(e, "move"); }}
            >
              {!isTauri && (
                <video ref={videoRef} src={p.srcPath} playsInline style={{ width: "100%", height: "100%", borderRadius: "inherit" }} />
              )}

              {/* crop rectangle — drawn over the FULL frame view (crop mode) */}
              {tool === "crop" && crop && (
                <div
                  className="ed-crop-box"
                  style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
                  onPointerDown={(e) => onCropDown(e, "move")}
                >
                  <span className="ed-crop-dim top" />
                  <span className="ed-crop-dim bottom" />
                  <span className="ed-crop-dim left" />
                  <span className="ed-crop-dim right" />
                  {(["nw", "ne", "sw", "se"] as const).map((part) => (
                    <span key={part} className={`ed-crop-handle ${part}`} onPointerDown={(e) => onCropDown(e, part)} />
                  ))}
                </div>
              )}

              {/* annotations */}
              {p.overlays.map((o) => {
                if (!ovlVisible(o) && selId !== o.id) return null;
                const v = mapToView(o);
                const unit = viewBox.height || 1; // per-mille → px at preview scale
                return (
                  <div
                    key={o.id}
                    className={`ed-overlay-item ${selId === o.id ? "sel" : ""}`}
                    style={{
                      left: `${v.left * 100}%`, top: `${v.top * 100}%`,
                      width: `${v.w * 100}%`, height: `${v.h * 100}%`,
                      borderColor: o.color,
                      borderStyle: selId === o.id ? "solid" : o.type === "text" ? "none" : "dashed",
                      borderRadius: o.type === "circle" ? "50%" : 4,
                      fontSize: (o.fs * unit) / 1000,
                      color: o.color,
                      fontWeight: 600,
                      cursor: tool === "select" ? "move" : "default",
                      opacity: ovlVisible(o) ? 1 : 0.45,
                    }}
                    onPointerDown={(e) => onOvlDown(e, o)}
                    onDoubleClick={(e) => { e.stopPropagation(); if (o.type === "text") setEditingId(o.id); }}
                  >
                    {o.type === "arrow" ? (
                      <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ overflow: "visible", display: "block" }}>
                        <line x1={4} y1={96} x2={88} y2={12} stroke={o.color} strokeWidth={(o.sw * unit) / 1000 * 1.35} strokeLinecap="round" />
                        <path d="M72 14 L88 12 L86 28" stroke={o.color} strokeWidth={(o.sw * unit) / 1000 * 1.35} strokeLinecap="round" fill="none" />
                      </svg>
                    ) : o.type === "text" ? (
                      editingId === o.id ? (
                        <input
                          autoFocus defaultValue={o.text}
                          onBlur={(e) => { patchSel({ text: e.target.value || "Text" }); setEditingId(null); }}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          style={{ width: "100%", background: "none", border: "none", outline: "none", color: o.color, font: "inherit", userSelect: "text" }}
                        />
                      ) : (
                        <span style={{ whiteSpace: "nowrap" }}>{o.text}</span>
                      )
                    ) : null}
                    {selId === o.id && tool === "select" && (
                      <span className="ed-resize" onPointerDown={(e) => onOvlResizeDown(e, o)} aria-label="Resize" />
                    )}
                  </div>
                );
              })}
            </div>

            {/* time chip */}
            <div style={{ position: "absolute", top: 10, left: 10, pointerEvents: "none" }}>
              <span className="chip" style={{ background: "rgba(0,0,0,0.45)", color: "#fff", borderColor: "rgba(255,255,255,0.2)" }}>
                {fmtTime(t)} {dur ? `· ${fmtTime(dur)}` : ""}
              </span>
            </div>
          </div>

          {/* transport + timeline */}
          <div className="ed-timeline">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <button className="icon-btn" onClick={togglePlay} aria-label="Play/Pause">
                <Icon name={playing ? "pause" : "play"} />
              </button>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>Trim</span>
              <span className="chip kf-chip">{fmtTime(p.trim.s)}</span>
              <span style={{ color: "var(--text-3)" }}>→</span>
              <span className="chip kf-chip">{fmtTime(p.trim.e || dur)}</span>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => mutate((pp) => ({ ...pp, trim: { s: 0, e: dur } }), false)}>Reset</button>
            </div>
            <div className="trim-track" ref={trimTrackRef}
              onPointerDown={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                seekTo(((e.clientX - r.left) / r.width) * (dur || 0));
              }}>
              <div className="trim-canvas">{Array.from({ length: 44 }, (_, i) => <i key={i} style={{ opacity: 0.22 + ((i * 7) % 10) / 14 }} />)}</div>
              <div
                className="trim-sel"
                style={{ left: `${dur ? (p.trim.s / dur) * 100 : 0}%`, width: `${dur ? ((p.trim.e - p.trim.s) / dur) * 100 : 100}%` }}
                onPointerDown={(e) => { e.stopPropagation(); trimRef.current = { part: "body", sx: e.clientX, os: p.trim.s, oe: p.trim.e }; }}
              >
                <div className="trim-handle left" onPointerDown={(e) => { e.stopPropagation(); trimRef.current = { part: "l", sx: e.clientX, os: p.trim.s, oe: p.trim.e }; }} />
                <div className="trim-handle right" onPointerDown={(e) => { e.stopPropagation(); trimRef.current = { part: "r", sx: e.clientX, os: p.trim.s, oe: p.trim.e }; }} />
              </div>
              <div className="ed-playhead" style={{ left: `${dur ? Math.min(100, (t / dur) * 100) : 0}%` }} />
            </div>
            {/* overlay timing lane — the keyframe track */}
            <div className="ed-lane">
              {p.overlays.map((o) => (
                <button key={o.id}
                  className={`ed-lane-seg ${selId === o.id ? "on" : ""}`}
                  style={{
                    left: `${dur ? (o.start / dur) * 100 : 0}%`,
                    width: `${dur ? Math.max(1.2, ((o.end - o.start) / dur) * 100) : 0}%`,
                    background: o.color,
                  }}
                  onClick={() => setSelId(o.id)}
                  title={`${o.type} ${fmtTime(o.start)}→${fmtTime(o.end)}`}
                />
              ))}
              {p.overlays.length === 0 && (
                <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>Overlay timing lane — annotations appear on this span</span>
              )}
            </div>
          </div>
        </div>

        {/* properties */}
        <div className="card ed-props">
          <div>
            <div className="prop-label">{sel ? `Selected · ${sel.type}` : "Defaults for new overlays"}</div>
            {sel ? (
              <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.7 }}>
                visible {fmtTime(sel.start)} → {fmtTime(sel.end)}
              </div>
            ) : null}
          </div>
          {sel && (
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn sm" style={{ flex: 1 }} onClick={() => patchSel({ start: Math.min(t, sel.end - 0.1) })}>
                <Icon name="clock" size={12} /> In @{fmtTime(t)}
              </button>
              <button className="btn sm" style={{ flex: 1 }} onClick={() => patchSel({ end: Math.max(t, sel.start + 0.1) })}>
                <Icon name="clock" size={12} /> Out @{fmtTime(t)}
              </button>
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm" style={{ flex: 1 }} disabled={!sel} onClick={duplicateSel}>
              <Icon name="plus" size={13} /> Duplicate
            </button>
            <button className="btn sm danger" style={{ flex: 1 }} disabled={!sel} onClick={deleteSel}>
              <Icon name="trash" size={13} /> Delete
            </button>
          </div>
          <div className="side-sep" style={{ margin: 0 }} />
          <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.8 }}>
            <b style={{ color: "var(--text)" }}>Project</b><br />
            {dur ? `${dims ? `${dims.w}×${dims.h}` : "…"} · ${fmtTime(dur)}` : "reading media…"}<br />
            Saves as .ompj · Ctrl+Z undo · Space play
          </div>
        </div>
      </div>

      {/* export modal */}
      {exportOpen && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && !exp.running && setExportOpen(false)}>
          <div className="modal">
            <div className="modal-head">
              <div className="modal-title">Export video</div>
              <button className="icon-btn" onClick={() => !exp.running && setExportOpen(false)} aria-label="Close"><Icon name="close" /></button>
            </div>
            <div className="modal-body">
              {exp.running ? (
                <div style={{ textAlign: "center", padding: "18px 0" }}>
                  <div style={{ fontSize: 13, marginBottom: 10 }}>
                    Rendering with FFmpeg… {exp.pct.toFixed(0)}%
                  </div>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${exp.pct}%` }} /></div>
                  <button className="btn danger sm" style={{ marginTop: 14 }} onClick={() => void cancelExport()}>Cancel</button>
                </div>
              ) : exp.out ? (
                <div style={{ textAlign: "center", padding: "18px 0" }}>
                  <span className="icon-btn lg" style={{ background: "var(--accent-dim)", color: "var(--accent)", borderRadius: 99 }}>
                    <Icon name="check" size={22} />
                  </span>
                  <div style={{ fontSize: 13.5, fontWeight: 600, marginTop: 10 }}>Export complete</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 4, wordBreak: "break-all" }}>{exp.out}</div>
                  <button className="btn sm" style={{ marginTop: 12 }} onClick={() => void invoke("library_reveal", { path: exp.out })}>
                    <Icon name="folder" size={13} /> Show in Explorer
                  </button>
                </div>
              ) : (
                <>
                  {exp.error && exp.error !== "cancelled" && (
                    <div className="note warn" style={{ marginBottom: 12, fontSize: 12.5 }}>Export failed: {exp.error}</div>
                  )}
                  {exp.error === "cancelled" && (
                    <div className="note" style={{ marginBottom: 12, fontSize: 12.5 }}>Export cancelled.</div>
                  )}
                  {ffMpeg && !ffMpeg.found && (
                    <div className="note warn" style={{ marginBottom: 12, fontSize: 12.5 }}>
                      FFmpeg was not found next to OMP — this build cannot export. Reinstall from the latest release.
                    </div>
                  )}
                  <div className="prop-label">Format</div>
                  <div className="seg" style={{ marginBottom: 14 }}>
                    {(["mp4", "webm", "gif"] as const).map((f) => (
                      <button key={f} className={format === f ? "on" : ""} onClick={() => setFormat(f)}>
                        {f === "mp4" ? "MP4 · H.264" : f === "webm" ? "WebM · VP9" : "GIF"}
                      </button>
                    ))}
                  </div>
                  {format !== "gif" && (
                    <>
                      <div className="prop-label">Quality</div>
                      <div className="seg" style={{ marginBottom: 14 }}>
                        {(["high", "medium", "low"] as const).map((q) => (
                          <button key={q} className={quality === q ? "on" : ""} onClick={() => setQuality(q)}>
                            {q[0].toUpperCase() + q.slice(1)}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.7 }}>
                    Window {fmtTime(p.trim.s)} → {fmtTime(p.trim.e || dur)}
                    {crop ? " · crop applied" : ""}
                    {p.overlays.length ? ` · ${p.overlays.filter((o) => o.end > p.trim.s && o.start < p.trim.e).length} overlays burned in` : ""}
                  </div>
                </>
              )}
            </div>
            {!exp.running && !exp.out && (
              <div className="modal-foot">
                <button className="btn" onClick={() => setExportOpen(false)}>Close</button>
                <button className="btn accent" disabled={!!ffMpeg && !ffMpeg.found} onClick={() => void runExport()}>
                  <Icon name="download" size={15} /> Start export
                </button>
              </div>
            )}
            {!exp.running && exp.out && (
              <div className="modal-foot">
                <button className="btn accent" onClick={() => { setExportOpen(false); exportStore.reset(); }}>Done</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
