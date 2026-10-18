import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { ONLINE_VIDEOS } from "../lib/data";
import { navigate } from "../lib/router";
import { customMedia } from "../lib/store";
import { engineStore } from "../lib/engine";
import { invoke, isTauri } from "../lib/tauri";
import {
  audioStore, playRadio, stopSession, stationToTrack,
  loadStations, addStation, removeStation, RADIO_PRESETS,
  type Station,
} from "../lib/audio";
import {
  parseM3U, loadChannels, importChannels, removeChannelsBySource, clearChannels,
  channelGroups, channelSources, loadRecent, pushRecent,
  parseYouTubeInput, ytEmbedUrl, ytThumb, loadYtKey, ytSearch, ytTestKey, YtError,
  ytdlpSearch, ytdlpStatus,
  BUILTIN_TV,
  type IptvChannel, type YtResult,
} from "../lib/online";

type Tab = "youtube" | "music" | "tv" | "radio";

export function Online({ query }: { query: string }) {
  const [tab, setTab] = useState<Tab>("youtube");
  const q = query.toLowerCase().trim();

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <div className="seg">
          <button className={tab === "youtube" ? "on" : ""} onClick={() => setTab("youtube")}>
            <Icon name="play" size={13} /> YouTube
          </button>
          <button className={tab === "music" ? "on" : ""} onClick={() => setTab("music")}>
            <Icon name="music" size={13} /> Music
          </button>
          <button className={tab === "tv" ? "on" : ""} onClick={() => setTab("tv")}>
            <Icon name="cast" size={13} /> Live TV
          </button>
          <button className={tab === "radio" ? "on" : ""} onClick={() => setTab("radio")}>
            <Icon name="radio" size={13} /> Radio
          </button>
        </div>
        <span style={{ flex: 1 }} />
        <span className="chip"><Icon name="check" /> No OMP ads. Ever.</span>
        <span className="chip badge" style={{ height: 28 }}>YouTube ads remain per Google policy</span>
      </div>

      {tab === "youtube" && <YouTubeTab q={q} />}
      {tab === "music" && <YouTubeTab q={q} music />}
      {tab === "tv" && <TvTab q={q} />}
      {tab === "radio" && <RadioTab />}
    </div>
  );
}

/* ==================================================================== */
/*  YouTube — paste a link, or search with your own API key              */
/* ==================================================================== */

