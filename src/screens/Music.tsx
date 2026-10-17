import { useSyncExternalStore, useState } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { TRACKS, RADIO } from "../lib/data";
import {
  nowPlaying, audio, playTrackById, nextTrack, togglePlay, seekTo,
  queueShuffle, setQueueShuffle, queueRepeat, setQueueRepeat,
} from "../lib/store";
import { fmtTime, pct } from "../lib/format";
import { navigate } from "../lib/router";

export function useNowPlaying() {
  return useSyncExternalStore(nowPlaying.sub, nowPlaying.get);
}

export function Music({ query }: { query: string }) {
  const np = useNowPlaying();
  const [shuffle, setShuffleState] = useState(queueShuffle);
  const [repeat, setRepeatState] = useState(queueRepeat);

  const q = query.toLowerCase();
  const tracks = TRACKS.filter((t) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));
  const albums = [...new Set(TRACKS.map((t) => t.album))];

  const current = TRACKS.find((t) => t.id === np.trackId) || null;

  const toggleShuffle = () => {
    const v = !shuffle;
    setShuffleState(v);
    setQueueShuffle(v);
    toast(v ? "Shuffle on" : "Shuffle off", "info");
  };
  const toggleRepeat = () => {
    const v = !repeat;
    setRepeatState(v);
    setQueueRepeat(v);
    toast(v ? "Repeat on" : "Repeat off", "info");
  };

  return (
    <div style={{ paddingBottom: current ? 90 : 0 }}>
      <div className="music-grid">
        <div>
          <div className="section-label">Albums</div>
          <div className="album-grid">
            {albums.map((al) => {
              const cover = TRACKS.find((t) => t.album === al)!.cover;
              const artist = TRACKS.find((t) => t.album === al)!.artist;
              return (
                <div key={al} className="card hover album-card" onClick={() => playTrackById(TRACKS.find((t) => t.album === al)!.id)}>
                  <div className="album-cover"><img src={cover} alt="" loading="lazy" /></div>
                  <div className="album-name">{al}</div>
                  <div className="album-artist">{artist} · {TRACKS.filter((t) => t.album === al).length} tracks</div>
                </div>
              );
            })}
          </div>

          <div className="section-label" style={{ marginTop: 26 }}>All tracks</div>
          <div className="track-list">
            {tracks.map((t, i) => (
              <div key={t.id} className={`track-item ${np.trackId === t.id ? "on" : ""}`} onClick={() => playTrackById(t.id)}>
                <span className="track-num">
                  {np.trackId === t.id && np.playing ? (
                    <span className="track-eq"><i /><i /><i /></span>
                  ) : i + 1}
                </span>
                <img className="track-cover" src={t.cover} alt="" loading="lazy" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="track-name">{t.title}</div>
                  <div className="track-artist">{t.artist} — {t.album}</div>
                </div>
                <span className="track-dur">{t.dur}</span>
                <button className="icon-btn sm" onClick={(e) => { e.stopPropagation(); playTrackById(t.id); }} aria-label="Play">
                  <Icon name="play" size={13} />
                </button>
              </div>
            ))}
            {tracks.length === 0 && (
              <div className="empty"><Icon name="music" /><div className="t">No matches</div><div className="d">Nothing in your library matches "{query}".</div></div>
            )}
          </div>
        </div>

        <div>
          <div className="section-label">Internet radio</div>
          <div className="radio-row" style={{ gridTemplateColumns: "1fr" }}>
            {RADIO.map((r) => (
              <div key={r.id} className="card hover radio-card" onClick={() => toast("Internet radio arrives with Phase 3 — music + widgets", "info")}>
                <span className="radio-dot" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>{r.genre}</div>
                </div>
                <Icon name="radio" size={16} />
              </div>
            ))}
          </div>

          <div className="section-label" style={{ marginTop: 22 }}>Desktop widget</div>
          <div className="card panel" style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.7 }}>
            Music keeps playing in a tiny floating widget — even with the main window closed.
            <button className="btn sm" style={{ marginTop: 10 }} onClick={() => navigate("widget")}>
              <Icon name="layers" size={14} /> Preview widget
            </button>
          </div>
        </div>
      </div>

      {/* hidden audio mirror for cover art in NP bar is handled globally */}
      {current && audio && null}
    </div>
  );
}

export function NowPlayingBar() {
  const np = useNowPlaying();
  const current = TRACKS.find((t) => t.id === np.trackId);
  if (!current) return null;

  return (
    <div className="np-bar">
      <img className="np-cover" src={current.cover} alt="" />
      <div className="np-info">
        <div className="np-name">{current.title}</div>
        <div className="np-artist">{current.artist} — {current.album}</div>
        <input
          type="range" className="slider thin np-seek" min={0} max={1000}
          value={Math.round(pct(np.time, np.dur) * 10)}
          style={{ ["--fill" as string]: `${pct(np.time, np.dur)}%` }}
          onChange={(e) => seekTo((Number(e.target.value) / 1000) * np.dur)}
          aria-label="Seek music"
        />
      </div>
      <span style={{ fontSize: 11, color: "var(--text-3)", fontVariantNumeric: "tabular-nums", flex: "none" }}>
        {fmtTime(np.time)}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 2, flex: "none" }}>
        <button className="icon-btn sm" onClick={() => nextTrack(-1)} aria-label="Previous track"><Icon name="prev" size={15} /></button>
        <button className="icon-btn" onClick={togglePlay} aria-label={np.playing ? "Pause" : "Play"}>
          <Icon name={np.playing ? "pause" : "play"} size={19} />
        </button>
        <button className="icon-btn sm" onClick={() => nextTrack(1)} aria-label="Next track"><Icon name="next" size={15} /></button>
      </div>
    </div>
  );
}
