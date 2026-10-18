import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { openContextMenu } from "../components/ContextMenu";
import { navigate } from "../lib/router";
import { invoke, isTauri, openMediaFile, APP_VERSION } from "../lib/tauri";
import { engineStore } from "../lib/engine";
import { VIDEOS, IMAGES, TRACKS, type VideoItem } from "../lib/data";
import { loadProgress, saveProgress, pushHistory, loadHistory, customMedia, removeHistory, clearHistory, type CustomMedia, type HistItem } from "../lib/store";
import { videoQueue } from "../lib/videoQueue";
import { playTracks, libItemToTrack } from "../lib/audio";
import { fmtTime, pct } from "../lib/format";

function useCustomMedia(): CustomMedia {
  return useSyncExternalStore(customMedia.sub, customMedia.get);
}

type Playlist = { id: number; name: string; trackCount: number };

function relTime(at: number): string {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const HIST_ICON: Record<HistItem["kind"], string> = { video: "film", music: "music", image: "image" };

export function Home({ query }: { query: string }) {
  const progress = useState(loadProgress)[0];
  const custom = useCustomMedia();
  const [greeting, setGreeting] = useState("Welcome back");
  const [dateLine, setDateLine] = useState("");
  const engine = useSyncExternalStore(engineStore.sub, engineStore.get);
  // real playlists from SQLite (null = still loading on Tauri)
  const [playlists, setPlaylists] = useState<Playlist[] | null>(isTauri ? null : []);
  const [hist, setHist] = useState<HistItem[]>(() => loadHistory().slice(0, 12));
  // real library counters from SQLite
  const [stats, setStats] = useState<{ videos: number; audio: number; folders: number } | null>(null);

  useEffect(() => {
    const d = new Date();
    const h = d.getHours();
    setGreeting(h < 5 ? "Late night session" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
    setDateLine(d.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" }));
  }, []);

  // real playlists — also refresh when they change anywhere in the app
  useEffect(() => {
    if (!isTauri) return;
    let dead = false;
    const load = () => void invoke<Playlist[]>("playlists_all").then((r) => { if (!dead) setPlaylists(r ?? []); });
    load();
    window.addEventListener("omp:playlists", load);
    return () => { dead = true; window.removeEventListener("omp:playlists", load); };
  }, []);

  // real library counters (videos / tracks / folders watched over by the DB)
  useEffect(() => {
    if (!isTauri) return;
    let dead = false;
    void invoke<{ videos: number; audio: number; folders: number }>("library_stats").then((s) => {
      if (!dead && s) setStats({ videos: s.videos ?? 0, audio: s.audio ?? 0, folders: s.folders ?? 0 });
    });
    return () => { dead = true; };
  }, []);

  const continueWatching = VIDEOS.filter((v) => {
    const p = progress[v.id];
    return p && p.t > 3 && pct(p.t, p.d) < 97;
  });

  const openFile = async () => {
    const f = await openMediaFile();
    if (!f) return;
    customMedia.set({ name: f.name, url: f.url });
    pushHistory({ id: `custom:${f.name}`, kind: "video", name: f.name, at: Date.now() });
    setHist(loadHistory().slice(0, 12));
    navigate("player");
    toast(`Opened ${f.name}`, "ok");
  };

  const filtered = (names: string[]) =>
    query ? names.some((n) => n.toLowerCase().includes(query.toLowerCase())) : true;

  const playVideo = (id: string) => {
    navigate("player");
    window.dispatchEvent(new CustomEvent("omp:play-video", { detail: id }));
  };

  const addToQueue = (v: VideoItem) => {
    videoQueue.add(v);
    toast(`Added "${v.title}" to the queue`, "ok");
  };

  const playPlaylist = async (p: Playlist) => {
    try {
      const items = await invoke<{ path: string; title: string; kind: string; duration: number; thumb: string; artist?: string; album?: string; genre?: string; id: number }[]>("playlist_items", { id: p.id });
      const tracks = (items ?? []).filter((m) => m.kind === "audio").map(libItemToTrack);
      if (!tracks.length) { toast("That playlist has no music yet — add some in Music", "info"); return; }
      playTracks(tracks, 0);
      navigate("music");
      toast(`Playing "${p.name}"`, "ok");
    } catch {
      toast("Could not open that playlist", "err");
    }
  };

  const deletePlaylist = (p: Playlist) => {
    void invoke("playlist_delete", { id: p.id }).then(() => {
      toast(`Playlist "${p.name}" deleted`, "ok");
      window.dispatchEvent(new CustomEvent("omp:playlists"));
      setPlaylists((cur) => (cur ?? []).filter((x) => x.id !== p.id));
    });
  };

  const playlistMenu = (e: React.MouseEvent, p: Playlist) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      { label: "Play playlist", icon: "play", onClick: () => void playPlaylist(p) },
      { sep: true as const },
      { label: "Delete playlist", icon: "close", danger: true, onClick: () => deletePlaylist(p) },
    ], p.name);
  };

  const openHist = (h: HistItem) => {
    if (h.kind === "music") { navigate("music"); return; }
    if (h.kind === "image") { navigate("gallery"); return; }
    const v = VIDEOS.find((x) => x.id === h.id);
    if (v) { playVideo(v.id); return; }
    navigate("player"); // external file — Player picks up the last opened media
  };

  const removeHist = (h: HistItem) => {
    removeHistory(h.id, h.at);
    setHist(loadHistory().slice(0, 12));
    toast("Removed from history", "ok");
  };

  const clearAllHist = () => {
    clearHistory();
    setHist([]);
    toast("History cleared", "ok");
  };

  const histMenu = (e: React.MouseEvent, h: HistItem) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      { label: "Open", icon: "play", onClick: () => openHist(h) },
      { sep: true as const },
      { label: "Remove from history", icon: "trash", danger: true, onClick: () => removeHist(h) },
    ], h.name);
  };

  const cardMenu = (e: React.MouseEvent, m: { kind?: string; id: string; title?: string; name?: string }) => {
    e.preventDefault();
    e.stopPropagation();
    const label = m.title ?? m.name ?? "media";
    const isVideo = m.kind === "video" || VIDEOS.some((v) => v.id === m.id);
    openContextMenu(e.clientX, e.clientY, [
      ...(isVideo ? [
        { label: "Play now", icon: "play", onClick: () => playVideo(m.id) },
        { label: "Add to queue", icon: "plus", onClick: () => { const v = VIDEOS.find((x) => x.id === m.id); if (v) addToQueue(v); } },
        { label: "Add as next in queue", icon: "list", onClick: () => { const v = VIDEOS.find((x) => x.id === m.id); if (v) { videoQueue.addNext(v); toast(`"${v.title}" plays next`, "ok"); } } },
      ] : [
        { label: "Open in Gallery", icon: "image", onClick: () => navigate("gallery") },
      ]),
      { sep: true as const },
      { label: "Copy title", icon: "type", onClick: () => { void navigator.clipboard?.writeText(label); toast("Copied", "ok"); } },
    ], label);
  };

  const recentMedia = [
    ...VIDEOS.map((v) => ({ ...v })),
    ...IMAGES.slice(0, 4).map((i) => ({ kind: "image" as const, id: i.id, title: i.name, src: i.src, poster: i.src, meta: `${i.w}×${i.h} · ${i.size}` })),
  ].filter((m) => filtered([m.title]));

  // live engine line — honest status, not a hardcoded string
  const engineOk = !isTauri || engine.available;
  const engineSub = !isTauri
    ? "WebView2 · web demo"
    : engine.available
      ? `mpv${engine.version ? ` · ${engine.version}` : ""} · ready`
      : "missing — auto-repair runs at boot";

  // quick-launch tiles — live counts when the database has answered
  const tiles = useMemo(() => [
    { icon: "film", label: "Videos", sub: String(stats ? stats.videos : VIDEOS.length), go: () => navigate("player") },
    { icon: "music", label: "Music", sub: String(stats ? stats.audio : TRACKS.length), go: () => navigate("music") },
    { icon: "image", label: "Gallery", sub: String(IMAGES.length), go: () => navigate("gallery") },
    { icon: "globe", label: "Online", sub: "YouTube · IPTV", go: () => navigate("online") },
    { icon: "scissors", label: "Editor", sub: "Trim & cut", go: () => navigate("editor") },
    { icon: "layers", label: "Widget", sub: "Mini player", go: () => navigate("widget") },
  ], [stats]);

  const statCards = stats ? [
    { icon: "film", v: String(stats.videos), k: "Videos" },
    { icon: "music", v: String(stats.audio), k: "Tracks" },
    { icon: "folder", v: String(stats.folders), k: "Folders" },
  ] : [
    { icon: "grid", v: String(VIDEOS.length + TRACKS.length + IMAGES.length), k: "Items" },
    { icon: "sparkle", v: "50+", k: "Formats" },
    { icon: "gauge", v: "0%", k: "Idle CPU" },
  ];

  const shown = (arr: HistItem[]) => arr.filter((h) => filtered([h.name]));

  return (
    <div className="home">
      {/* ---------- HERO 2.0 — ambient accent glow, real date, engine pill ---------- */}
      <section className="card hero-v2 anim-in">
        <div className="hero-glow" aria-hidden="true" />
        <img className="hero-logo" src="./icon-512.png" alt="OMP" />
        <div className="hero-main">
          <div className="hero-top">
            <span className="hero-name">{greeting}</span>
            <span className="hero-ver">v{APP_VERSION}</span>
          </div>
          <div className="hero-tag">
            {dateLine && <span className="hero-date">{dateLine}</span>}
            <span className="hero-sep" aria-hidden="true">·</span>
            <span>Every Format. One Player. Open to All.</span>
          </div>
          <div className="hero-actions">
            <button className="btn accent" onClick={openFile}>
              <Icon name="play" size={15} /> Open media
            </button>
            <button className="btn" onClick={() => navigate("player")}>
              <Icon name="film" size={15} /> Resume
            </button>
            <button className="btn" onClick={() => navigate("music")}>
              <Icon name="music" size={15} /> Music
            </button>
            <button className="btn" onClick={() => navigate("online")}>
              <Icon name="globe" size={15} /> Online
            </button>
            <button className="btn" onClick={() => navigate("editor")}>
              <Icon name="scissors" size={15} /> Editor
            </button>
          </div>
        </div>
        <button
          className={`hero-engine ${engineOk ? "ok" : "bad"}`}
          onClick={() => navigate("settings")}
          title="Engine status — click for Engine & tools"
        >
          <span className={`health-dot ${engineOk ? "ok" : "bad"}`} />
          <span className="he-col">
            <span className="he-t">{engineOk ? "Engine ready" : "Engine needs repair"}</span>
            <span className="he-s">{engineSub}</span>
          </span>
          <Icon name="chevronR" size={14} />
        </button>
      </section>

      {/* ---------- QUICK LAUNCH TILES — live counts from the database ---------- */}
      <div className="quick-grid anim-in d1">
        {tiles.filter((t) => filtered([t.label])).map((t) => (
          <button key={t.label} className="card hover quick-tile" onClick={t.go}>
            <span className="qt-ico"><Icon name={t.icon} size={19} /></span>
            <span className="qt-txt">
              <span className="qt-label">{t.label}</span>
              <span className="qt-sub">{t.sub}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="home-grid">
        <div>
          {custom.name && (
            <>
              <div className="section-label">Now open</div>
              <div className="card hover media-card now-open anim-in" onClick={() => navigate("player")}>
                <div className="media-thumb" style={{ aspectRatio: "1/0.55" }}>
                  <Icon name="film" size={26} />
                  <div className="play-hint"><span className="icon-btn"><Icon name="play" /></span></div>
                </div>
                <div className="media-title">{custom.name}</div>
                <div className="media-meta">External file</div>
              </div>
            </>
          )}

          {continueWatching.length > 0 && (
            <>
              <div className="section-label">
                Continue watching
                <span className="sec-count">{continueWatching.length}</span>
              </div>
              <div className="media-row">
                {continueWatching.filter((v) => filtered([v.title])).map((v) => {
                  const p = progress[v.id];
                  return (
                    <div
                      key={v.id}
                      className="card hover media-card"
                      onClick={() => playVideo(v.id)}
                      onContextMenu={(e) => cardMenu(e, { kind: "video", id: v.id, title: v.title })}
                    >
                      <div className="media-thumb">
                        <img src={v.poster} alt="" loading="lazy" />
                        <div className="play-hint"><span className="icon-btn"><Icon name="play" /></span></div>
                        <span className="media-badge">{Math.round(100 - pct(p.t, p.d))}% left</span>
                        <div className="media-progress"><i style={{ width: `${pct(p.t, p.d)}%` }} /></div>
                      </div>
                      <div className="media-title">{v.title}</div>
                      <div className="media-meta">{fmtTime(p.t)} / {fmtTime(p.d)}</div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {shown(hist).length > 0 && (
            <>
              <div className="section-label">
                Recently played
                <button className="sec-link" onClick={clearAllHist} title="Clear all history">
                  <Icon name="trash" size={12} /> Clear
                </button>
              </div>
              <div className="hist-grid">
                {shown(hist).map((h) => (
                  <button
                    key={`${h.id}:${h.at}`}
                    className="card hover hist-tile"
                    onClick={() => openHist(h)}
                    onContextMenu={(e) => histMenu(e, h)}
                    title={h.name}
                  >
                    <span className="ht-thumb">
                      {h.thumb
                        ? <img src={h.thumb} alt="" loading="lazy" />
                        : <Icon name={HIST_ICON[h.kind] ?? "film"} size={17} />}
                    </span>
                    <span className="ht-txt">
                      <span className="ht-name">{h.name}</span>
                      <span className="ht-when">{relTime(h.at)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="section-label">
            Recently added
            <button className="sec-link" onClick={() => navigate("library")}>
              Library <Icon name="chevronR" size={12} />
            </button>
          </div>
          <div className="media-row">
            {recentMedia.map((m) => (
              <div
                key={m.id}
                className="card hover media-card"
                onClick={() => {
                  if (m.kind === "video") playVideo(m.id);
                  else navigate("gallery");
                }}
                onContextMenu={(e) => cardMenu(e, { kind: m.kind, id: m.id, title: m.title, name: typeof m.title === "string" ? undefined : String((m as { name?: string }).name ?? "") || undefined })}
              >
                <div className="media-thumb">
                  <img src={m.poster} alt="" loading="lazy" />
                  {m.kind === "video" && (
                    <div className="play-hint"><span className="icon-btn"><Icon name="play" /></span></div>
                  )}
                </div>
                <div className="media-title">{m.title}</div>
                <div className="media-meta">{"meta" in m && m.meta ? m.meta : "Video"}</div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="section-label">Library at a glance</div>
          <div className="stat-grid">
            {statCards.map((s) => (
              <div className="card stat" key={s.k}>
                <span className="stat-ico"><Icon name={s.icon} size={15} /></span>
                <div className="stat-txt">
                  <div className="v">{s.v}</div>
                  <div className="k">{s.k}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="section-label">
            Your playlists
            {playlists !== null && playlists.length > 0 && <span className="sec-count">{playlists.length}</span>}
          </div>
          <div className="pl-list">
            {playlists === null && <div className="card panel pl-empty">Loading playlists…</div>}
            {playlists?.length === 0 && (
              <div className="card panel pl-empty">
                No playlists yet. Open <b>Music</b>, right-click any track → <b>Add to playlist</b>.
              </div>
            )}
            {(playlists ?? []).filter((p) => filtered([p.name])).map((p) => (
              <div key={p.id} className="card hover pl-row"
                onClick={() => void playPlaylist(p)}
                onContextMenu={(e) => playlistMenu(e, p)}>
                <span className="pl-ico"><Icon name="list" size={14} /></span>
                <div className="pl-txt">
                  <div className="pl-name">{p.name}</div>
                  <div className="pl-sub">{p.trackCount} {p.trackCount === 1 ? "track" : "tracks"}</div>
                </div>
                <span className="pl-play"><Icon name="play" size={12} /></span>
                <Icon className="pl-go" name="chevronR" size={15} />
              </div>
            ))}
          </div>

          <div className="section-label">System</div>
          <div className="card panel sys-card">
            <div className="sys-row">
              <Icon name="info" size={14} />
              <span>Version</span>
              <b>v{APP_VERSION}</b>
            </div>
            <div className="sys-row">
              <Icon name="gauge" size={14} />
              <span>Engine</span>
              <b className="sys-eng">
                <span className={`health-dot ${engineOk ? "ok" : "bad"}`} />
                {engineOk ? "mpv · ready" : "needs repair"}
              </b>
            </div>
            <div className="sys-row">
              <Icon name="save" size={14} />
              <span>License</span>
              <b>GPL-3.0</b>
            </div>
            <button className="btn sys-btn" onClick={() => navigate("settings")}>
              Engine & tools <Icon name="chevronR" size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// re-exported for convenience in App
export { saveProgress };
