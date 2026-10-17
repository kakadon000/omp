import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { navigate } from "../lib/router";
import { openMediaFile, APP_VERSION } from "../lib/tauri";
import { VIDEOS, IMAGES, TRACKS } from "../lib/data";
import { loadProgress, saveProgress, pushHistory, customMedia, type CustomMedia } from "../lib/store";
import { fmtTime, pct } from "../lib/format";
import { useSyncExternalStore } from "react";

function useCustomMedia(): CustomMedia {
  return useSyncExternalStore(customMedia.sub, customMedia.get);
}

export function Home({ query }: { query: string }) {
  const progress = useState(loadProgress)[0];
  const custom = useCustomMedia();
  const [greeting, setGreeting] = useState("Welcome back");

  useEffect(() => {
    const h = new Date().getHours();
    setGreeting(h < 5 ? "Late night session" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
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
    navigate("player");
    toast(`Opened ${f.name}`, "ok");
  };

  const filtered = (names: string[]) =>
    query ? names.some((n) => n.toLowerCase().includes(query.toLowerCase())) : true;

  const recentMedia = [
    ...VIDEOS.map((v) => ({ ...v })),
    ...IMAGES.slice(0, 4).map((i) => ({ kind: "image" as const, id: i.id, title: i.name, src: i.src, poster: i.src, meta: `${i.w}×${i.h} · ${i.size}` })),
  ].filter((m) => filtered([m.title]));

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
                      onClick={() => { navigate("player"); window.dispatchEvent(new CustomEvent("omp:play-video", { detail: v.id })); }}
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
                  if (m.kind === "video") {
                    navigate("player");
                    window.dispatchEvent(new CustomEvent("omp:play-video", { detail: m.id }));
                  } else {
                    navigate("gallery");
                  }
                }}
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
            <div className="card stat"><div className="v">{VIDEOS.length + TRACKS.length + IMAGES.length}</div><div className="k">Items</div></div>
            <div className="card stat"><div className="v">50+</div><div className="k">Formats</div></div>
            <div className="card stat"><div className="v">0<span style={{ fontSize: 13 }}>%</span></div><div className="k">Idle CPU</div></div>
          </div>

          <div className="section-label">Quick playlists</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { name: "Favourites", icon: "heart", n: TRACKS.length },
              { name: "Focus Mix", icon: "sparkle", n: 8 },
              { name: "Watch Later", icon: "clock", n: 5 },
            ].map((p) => (
              <div key={p.name} className="card hover" style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", cursor: "pointer" }}
                onClick={() => navigate("music")}>
                <span className="icon-btn sm" style={{ background: "var(--accent-dim)", color: "var(--accent)" }}>
                  <Icon name={p.icon} size={14} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: "var(--text-3)" }}>{p.n} items</div>
                </div>
                <Icon name="chevronR" size={15} />
              </div>
            ))}
          </div>

          <div className="section-label">System</div>
          <div className="card panel" style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.9 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>Version</span><b style={{ color: "var(--text)" }}>v{APP_VERSION}</b></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>Engine</span><b style={{ color: "var(--text)" }}>WebView2 · Phase 1</b></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>License</span><b style={{ color: "var(--text)" }}>GPL-3.0</b></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// re-exported for convenience in App
export { saveProgress };
