import { useEffect } from "react";
import { Icon } from "./Icon";

export type ShortcutGroup = {
  title: string;
  keys: { k: string; d: string }[];
};

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Playback",
    keys: [
      { k: "Space K", d: "Play / pause" },
      { k: "S", d: "Stop" },
      { k: "N P", d: "Next / previous in queue" },
      { k: "[ ]", d: "Slower / faster (0.25×)" },
      { k: "Backspace", d: "Reset speed to 1×" },
      { k: ", .", d: "Frame step back / forward" },
    ],
  },
  {
    title: "Seeking",
    keys: [
      { k: "← →", d: "Seek (settings step)" },
      { k: "Shift+← →", d: "Fine seek ±3s" },
      { k: "Ctrl+← →", d: "Long seek ±60s" },
      { k: "J L", d: "Back / forward 10s" },
      { k: "0–9", d: "Jump to 0–90%" },
      { k: "Home End", d: "Start / end" },
      { k: "Ctrl+G", d: "Jump to time…" },
    ],
  },
  {
    title: "Volume",
    keys: [
      { k: "↑ ↓", d: "Volume up / down" },
      { k: "M", d: "Mute" },
      { k: "Slider", d: "Boost up to 200%" },
    ],
  },
  {
    title: "Video",
    keys: [
      { k: "F", d: "Fullscreen (Esc exits)" },
      { k: "A", d: "Cycle aspect ratio" },
      { k: "+ − *", d: "Zoom in / out / reset" },
      { k: "Z", d: "Rotate 90°" },
      { k: "Shift+Z", d: "Reset zoom + rotation" },
      { k: "T", d: "Take snapshot" },
    ],
  },
  {
    title: "Audio & subtitles",
    keys: [
      { k: "C", d: "Subtitles on / off" },
      { k: "G H", d: "Subtitle delay −/+ 0.5s" },
      { k: "Alt+J K", d: "Audio delay −/+ 0.5s" },
    ],
  },
  {
    title: "Loop & queue",
    keys: [
      { k: "B", d: "A-B loop: set A → B → off" },
      { k: "Shift+L", d: "Loop: off → all → one" },
      { k: "R", d: "Shuffle" },
      { k: "Q", d: "Show / hide queue" },
    ],
  },
  {
    title: "Interface",
    keys: [
      { k: "I", d: "Stats for nerds" },
      { k: "?", d: "This shortcut map" },
      { k: "Esc", d: "Close menus & dialogs" },
      { k: "Right-click", d: "Context menu everywhere" },
    ],
  },
  {
    title: "App-wide",
    keys: [
      { k: "Ctrl+K", d: "Focus search" },
      { k: "Alt+1…0", d: "Home → Settings screens" },
      { k: "Ctrl+O", d: "Open media file (player)" },
    ],
  },
];

// The "?" overlay — full keyboard map. App renders it app-wide so help is
// available on every screen. Esc / backdrop click close it.
export function ShortcutsModal({ groups, onClose }: { groups: ShortcutGroup[]; onClose: () => void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide keys-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="modal-head">
          <div className="modal-title">
            <Icon name="list" size={18} /> Keyboard shortcuts
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body keys-grid">
          {groups.map((g) => (
            <div key={g.title} className="keys-group">
              <div className="keys-gtitle">{g.title}</div>
              {g.keys.map((r) => (
                <div key={r.k + r.d} className="keys-row">
                  <span className="keys-kbd">
                    {r.k.split(" ").map((piece, i) => (
                      <span key={i} className="kbd">{piece}</span>
                    ))}
                  </span>
                  <span className="keys-desc">{r.d}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <span className="keys-note">Shortcuts work everywhere — even in fullscreen. Press <span className="kbd">?</span> anytime.</span>
          <button className="btn accent" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}
