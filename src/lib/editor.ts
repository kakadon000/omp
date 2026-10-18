// Phase 4 — editor project model: .ompj state, undo/redo, autosave,
// WYSIWYG overlay rendering (canvas → PNG → ffmpeg burn-in) and the
// export orchestration client (progress events from src-tauri/src/editor.rs).

import { invoke, isTauri } from "./tauri";

export type OvlType = "rect" | "circle" | "arrow" | "text";

export type Ovl = {
  id: string;
  type: OvlType;
  x: number; y: number; w: number; h: number; // 0..1 fractions of the frame
  color: string;
  sw: number; // stroke width, per-mille of frame height (resolution-independent)
  fs: number; // font size, per-mille of frame height (text only)
  text?: string;
  start: number; end: number; // seconds, project timeline (absolute)
};

export type OmpProject = {
  ompj: 1;
  name: string;
  srcPath: string; // real filesystem path (mpv) or object URL (web demo)
  dur: number; // source duration (s) — filled from the engine "loaded" event
  vw: number; vh: number; // source pixel size — from the engine as well
  trim: { s: number; e: number };
  crop: { x: number; y: number; w: number; h: number } | null;
  overlays: Ovl[];
  created: number;
  modified: number;
};

export function newProject(srcPath: string, name: string): OmpProject {
  return {
    ompj: 1, name: name.replace(/\.[^.]+$/, "") || "Project",
    srcPath, dur: 0, vw: 0, vh: 0,
    trim: { s: 0, e: 0 },
    crop: null, overlays: [],
    created: Date.now(), modified: Date.now(),
  };
}

/* ------------------------- tiny store ------------------------- */
type EdState = { project: OmpProject | null; dirty: boolean };
let st: EdState = { project: null, dirty: false };
const subs = new Set<() => void>();
function emit() { subs.forEach((f) => f()); }

