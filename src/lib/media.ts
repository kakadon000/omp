// Seekability fixer.
//
// Chromium only allows seeks within `seekable`. Media served without HTTP
// Range support (some custom protocols, naive static servers) ends up with
// seekable === [0, 0] — every seek clamps back to 0 and the timeline looks
// dead. For sources we can fetch (same-origin / blob / data) and that fit in
// memory, we swap in a Blob URL copy, which is always fully seekable.

const MAX_BYTES = 64 * 1024 * 1024; // 64 MB — bundled/demo media territory

const fixed = new Map<string, string>(); // original src -> blob URL

export function sameOriginFetchable(src: string): boolean {
  try {
    if (src.startsWith("blob:") || src.startsWith("data:")) return true;
    const u = new URL(src, location.href);
    return u.origin === location.origin;
  } catch {
    return false;
  }
}

export function seekableOK(el: HTMLMediaElement): boolean {
  const d = el.duration;
  if (!Number.isFinite(d) || d <= 0) return true; // live stream — nothing to fix
  const sk = el.seekable;
  if (sk.length === 0) return false;
  return sk.end(sk.length - 1) >= d - 0.3;
}

/**
 * Make sure `el` can actually seek. Returns true when the element is
 * seekable when the promise settles (possibly after swapping in a blob).
 */
export async function ensureSeekable(el: HTMLMediaElement, src: string): Promise<boolean> {
  if (seekableOK(el)) return true;
  if (fixed.has(src)) {
    const url = fixed.get(src)!;
    if (el.src !== url) {
      el.src = url;
      el.load();
    }
    return true;
  }
  if (!sameOriginFetchable(src)) return false;
  try {
    const resp = await fetch(src);
    if (!resp.ok) return false;
    const cl = Number(resp.headers.get("content-length") || "0");
    if (cl > MAX_BYTES) return false;
    const blob = await resp.blob();
    if (blob.size > MAX_BYTES || blob.size === 0) return false;
    const url = URL.createObjectURL(blob);
    fixed.set(src, url);
    el.src = url;
    el.load();
    return true;
  } catch {
    return false;
  }
}

/** Seek that survives non-range sources: seeks, and if the source clamped
 *  the position back, swaps in a seekable blob and re-seeks. */
export async function robustSeek(el: HTMLMediaElement | null, t: number, src: string): Promise<void> {
  if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
  const want = Math.min(Math.max(0, t), Math.max(0, el.duration - 0.05));
  try {
    el.currentTime = want;
  } catch {
    /* noop */
  }
  if (Math.abs(el.currentTime - want) > 0.25) {
    const ok = await ensureSeekable(el, src);
    if (ok) {
      try { el.currentTime = want; } catch { /* noop */ }
    }
  }
}
