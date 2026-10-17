import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";

type Tool = "select" | "crop" | "rect" | "circle" | "arrow" | "text";
type Ovl = {
  id: string; type: "rect" | "circle" | "arrow" | "text";
  x: number; y: number; w: number; h: number;
  color: string; sw: number; fs: number; text?: string;
};

const COLORS = ["#ffffff", "#0b0d12", "#4cc2ff", "#45d0c8", "#b6a6ff", "#ffc76b", "#ff7a78", "#6fd598"];

const TOOLS: { t: Tool; icon: string; label: string }[] = [
  { t: "select", icon: "square", label: "Select" },
  { t: "crop", icon: "crop", label: "Crop" },
  { t: "rect", icon: "square", label: "Rectangle" },
  { t: "circle", icon: "circle", label: "Circle" },
  { t: "arrow", icon: "arrow", label: "Arrow" },
  { t: "text", icon: "type", label: "Text" },
];

const DEMO_LEN = 12; // seconds

export function Editor() {
  const [tool, setTool] = useState<Tool>("select");
  const [ovls, setOvls] = useState<Ovl[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [undoStack, setUndo] = useState<Ovl[][]>([]);
  const [redoStack, setRedo] = useState<Ovl[][]>([]);
  const [color, setColor] = useState(COLORS[2]);
  const [sw, setSw] = useState(2);
  const [fs, setFs] = useState(18);
  const [trim, setTrim] = useState({ s: 8, e: 74 });
  const [kfs, setKfs] = useState<number[]>([24, 52]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [expProg, setExpProg] = useState<number | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const trimRef = useRef<{ part: "l" | "r" | "body"; sx: number; os: number; oe: number } | null>(null);

  const sel = ovls.find((o) => o.id === selId) || null;

  const snapshot = (cur: Ovl[]) => {
    setUndo((u) => [...u.slice(-29), cur]);
    setRedo([]);
  };

  const addOvl = (type: Ovl["type"], x: number, y: number) => {
    snapshot(ovls);
    const o: Ovl = {
      id: `o${Date.now()}`, type,
      x, y,
      w: type === "circle" ? 16 : 26,
      h: type === "circle" ? 16 : type === "arrow" ? 18 : type === "text" ? 6 : 16,
      color, sw, fs, text: type === "text" ? "Double-click to edit" : undefined,
    };
    setOvls((cur) => [...cur, o]);
    setSelId(o.id);
  };

  const canvasClick = (e: React.MouseEvent) => {
    if (tool === "select" || tool === "crop") return;
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    addOvl(tool, Math.min(88, x - 4), Math.min(88, y - 3));
  };

  // overlay dragging
  const onOvlDown = (e: React.PointerEvent, o: Ovl) => {
    if (tool !== "select") return;
    e.stopPropagation();
    setSelId(o.id);
    dragRef.current = { id: o.id, sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y };
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      const r = canvasRef.current?.getBoundingClientRect();
      if (!d || !r) return;
      const dx = ((e.clientX - d.sx) / r.width) * 100;
      const dy = ((e.clientY - d.sy) / r.height) * 100;
      setOvls((cur) =>
        cur.map((o) =>
          o.id === d.id
            ? { ...o, x: Math.max(-2, Math.min(98, d.ox + dx)), y: Math.max(-2, Math.min(96, d.oy + dy)) }
            : o
        )
      );
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  // trim dragging
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = trimRef.current;
      if (!d) return;
      const dx = (e.clientX - d.sx) / 5; // % per px over ~500px track
      if (d.part === "l") setTrim((t) => ({ ...t, s: Math.max(0, Math.min(d.oe - 4, d.os + dx)) }));
      else if (d.part === "r") setTrim((t) => ({ ...t, e: Math.min(100, Math.max(d.os + 4, d.oe + dx)) }));
      else {
        const span = d.oe - d.os;
        const ns = Math.max(0, Math.min(100 - span, d.os + dx));
        setTrim({ s: ns, e: ns + span });
      }
    };
    const up = () => { trimRef.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  const undo = () => {
    setUndo((u) => {
      if (!u.length) return u;
      setRedo((r) => [...r, ovls]);
      setOvls(u[u.length - 1]);
      return u.slice(0, -1);
    });
    setSelId(null);
  };
  const redo = () => {
    setRedo((r) => {
      if (!r.length) return r;
      setUndo((u) => [...u, ovls]);
      setOvls(r[r.length - 1]);
      return r.slice(0, -1);
    });
    setSelId(null);
  };

  const patchSel = (patch: Partial<Ovl>) => {
    if (!sel) return;
    setOvls((cur) => cur.map((o) => (o.id === sel.id ? { ...o, ...patch } : o)));
  };

  const deleteSel = () => {
    if (!sel) return;
    snapshot(ovls);
    setOvls((cur) => cur.filter((o) => o.id !== sel.id));
    setSelId(null);
  };

  const runExport = () => {
    setExpProg(0);
    const iv = window.setInterval(() => {
      setExpProg((p) => {
        if (p === null) return null;
        if (p >= 100) {
          window.clearInterval(iv);
          setTimeout(() => {
            setExportOpen(false);
            setExpProg(null);
            toast("Exported to Videos\\OMP · demo render (FFmpeg export lands in Phase 4)", "ok");
          }, 500);
          return 100;
        }
        return p + 4;
      });
    }, 80);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div>
          <div className="page-title" style={{ fontSize: 22 }}>Editor</div>
          <div className="page-sub">Lightweight edits · trim, shapes, text, keyframes — projects save as .ompj</div>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={undo} disabled={!undoStack.length} aria-label="Undo"><Icon name="undo" size={15} /> Undo</button>
        <button className="btn" onClick={redo} disabled={!redoStack.length} aria-label="Redo"><Icon name="redo" size={15} /> Redo</button>
        <button className="btn accent" onClick={() => setExportOpen(true)}><Icon name="download" size={15} /> Export</button>
      </div>

      <div className="editor-grid">
        {/* tools */}
        <div className="card ed-tools">
          {TOOLS.map((t) => (
            <button
              key={t.t}
              className={`ed-tool ${tool === t.t ? "on" : ""}`}
              onClick={() => { setTool(t.t); if (t.t !== "select") setSelId(null); }}
            >
              <Icon name={t.icon} /> {t.label}
            </button>
          ))}
          <div className="side-sep" style={{ margin: "8px 4px" }} />
          <button className={`ed-tool`} onClick={() => toast("Framing presets (16:9, 1:1, 4:5) arrive with Phase 4", "info")}>
            <Icon name="film" /> Framing
          </button>
        </div>

        {/* stage */}
        <div className="ed-stage">
          <div
            className="ed-canvas-wrap"
            onClick={canvasClick}
            style={{ cursor: tool !== "select" && tool !== "crop" ? "crosshair" : "default" }}
          >
            <div className="ed-canvas" ref={canvasRef} style={{ position: "relative" }}>
              <img src="./gallery/shot-3.jpg" alt="Frame" draggable={false} />
              <div style={{ position: "absolute", top: 10, left: 10 }}>
                <span className="chip" style={{ background: "rgba(0,0,0,0.45)", color: "#fff", borderColor: "rgba(255,255,255,0.2)" }}>
                  Frame 00:00:03.2 · 00:12.0 total
                </span>
              </div>
              {tool === "crop" && (
                <div style={{ position: "absolute", inset: "12% 18%", border: `2px dashed ${color}`, borderRadius: 4, pointerEvents: "none" }}>
                  <span style={{ position: "absolute", top: -24, left: 0, fontSize: 11, color: "var(--accent)" }}>Crop region — drag handles in Phase 4</span>
                </div>
              )}
              {ovls.map((o) => (
                <div
                  key={o.id}
                  className={`ed-overlay-item ${selId === o.id ? "sel" : ""}`}
                  style={{
                    left: `${o.x}%`, top: `${o.y}%`, width: `${o.w}%`, height: `${o.h}%`,
                    borderColor: o.color, borderStyle: selId === o.id ? "solid" : o.type === "text" ? "none" : "dashed",
                    borderRadius: o.type === "circle" ? "50%" : 4,
                    fontSize: o.fs,
                    color: o.color,
                    fontWeight: 600,
                    cursor: tool === "select" ? "move" : "default",
                  }}
                  onPointerDown={(e) => onOvlDown(e, o)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (o.type === "text") setEditingId(o.id);
                  }}
                  onClick={(e) => { if (tool === "select") { e.stopPropagation(); setSelId(o.id); } }}
                >
                  {o.type === "arrow" ? (
                    <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ overflow: "visible" }}>
                      <line x1="4" y1="96" x2="88" y2="12" stroke={o.color} strokeWidth={o.sw * 1.2} strokeLinecap="round" />
                      <path d="M88 12 l-16 2 M88 12 l-2 16" stroke={o.color} strokeWidth={o.sw * 1.2} strokeLinecap="round" fill="none" transform="rotate(0 88 12)" />
                    </svg>
                  ) : o.type === "text" ? (
                    editingId === o.id ? (
                      <input
                        autoFocus
                        defaultValue={o.text}
                        onBlur={(e) => { patchSel({ text: e.target.value || "Text" }); setEditingId(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        style={{ width: "100%", height: "100%", background: "none", border: "none", outline: "none", color: o.color, font: "inherit", userSelect: "text" }}
                      />
                    ) : (
                      <span style={{ whiteSpace: "nowrap" }}>{o.text}</span>
                    )
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          {/* timeline */}
          <div className="ed-timeline">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>Trim</span>
              <span className="chip kf-chip">{((trim.s / 100) * DEMO_LEN).toFixed(1)}s</span>
              <span style={{ color: "var(--text-3)" }}>→</span>
              <span className="chip kf-chip">{((trim.e / 100) * DEMO_LEN).toFixed(1)}s</span>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => setTrim({ s: 0, e: 100 })}>Reset</button>
            </div>
            <div className="trim-track">
              <div className="trim-canvas">{Array.from({ length: 40 }, (_, i) => <i key={i} style={{ opacity: 0.25 + ((i * 7) % 10) / 13 }} />)}</div>
              <div
                className="trim-sel"
                style={{ left: `${trim.s}%`, width: `${trim.e - trim.s}%` }}
                onPointerDown={(e) => { trimRef.current = { part: "body", sx: e.clientX, os: trim.s, oe: trim.e }; }}
              >
                <div className="trim-handle left" onPointerDown={(e) => { e.stopPropagation(); trimRef.current = { part: "l", sx: e.clientX, os: trim.s, oe: trim.e }; }} />
                <div className="trim-handle right" onPointerDown={(e) => { e.stopPropagation(); trimRef.current = { part: "r", sx: e.clientX, os: trim.s, oe: trim.e }; }} />
              </div>
            </div>
            <div className="keyframes-row">
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>Keyframes</span>
              <button className="btn sm" onClick={() => {
                const mid = Math.round((trim.s + trim.e) / 2);
                setKfs((k) => [...k, mid].sort((a, b) => a - b));
                toast(`Keyframe at ${((mid / 100) * DEMO_LEN).toFixed(1)}s`, "ok");
              }}>
                <Icon name="plus" size={13} /> Add at playhead
              </button>
              {kfs.map((k) => (
                <span key={`${k}-${kfs.indexOf(k)}`} className="chip kf-chip">
                  {((k / 100) * DEMO_LEN).toFixed(1)}s
                  <button
                    style={{ display: "inline-flex", color: "inherit" }}
                    onClick={() => setKfs((cur) => cur.filter((x, i) => !(x === k && i === kfs.indexOf(k))))}
                    aria-label="Remove keyframe"
                  >
                    <Icon name="close" size={11} />
                  </button>
                </span>
              ))}
              {kfs.length === 0 && <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>No keyframes yet</span>}
            </div>
          </div>
        </div>

        {/* properties */}
        <div className="card ed-props">
          <div>
            <div className="prop-label">{sel ? `Selected · ${sel.type}` : "Default properties"}</div>
            <div className="swatch-row">
              {COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch ${(sel ? sel.color : color) === c ? "on" : ""}`}
                  style={{ background: c }}
                  onClick={() => { if (sel) patchSel({ color: c }); else setColor(c); }}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>
          <div>
            <div className="prop-label">Stroke width · {sel ? sel.sw : sw}px</div>
            <input type="range" className="slider" min={1} max={10} value={sel ? sel.sw : sw}
              style={{ ["--fill" as string]: `${((sel ? sel.sw : sw) / 10) * 100}%` }}
              onChange={(e) => { const v = Number(e.target.value); if (sel) patchSel({ sw: v }); else setSw(v); }} />
          </div>
          {sel?.type === "text" && (
            <div>
              <div className="prop-label">Font size · {sel.fs}px</div>
              <input type="range" className="slider" min={10} max={48} value={sel.fs}
                style={{ ["--fill" as string]: `${((sel.fs - 10) / 38) * 100}%` }}
                onChange={(e) => patchSel({ fs: Number(e.target.value) })} />
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm" style={{ flex: 1 }} disabled={!sel}
              onClick={() => { if (sel) { snapshot(ovls); const c = { ...sel, id: `o${Date.now()}`, x: sel.x + 4, y: sel.y + 4 }; setOvls((cur) => [...cur, c]); setSelId(c.id); } }}>
              <Icon name="plus" size={13} /> Duplicate
            </button>
            <button className="btn sm danger" style={{ flex: 1 }} disabled={!sel} onClick={deleteSel}>
              <Icon name="trash" size={13} /> Delete
            </button>
          </div>
          <div className="side-sep" style={{ margin: 0 }} />
          <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.8 }}>
            <b style={{ color: "var(--text)" }}>Project</b><br />
            Untitled.ompj — auto-saves locally. Editable keyframe projects land fully in Phase 4.
          </div>
        </div>
      </div>

      {/* export modal */}
      {exportOpen && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && expProg === null && setExportOpen(false)}>
          <div className="modal">
            <div className="modal-head">
              <div className="modal-title">Export video</div>
              <button className="icon-btn" onClick={() => expProg === null && setExportOpen(false)} aria-label="Close"><Icon name="close" /></button>
            </div>
            <div className="modal-body">
              {expProg === null ? (
                <>
                  <div className="prop-label">Format</div>
                  <div className="seg" style={{ marginBottom: 14 }}>
                    <button className="on">MP4 · H.264</button>
                    <button onClick={() => toast("WebM export arrives with Phase 4", "info")}>WebM</button>
                  </div>
                  <div className="prop-label">Quality</div>
                  <div className="seg" style={{ marginBottom: 14 }}>
                    <button className="on">High</button>
                    <button onClick={() => toast("Quality presets arrive with Phase 4", "info")}>Medium</button>
                    <button onClick={() => toast("Quality presets arrive with Phase 4", "info")}>Low</button>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input type="checkbox" defaultChecked id="ovl-in" style={{ accentColor: "var(--accent)" }} />
                    <label htmlFor="ovl-in" style={{ fontSize: 13 }}>Burn in overlays ({ovls.length})</label>
                  </div>
                </>
              ) : (
                <div style={{ textAlign: "center", padding: "18px 0" }}>
                  {expProg < 100 ? (
                    <>
                      <div className="spinner" style={{ margin: "0 auto 14px" }} />
                      <div style={{ fontSize: 13, marginBottom: 10 }}>Rendering with FFmpeg… {expProg}%</div>
                      <div className="bar-track"><div className="bar-fill" style={{ width: `${expProg}%` }} /></div>
                    </>
                  ) : (
                    <>
                      <span className="icon-btn lg" style={{ background: "var(--accent-dim)", color: "var(--accent)", borderRadius: 99 }}>
                        <Icon name="check" size={22} />
                      </span>
                      <div style={{ fontSize: 13.5, fontWeight: 600, marginTop: 10 }}>Export complete</div>
                    </>
                  )}
                </div>
              )}
            </div>
            {expProg === null && (
              <div className="modal-foot">
                <button className="btn" onClick={() => setExportOpen(false)}>Cancel</button>
                <button className="btn accent" onClick={runExport}><Icon name="download" size={15} /> Start export</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
