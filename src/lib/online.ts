// Phase 5 — online media service.
// YouTube: authorized interfaces only (official nocookie embeds + the user's
// own YouTube Data API key for search — no scraping, no key sharing).
// IPTV: M3U/M3U8 playlist parsing with a local channel store. Streams play
// through the native mpv engine (HLS/TS handled by libmpv directly).

export type IptvChannel = {
  id: string;
  name: string;
  url: string;
  logo: string;
  group: string;
  tvgId: string;
  source: string; // playlist file name it came from
};

/* ------------------------------------------------------------------ */
/*  M3U / M3U8 parsing                                                 */
/* ------------------------------------------------------------------ */

const ATTR_RE = /([a-zA-Z0-9-]+)="([^"]*)"/g;

function attrObject(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = m[2];
  return out;
}

function isStreamLine(l: string): boolean {
  return /^(https?|rtsp|rtmp|rtp|udp)?:\/\//i.test(l.trim());
}

/**
 * Parse an M3U/M3U8 playlist. Tolerates:
 *  - full #EXTINF attribute sets (tvg-name, tvg-logo, tvg-id, group-title)
 *  - #EXTGRP lines
 *  - bare URL lists with no #EXTM3U header at all
 *  - #EXTVLCOPT and other vendor lines (ignored)
 */
export function parseM3U(text: string, source: string): IptvChannel[] {
  const lines = text.split(/\r?\n/);
  const out: IptvChannel[] = [];
  const seen = new Set<string>();
  let pending: Partial<IptvChannel> | null = null;

  const push = (name: string, url: string, logo: string, group: string, tvgId: string) => {
    const u = url.trim();
    if (!u || !isStreamLine(u) || seen.has(u)) return;
    seen.add(u);
    out.push({
      id: `ch-${hash(u)}`,
      name: (name || u.split("/").pop() || "Channel").trim(),
      url: u,
      logo,
      group: (group || "General").trim(),
      tvgId,
      source,
    });
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const attrs = attrObject(line);
      // display name = text after the last comma (names may contain commas,
      // but the attribute blob never does — it's quoted)
      const commaAt = line.lastIndexOf(",");
      const name = commaAt >= 0 ? line.slice(commaAt + 1).trim() : "";
      pending = {
        name: attrs["tvg-name"] || name || "",
        logo: attrs["tvg-logo"] || "",
        group: attrs["group-title"] || "",
        tvgId: attrs["tvg-id"] || "",
      };
      // some exports keep the readable name only after the comma
      if (name && (!pending.name || pending.name === name)) pending.name = name;
      continue;
    }
    if (line.startsWith("#EXTGRP:")) {
      if (pending) pending.group = line.slice(8).trim();
      continue;
    }
    if (line.startsWith("#")) continue; // EXTM3U / EXTVLCOPT / comments
    if (pending) {
      push(pending.name || "", line, pending.logo || "", pending.group || "", pending.tvgId || "");
      pending = null;
    } else if (isStreamLine(line)) {
      push("", line, "", "", "");
    }
  }
  return out;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/* ------------------------------------------------------------------ */
/*  Channel store (localStorage — playlists are user content, not      */
/*  media library; SQLite stays for scanned files)                     */
/* ------------------------------------------------------------------ */

const CH_KEY = "omp.online.channels";
const RECENT_KEY = "omp.online.recent";
const YT_KEY = "omp.online.ytkey";