export const editorStore = {
  get: () => st,
  sub(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};

/** Commit a mutation (with undo snapshot). */
export function mutate(fn: (p: OmpProject) => OmpProject | null, snap = true) {
  if (!st.project) return;
  if (snap) pushUndo(st.project);
  const next = fn(structuredClone(st.project));
  if (!next) return;
  next.modified = Date.now();
  st = { project: next, dirty: true };
  autosave();
  emit();
}

/** Replace the whole project (open/create) — no undo snapshot. */
export function setProject(p: OmpProject | null) {
  st = { project: p, dirty: false };
  undoStack = []; redoStack = [];
  if (p) autosave();
  emit();
}

/** Silent metadata update (dims/duration from the engine — not undoable). */
export function patchMeta(patch: Partial<OmpProject>) {
  if (!st.project) return;
  st = { ...st, project: { ...st.project, ...patch } };
  emit();
}

/** Clear the dirty flag after a successful save. */
export function markClean() {
  if (!st.dirty) return;
  st = { ...st, dirty: false };
  emit();
}

/* ------------------------- undo / redo ------------------------- */
let undoStack: string[] = [];
let redoStack: string[] = [];

function pushUndo(p: OmpProject) {
  undoStack.push(JSON.stringify(p));
  if (undoStack.length > 40) undoStack.shift();
  redoStack = [];
  emit();
}

export function undo(): boolean {
  const prev = undoStack.pop();
  if (!prev || !st.project) return false;
  redoStack.push(JSON.stringify(st.project));
  try {
    st = { ...st, project: JSON.parse(prev) as OmpProject, dirty: true };
    autosave();
  } catch { return false; }
  emit();
  return true;
}

export function redo(): boolean {
  const next = redoStack.pop();
  if (!next || !st.project) return false;
  undoStack.push(JSON.stringify(st.project));
  try {
    st = { ...st, project: JSON.parse(next) as OmpProject, dirty: true };
    autosave();
  } catch { return false; }
  emit();
  return true;
}

export function undoRedoState() {
  return { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
}

/* ------------------------- autosave ------------------------- */
const AS_KEY = "omp.editor.autosave";
let asTimer = 0;

function autosave() {
  window.clearTimeout(asTimer);
  asTimer = window.setTimeout(() => {
    try {
      if (st.project) localStorage.setItem(AS_KEY, JSON.stringify(st.project));
    } catch { /* quota — non-fatal */ }
  }, 400);
}

export function loadAutosave(): OmpProject | null {
  try {
    const raw = localStorage.getItem(AS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as OmpProject;
    return p?.ompj === 1 && p.srcPath ? p : null;
  } catch { return null; }
}

/* ------------------------- overlay geometry (WYSIWYG) ------------------------- */
// Arrow shaft + head as FRACTIONS of the overlay box — the exact same
// geometry the preview SVG draws (viewBox 0 0 100 100), so export == preview.
const ARROW = { sx: 0.04, sy: 0.96, ex: 0.88, ey: 0.12, h1x: 0.72, h1y: 0.14, h2x: 0.86, h2y: 0.28 };

export function drawOvl(ctx: CanvasRenderingContext2D, o: Ovl, W: number, H: number) {
  const x = o.x * W, y = o.y * H, w = o.w * W, h = o.h * H;
  const sw = Math.max(1.5, (o.sw * H) / 1000);
  ctx.save();
  ctx.strokeStyle = o.color;
  ctx.fillStyle = o.color;
  ctx.lineWidth = sw;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (o.type === "rect") {
    ctx.strokeRect(x + sw / 2, y + sw / 2, Math.max(2, w - sw), Math.max(2, h - sw));
  } else if (o.type === "circle") {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, Math.max(2, w / 2 - sw / 2), Math.max(2, h / 2 - sw / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (o.type === "arrow") {
    const lx = sw * 1.35;
    ctx.lineWidth = lx;
    ctx.beginPath();
    ctx.moveTo(x + ARROW.sx * w, y + ARROW.sy * h);
    ctx.lineTo(x + ARROW.ex * w, y + ARROW.ey * h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + ARROW.h1x * w, y + ARROW.h1y * h);
    ctx.lineTo(x + ARROW.ex * w, y + ARROW.ey * h);
    ctx.lineTo(x + ARROW.h2x * w, y + ARROW.h2y * h);
    ctx.stroke();
  } else if (o.type === "text") {
    const fs = (o.fs * H) / 1000;
    ctx.font = `600 ${fs}px Inter, "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(o.text || "Text", x + sw * 0.5, y);
  }
  ctx.restore();
}

/** Render every overlay that is visible in the trim window to a full-frame
 *  transparent PNG on disk; returns temp paths aligned with the array order. */
export async function renderOverlayPngs(p: OmpProject): Promise<string[]> {
  const W = Math.round(p.vw || 1920);
  const H = Math.round(p.vh || 1080);
  const paths: string[] = [];
  const visible = p.overlays.filter((o) => o.end > p.trim.s + 0.02 && o.start < p.trim.e - 0.02);
  for (const o of visible) {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    if (!ctx) { paths.push(""); continue; }
    drawOvl(ctx, o, W, H);
    const b64 = c.toDataURL("image/png");
    const pth = await invoke<string>("editor_write_png", { dataB64: b64 });
    paths.push(pth || "");
  }
  return paths;
}

/* ------------------------- export orchestration ------------------------- */
export type ExpState = {
  running: boolean; pct: number; elapsed: number; total: number;
  out: string | null; error: string | null; cancelled: boolean;
};
let exp: ExpState = { running: false, pct: 0, elapsed: 0, total: 0, out: null, error: null, cancelled: false };
const expSubs = new Set<() => void>();
function expEmit() { expSubs.forEach((f) => f()); }

export const exportStore = {
  get: () => exp,
  sub(f: () => void) { expSubs.add(f); return () => { expSubs.delete(f); }; },
  /** Clear the finished/failed state so the modal shows the config page. */
  reset() {
    exp = { running: false, pct: 0, elapsed: 0, total: 0, out: null, error: null, cancelled: false };
    expEmit();
  },
};

export async function startExport(
  p: OmpProject,
  outPath: string,
  format: "mp4" | "webm" | "gif",
  quality: "high" | "medium" | "low"
): Promise<boolean> {
  if (!isTauri || exp.running) return false;
  exp = { running: true, pct: 0, elapsed: 0, total: Math.max(0.1, p.trim.e - p.trim.s || p.dur), out: null, error: null, cancelled: false };
  expEmit();
  const pngs = await renderOverlayPngs(p);
  // Reorder: project.overlays must contain ONLY the burnable overlays in the
  // exact order of `pngs` (Rust zips them by index).
  const burn = p.overlays.filter((o) => o.end > p.trim.s + 0.02 && o.start < p.trim.e - 0.02);
  const payload: OmpProject = { ...structuredClone(p), overlays: burn };
  const ok = await invoke<boolean>("editor_export", {
    project: payload,
    overlays: pngs,
    outPath,
    format,
    quality,
  });
  if (ok === false) {
    exp = { ...exp, running: false, error: "Exporter busy or unavailable" };
    expEmit();
    return false;
  }
  // progress + done listeners
  const { tauriListen } = await import("./tauri");
  void tauriListen<{ pct: number; elapsed: number; total: number }>("omp://export-progress", (d) => {
    exp = { ...exp, pct: d?.pct ?? 0, elapsed: d?.elapsed ?? 0, total: d?.total ?? exp.total };
    expEmit();
  }).then((un1) => {
    void tauriListen<{ ok: boolean; out?: string; error?: string; cancelled?: boolean }>("omp://export-done", (d) => {
      exp = {
        ...exp, running: false,
        out: d?.ok ? d.out ?? null : null,
        error: d?.ok ? null : d?.cancelled ? "cancelled" : d?.error || "export failed",
        cancelled: !!d?.cancelled,
      };
      expEmit();
      un1();
    });
  });
  return true;
}

export async function cancelExport() {
  await invoke("editor_export_cancel");
}

/* ------------------------- .ompj file IO ------------------------- */

export async function saveProjectAs(p: OmpProject): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: `${p.name || "project"}.ompj`,
      filters: [{ name: "OMP Project", extensions: ["ompj"] }],
    });
    if (typeof path !== "string") return null;
    const ok = await invoke<boolean>("editor_write_project", {
      path, json: JSON.stringify(p, null, 2),
    });
    return ok ? path : null;
  } catch { return null; }
}

export async function openProjectPath(path: string): Promise<OmpProject | null> {
  const json = await invoke<string>("editor_read_project", { path });
  if (!json) return null;
  try {
    const p = JSON.parse(json) as OmpProject;
    if (p?.ompj !== 1 || !p.srcPath) return null;
    p.overlays = Array.isArray(p.overlays) ? p.overlays : [];
    setProject(p);
    return p;
  } catch { return null; }
}

export async function openProjectDialog(): Promise<OmpProject | null> {
  if (!isTauri) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      filters: [{ name: "OMP Project", extensions: ["ompj"] }],
    });
    if (typeof path !== "string") return null;
    return await openProjectPath(path);
  } catch { return null; }
}

/* ------------------------- ffmpeg availability ------------------------- */
export async function ffmpegStatus(): Promise<{ found: boolean; path: string }> {
  const r = await invoke<{ found: boolean; path: string }>("editor_ffmpeg_status");
  return r ?? { found: false, path: "" };
}
