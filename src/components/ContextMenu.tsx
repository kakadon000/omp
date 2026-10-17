import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icon";

// Global right-click menu system.
// Any screen can call openContextMenu(x, y, items, title?) — the single
// ContextMenuHost (mounted once in App) renders it.

export type CtxItem =
  | { sep: true }
  | {
      sep?: false;
      label: string;
      icon?: string;
      hint?: string;
      checked?: boolean;
      disabled?: boolean;
      danger?: boolean;
      sub?: CtxItem[];
      onClick?: () => void;
    };

type OpenState = { x: number; y: number; items: CtxItem[]; title?: string; id: number } | null;

let state: OpenState = null;
const subs = new Set<() => void>();
let openId = 0;

function emit() {
  subs.forEach((f) => f());
}

export function closeContextMenu() {
  if (state) {
    state = null;
    emit();
  }
}

export function openContextMenu(x: number, y: number, items: CtxItem[], title?: string) {
  openId += 1;
  state = { x, y, items, title, id: openId };
  emit();
}

export function useContextMenuOpen() {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
    () => state
  );
}

type CtxRowItem = { item: Extract<CtxItem, { sep?: false }> };

export function ContextMenuHost() {
  const open = useContextMenuOpen();
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // clamp to viewport once rendered (measure the menu itself, not the layer)
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      x: Math.max(8, Math.min(open.x, vw - r.width - 8)),
      y: Math.max(8, Math.min(open.y, vh - r.height - 8)),
    });
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const close = () => closeContextMenu();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeContextMenu();
      }
    };
    // capture-phase listeners so we close before anything else reacts
    window.addEventListener("pointerdown", onWinDown, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("resize", close, true);
    window.addEventListener("blur", close, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onWinDown, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("resize", close, true);
      window.removeEventListener("blur", close, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open?.id]);

  // clicking outside the menu closes it (but a click on a menu item runs first)
  function onWinDown(e: PointerEvent) {
    const el = menuRef.current;
    if (el && !el.contains(e.target as Node)) closeContextMenu();
  }

  if (!open) return null;

  return (
    <div className="ctx-layer">
      <div
        className="ctx-menu"
        ref={menuRef}
        style={{ left: pos.x, top: pos.y }}
        role="menu"
        onContextMenu={(e) => e.preventDefault()}
      >
        {open.title && <div className="ctx-title">{open.title}</div>}
        {open.items.map((it, i) =>
          "sep" in it && it.sep ? (
            <div key={i} className="ctx-sep" />
          ) : (
            <CtxRow key={i} item={it as Extract<CtxItem, { sep?: false }>} />
          )
        )}
      </div>
    </div>
  );
}

function CtxRow({ item }: { item: Extract<CtxItem, { sep?: false }> }) {
  const [subOpen, setSubOpen] = useState(false);
  if (item.disabled) {
    return (
      <button className="ctx-item disabled" disabled>
        <span className="ctx-ico">{item.icon ? <Icon name={item.icon} size={15} /> : null}</span>
        <span className="grow">{item.label}</span>
        {item.hint && <span className="ctx-hint">{item.hint}</span>}
      </button>
    );
  }
  return (
    <div
      className="ctx-wrap"
      onMouseEnter={() => setSubOpen(true)}
      onMouseLeave={() => setSubOpen(false)}
    >
      <button
        className={`ctx-item ${item.danger ? "danger" : ""}`}
        onClick={() => {
          if (item.sub) return;
          closeContextMenu();
          item.onClick?.();
        }}
        onMouseEnter={() => {
          if (!item.sub) setSubOpen(false);
        }}
        role="menuitem"
      >
        <span className="ctx-ico">
          {item.checked ? <Icon name="check" size={14} /> : item.icon ? <Icon name={item.icon} size={15} /> : null}
        </span>
        <span className="grow">{item.label}</span>
        {item.hint && <span className="ctx-hint">{item.hint}</span>}
        {item.sub && <Icon name="chevronR" size={13} />}
      </button>
      {item.sub && subOpen && (
        <div className="ctx-menu sub" role="menu">
          {item.sub.map((s, i) =>
            "sep" in s && s.sep ? (
              <div key={i} className="ctx-sep" />
            ) : (
              <CtxRow key={i} item={s as Extract<CtxItem, { sep?: false }>} />
            )
          )}
        </div>
      )}
    </div>
  );
}
