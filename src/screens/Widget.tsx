import { useState } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { TRACKS } from "../lib/data";
import { nowPlaying, nextTrack, togglePlay, seekTo, audio } from "../lib/store";
import { useNowPlaying } from "./Music";
import { fmtTime, pct } from "../lib/format";

const PRESETS = ["Glass Dark", "Frosted Light", "Solid Contrast"] as const;

export function WidgetPage() {
  const np = useNowPlaying();
  const [onTop, setOnTop] = useState(false);
  const [opacity, setOpacity] = useState(0.9);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]>("Glass Dark");

  const track = TRACKS.find((t) => t.id === np.trackId);
  const setVolLocal = (v: number) => { if (audio) audio.volume = v; };

  const dark = preset !== "Frosted Light";

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <span className="badge accent">Phase 3 widget — live preview of the real floating window</span>
        <span className="chip"><Icon name="check" /> Works with the main window closed</span>
        <span className="chip"><Icon name="check" /> Zero idle animations</span>
      </div>

      {!track ? (
        <div className="empty">
          <Icon name="layers" />
          <div className="t">Nothing playing</div>
          <div className="d">Start a track on the Music screen — the widget follows it live.</div>
          <button className="btn accent" onClick={() => (location.hash = "#/music")}>
            <Icon name="music" size={15} /> Open Music
          </button>
        </div>
      ) : (
        <div className="widget-stage">
          {/* compact */}
          <div>
            <div className="section-label">Compact player</div>
            <div className="widget-preview" style={{ opacity, background: dark ? "#181a20" : "#f4f5f8" }}>
              <div className="widget compact">
                <img className="w-cover" src={track.cover} alt="" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="w-name" style={{ color: dark ? "#f2f3f6" : "#191c23" }}>{track.title}</div>
                  <div className="w-artist" style={{ color: dark ? "rgba(242,243,246,0.6)" : "rgba(25,28,35,0.6)" }}>{track.artist}</div>
                </div>
                <div className="w-controls" style={{ color: dark ? "#f2f3f6" : "#191c23" }}>
                  <button className="icon-btn sm" onClick={() => nextTrack(-1)} aria-label="Previous"><Icon name="prev" size={14} /></button>
                  <button className="icon-btn sm" onClick={togglePlay} aria-label="Play/pause"><Icon name={np.playing ? "pause" : "play"} size={16} /></button>
                  <button className="icon-btn sm" onClick={() => nextTrack(1)} aria-label="Next"><Icon name="next" size={14} /></button>
                </div>
              </div>
              <input
                type="range" className="slider thin" min={0} max={1000} value={Math.round(pct(np.time, np.dur) * 10)}
                style={{ ["--fill" as string]: `${pct(np.time, np.dur)}%`, marginTop: 10 }}
                onChange={(e) => seekTo((Number(e.target.value) / 1000) * np.dur)}
                aria-label="Widget seek"
              />
            </div>
          </div>

          {/* expanded */}
          <div>
            <div className="section-label">Desktop widget</div>
            <div className="widget-preview" style={{ opacity, background: dark ? "#181a20" : "#f4f5f8" }}>
              <div className="widget expanded">
                <img className="w-cover" src={track.cover} alt="" style={{ boxShadow: "0 10px 30px rgba(0,0,0,0.35)" }} />
                <div className="w-row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="w-name" style={{ color: dark ? "#f2f3f6" : "#191c23", fontSize: 14.5 }}>{track.title}</div>
                    <div className="w-artist" style={{ color: dark ? "rgba(242,243,246,0.6)" : "rgba(25,28,35,0.6)" }}>{track.artist} — {track.album}</div>
                  </div>
                  {np.playing && (
                    <span className="w-vis" style={{ color: "var(--accent)" }}>
                      <i /><i /><i /><i />
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 6px" }}>
                  <span style={{ fontSize: 10.5, color: dark ? "rgba(242,243,246,0.5)" : "rgba(25,28,35,0.5)", fontVariantNumeric: "tabular-nums", flex: "none" }}>{fmtTime(np.time)}</span>
                  <input
                    type="range" className="slider thin" min={0} max={1000} value={Math.round(pct(np.time, np.dur) * 10)}
                    style={{ ["--fill" as string]: `${pct(np.time, np.dur)}%` }}
                    onChange={(e) => seekTo((Number(e.target.value) / 1000) * np.dur)}
                    aria-label="Widget seek"
                  />
                  <span style={{ fontSize: 10.5, color: dark ? "rgba(242,243,246,0.5)" : "rgba(25,28,35,0.5)", fontVariantNumeric: "tabular-nums", flex: "none" }}>{fmtTime(np.dur)}</span>
                </div>
                <div className="w-row" style={{ justifyContent: "center", gap: 6, color: dark ? "#f2f3f6" : "#191c23" }}>
                  <button className="icon-btn" onClick={() => nextTrack(-1)} aria-label="Previous"><Icon name="prev" /></button>
                  <button className="icon-btn lg" onClick={togglePlay} aria-label="Play/pause" style={{ background: "var(--accent)", color: "var(--accent-text)", borderRadius: 99 }}>
                    <Icon name={np.playing ? "pause" : "play"} size={20} />
                  </button>
                  <button className="icon-btn" onClick={() => nextTrack(1)} aria-label="Next"><Icon name="next" /></button>
                </div>
              </div>
            </div>
          </div>

          {/* settings */}
          <div>
            <div className="section-label">Widget settings</div>
            <div className="card">
              <div className="row">
                <div className="row-main">
                  <div className="row-title">Always on top</div>
                  <div className="row-desc">Float above every window</div>
                </div>
                <label className="switch">
                  <input type="checkbox" checked={onTop} onChange={(e) => { setOnTop(e.target.checked); toast(e.target.checked ? "Always on top — active in the desktop app" : "Always on top off", "info"); }} />
                  <span className="track"><span className="thumb" /></span>
                </label>
              </div>
              <div className="row">
                <div className="row-main">
                  <div className="row-title">Opacity · {Math.round(opacity * 100)}%</div>
                  <input type="range" className="slider" min={40} max={100} value={Math.round(opacity * 100)}
                    style={{ ["--fill" as string]: `${((opacity - 0.4) / 0.6) * 100}%`, width: 180 }}
                    onChange={(e) => setOpacity(Number(e.target.value) / 100)} />
                </div>
              </div>
              <div className="row">
                <div className="row-main">
                  <div className="row-title">Volume</div>
                  <input type="range" className="slider" min={0} max={100} defaultValue={100}
                    style={{ ["--fill" as string]: "100%", width: 180 }}
                    onChange={(e) => setVolLocal(Number(e.target.value) / 100)} />
                </div>
              </div>
              <div className="row">
                <div className="row-main">
                  <div className="row-title">Theme preset</div>
                  <div className="row-desc">Applies to the floating widget</div>
                </div>
                <div className="seg">
                  {PRESETS.map((p) => (
                    <button key={p} className={preset === p ? "on" : ""} onClick={() => setPreset(p)}>{p}</button>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 12, lineHeight: 1.7 }}>
              The widget runs as its own always-available window (Phase 3). A true desktop-layer widget
              attached behind icons is a deeper Windows integration — we won't fake it with transparency.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
