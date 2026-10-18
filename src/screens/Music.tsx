// Phase 3 — Music: the real audio library.
// Tauri → SQLite library (albums from embedded tags, artwork from embedded
// covers, playlists in SQLite) + internet radio (mpv streams, icy-title).
// Web demo → falls back to the bundled sample tracks (store.ts demo layer).

import { useSyncExternalStore, useEffect, useState, useCallback } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { openContextMenu } from "../components/ContextMenu";
import { TRACKS } from "../lib/data";
import { invoke, isTauri } from "../lib/tauri";
import { engineStore } from "../lib/engine";
import {
  audioStore, audioUse, playTracks, playRadio, toggle, next, seek,
  setShuffle, setRepeat, trackArt, libItemToTrack, loadStations, addStation,
  removeStation, stationToTrack, type AudioTrack, type Station,
} from "../lib/audio";
import { sleepTimer } from "../lib/sleep";
import { fmtTime, pct } from "../lib/format";
import { navigate } from "../lib/router";

type LibItem = {
  id: number; path: string; title: string; kind: string; duration: number;
  thumb: string; artist?: string; album?: string; genre?: string;
};

type Playlist = { id: number; name: string; trackCount: number };

/* library data hook (Tauri) with the web-demo fallback */
function useMusicLibrary(query: string) {
  const [items, setItems] = useState<LibItem[] | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!isTauri) return;
    let dead = false;
    void invoke<LibItem[]>("library_list", { query, kind: "audio", sort: "title" })
      .then((r) => { if (!dead) setItems(r ?? []); });
    return () => { dead = true; };
  }, [query, tick]);

  useEffect(() => {
    if (!isTauri) return;
    const on = () => setTick((t) => t + 1);
    window.addEventListener("omp:playlists", on);
    return () => window.removeEventListener("omp:playlists", on);
  }, []);

  return items; // null = still loading (Tauri), [] vs TRACKS handled by caller
}

function usePlaylists() {
  const [pls, setPls] = useState<Playlist[]>([]);
  const refresh = useCallback(() => {
    if (!isTauri) return;
    void invoke<Playlist[]>("playlists_all").then((r) => setPls(r ?? []));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (!isTauri) return;
    const on = () => refresh();
    window.addEventListener("omp:playlists", on);
    return () => window.removeEventListener("omp:playlists", on);
  }, [refresh]);
  return { pls, refresh };
}

const fallbackTracks = (): AudioTrack[] =>
  TRACKS.map((t) => ({
    id: t.id, kind: "file" as const, src: t.src, title: t.title,
    artist: t.artist, album: t.album, thumb: t.cover, duration: 0,
  }));