function YouTubeTab({ q, music }: { q: string; music?: boolean }) {
  const [key, setKey] = useState(loadYtKey());
  useEffect(() => {
    const fn = () => setKey(loadYtKey());
    window.addEventListener("focus", fn);
    return () => window.removeEventListener("focus", fn);
  }, []);

  // v0.9.0 — built-in extractor presence (drives keyless search + native play)
  const [ytdlpOk, setYtdlpOk] = useState<boolean | null>(null);
  useEffect(() => {
    void ytdlpStatus().then((s) => setYtdlpOk(s.available));
  }, []);
  const engine = useSyncExternalStore(engineStore.sub, engineStore.get);
  // native path = healthy mpv engine + bundled extractor: hardware-decoded
  // playback with VLC-grade controls and a fraction of the WebView's CPU
  const canNative = engine.kind === "mpv" && ytdlpOk === true;

  const [input, setInput] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [results, setResults] = useState<YtResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [playing, setPlaying] = useState<{ videoId: string; listId?: string; title: string } | null>(null);

  // global search box query routes into the search field
  useEffect(() => {
    if (q) { setSearchQ(q); }
  }, [q]);

  /** engine-aware play: native player when possible, embed otherwise */
  const playDecision = (videoId: string, listId: string | undefined, title: string) => {
    if (canNative) {
      const url = listId && !videoId
        ? `https://www.youtube.com/playlist?list=${listId}`
        : `https://www.youtube.com/watch?v=${videoId}`;
      customMedia.set({ name: title || "YouTube", url });
      navigate("player");
      return;
    }
    setPlaying({ videoId, listId, title });
  };

  const runSearch = async (term: string) => {
    const t = term.trim();
    if (!t) return;
    // a pasted link in the search box → just play it
    const parsed = parseYouTubeInput(t);
    if (parsed.videoId || parsed.listId) {
      playDecision(parsed.videoId || "", parsed.listId, parsed.listId && !parsed.videoId ? "YouTube playlist" : t);
      return;
    }
    setBusy(true); setErr(""); setResults(null);
    try {
      if (key) {
        const rs = await ytSearch(key, t, { music });
        setResults(rs);
        if (!rs.length) setErr("No results.");
      } else {
        // v0.9.0: NO KEY → the built-in extractor searches instead
        if (!isTauri) { setErr("Search runs in the desktop app (built-in extractor or your own API key)."); return; }
        if (ytdlpOk === false) {
          setErr("Search needs a YouTube Data API key (Settings → Online) — or reinstall OMP to get the built-in extractor back.");
          return;
        }
        const rs = await ytdlpSearch(t, 20);
        setResults(rs);
        if (!rs.length) setErr("No results.");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(
        e instanceof YtError
          ? `${msg} (Tip: searches also work keyless through the built-in extractor — clear the key in Settings → Online.)`
          : msg || "Search failed — network error.",
      );
    } finally {
      setBusy(false);
    }
  };

  const playParsed = (text: string) => {
    const p = parseYouTubeInput(text);
    if (!p.videoId && !p.listId) { toast("Not a YouTube link or video id", "err"); return; }
    playDecision(p.videoId || "", p.listId, text);
  };

  const openInBrowser = (url: string) => {
    if (isTauri) void invoke("open_url", { url });
    else window.open(url, "_blank");
  };

  return (
    <div>
      {/* input row */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <input
          className="input"
          style={{ flex: 2, minWidth: 260 }}
          placeholder={music ? "Paste a YouTube music link, video id, or search…" : "Paste a YouTube link (watch / shorts / youtu.be / playlist)…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { if (input.includes("youtube") || input.includes("youtu.be") || /^[a-zA-Z0-9_-]{11}$/.test(input.trim())) playParsed(input); else runSearch(input); } }}
        />
        <button className="btn" onClick={() => { if (input.includes("youtube") || input.includes("youtu.be") || /^[a-zA-Z0-9_-]{11}$/.test(input.trim())) playParsed(input); else runSearch(input); }}>
          <Icon name="play" size={14} /> Play
        </button>
        <button className="btn ghost" onClick={() => runSearch(searchQ || input)}>
          <Icon name="search" size={14} /> Search
        </button>
        {music && (
          <button className="btn ghost" onClick={() => openInBrowser("https://music.youtube.com")} title="Open the official YouTube Music in your browser">
            <Icon name="external" size={14} /> YouTube Music
          </button>
        )}
      </div>
      <input
        className="input"
        style={{ width: "100%", marginBottom: 14 }}
        placeholder={key ? "Search YouTube…" : "Search (needs a free API key — Settings → Online)"}
        value={searchQ}
        onChange={(e) => setSearchQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") runSearch(searchQ); }}
      />

      {/* theater player */}
      {playing && (
        <div className="card panel" style={{ padding: 10, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 4px 8px" }}>
            <Icon name="play" size={14} />
            <div style={{ flex: 1, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{playing.title}</div>
            {ytdlpOk && (
              <button className="btn ghost sm" title="Play through OMP's native engine — hardware decoded, way lighter on the CPU" onClick={() => playDecision(playing.videoId, playing.listId, playing.title)}>
                <Icon name="play" size={13} /> Native player
              </button>
            )}
            <button className="icon-btn" title="Open in browser" onClick={() => openInBrowser(playing.videoId ? `https://www.youtube.com/watch?v=${playing.videoId}` : `https://www.youtube.com/playlist?list=${playing.listId}`)}>
              <Icon name="external" size={14} />
            </button>
            <button className="icon-btn" title="Close player" onClick={() => setPlaying(null)}>
              <Icon name="close" size={14} />
            </button>
          </div>
          <div className="yt-theater">
            <iframe
              key={`${playing.videoId}|${playing.listId || ""}`}
              src={ytEmbedUrl(playing.videoId, playing.listId)}
              title={playing.title}
              allow="accelerometer; autoplay; encrypted-media; picture-in-picture; web-share"
              allowFullScreen
            />
          </div>
        </div>
      )}

      {/* search results */}
      {err && (
        <div className="card panel" style={{ padding: "14px 16px", marginBottom: 14, display: "flex", gap: 10, alignItems: "center", borderColor: "var(--warn)" }}>
          <Icon name="info" size={16} />
          <div style={{ flex: 1, fontSize: 12.5 }}>{err}</div>
          <button className="btn ghost" onClick={() => navigate("settings")}>Settings</button>
        </div>
      )}
      {busy && <div className="section-label">Searching…</div>}
      {results && results.length > 0 && (
        <>
          <div className="section-label" style={{ marginBottom: 10 }}>{music ? "Music results" : "Results"}</div>
          <div className="yt-result-grid">
            {results.map((r) => (
              <div key={r.id} className="card hover yt-result" onClick={() => playDecision(r.id, undefined, r.title)} title={canNative ? "Play in OMP's native player" : "Play in the embedded player"}>
                <div className="yt-result-thumb">
                  <img src={r.thumb} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.opacity = "0"; }} />
                  <span className={`yt-dur ${r.live ? "live" : ""}`}>{r.duration}</span>
                </div>
                <div className="yt-result-body">
                  <div className="yt-result-title" title={r.title}>{r.title}</div>
                  <div className="yt-result-meta">{r.channel}</div>
                  <div className="yt-result-meta">{r.views}{r.views && r.published ? " · " : ""}{r.published}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* curated open collection — always works, no key */}
      <div className="section-label" style={{ marginTop: results ? 26 : 8 }}>
        {music ? "Open music films" : "Open collection — Blender films, no key needed"}
      </div>
      <div className="yt-grid">
        {ONLINE_VIDEOS.filter((v) => !q || v.name.toLowerCase().includes(q)).map((v) => (
          <div key={v.id} className="card hover yt-card" onClick={() => playDecision(v.yt, undefined, v.name)}>
            <div className="yt-thumb">
              <img src={ytThumb(v.yt)} alt={v.name} loading="lazy" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              <span className="icon-btn" style={{ position: "relative", background: "rgba(18,20,26,0.65)", color: "#fff", borderRadius: 99, width: 46, height: 46, backdropFilter: "blur(8px)" }}>
                <Icon name="play" size={20} />
              </span>
            </div>
            <div className="yt-name">{v.name}</div>
            <div className="yt-src">{v.src} · YouTube</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  Live TV — import M3U/M3U8, stream through the native engine          */
/* ==================================================================== */

function TvTab({ q }: { q: string }) {
  const [channels, setChannels] = useState<IptvChannel[]>(() => loadChannels());
  const [group, setGroup] = useState<string>("*");
  const [recent, setRecent] = useState(() => loadRecent());

  useEffect(() => {
    const fn = () => { setChannels(loadChannels()); setRecent(loadRecent()); };
    window.addEventListener("omp://channels-changed", fn as EventListener);
    return () => window.removeEventListener("omp://channels-changed", fn as EventListener);
  }, []);

  const all = useMemo(() => [...BUILTIN_TV, ...channels], [channels]);
  const groups = useMemo(() => channelGroups(all), [all]);
  const sources = useMemo(() => channelSources(channels), [channels]);

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return all.filter((c) =>
      (group === "*" || (c.group || "General") === group) &&
      (!ql || c.name.toLowerCase().includes(ql) || c.group.toLowerCase().includes(ql)));
  }, [all, group, q]);

  const playChannel = (c: { name: string; url: string; logo?: string; group?: string }) => {
    customMedia.set({ name: c.name, url: c.url, live: true });
    pushRecent({ name: c.name, url: c.url, logo: c.logo, group: c.group });
    setRecent(loadRecent());
    navigate("player");
  };

  const importPlaylist = async () => {
    if (!isTauri) { toast("Playlist import runs in the desktop app", "info"); return; }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: "M3U playlist", extensions: ["m3u", "m3u8"] }],
      });
      if (typeof path !== "string") return;
      const text = await invoke<string | null>("online_read_file", { path });
      if (!text) { toast("Could not read that playlist file", "err"); return; }
      const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Playlist";
      const parsed = parseM3U(text, name);
      if (!parsed.length) { toast("No channels found in that playlist", "err"); return; }
      const { added, total } = importChannels(parsed, name);
      toast(`Imported ${added} new channel${added === 1 ? "" : "s"} (${total} total)`, "ok");
    } catch {
      toast("Import failed", "err");
    }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn" onClick={importPlaylist}><Icon name="folder" size={14} /> Import M3U / M3U8</button>
        {channels.length > 0 && (
          <button className="btn ghost" onClick={() => { if (confirm("Remove all imported channels?")) { clearChannels(); setGroup("*"); } }}>
            <Icon name="trash" size={14} /> Clear all
          </button>
        )}
        <span style={{ flex: 1 }} />
        <span className="chip"><Icon name="check" /> {all.length} channels</span>
      </div>

      {/* imported playlist sources */}
      {sources.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          {sources.map((s) => (
            <span key={s.name} className="chip badge" style={{ height: 26 }} title="Imported playlist">
              {s.name} · {s.count}
              <button
                className="chip-x"
                title="Remove this playlist"
                onClick={(e) => { e.stopPropagation(); removeChannelsBySource(s.name); }}
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* group filter */}
      {groups.length > 1 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          <button className={`chip ${group === "*" ? "badge" : ""}`} style={{ height: 26 }} onClick={() => setGroup("*")}>All</button>
          {groups.map((g) => (
            <button key={g.name} className={`chip ${group === g.name ? "badge" : ""}`} style={{ height: 26 }} onClick={() => setGroup(g.name)}>
              {g.name} · {g.count}
            </button>
          ))}
        </div>
      )}

      {/* recent */}
      {recent.length > 0 && group === "*" && !q && (
        <>
          <div className="section-label" style={{ marginBottom: 10 }}>Recently watched</div>
          <div className="radio-row" style={{ marginBottom: 20 }}>
            {recent.slice(0, 8).map((r) => (
              <div key={r.url} className="card hover radio-card" onClick={() => playChannel(r)}>
                <span className="radio-dot" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>{r.group || "Channel"}</div>
                </div>
                <Icon name="play" size={15} />
              </div>
            ))}
          </div>
        </>
      )}

      {filtered.length === 0 ? (
        <div className="empty" style={{ padding: "60px 20px" }}>
          <Icon name="cast" />
          <div className="t">{q ? "No channel matches" : "No channels yet"}</div>
          <div className="d">
            Import an M3U / M3U8 playlist (the standard IPTV format) or start with the
            built-in public channels. Streams play through OMP's native engine —
            nothing runs in the background after you stop watching.
          </div>
          {!isTauri && <span className="badge accent">Desktop feature — install the app</span>}
        </div>
      ) : (
        <div className="ch-grid">
          {filtered.map((c) => (
            <div key={c.id} className="card hover ch-card" onClick={() => playChannel(c)} title={c.url}>
              {c.logo ? (
                <img className="ch-logo" src={c.logo} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              ) : (
                <span className="ch-tile">{(c.name || "?").slice(0, 1).toUpperCase()}</span>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ch-name">{c.name}</div>
                <div className="ch-meta">{c.group}{c.source === "Built-in" ? " · Built-in" : ""}</div>
              </div>
              <span className="live-dot" title="Live stream" />
              <Icon name="play" size={15} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ==================================================================== */
/*  Radio — the real engine session (same service the Music screen uses) */
/* ==================================================================== */

function RadioTab() {
  const audio = useSyncExternalStore(audioStore.sub, audioStore.get);
  const [stations, setStations] = useState<Station[]>(() => loadStations());
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [genre, setGenre] = useState("");

  const activeUrl = audio.track?.kind === "radio" ? audio.track.src : "";
  const playingUrl = activeUrl && audio.playing ? activeUrl : "";

  const play = (s: Station) => {
    if (activeUrl === s.url) { stopSession(); return; }
    playRadio(stationToTrack(s));
  };

  const add = () => {
    if (!name.trim() || !/^https?:\/\//i.test(url.trim())) {
      toast("Station needs a name and an http(s) stream URL", "err");
      return;
    }
    addStation(name.trim(), url.trim(), genre.trim() || "Custom");
    setStations(loadStations());
    setName(""); setUrl(""); setGenre("");
    toast("Station added", "ok");
  };

  const rows = [...RADIO_PRESETS, ...stations.filter((s) => s.custom)];

  return (
    <div>
      <div className="card panel" style={{ padding: "12px 16px", marginBottom: 16, fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.8, display: "flex", gap: 10, alignItems: "center" }}>
        <Icon name="radio" size={16} />
        <span style={{ flex: 1 }}>
          Radio streams play through the same engine as your music — they keep
          playing while you browse, and the desktop widget tracks them like any track.
        </span>
        {audio.track?.kind === "radio" && (
          <button className="btn ghost" onClick={() => stopSession()}><Icon name="close" size={13} /> Stop</button>
        )}
      </div>

      {audio.track?.kind === "radio" && (
        <div className="card panel" style={{ padding: "12px 16px", marginBottom: 16, display: "flex", gap: 10, alignItems: "center" }}>
          <span className="radio-dot" style={{ background: audio.playing ? "var(--ok)" : "var(--text-3)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{audio.track.title}</div>
            <div style={{ fontSize: 11.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {audio.icy ? `♪ ${audio.icy}` : audio.track.genre || "Internet radio"}
            </div>
          </div>
          {audio.icy && <span className="chip badge" style={{ height: 24 }}>LIVE</span>}
        </div>
      )}

      <div className="radio-row">
        {rows.map((s) => {
          const isPlaying = playingUrl === s.url;
          const isActive = activeUrl === s.url;
          return (
            <div key={s.id} className={`card hover radio-card ${isActive ? "sel" : ""}`} onClick={() => play(s)}>
              <span className="radio-dot" style={{ background: isPlaying ? "var(--ok)" : undefined }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, display: "flex", gap: 6, alignItems: "center" }}>
                  {s.name}
                  {isPlaying && <span className="playing-bars" />}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>{s.genre}</div>
              </div>
              {s.custom && (
                <button className="icon-btn" title="Remove station" onClick={(e) => { e.stopPropagation(); removeStation(s.id); setStations(loadStations()); }}>
                  <Icon name="trash" size={13} />
                </button>
              )}
              <Icon name="radio" size={15} />
            </div>
          );
        })}
      </div>

      <div className="section-label" style={{ marginTop: 24, marginBottom: 10 }}>Add a station</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input className="input" style={{ width: 170 }} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" style={{ flex: 1, minWidth: 220 }} placeholder="Stream URL (https://… )" value={url} onChange={(e) => setUrl(e.target.value)} />
        <input className="input" style={{ width: 130 }} placeholder="Genre" value={genre} onChange={(e) => setGenre(e.target.value)} />
        <button className="btn" onClick={add}><Icon name="plus" size={14} /> Add</button>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 8 }}>
        Tip: most station pages publish a "direct stream link" (ends in .mp3, .aac, or an /stream URL). Paste that.
      </div>
    </div>
  );
}