export function loadChannels(): IptvChannel[] {
  try {
    const raw = localStorage.getItem(CH_KEY);
    const list = raw ? (JSON.parse(raw) as IptvChannel[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function persist(list: IptvChannel[]) {
  try {
    localStorage.setItem(CH_KEY, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent("omp://channels-changed"));
  } catch {
    /* storage full — channels just won't persist */
  }
}

export function importChannels(parsed: IptvChannel[], source: string): { added: number; total: number } {
  const existing = loadChannels();
  const have = new Set(existing.map((c) => c.url));
  let added = 0;
  for (const ch of parsed) {
    if (have.has(ch.url)) continue;
    have.add(ch.url);
    existing.push({ ...ch, source });
    added++;
  }
  persist(existing);
  return { added, total: existing.length };
}

export function removeChannelsBySource(source: string) {
  persist(loadChannels().filter((c) => c.source !== source));
}

export function clearChannels() {
  persist([]);
}

export function channelSources(list: IptvChannel[]): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const c of list) map.set(c.source, (map.get(c.source) || 0) + 1);
  return [...map.entries()].map(([name, count]) => ({ name, count }));
}

export function channelGroups(list: IptvChannel[]): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const c of list) {
    const g = c.group || "General";
    map.set(g, (map.get(g) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));
}

/* --------------------------- recent channels ------------------------ */

export type RecentChannel = { name: string; url: string; logo: string; group: string; at: number };

export function loadRecent(): RecentChannel[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as RecentChannel[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function pushRecent(ch: { name: string; url: string; logo?: string; group?: string }) {
  if (!ch.url || !isStreamLine(ch.url)) return;
  const list = loadRecent().filter((r) => r.url !== ch.url);
  list.unshift({ name: ch.name, url: ch.url, logo: ch.logo || "", group: ch.group || "", at: Date.now() });
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
  } catch {
    /* noop */
  }
}

/* ------------------------------------------------------------------ */
/*  YouTube — authorized interfaces only                               */
/* ------------------------------------------------------------------ */

/** Parse anything a user might paste: watch URLs, shorts, live, embed,
 *  youtu.be links, playlist links, or a bare 11-character video id. */
export function parseYouTubeInput(input: string): { videoId?: string; listId?: string } {
  const s = input.trim();
  if (!s) return {};
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return { videoId: s };
  let u: URL | null = null;
  try {
    u = new URL(s.startsWith("http") ? s : `https://${s}`);
  } catch {
    return {};
  }
  const host = u.hostname.replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  if (host === "youtu.be") {
    const id = path.slice(1);
    return { videoId: /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : undefined, listId: u.searchParams.get("list") || undefined };
  }
  if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
    const v = u.searchParams.get("v");
    const listId = u.searchParams.get("list") || undefined;
    const segs = path.split("/").filter(Boolean);
    const kind = segs[0];
    const cand = segs[1];
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return { videoId: v, listId };
    if (cand && ["shorts", "live", "embed", "v"].includes(kind) && /^[a-zA-Z0-9_-]{11}$/.test(cand)) {
      return { videoId: cand, listId };
    }
    if (kind === "playlist" && listId) return { listId };
  }
  return { listId: u.searchParams.get("list") || undefined };
}

export function ytEmbedUrl(videoId: string, listId?: string, autoplay = true): string {
  const p = new URLSearchParams({
    autoplay: autoplay ? "1" : "0",
    rel: "0",
    modestbranding: "1",
    playsinline: "1",
  });
  if (listId) p.set("list", listId);
  if (listId && !videoId) p.set("listType", "playlist");
  return `https://www.youtube-nocookie.com/embed/${videoId || "videoseries"}?${p.toString()}`;
}

export function ytThumb(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/* ----------------------------- API key ------------------------------ */

export function loadYtKey(): string {
  try {
    return localStorage.getItem(YT_KEY) || "";
  } catch {
    return "";
  }
}

export function saveYtKey(k: string) {
  try {
    if (k) localStorage.setItem(YT_KEY, k.trim());
    else localStorage.removeItem(YT_KEY);
  } catch {
    /* noop */
  }
}

/* --------------------------- Data API search ------------------------ */

export type YtResult = {
  id: string;
  title: string;
  channel: string;
  thumb: string;
  duration: string; // "3:42" | "1:02:10" | "" (live/upcoming)
  views: string; // "1.2M views" | ""
  published: string; // "2024-02-11"
  live: boolean;
};

function isoToDur(iso: string): string {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return "";
  const [, d, h, min, s] = m.map((x) => (x ? parseInt(x, 10) : 0)) as unknown as number[];
  const hh = (d || 0) * 24 + (h || 0);
  if (hh > 0) return `${hh}:${String(min || 0).padStart(2, "0")}:${String(s || 0).padStart(2, "0")}`;
  return `${min || 0}:${String(s || 0).padStart(2, "0")}`;
}

function fmtViews(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K views`;
  return n > 0 ? `${n} views` : "";
}

export class YtError extends Error {}

/**
 * Search YouTube with the user's own Data API v3 key.
 * Two calls: search.list (1 unit) + videos.list (1 unit) for durations/views.
 */
export async function ytSearch(
  key: string,
  query: string,
  opts?: { music?: boolean; max?: number },
): Promise<YtResult[]> {
  if (!key) throw new YtError("No YouTube API key — add one in Settings → Online");
  const max = Math.min(Math.max(opts?.max ?? 24, 1), 50);
  const sp = new URLSearchParams({
    part: "snippet",
    type: "video",
    maxResults: String(max),
    q: query,
    safeSearch: "none",
    key,
  });
  if (opts?.music) sp.set("videoCategoryId", "10");
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${sp}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.message || `HTTP ${res.status}`;
    if (res.status === 403) throw new YtError(`API key rejected or quota exhausted (${reason})`);
    if (res.status === 400) throw new YtError(`Bad API key (${reason})`);
    throw new YtError(`YouTube search failed — ${reason}`);
  }
  const data = await res.json();
  const items: { id: { videoId?: string }; snippet: Record<string, string> }[] = data.items || [];
  const ids = items.map((i) => i.id?.videoId).filter(Boolean) as string[];
  if (!ids.length) return [];

  const vp = new URLSearchParams({
    part: "contentDetails,statistics,liveStreamingDetails",
    id: ids.join(","),
    key,
  });
  const vres = await fetch(`https://www.googleapis.com/youtube/v3/videos?${vp}`);
  const vdata = vres.ok ? await vres.json() : { items: [] };
  const byId = new Map<string, Record<string, never>>();
  for (const it of vdata.items || []) byId.set(it.id, it);

  return items
    .filter((i) => i.id?.videoId)
    .map((i) => {
      const id = i.id.videoId as string;
      const v = byId.get(id);
      const dur = (v?.contentDetails as { duration?: string } | undefined)?.duration || "";
      const views = parseInt((v?.statistics as { viewCount?: string } | undefined)?.viewCount || "0", 10);
      const isLive = !!((v?.liveStreamingDetails as object | undefined) || dur === "P0D");
      return {
        id,
        title: decodeHtml(i.snippet.title || "Untitled"),
        channel: decodeHtml(i.snippet.channelTitle || ""),
        thumb: ytThumb(id),
        duration: isLive ? "LIVE" : isoToDur(dur),
        views: isLive ? "" : fmtViews(views),
        published: (i.snippet.publishedAt || "").slice(0, 10),
        live: isLive,
      };
    });
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Cheap key check: 1-unit videos.list call on a known public video. */
export async function ytTestKey(key: string): Promise<{ ok: boolean; msg: string }> {
  try {
    const sp = new URLSearchParams({ part: "id", id: "aqz-KE-bpKQ", key });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${sp}`);
    if (res.ok) return { ok: true, msg: "Key works — search is live" };
    const body = await res.json().catch(() => null);
    return { ok: false, msg: body?.error?.message || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, msg: e instanceof Error ? e.message : "Network error" };
  }
}

/* ----------------------------- misc --------------------------------- */

export function isStreamUrl(u: string): boolean {
  return isStreamLine(u);
}

/** Built-in starter channels — free, publicly announced official streams. */
export const BUILTIN_TV: IptvChannel[] = [
  {
    id: "tv-nasa",
    name: "NASA TV Public",
    url: "https://ntv1.akamaized.net/hls/live/2014075/NASA-NTV1-HLS/master.m3u8",
    logo: "",
    group: "Science",
    tvgId: "",
    source: "Built-in",
  },
  {
    id: "tv-redbull",
    name: "Red Bull TV",
    url: "https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8",
    logo: "",
    group: "Sports",
    tvgId: "",
    source: "Built-in",
  },
];
