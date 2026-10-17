import { useState } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { ONLINE_VIDEOS, IPTV, RADIO } from "../lib/data";

export function Online({ query }: { query: string }) {
  const [playing, setPlaying] = useState<string | null>(null);
  const [tab, setTab] = useState<"video" | "music" | "tv">("video");
  const q = query.toLowerCase();

  const vids = ONLINE_VIDEOS.filter((v) => !q || v.name.toLowerCase().includes(q));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <div className="seg">
          <button className={tab === "video" ? "on" : ""} onClick={() => setTab("video")}>Video</button>
          <button className={tab === "music" ? "on" : ""} onClick={() => setTab("music")}>Music</button>
          <button className={tab === "tv" ? "on" : ""} onClick={() => setTab("tv")}>Live TV</button>
        </div>
        <span style={{ flex: 1 }} />
        <span className="chip"><Icon name="check" /> No OMP ads. Ever.</span>
        <span className="chip badge" style={{ height: 28 }}>YouTube ads remain per Google policy</span>
      </div>

      {tab === "video" && (
        <>
          <div className="yt-grid">
            {vids.map((v) => (
              <div key={v.id} className="card hover yt-card">
                {playing === v.id ? (
                  <div className="yt-embed">
                    <iframe
                      src={`https://www.youtube-nocookie.com/embed/${v.yt}?autoplay=1&rel=0`}
                      title={v.name}
                      allow="accelerometer; autoplay; encrypted-media; picture-in-picture"
                      allowFullScreen
                    />
                  </div>
                ) : (
                  <div className="yt-thumb" onClick={() => setPlaying(v.id)}>
                    <img
                      src={`https://i.ytimg.com/vi/${v.yt}/hqdefault.jpg`}
                      alt={v.name}
                      loading="lazy"
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                    <span className="icon-btn" style={{ position: "relative", background: "rgba(18,20,26,0.65)", color: "#fff", borderRadius: 99, width: 46, height: 46, backdropFilter: "blur(8px)" }}>
                      <Icon name="play" size={20} />
                    </span>
                  </div>
                )}
                <div className="yt-name">{v.name}</div>
                <div className="yt-src">{v.src} · YouTube</div>
              </div>
            ))}
          </div>
          {vids.length === 0 && (
            <div className="empty">
              <Icon name="globe" />
              <div className="t">No matches</div>
              <div className="d">Full YouTube search arrives with Phase 5. For now enjoy the curated open films.</div>
            </div>
          )}
          <div className="section-label" style={{ marginTop: 24 }}>Internet radio</div>
          <div className="radio-row">
            {RADIO.map((r) => (
              <div key={r.id} className="card hover radio-card" onClick={() => toast("Radio streams arrive with Phase 3", "info")}>
                <span className="radio-dot" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>{r.genre}</div>
                </div>
                <Icon name="radio" size={16} />
              </div>
            ))}
          </div>
        </>
      )}

      {tab === "music" && (
        <div className="empty" style={{ padding: "70px 20px" }}>
          <Icon name="music" />
          <div className="t">YouTube Music — Phase 5</div>
          <div className="d">
            A dedicated YouTube Music experience where supported, using authorized interfaces only.
            Local music works today on the Music screen.
          </div>
          <span className="badge accent">Planned · Phase 5</span>
        </div>
      )}

      {tab === "tv" && (
        <>
          <div className="section-label">Authorized IPTV streams</div>
          <div className="radio-row" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
            {IPTV.filter((c) => !q || c.name.toLowerCase().includes(q)).map((c) => (
              <div key={c.id} className="card hover radio-card" onClick={() =>
                toast(c.status === "ready" ? "IPTV playback arrives with Phase 5" : "Geo-restricted in this demo region", "info")}>
                <span className="radio-dot" style={{ background: c.status === "ready" ? "var(--ok)" : "var(--text-3)" }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>{c.genre} · {c.status === "ready" ? "Ready" : "Geo-restricted"}</div>
                </div>
                <Icon name="cast" size={16} />
              </div>
            ))}
          </div>
          <div className="card panel" style={{ marginTop: 16, fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.8 }}>
            <b style={{ color: "var(--text)" }}>Playlist import</b> — load M3U/M3U8 playlists in Phase 5. Streams run in an
            isolated WebView with its own permissions, and no background processes stay alive after you close the tab.
          </div>
        </>
      )}
    </div>
  );
}
