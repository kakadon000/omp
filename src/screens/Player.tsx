import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { VIDEOS } from "../lib/data";
import { customMedia, loadProgress, saveProgress, pushHistory, type Settings } from "../lib/store";
import { fmtTime, pct } from "../lib/format";
import { navigate } from "../lib/router";
import { openMediaFile } from "../lib/tauri";

type MenuKind = "speed" | "subs" | "audio" | null;

export function Player({ settings }: { settings: Settings }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lastSave = useRef(0);

  const custom = useSyncExternalStore(customMedia.sub, customMedia.get);
  const [vidId, setVidId] = useState<string>(VIDEOS[0].id);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(settings.defaultSpeed);
  const [subs, setSubs] = useState(false);
  const [menu, setMenu] = useState<MenuKind>(null);
  const [fs, setFs] = useState(false);
  const [pip, setPip] = useState(false);

  const vid = VIDEOS.find((v) => v.id === vidId) ?? VIDEOS[0];
  const src = custom.url || vid.src;
  const title = custom.url ? custom.name : vid.title;

  // external navigation (Home "continue watching")
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      customMedia.set({ name: "", url: "" });
      setVidId(id);
    };
    window.addEventListener("omp:play-video", on);
    return () => window.removeEventListener("omp:play-video", on);
  }, []);

  // apply rate
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, src]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const seekBy = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.min(v.duration - 0.05, Math.max(0, v.currentTime + delta));
    setTime(v.currentTime);
  }, []);

  const setVolume = (val: number) => {
    const v = videoRef.current;
    setVol(val);
    setMuted(val === 0);
    if (v) { v.volume = val; v.muted = val === 0; }
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    const next = !muted;
    v.muted = next;
    setMuted(next);
  };

  const toggleFullscreen = () => {
    const el = stageRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => toast("Fullscreen blocked", "err"));
  };

  const togglePip = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setPip(false);
      } else {
        await v.requestPictureInPicture();
        setPip(true);
      }
    } catch {
      toast("Picture-in-picture unavailable here", "err");
    }
  };

  // fullscreen state
  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  // keyboard shortcuts — only while this screen is open
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (document.querySelector(".modal")) return;
      switch (e.key) {
        case " ": e.preventDefault(); togglePlay(); break;
        case "ArrowRight": e.preventDefault(); seekBy(settings.seekStep); break;
        case "ArrowLeft": e.preventDefault(); seekBy(-settings.seekStep); break;
        case "ArrowUp": e.preventDefault(); setVolume(Math.min(1, vol + 0.05)); break;
        case "ArrowDown": e.preventDefault(); setVolume(Math.max(0, vol - 0.05)); break;
        case "f": case "F": toggleFullscreen(); break;
        case "m": case "M": toggleMute(); break;
        case ",": seekBy(-1 / 30); break;
        case ".": seekBy(1 / 30); break;
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  const nextVideo = () => {
    if (custom.url) return;
    const i = VIDEOS.findIndex((v) => v.id === vidId);
    setVidId(VIDEOS[(i + 1) % VIDEOS.length].id);
  };
  const prevVideo = () => {
    if (custom.url) return;
    const i = VIDEOS.findIndex((v) => v.id === vidId);
    setVidId(VIDEOS[(i - 1 + VIDEOS.length) % VIDEOS.length].id);
  };

  const subtitleUrl = "./media/sample-subs.vtt";

  return (
    <div className="player-shell" style={{ height: "100%" }}>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div className="player-stage" ref={stageRef} style={{ position: "relative" }}>
          <video
            key={src}
            ref={videoRef}
            src={src}
            autoPlay
            playsInline
            onClick={togglePlay}
            onDoubleClick={toggleFullscreen}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              setTime(v.currentTime);
              const now = Date.now();
              if (!custom.url && now - lastSave.current > 2000) {
                lastSave.current = now;
                saveProgress(vid.id, v.currentTime, v.duration);
              }
            }}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              v.volume = vol;
              v.playbackRate = rate;
              setDur(v.duration || 0);
              if (!custom.url) {
                const p = loadProgress()[vid.id];
                if (p && p.t > 3 && pct(p.t, p.d) < 97) {
                  v.currentTime = p.t;
                  toast(`Resumed at ${fmtTime(p.t)}`, "info");
                }
                pushHistory({ id: vid.id, kind: "video", name: vid.title, at: Date.now(), thumb: vid.poster });
              }
            }}
            onEnded={() => {
              if (!custom.url) {
                saveProgress(vid.id, 0, 0);
                nextVideo();
              }
            }}
            onError={() => toast("This format needs the mpv engine — arrives in Phase 1.1", "info")}
          >
            {subs && !custom.url && (
              <track kind="subtitles" src={subtitleUrl} srcLang="en" label="English" default />
            )}
          </video>

          {!playing && (
            <button className="stage-big-play" onClick={togglePlay} aria-label="Play">
              <Icon name="play" />
            </button>
          )}

          <div className="pc-title">
            <span className="chip"><Icon name="film" /> {title}</span>
          </div>
        </div>

        {/* queue */}
        {!custom.url && (
          <aside className="player-queue">
            <div className="section-label">Up next</div>
            {VIDEOS.map((v) => (
              <div
                key={v.id}
                className={`q-item ${v.id === vidId ? "on" : ""}`}
                onClick={() => { setVidId(v.id); }}
              >
                <div className="q-thumb">{v.poster ? <img src={v.poster} alt="" loading="lazy" /> : <Icon name="film" />}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="q-title">{v.title}</div>
                  <div className="q-meta">{v.duration} · {v.res} · {v.codec}</div>
                </div>
                {v.id === vidId && <Icon name="play" size={13} />}
              </div>
            ))}
            <div className="side-sep" style={{ margin: "12px 4px" }} />
            <button className="btn sm" style={{ width: "100%" }} onClick={async () => {
              const f = await openMediaFile();
              if (f) {
                customMedia.set({ name: f.name, url: f.url });
                pushHistory({ id: `custom:${f.name}`, kind: "video", name: f.name, at: Date.now() });
              }
            }}>
              <Icon name="plus" size={14} /> Open external file
            </button>
          </aside>
        )}
      </div>

      {/* control bar */}
      <div className="player-bar">
        <div className="seek-wrap">
          <span className="seek-time">{fmtTime(time)}</span>
          <input
            type="range"
            className="slider thin"
            min={0}
            max={1000}
            value={Math.round(pct(time, dur) * 10)}
            style={{ ["--fill" as string]: `${pct(time, dur)}%` }}
            onChange={(e) => {
              const v = videoRef.current;
              const p = Number(e.target.value) / 1000;
              if (v && Number.isFinite(v.duration)) {
                v.currentTime = p * v.duration;
                setTime(v.currentTime);
              }
            }}
            aria-label="Seek"
          />
          <span className="seek-time right">{fmtTime(dur)}</span>
        </div>

        <div className="player-controls">
          <button className="icon-btn" onClick={prevVideo} aria-label="Previous"><Icon name="prev" /></button>
          <button className="icon-btn lg" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
            <Icon name={playing ? "pause" : "play"} size={22} />
          </button>
          <button className="icon-btn" onClick={nextVideo} aria-label="Next"><Icon name="next" /></button>
          <button className="icon-btn tip" data-tip="Frame back (,)" onClick={() => seekBy(-1 / 30)} aria-label="Frame back"><Icon name="stepB" /></button>
          <button className="icon-btn tip" data-tip="Frame forward (.)" onClick={() => seekBy(1 / 30)} aria-label="Frame forward"><Icon name="stepF" /></button>

          <div className="pc-grow" />

          <div className="vol-wrap">
            <button className="icon-btn sm" onClick={toggleMute} aria-label="Mute">
              <Icon name={muted || vol === 0 ? "mute" : "volume"} />
            </button>
            <input
              type="range" className="slider thin" min={0} max={100} value={Math.round(vol * 100)}
              style={{ ["--fill" as string]: `${vol * 100}%` }}
              onChange={(e) => setVolume(Number(e.target.value) / 100)}
              aria-label="Volume"
            />
          </div>

          {/* speed menu */}
          <div className="menu-wrap">
            <button
              className={`icon-btn tip ${rate !== 1 ? "on" : ""}`} data-tip="Playback speed" data-tip-up
              onClick={() => setMenu(menu === "speed" ? null : "speed")}
              aria-label="Speed"
            >
              <Icon name="gauge" />
            </button>
            {menu === "speed" && (
              <div className="menu up" onMouseLeave={() => setMenu(null)}>
                {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                  <button key={r} className={`menu-item ${r === rate ? "sel" : ""}`} onClick={() => { setRate(r); setMenu(null); }}>
                    <span className="grow">{r === 1 ? "Normal" : `${r}×`}</span>
                    {r === rate && <Icon name="check" size={14} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* subtitles menu */}
          {!custom.url && (
            <div className="menu-wrap">
              <button
                className={`icon-btn tip ${subs ? "on" : ""}`} data-tip="Subtitles"
                onClick={() => setMenu(menu === "subs" ? null : "subs")}
                aria-label="Subtitles"
              >
                <Icon name="cc" />
              </button>
              {menu === "subs" && (
                <div className="menu up" onMouseLeave={() => setMenu(null)}>
                  <button className={`menu-item ${!subs ? "sel" : ""}`} onClick={() => { setSubs(false); setMenu(null); }}>
                    <span className="grow">Off</span>{!subs && <Icon name="check" size={14} />}
                  </button>
                  <button className={`menu-item ${subs ? "sel" : ""}`} onClick={() => { setSubs(true); setMenu(null); }}>
                    <span className="grow">English (sample.srt)</span>{subs && <Icon name="check" size={14} />}
                  </button>
                  <div className="menu-sep" />
                  <button className="menu-item" onClick={() => toast("External subtitle loading lands in Phase 1.1", "info")}>
                    <Icon name="plus" size={14} /><span className="grow">Load file…</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* audio tracks */}
          <div className="menu-wrap">
            <button className="icon-btn tip" data-tip="Audio tracks" onClick={() => setMenu(menu === "audio" ? null : "audio")} aria-label="Audio tracks">
              <Icon name="list" />
            </button>
            {menu === "audio" && (
              <div className="menu up" onMouseLeave={() => setMenu(null)}>
                <button className="menu-item sel">
                  <span className="grow">Default (AAC 2.0)</span><Icon name="check" size={14} />
                </button>
                <button className="menu-item" onClick={() => toast("Multi-track audio arrives with the mpv engine (Phase 1.1)", "info")}>
                  <span className="grow">External audio…</span>
                </button>
              </div>
            )}
          </div>

          <button className={`icon-btn tip ${pip ? "on" : ""}`} data-tip="Picture-in-picture" onClick={togglePip} aria-label="Picture in picture">
            <Icon name="pip" />
          </button>
          <button className="icon-btn tip" data-tip={fs ? "Exit fullscreen (F)" : "Fullscreen (F)"} onClick={toggleFullscreen} aria-label="Fullscreen">
            <Icon name={fs ? "exitFullscreen" : "fullscreen"} />
          </button>
        </div>
      </div>
    </div>
  );
}
