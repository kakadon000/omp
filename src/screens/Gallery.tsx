import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { openContextMenu } from "../components/ContextMenu";
import { IMAGES } from "../lib/data";
import { pushHistory, externalImage } from "../lib/store";
import { openImageFiles } from "../lib/tauri";
import {
  listItems, fileSrc, removeItem, revealFile, type MediaItem,
} from "../lib/library";
import { isTauri, invoke } from "../lib/tauri";
import { fmtSize } from "../lib/format";
import { navigate } from "../lib/router";

type GalItem = {
  id: string;
  name: string;
  src: string;
  w: number;
  h: number;
  size: string;
  folder: string;
  libId?: number;
  path?: string;
};

export function Gallery({ query }: { query: string }) {
  const [extra, setExtra] = useState<{ id: string; name: string; src: string }[]>([]);
  const [folder, setFolder] = useState("All");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);

  /* ---- v0.6.1: REAL scanned images from the SQLite library ---- */
  const [libImages, setLibImages] = useState<MediaItem[] | null>(null);
  useEffect(() => {
    if (!isTauri) return;
    let dead = false;
    void listItems(query, "image", "added").then((r) => { if (!dead) setLibImages(r ?? []); });
    return () => { dead = true; };
  }, [query]);

  const ext = useSyncExternalStore(externalImage.sub, externalImage.get)?.img;

  const libItems: GalItem[] = useMemo(
    () =>
      (libImages ?? []).map((m) => ({
        id: `lib${m.id}`,
        name: m.title,
        src: fileSrc(m.path),
        w: m.width,
        h: m.height,
        size: fmtSize(m.size),
        folder: m.dir.split(/[\\/]/).filter(Boolean).pop() || m.dir || "Scanned",
        libId: m.id,
        path: m.path,
      })),
    [libImages]
  );

  const demoItems: GalItem[] = IMAGES.map((i) => ({
    id: i.id, name: i.name, src: i.src, w: i.w, h: i.h,
    size: i.size, folder: i.folder,
  }));

  const all = useMemo(() => {
    const base = isTauri ? [...libItems, ...extra.map((e) => ({ ...e, w: 0, h: 0, size: "—", folder: "Added" }))] : [...demoItems, ...extra.map((e) => ({ ...e, w: 0, h: 0, size: "—", folder: "Added" }))];
    // an image opened via "Open with OMP" floats to the top of the session
    if (isTauri && ext) {
      return [{ id: "ext0", name: ext.name, src: fileSrc(ext.path), w: 0, h: 0, size: "—", folder: "Opened just now" } as GalItem, ...base];
    }
    return base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTauri, libItems, extra, ext]);

  const folders = ["All", ...new Set(all.map((i) => i.folder))];
  const q = query.toLowerCase();
  const items = all.filter(
    (i) => (folder === "All" || i.folder === folder) && (!q || i.name.toLowerCase().includes(q))
  );

  const open = all.find((i) => i.id === openId) || null;
  const openIndex = items.findIndex((i) => i.id === openId);

  const addImages = async () => {
    const f = await openImageFiles();
    if (!f) return;
    setExtra((cur) => [...cur, { id: `x${Date.now()}`, name: f.name!, src: f.url }]);
    pushHistory({ id: `img:${f.name}`, kind: "image", name: f.name!, at: Date.now() });
    toast(`Added ${f.name}`, "ok");
  };

  const toggleSel = (id: string) => {
    setSel((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const imgMenu = (e: React.MouseEvent, img: GalItem) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      { label: "Open", icon: "image", onClick: () => setOpenId(img.id) },
      { label: sel.has(img.id) ? "Deselect" : "Select", icon: "check", onClick: () => toggleSel(img.id) },
      { sep: true },
      { label: "Copy filename", icon: "type", onClick: () => { void navigator.clipboard?.writeText(img.name); toast("Filename copied", "ok"); } },
      ...(isTauri && img.path
        ? [
            { label: "Open file location", icon: "folder", onClick: () => void revealFile(img.path!) },
            ...(img.libId
              ? [{
                  label: "Remove from library", icon: "trash", danger: true,
                  onClick: async () => {
                    if (await removeItem(img.libId!)) {
                      toast("Removed from library", "ok");
                      void listItems(query, "image", "added").then((r) => setLibImages(r ?? []));
                    }
                  },
                }]
              : []),
          ]
        : []),
    ], img.name);
  };

  const deleteSelected = () => {
    if (sel.size === 0) return;
    if (!isTauri) {
      toast("The demo gallery is read-only — run the desktop app", "info");
      setSel(new Set());
      return;
    }
    void (async () => {
      const ids = [...sel].map((s) => s.replace(/^lib/, "")).map(Number).filter(Number.isFinite);
      let ok = 0;
      for (const id of ids) if (await removeItem(id)) ok += 1;
      toast(`${ok} image${ok === 1 ? "" : "s"} removed from the library`, ok ? "ok" : "info");
      setSel(new Set());
      void listItems(query, "image", "added").then((r) => setLibImages(r ?? []));
    })();
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {folders.map((f) => (
          <button key={f} className={`chip clickable ${folder === f ? "on" : ""}`} onClick={() => setFolder(f)}>
            <Icon name="folder" /> {f}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {sel.size > 0 && (
          <button className="btn sm danger" onClick={deleteSelected}>
            <Icon name="trash" size={14} /> Delete {sel.size}
          </button>
        )}
        <button className="btn sm" onClick={addImages}>
          <Icon name="plus" size={14} /> Add images
        </button>
        <button className="btn sm accent" onClick={() => navigate("library")}>
          <Icon name="grid" size={14} /> Scan folders
        </button>
      </div>

      <div className="gal-grid">
        {items.map((img) => (
          <div
            key={img.id}
            className={`gal-item ${sel.has(img.id) ? "sel" : ""}`}
            onClick={() => setOpenId(img.id)}
            onContextMenu={(e) => imgMenu(e, img)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && setOpenId(img.id)}
          >
            <img src={img.src} alt={img.name} loading="lazy" />
            <button
              className="gal-check"
              onClick={(e) => { e.stopPropagation(); toggleSel(img.id); }}
              aria-label="Select"
            >
              <Icon name="check" size={12} />
            </button>
            <div className="gal-name">{img.name}</div>
          </div>
        ))}
      </div>

      {items.length === 0 && (
        <div className="empty">
          <Icon name="image" />
          <div className="t">{query ? "No matches" : isTauri && (libImages?.length ?? 0) === 0 ? "No images in the library yet" : "Nothing here"}</div>
          <div className="d">
            {query
              ? `No images match "${query}".`
              : isTauri && (libImages?.length ?? 0) === 0
                ? "Add a folder in the Library screen (or rescan) — every photo in your scanned folders shows up here with live previews."
                : "This folder is empty."}
          </div>
          {isTauri && (libImages?.length ?? 0) === 0 && (
            <button className="btn accent" style={{ marginTop: 12 }} onClick={() => navigate("library")}>
              <Icon name="folder" size={15} /> Open Library
            </button>
          )}
        </div>
      )}

      {open && (
        <ImageViewer
          src={open.src}
          name={open.name}
          dims={open.w ? `${open.w}×${open.h} · ${open.size}` : open.size !== "—" ? open.size : "Added this session"}
          onClose={() => setOpenId(null)}
          onPrev={() => openIndex > 0 && setOpenId(items[openIndex - 1].id)}
          onNext={() => openIndex < items.length - 1 && setOpenId(items[openIndex + 1].id)}
        />
      )}
    </div>
  );
}

function ImageViewer({ src, name, dims, onClose, onPrev, onNext }: {
  src: string; name: string; dims: string;
  onClose: () => void; onPrev: () => void; onNext: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  const [slide, setSlide] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => { setZoom(1); setRot(0); }, [src]);

  useEffect(() => {
    if (slide) {
      timer.current = window.setInterval(() => onNext(), 2600);
    }
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [slide, onNext]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") onPrev();
      if (e.key === "ArrowRight") onNext();
      if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(4, z + 0.25));
      if (e.key === "-") setZoom((z) => Math.max(0.5, z - 0.25));
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose, onPrev, onNext]);

  return (
    <div className="viewer">
      <div className="viewer-info">
        <span className="chip" style={{ background: "rgba(16,18,24,0.6)", color: "rgba(255,255,255,0.85)", borderColor: "rgba(255,255,255,0.14)" }}>
          <Icon name="image" size={12} /> {name} · {dims}
        </span>
      </div>
      <div className="viewer-stage">
        <img
          src={src}
          alt={name}
          style={{ transform: `scale(${zoom}) rotate(${rot}deg)` }}
          onWheel={(e) => {
            e.preventDefault();
            setZoom((z) => Math.min(4, Math.max(0.5, z + (e.deltaY < 0 ? 0.12 : -0.12))));
          }}
        />
      </div>
      <div className="viewer-bar">
        <button className="icon-btn" onClick={onPrev} aria-label="Previous"><Icon name="chevronL" /></button>
        <button className="icon-btn" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} aria-label="Zoom out"><Icon name="zoomOut" /></button>
        <span className="chip" style={{ fontVariantNumeric: "tabular-nums" }}>{Math.round(zoom * 100)}%</span>
        <button className="icon-btn" onClick={() => setZoom((z) => Math.min(4, z + 0.25))} aria-label="Zoom in"><Icon name="zoomIn" /></button>
        <button className="icon-btn" onClick={() => setRot((r) => r + 90)} aria-label="Rotate"><Icon name="rotate" /></button>
        <button className={`icon-btn ${slide ? "on" : ""}`} onClick={() => setSlide((s) => !s)} aria-label="Slideshow"><Icon name="slideshow" /></button>
        <button className="icon-btn" onClick={onNext} aria-label="Next"><Icon name="chevronR" /></button>
        <span style={{ width: 14 }} />
        <button className="icon-btn" onClick={() => toast("Wallpaper + crop actions arrive with Phase 2", "info")} aria-label="Set wallpaper"><Icon name="pin" /></button>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </div>
    </div>
  );
}