export function Music({ query }: { query: string }) {
  const st = audioUse();
  const engineInfo = useSyncExternalStore(engineStore.sub, engineStore.get);
  const libItems = useMusicLibrary(query);
  const { pls, refresh: refreshPls } = usePlaylists();
  const [stations, setStations] = useState<Station[]>(() => loadStations());
  const [addOpen, setAddOpen] = useState(false);
  const [stName, setStName] = useState("");
  const [stUrl, setStUrl] = useState("");
  const [plName, setPlName] = useState("");

  const tracks: AudioTrack[] = isTauri
    ? (libItems ?? []).map(libItemToTrack)
    : fallbackTracks();

  const q = query.toLowerCase();
  const filtered = tracks.filter(
    (t) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)
  );
  const albums = [...new Set(filtered.map((t) => t.album || "Unknown album"))];
  const current = st.track;

  const play = (list: AudioTrack[], i: number) => playTracks(list, i);
  const playAlbum = (album: string) => {
    const list = filtered.filter((t) => (t.album || "Unknown album") === album);
    if (list.length) play(list, 0);
  };

  const addToPlaylist = async (plId: number, t: AudioTrack) => {
    if (!isTauri || t.kind !== "file") return;
    const ok = await invoke<boolean>("playlist_add", { id: plId, path: t.src });
    toast(ok ? `Added to playlist` : "Could not add (file not in library?)", ok ? "ok" : "err");
  };

  const createPl = async () => {
    const name = plName.trim();
    if (!name) return;
    const id = await invoke<number | null>("playlist_create", { name });
    if (id) {
      toast(`Playlist "${name}" created`, "ok");
      setPlName("");
      refreshPls();
    } else toast("Could not create (duplicate name?)", "err");
  };

  const trackMenu = (e: React.MouseEvent, t: AudioTrack, list: AudioTrack[], i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const items: Parameters<typeof openContextMenu>[2] = [
      { label: "Play", icon: "play", onClick: () => play(list, i) },
      { label: "Play next", icon: "next", onClick: () => {
        const qq = [...st.queue];
        qq.splice(st.qIndex + 1, 0, t);
        playTracks(qq, st.qIndex + 1 >= 0 ? st.qIndex + 1 : 0);
      } },
      { sep: true },
    ];
    if (isTauri && pls.length) {
      items.push({ label: "Add to playlist", icon: "list", sub: pls.map((p) => ({
        label: `${p.name} (${p.trackCount})`,
        icon: "folder",
        onClick: () => void addToPlaylist(p.id, t),
      })) });
    }
    if (isTauri && t.libId) {
      items.push(
        { sep: true },
        { label: "Show in Explorer", icon: "folder", onClick: () => void invoke("library_reveal", { path: t.src }) },
        { label: "Remove from library", icon: "trash", onClick: () => {
          void invoke("library_remove_item", { id: t.libId }).then(() => toast("Removed from library", "ok"));
        } },
      );
    }
    openContextMenu(e.clientX, e.clientY, items, t.title);
  };

  return (
    <div style={{ paddingBottom: current ? 96 : 0 }}>
      {/* v0.9.1 — honest state when the native engine is unavailable: the
          WebView audio fallback takes over and the user deserves to know */}
      {isTauri && !engineInfo.available && (
        <div className="card panel" style={{ padding: "9px 14px", marginBottom: 14, display: "flex", gap: 10, alignItems: "center", borderColor: "var(--warn, #ffb454)" }}>
          <Icon name="alert" size={14} />
          <span style={{ flex: 1, fontSize: 12.5 }}>
            Native engine not active — music plays with the built-in audio engine (slightly lower quality).
          </span>
          <button className="btn sm" onClick={() => navigate("settings")}>Fix</button>
        </div>
      )}
      <div className="music-grid">
        <div>
          {/* ---------------- albums ---------------- */}
          <div className="section-label">Albums {isTauri && libItems === null ? "" : `· ${albums.length}`}</div>
          {albums.length === 0 && isTauri && libItems !== null && (
            <div className="empty" style={{ marginBottom: 18 }}>
              <Icon name="music" />
              <div className="t">No music in the library yet</div>
              <div className="d">Add a music folder in the Library screen — OMP extracts album art, artist and album from the files' tags.</div>
              <button className="btn sm" style={{ marginTop: 10 }} onClick={() => navigate("library")}>
                <Icon name="folder" size={14} /> Open Library
              </button>
            </div>
          )}
          <div className="album-grid">
            {albums.slice(0, 12).map((al) => {
              const inAlbum = filtered.filter((t) => (t.album || "Unknown album") === al);
              const cover = inAlbum.find((t) => t.thumb)?.thumb || "";
              return (
                <div key={al} className="card hover album-card" onClick={() => playAlbum(al)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openContextMenu(e.clientX, e.clientY, [
                      { label: "Play album", icon: "play", onClick: () => playAlbum(al) },
                    ], al);
                  }}>
                  <div className="album-cover">
                    {cover ? (
                      <img src={trackArt(inAlbum[0])} alt="" loading="lazy" />
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--accent)", opacity: 0.55 }}>
                        <Icon name="music" size={26} />
                      </div>
                    )}
                  </div>
                  <div className="album-name">{al}</div>
                  <div className="album-artist">{inAlbum[0].artist} · {inAlbum.length} track{inAlbum.length === 1 ? "" : "s"}</div>
                </div>
              );
            })}
          </div>

          {/* ---------------- all tracks ---------------- */}
          <div className="section-label" style={{ marginTop: 26 }}>All tracks {filtered.length ? `· ${filtered.length}` : ""}</div>
          <div className="track-list">
            {filtered.map((t, i) => (
              <div
                key={t.id}
                className={`track-item ${current?.id === t.id ? "on" : ""}`}
                onClick={() => (current?.id === t.id ? toggle() : play(filtered, i))}
                onContextMenu={(e) => trackMenu(e, t, filtered, i)}
              >
                <span className="track-num">
                  {current?.id === t.id && st.playing ? (
                    <span className="track-eq"><i /><i /><i /></span>
                  ) : i + 1}
                </span>
                <span className="track-cover" style={{ display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", background: "rgba(127,127,127,0.08)" }}>
                  {t.thumb ? (
                    <img src={trackArt(t)} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <Icon name="music" size={12} />
                  )}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="track-name">{t.title}</div>
                  <div className="track-artist">{t.artist} — {t.album}</div>
                </div>
                <span className="track-dur">{t.duration > 0 ? fmtTime(t.duration) : "—"}</span>
                <button className="icon-btn sm" onClick={(e) => { e.stopPropagation(); play(filtered, i); }} aria-label="Play">
                  <Icon name="play" size={13} />
                </button>
              </div>
            ))}
            {filtered.length === 0 && (!isTauri || libItems !== null) && (
              <div className="empty"><Icon name="music" /><div className="t">No matches</div><div className="d">Nothing matches "{query}".</div></div>
            )}
          </div>
        </div>

        <div>
          {/* ---------------- playlists ---------------- */}
          <div className="section-label">Playlists</div>
          {isTauri ? (
            <div style={{ display: "grid", gap: 8 }}>
              {pls.map((p) => (
                <div key={p.id} className="card hover" style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openContextMenu(e.clientX, e.clientY, [
                      { label: "Play playlist", icon: "play", onClick: () => {
                        void invoke<LibItem[]>("playlist_items", { id: p.id })
                          .then((items) => {
                            const ts = (items ?? []).map(libItemToTrack);
                            if (ts.length) play(ts, 0);
                            else toast("Playlist is empty", "info");
                          });
                      } },
                      { label: "Delete playlist", icon: "trash", onClick: () => {
                        void invoke("playlist_delete", { id: p.id }).then(() => { toast("Playlist deleted", "ok"); refreshPls(); });
                      } },
                    ], p.name);
                  }}
                  onClick={() => {
                    void invoke<LibItem[]>("playlist_items", { id: p.id }).then((items) => {
                      const ts = (items ?? []).map(libItemToTrack);
                      if (ts.length) play(ts, 0);
                      else toast("Playlist is empty — right-click tracks to add them", "info");
                    });
                  }}>
                  <Icon name="list" size={15} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: "var(--text-3)" }}>{p.trackCount} track{p.trackCount === 1 ? "" : "s"}</div>
                  </div>
                  <Icon name="play" size={14} />
                </div>
              ))}
              {pls.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.6 }}>
                  Right-click any track → "Add to playlist" to build one.
                </div>
              )}
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="input" placeholder="New playlist name" style={{ flex: 1 }}
                  value={plName} onChange={(e) => setPlName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void createPl(); }}
                />
                <button className="btn sm" onClick={() => void createPl()}>
                  <Icon name="plus" size={14} />
                </button>
              </div>
            </div>
          ) : (
            <div className="card panel" style={{ fontSize: 12.5, color: "var(--text-2)" }}>
              SQLite playlists live in the desktop app — download it to build your own.
            </div>
          )}

          {/* ---------------- radio ---------------- */}
          <div className="section-label" style={{ marginTop: 22 }}>Internet radio</div>
          <div className="radio-row" style={{ gridTemplateColumns: "1fr" }}>
            {stations.map((r) => (
              <div key={r.id} className="card hover radio-card"
                onClick={() => playRadio(stationToTrack(r))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!r.custom) return;
                  openContextMenu(e.clientX, e.clientY, [
                    { label: "Remove station", icon: "trash", onClick: () => {
                      removeStation(r.id);
                      setStations(loadStations());
                      toast("Station removed", "ok");
                    } },
                  ], r.name);
                }}>
                <span className="radio-dot" style={current?.id === r.url && st.playing ? { background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" } : undefined} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>{r.genre}{current?.id === r.url && st.live && st.icy ? ` · ${st.icy}` : ""}</div>
                </div>
                <Icon name="radio" size={16} />
              </div>
            ))}
          </div>

          {addOpen ? (
            <div className="card panel" style={{ marginTop: 10, display: "grid", gap: 8 }}>
              <input className="input" placeholder="Station name" value={stName} onChange={(e) => setStName(e.target.value)} />
              <input className="input" placeholder="Stream URL (http…)" value={stUrl} onChange={(e) => setStUrl(e.target.value)} />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn sm" onClick={() => {
                  const s = addStation(stName, stUrl, "");
                  if (s) {
                    setStations(loadStations());
                    setAddOpen(false);
                    setStName("");
                    setStUrl("");
                    toast("Station added", "ok");
                  } else toast("Enter a valid http(s) stream URL", "err");
                }}>Save</button>
                <button className="btn sm ghost" onClick={() => setAddOpen(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setAddOpen(true)}>
              <Icon name="plus" size={14} /> Add station
            </button>
          )}

          {/* ---------------- widget ---------------- */}
          <div className="section-label" style={{ marginTop: 22 }}>Desktop widget</div>
          <div className="card panel" style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.7 }}>
            Music keeps playing in a floating always-on-top widget — even with the main window closed.
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button className="btn sm" onClick={() => void invoke("widget_toggle")}>
                <Icon name="layers" size={14} /> {isTauri ? "Show floating widget" : "Preview widget"}
              </button>
              {isTauri && (
                <button className="btn sm ghost" onClick={() => navigate("widget")}>
                  <Icon name="info" size={14} /> Preview in app
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <NowPlayingBar />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Now playing bar — bound to the real audio session                   */
/* ------------------------------------------------------------------ */

export function useAudioState() {
  return useSyncExternalStore(audioStore.sub, audioStore.get);
}

export function NowPlayingBar() {
  const st = audioUse();
  const current = st.track;
  const [scrub, setScrub] = useState<number | null>(null);
  const [sleepOpen, setSleepOpen] = useState(false);
  const sleep = useSyncExternalStore(sleepTimer.sub, sleepTimer.get);
  if (!current) return null;

  const dur = st.live ? 0 : st.dur || current.duration || 0;
  const displayPct = dur > 0 ? (scrub !== null ? scrub / dur : pct(st.time, dur)) : 0;
  const commit = () => {
    setScrub((cur) => {
      if (cur !== null && dur > 0) seek(cur);
      return null;
    });
  };
  const title = st.live && st.icy ? st.icy : current.title;
  const sub = st.live ? current.title : `${current.artist} — ${current.album}`;

  return (
    <div className="np-bar">
      <span className="np-cover" style={{ display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", background: "rgba(127,127,127,0.1)" }}>
        {current.thumb ? (
          <img src={trackArt(current)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <Icon name="music" size={16} />
        )}
      </span>
      <div className="np-info">
        <div className="np-name" title={title}>
          {title}
          {st.live && <span className="live-chip">LIVE</span>}
        </div>
        <div className="np-artist">{sub}</div>
        {!st.live && dur > 0 && (
          <input
            type="range" className="slider thin np-seek" min={0} max={1000}
            value={Math.round(displayPct * 1000)}
            style={{ ["--fill" as string]: `${displayPct * 100}%` }}
            onChange={(e) => setScrub((Number(e.target.value) / 1000) * dur)}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            aria-label="Seek music"
          />
        )}
      </div>
      <span style={{ fontSize: 11, color: "var(--text-3)", fontVariantNumeric: "tabular-nums", flex: "none" }}>
        {st.live ? (st.playing ? "ON AIR" : "PAUSED") : fmtTime(st.time)}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 2, flex: "none" }}>
        <button
          className={`icon-btn sm ${st.shuffle ? "on" : ""}`}
          onClick={() => setShuffle(!st.shuffle)}
          title={st.shuffle ? "Shuffle on" : "Shuffle off"} aria-label="Shuffle"
        >
          <Icon name="shuffle" size={14} />
        </button>
        <button
          className={`icon-btn sm ${st.repeat ? "on" : ""}`}
          onClick={() => setRepeat(!st.repeat)}
          title={st.repeat ? "Repeat: one" : "Repeat: off"} aria-label="Repeat"
        >
          <Icon name="repeat" size={14} />
        </button>
        <button className="icon-btn sm" onClick={() => next(-1)} disabled={st.queue.length < 2} aria-label="Previous track"><Icon name="prev" size={15} /></button>
        <button className="icon-btn" onClick={() => void toggle()} aria-label={st.playing ? "Pause" : "Play"}>
          <Icon name={st.playing ? "pause" : "play"} size={19} />
        </button>
        <button className="icon-btn sm" onClick={() => next(1)} disabled={st.queue.length < 2} aria-label="Next track"><Icon name="next" size={15} /></button>
        <div className="menu-wrap">
          <button
            className={`icon-btn sm ${sleep.mode !== "off" ? "on" : ""}`}
            onClick={(e) => { e.currentTarget.focus(); setSleepOpen((o) => !o); }}
            title={sleep.mode !== "off" ? `Sleep: ${sleepTimer.label()}` : "Sleep timer"}
            aria-label="Sleep timer"
          >
            <Icon name="moon" size={14} />
          </button>
          {sleepOpen && (
            <div className="menu up np-sleep" onMouseLeave={() => setSleepOpen(false)}>
              {[
                { id: "off", label: "Off", run: () => sleepTimer.disarm() },
                { id: "15", label: "15 minutes", run: () => sleepTimer.arm(15) },
                { id: "30", label: "30 minutes", run: () => sleepTimer.arm(30) },
                { id: "60", label: "60 minutes", run: () => sleepTimer.arm(60) },
                { id: "end", label: "After this track", run: () => sleepTimer.armEndOfTrack() },
              ].map((o) => {
                const sel = o.id === "off" ? sleep.mode === "off" : o.id === "end" ? sleep.mode === "end" : sleep.mode === "minutes" && Math.abs(sleep.remainingMs / 60_000 - Number(o.id)) < 0.5;
                return (
                  <button key={o.id} className={`menu-item ${sel ? "sel" : ""}`} onClick={() => { o.run(); setSleepOpen(false); }}>
                    <span className="grow">{o.label}</span>{sel && <Icon name="check" size={14} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button className="icon-btn sm" onClick={() => void invoke("widget_toggle")} title="Show desktop widget" aria-label="Show widget"><Icon name="layers" size={14} /></button>
      </div>
    </div>
  );
}
