// Phase 3 — Widget screen: an in-app preview + the launcher for the REAL
// floating desktop widget (its own frameless always-on-top window).
// Playback state comes from the global audio service, not the demo store.

import { useState } from "react";
import { Icon } from "../components/Icon";
import { invoke, isTauri } from "../lib/tauri";
import { audioUse, setVolume, seek, toggle, next, trackArt } from "../lib/audio";
import { fmtTime, pct } from "../lib/format";
import { navigate } from "../lib/router";

export function WidgetPage() {
  const st = audioUse();
  const [onTop] = useState(true);
  const [opacity, setOpacity] = useState(0.94);

  const track = st.track;
  const dur = st.live ? 0 : st.dur || track?.duration || 0;

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
          <div className="d">Start a track or radio station on the Music screen — the widget follows it live.</div>
          <button className="btn accent" onClick={() => navigate("music")}>
            <Icon name="music" size={15} /> Open Music
          </button>
        </div>
      ) : (
        <div className="widget-stage">
          {/* compact */}
          <div>
            <div className="section-label">Compact player</div>
            <div className="widget-preview" style={{ opacity }}>
              <div className="widget compact">
                <span className="w-cover" style={{ display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", background: "rgba(127,127,127,0.12)" }}>
                  {track.thumb ? <img src={trackArt(track)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Icon name="music" size={14} />}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="w-name">{st.live && st.icy ? st.icy : track.title}</div>
                  <div className="w-artist">{st.live ? "Internet radio" : track.artist}</div>
                </div>
                <div className="w-controls">
                  <button className="icon-btn sm" onClick={() => next(-1)} aria-label="Previous"><Icon name="prev" size={14} /></button>
                  <button className="icon-btn sm" onClick={() => void toggle()} aria-label="Play/pause"><Icon name={st.playing ? "pause" : "play"} size={16} /></button>
                  <button className="icon-btn sm" onClick={() => next(1)} aria-label="Next"><Icon name="next" size={14} /></button>
                </div>
              </div>
              {!st.live && (
                <input
                  type="range" className="slider thin" min={0} max={1000} value={Math.round(pct(st.time, dur) * 10)}
                  style={{ ["--fill" as string]: `${pct(st.time, dur)}%`, marginTop: 10 }}
                  onChange={(e) => seek((Number(e.target.value) / 1000) * dur)}
                  aria-label="Widget seek"
                />
              )}
            </div>
          </div>

          {/* expanded */}
          <div>
            <div className="section-label">Desktop widget</div>
            <div className="widget-preview" style={{ opacity }}>
              <div className="widget expanded">
                <span className="w-cover" style={{ display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", background: "rgba(127,127,127,0.12)", boxShadow: "0 10px 30px rgba(0,0,0,0.35)" }}>
                  {track.thumb ? <img src={trackArt(track)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Icon name="music" size={22} />}
                </span>
                <div className="w-row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="w-name" style={{ fontSize: 14.5 }}>{st.live && st.icy ? st.icy : track.title}</div>
                    <div className="w-artist">{st.live ? `${track.title} · LIVE` : `${track.artist} — ${track.album}`}</div>
                  </div>
                  {st.playing && (
                    <span className="w-vis" style={{ color: "var(--accent)" }}>
                      <i /><i /><i /><i />
                    </span>
                  )}
                </div>
                {!st.live && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 6px" }}>
                    <span style={{ fontSize: 10.5, color: "var(--text-3)", fontVariantNumeric: "tabular-nums", flex: "none" }}>{fmtTime(st.time)}</span>
                    <input
                      type="range" className="slider thin" min={0} max={1000} value={Math.round(pct(st.time, dur) * 10)}
                      style={{ ["--fill" as string]: `${pct(st.time, dur)}%` }}
                      onChange={(e) => seek((Number(e.target.value) / 1000) * dur)}
                      aria-label="Widget seek"
                    />
                    <span style={{ fontSize: 10.5, color: "var(--text-3)", fontVariantNumeric: "tabular-nums", flex: "none" }}>{fmtTime(dur)}</span>
                  </div>
                )}
                <div className="w-row" style={{ justifyContent: "center", gap: 6 }}>
                  <button className="icon-btn" onClick={() => next(-1)} aria-label="Previous"><Icon name="prev" /></button>
                  <button className="icon-btn lg" onClick={() => void toggle()} aria-label="Play/pause" style={{ background: "var(--accent)", color: "var(--accent-text)", borderRadius: 99 }}>
                    <Icon name={st.playing ? "pause" : "play"} size={20} />
                  </button>
                  <button className="icon-btn" onClick={() => next(1)} aria-label="Next"><Icon name="next" /></button>
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
                  <div className="row-desc">The floating widget always floats above other windows</div>
                </div>
                <label className="switch">
                  <input type="checkbox" checked={onTop} readOnly />
                  <span className="track"><span className="thumb" /></span>
                </label>
              </div>
              <div className="row">
                <div className="row-main">
                  <div className="row-title">Preview opacity · {Math.round(opacity * 100)}%</div>
                  <input type="range" className="slider" min={40} max={100} value={Math.round(opacity * 100)}
                    style={{ ["--fill" as string]: `${((opacity - 0.4) / 0.6) * 100}%`, width: 180 }}
                    onChange={(e) => setOpacity(Number(e.target.value) / 100)} />
                </div>
              </div>
              <div className="row">
                <div className="row-main">
                  <div className="row-title">Volume</div>
                  <div className="row-desc">Applies to the whole audio session</div>
                  <input type="range" className="slider" min={0} max={100} value={Math.round(st.volume * 100)}
                    style={{ ["--fill" as string]: `${st.volume * 100}%`, width: 180 }}
                    onChange={(e) => setVolume(Number(e.target.value) / 100)} />
                </div>
              </div>
              <div className="row">
                <div className="row-main">
                  <div className="row-title">Background playback</div>
                  <div className="row-desc">Closing the main window keeps the music going</div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    defaultChecked
                    onChange={(e) => {
                      void invoke("set_background_playback", { v: e.target.checked });
                    }}
                  />
                  <span className="track"><span className="thumb" /></span>
                </label>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              {isTauri && (
                <button className="btn accent" onClick={() => void invoke("widget_toggle")}>
                  <Icon name="layers" size={15} /> Show floating widget
                </button>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 12, lineHeight: 1.7 }}>
              The widget runs as its own real window — frameless, translucent and always on top.
              Drag it by the header, expand it for the queue and volume, and close the main window
              while music plays: OMP keeps playing and the widget stays with you. A desktop-layer
              widget attached behind icons is deeper Windows integration we won't fake.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
