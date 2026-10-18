import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { openContextMenu } from "../components/ContextMenu";
import { navigate } from "../lib/router";
import { invoke, isTauri, openMediaFile, APP_VERSION } from "../lib/tauri";
import { engineStore } from "../lib/engine";
import { VIDEOS, IMAGES, TRACKS, type VideoItem } from "../lib/data";
import { loadProgress, saveProgress, pushHistory, loadHistory, customMedia, type CustomMedia, type HistItem } from "../lib/store";
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
  const engine = useSyncExternalStore(engineStore.sub, engineStore.get);
  // real playlists from SQLite (null = still loading on Tauri)
  const [playlists, setPlaylists] = useState<Playlist[] | null>(isTauri ? null : []);
  const [hist, setHist] = useState<HistItem[]>(() => loadHistory().slice(0, 8));
  // real library counters from SQLite
  const [stats, setStats] = useState<{ videos: number; audio: number; folders: number } | null>(null);

  useEffect(() => {
    const h = new Date().getHours();
    setGreeting(h < 5 ? "Late night session" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
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
    setHist(loadHistory().slice(0, 8));
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
  const engineLabel = !isTauri
    ? "WebView2 · web demo"
    : engine.available
      ? `mpv engine${engine.version ? ` · ${engine.version}` : ""} · ready`
      : "engine missing — Settings → Engine & tools";

  return (
    <div>
      <div className="home-grid">
        <div>
          <section className="card hero">
            <img src="./icon-512.png" alt="OMP" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="hero-name">{greeting}</div>
              <div className="hero-tag">Every Format. One Player. Open to All.</div>
              <div className="hero-actions">
                <button className="btn accent" onClick={openFile}>
                  <Icon name="play" size={15} /> Open media
                </button>
                <button className="btn" onClick={() => navigate("player")}>
                  <Icon name="film" size={15} /> Resume watching
                </button>
                <button className="btn" onClick={() => navigate("music")}>
                  <Icon name="music" size={15} /> Play music
                </button>
              </div>
            </div>
          </section>

          {custom.name && (
            <div className="section-label">Now open</div>
          )}
          {custom.name && (
            <div className="card hover media-card" style={{ width: 260 }} onClick={() => navigate("player")}>
              <div className="media-thumb" style={{ aspectRatio: "1/0.55" }}>
                <Icon name="film" size={26} />
                <div className="play-hint"><span className="icon-btn"><Icon name="play" /></span></div>
              </div>
              <div className="media-title">{custom.name}</div>
              <div className="media-meta">External file</div>
            </div>
          )}

          {hist.length > 0 && (
            <>
              <div className="section-label">Recently played</div>
              <div className="hist-row">
                {hist.filter((h) => filtered([h.name])).map((h) => (
                  <button key={`${h.id}:${h.at}`} className="card hover hist-chip" onClick={() => openHist(h)} title={h.name}>
                    {h.thumb ? <img src={h.thumb} alt="" loading="lazy" /> : <Icon name={HIST_ICON[h.kind] ?? "film"} size={15} />}
                    <span className="hist-name">{h.name}</span>
                    <span className="hist-when">{relTime(h.at)}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {continueWatching.length > 0 && (
            <>
              <div className="section-label">Continue watching</div>
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

          <div className="section-label">Recently added</div>
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
            {(stats ? [
              { v: String(stats.videos), k: "Videos" },
              { v: String(stats.audio), k: "Tracks" },
              { v: String(stats.folders), k: "Folders" },
            ] : [
              { v: String(VIDEOS.length + TRACKS.length + IMAGES.length), k: "Items" },
              { v: "50+", k: "Formats" },
              { v: "0%", k: "Idle CPU" },
            ]).map((s) => (
              <div className="card stat" key={s.k}><div className="v">{s.v}</div><div className="k">{s.k}</div></div>
            ))}
          </div>

          <div className="section-label">Your playlists</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {playlists === null && <div className="card panel" style={{ fontSize: 12.5, color: "var(--text-3)" }}>Loading playlists…</div>}
            {playlists?.length === 0 && (
              <div className="card panel" style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.7 }}>
                No playlists yet. Open <b style={{ color: "var(--text)" }}>Music</b>, right-click any track → <b style={{ color: "var(--text)" }}>Add to playlist</b>.
              </div>
            )}
            {(playlists ?? []).filter((p) => filtered([p.name])).map((p) => (
              <div key={p.id} className="card hover" style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", cursor: "pointer" }}
                onClick={() => void playPlaylist(p)}
                onContextMenu={(e) => playlistMenu(e, p)}>
                <span className="icon-btn sm" style={{ background: "var(--accent-dim)", color: "var(--accent)" }}>
                  <Icon name="list" size={14} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: "var(--text-3)" }}>{p.trackCount} {p.trackCount === 1 ? "track" : "tracks"}</div>
                </div>
                <Icon name="chevronR" size={15} />
              </div>
            ))}
          </div>

          <div className="section-label">System</div>
          <div className="card panel" style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.9 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>Version</span><b style={{ color: "var(--text)" }}>v{APP_VERSION}</b></div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Engine</span>
              <b style={{ color: "var(--text)", display: "flex", alignItems: "center", gap: 6, textAlign: "right" }}>
                <span className={`health-dot ${engineOk ? "ok" : "bad"}`} />
                {engineLabel}
              </b>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>License</span><b style={{ color: "var(--text)" }}>GPL-3.0</b></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// re-exported for convenience in App
export { saveProgress };
