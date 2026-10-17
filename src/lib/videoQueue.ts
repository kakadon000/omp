// Video playlist — a real, managed queue (VLC-style) instead of the static
// "Up next" list. Session-scoped; Phase 2 persists it in SQLite.
import { VIDEOS, type VideoItem } from "./data";

export type RepeatMode = "off" | "one" | "all";

type QueueState = {
  items: VideoItem[];
  index: number;
  shuffle: boolean;
  repeat: RepeatMode;
};

let state: QueueState = {
  items: VIDEOS,
  index: 0,
  shuffle: false,
  repeat: "off",
};

const subs = new Set<() => void>();
function emit() {
  subs.forEach((f) => f());
}

function setState(patch: Partial<QueueState>) {
  state = { ...state, ...patch };
  emit();
}

export const videoQueue = {
  sub(cb: () => void) {
    subs.add(cb);
    return () => subs.delete(cb);
  },
  get: () => state,
  current(): VideoItem | null {
    return state.items[state.index] ?? null;
  },
  playAt(i: number) {
    if (i < 0 || i >= state.items.length) return;
    setState({ index: i });
  },
  playId(id: string) {
    const i = state.items.findIndex((v) => v.id === id);
    if (i >= 0) setState({ index: i });
  },
  add(item: VideoItem, playNow = false) {
    const exists = state.items.findIndex((v) => v.id === item.id);
    const items = [...state.items];
    if (exists >= 0) {
      if (playNow) setState({ index: exists });
      return;
    }
    items.push(item);
    setState({ items, index: playNow ? items.length - 1 : state.index });
  },
  addNext(item: VideoItem) {
    if (state.items.some((v) => v.id === item.id)) return;
    const items = [...state.items];
    items.splice(state.index + 1, 0, item);
    setState({ items });
  },
  remove(i: number) {
    if (state.items.length <= 1) return;
    const items = state.items.filter((_, x) => x !== i);
    let index = state.index;
    if (i < state.index) index -= 1;
    else if (i === state.index) index = Math.min(index, items.length - 1);
    setState({ items, index });
  },
  move(i: number, dir: 1 | -1) {
    const j = i + dir;
    if (j < 0 || j >= state.items.length) return;
    const items = [...state.items];
    [items[i], items[j]] = [items[j], items[i]];
    let index = state.index;
    if (state.index === i) index = j;
    else if (state.index === j) index = i;
    setState({ items, index });
  },
  clearExceptCurrent() {
    const cur = state.items[state.index];
    if (!cur) return;
    setState({ items: [cur], index: 0 });
  },
  restoreDefaults() {
    setState({ items: VIDEOS, index: 0 });
  },
  next(manual: boolean): VideoItem | null {
    const { items, index, shuffle, repeat } = state;
    if (items.length === 0) return null;
    if (!manual && repeat === "one") return items[index];
    if (shuffle && items.length > 1) {
      let n = index;
      while (n === index) n = Math.floor(Math.random() * items.length);
      setState({ index: n });
      return items[n];
    }
    const n = index + 1;
    if (n >= items.length) {
      if (repeat === "all" || manual) {
        setState({ index: 0 });
        return items[0];
      }
      return null; // end of queue, no repeat
    }
    setState({ index: n });
    return items[n];
  },
  prev(): VideoItem | null {
    const { items, index } = state;
    if (items.length === 0) return null;
    const p = index - 1 < 0 ? items.length - 1 : index - 1;
    setState({ index: p });
    return items[p];
  },
  toggleShuffle() {
    setState({ shuffle: !state.shuffle });
    return state.shuffle;
  },
  cycleRepeat(): RepeatMode {
    const next: RepeatMode = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
    setState({ repeat: next });
    return next;
  },
};
