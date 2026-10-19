import { Component, lazy, Suspense, useEffect, useRef, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { Toasts, toast } from "./components/Toast";
import { Icon } from "./components/Icon";
import { ContextMenuHost } from "./components/ContextMenu";
import { ShortcutsModal, SHORTCUT_GROUPS } from "./components/ShortcutsModal";
import { useRoute, navigate, type Route } from "./lib/router";
import { getShellInfo, invoke, isTauri, tauriListen, APP_VERSION } from "./lib/tauri";
import { initEngine } from "./lib/engine";
import {
  loadSettings, saveSettings, applySettings,
  customMedia, externalImage,
  type Settings,
} from "./lib/store";
import { fileSrc } from "./lib/library";
import { playTracks, type AudioTrack } from "./lib/audio";
import { openProjectPath } from "./lib/editor";
import { parseM3U, importChannels } from "./lib/online";
import { parseOmpTheme } from "./lib/theme";
import { Home } from "./screens/Home";
import { Player } from "./screens/Player";
import { Music, NowPlayingBar } from "./screens/Music";
import { Gallery } from "./screens/Gallery";
import { Editor } from "./screens/Editor";
import { Downloader } from "./screens/Downloader";
// Online screen is code-split (bundled ≠ loaded: iframes + search UI only
// download when first visited)
const Online = lazy(() =>
  import("./screens/Online").then((m) => ({ default: m.Online })),
);
import { WidgetPage } from "./screens/Widget";
import { Library } from "./screens/Library";
import { Themes } from "./screens/Themes";
import { Settings as SettingsScreen } from "./screens/Settings";

// v0.14.1 — the lazy Online chunk (iframes + search UI) failed to load once →
// the Suspense fallback ("Loading online…") used to sit there forever. React
// routes lazy-load rejections to the nearest error boundary — this one gives
// the user a retry instead of an eternal spinner.
class OnlineBoundary extends Component<{ children: ReactNode }, { err: boolean }> {
  state = { err: false };
  static getDerivedStateFromError() { return { err: true }; }
  render() {
    if (this.state.err) {
      return (
        <div className="empty" style={{ padding: 80 }}>
          <div className="t">Online failed to load</div>
          <div style={{ fontSize: 12.5, color: "var(--text-3)", margin: "8px 0 14px" }}>
            The screen module didn't arrive — usually a one-off.
          </div>
          <button className="btn accent" onClick={() => this.setState({ err: false })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

const ROUTE_ORDER: Route[] = [
  "home", "player", "music", "gallery", "editor",
  "online", "downloads", "widget", "library", "themes", "settings",
];

// v0.15.0 — the splash is a FIRST-LAUNCH luxury. localStorage remembers the
// first successful boot; every launch after: no in-app overlay, and the native
// splash is closed with zero wait (the Rust side never even shows it again —
// the main window appears instantly from the setup hook).
const FIRST_BOOT = (() => {
  try {
    const seen = localStorage.getItem("omp.launched.v1");
    localStorage.setItem("omp.launched.v1", "1");
    return !seen;
  } catch { return true; }
})();

export default function App() {
  const route = useRoute();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [query, setQuery] = useState("");
  const [booted, setBooted] = useState(false);
  const [bootGone, setBootGone] = useState(false);
  const [vidPlaying, setVidPlaying] = useState(false);
  const [peek, setPeek] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // v0.15.2 — the last session crashed (session.dirty was found at boot): OMP
  // auto-recovered into maximum-compatibility mode and tells the user here,
  // with a one-tap crash report so "it crashes" finally arrives WITH data.
  const [crashRecov, setCrashRecov] = useState(false);
  // latest media-entry router, shared with the drag & drop subscription
  const openPathRef = useRef<(p: string) => void>(() => {});
  // v0.15.1 — safe graphics mode (Rust launches the webview with --disable-gpu
  // when this machine's GPU path broke): glass effects stay reduced no matter
  // what the settings say, software-rasterized backdrop blur is a CPU fire
  const safeGfx = useRef(false);

  // boot: apply settings, close the native splash, THEN idle-work
  useEffect(() => {
    // v0.15.1 — React is alive: retire the static boot hero (index.html) so
    // the real UI takes over, and mark the document for the pre-React
    // watchdog (it stops messaging once this flag lands).
    document.documentElement.dataset.react = "1";
    document.getElementById("omp-hero")?.remove();
    applySettings(settings);
    void initEngine(settings.engine); // resolve mpv availability before the Player mounts
    // v0.15.0 — first paint beats everything: OS info, the update nudge and
    // every other nice-to-have wait ~2.5s so the window is UP instantly.
    const idle = setTimeout(() => {
      getShellInfo().then((info) => {
        if (info && info.win !== "other") document.documentElement.dataset.win = info.win;
      }).catch(() => { /* cosmetic — Windows-generation styling only */ });
      // v0.13.0 — a quiet weekly update nudge; fires only when a newer
      // release actually exists, and never nags more than once a week
      const UPD_KEY = "omp.updatecheck.at";
      if (isTauri && Date.now() - Number(localStorage.getItem(UPD_KEY) || 0) > 7 * 24 * 3600 * 1000) {
        localStorage.setItem(UPD_KEY, String(Date.now()));
        void invoke<{ latest: string; url: string; newer: boolean } | null>("check_update", { current: APP_VERSION })
          .then((r) => {
            if (r?.newer) toast(`OMP v${r.latest} is out — Settings → About → Get v${r.latest}`, "info");
          })
          .catch(() => { /* offline — silence is fine for a background nudge */ });
      }
    }, 2500);
    // v0.15.1 — BOOT HANDSHAKE (React side). The window is shown only when
    // the shell answers ui_ready; the inline script in index.html already
    // pings too, this is the backup that survives everything else. Retries
    // absorb a slow IPC bridge on cold machines.
    let hs = 0;
    const handshake = () => {
      hs++;
      if (isTauri) {
        invoke<{ safe?: boolean; crashed?: boolean }>("ui_ready")
          .then((r) => {
            // window is up — the pre-React paint watch may start now
            (window as unknown as { __ompStartPaintWatch?: () => void }).__ompStartPaintWatch?.();
            if (r?.safe) {
              safeGfx.current = true;
              document.documentElement.classList.add("reduced");
              toast("Safe graphics mode — GPU rendering was unstable on this machine", "info");
            }
            // v0.15.2 — the previous session died without a goodbye. OMP is
            // already running software UI + software video this launch.
            if (r?.crashed) setCrashRecov(true);
          })
          .catch(() => { if (hs < 40) setTimeout(handshake, 350); });
      }
    };
    handshake();
    const t = setTimeout(() => {
      setBooted(true);
      // first launch only: retire the native splash (retrying — the IPC
      // bridge can lag behind the 900ms mark on slow disks)
      if (isTauri && FIRST_BOOT) {
        let cs = 0;
        const bye = () =>
          invoke("close_splash").catch(() => { if (++cs < 30) setTimeout(bye, 350); });
        bye();
      }
    }, FIRST_BOOT ? 900 : 0);
    // fully unmount the boot overlay shortly after the fade — an invisible
    // overlay with an infinite loading animation burns CPU forever
    const t2 = setTimeout(() => setBootGone(true), FIRST_BOOT ? 1500 : 120);
    return () => { clearTimeout(idle); clearTimeout(t); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v0.10.1 — SELF-HEAL: if a core component is missing/blocked on this machine
  // (antivirus quarantine is the usual suspect), auto-run the official repair
  // once per 24h instead of waiting for the user to discover the button.
  // Only engine + yt-dlp (the "nothing plays" family) — ffmpeg is 164 MB and
  // editor-only, so it stays manual. Progress/completion still lands in
  // Settings → Engine & tools; toasts here make it visible anywhere.
  useEffect(() => {
    if (!isTauri) return;
    let un: (() => void) | undefined;
    const AUTO_KEY = "omp.autorepair.at";
    type Comp = { name: string; present: boolean };
    type Health = { engine_loads: boolean; components: Comp[] };
    // v0.15.0 — the health probe waits 3s: opening the app must never race
    // the first paint, even against a slow disk
    const probe = setTimeout(() => {
      void invoke<Health>("omp_health").then((h) => {
        if (!h || !Array.isArray(h.components)) return;
        const eng = h.components.find((c) => c.name === "engine");
        const ytdlp = h.components.find((c) => c.name === "ytdlp");
        let kind = "";
        if (!eng?.present || !h.engine_loads) kind = "engine";
        else if (ytdlp && !ytdlp.present) kind = "ytdlp";
        if (!kind) return;
        const last = Number(localStorage.getItem(AUTO_KEY) || 0);
        if (Date.now() - last < 24 * 3600 * 1000) return;
        localStorage.setItem(AUTO_KEY, String(Date.now()));
        toast("Engine files are broken — auto-repair is running in the background ⚡", "info");
        void invoke<boolean>("omp_repair_download", { kind });
      }).catch(() => { /* health probe is best-effort at boot */ });
    }, 3000);
    void tauriListen<{ kind: string; phase: string }>("omp://repair", (e) => {
      if (e.phase === "done" && e.kind === "engine") {
        toast("Engine repaired — native playback restored ⚡", "ok");
      } else if (e.phase === "error" && e.kind === "engine") {
        toast("Auto-repair failed — Settings → Engine & tools has the details", "err");
      }
    }).then((fn) => { un = fn; });
    return () => { clearTimeout(probe); un?.(); };
  }, []);

  // player tells us when video is actually playing → auto-hide the sidebar
  useEffect(() => {
    const on = (e: Event) => setVidPlaying(!!(e as CustomEvent<{ playing?: boolean }>).detail?.playing);
    window.addEventListener("omp:video-state", on);
    return () => window.removeEventListener("omp:video-state", on);
  }, []);

  // app-wide hotkeys: ? shortcuts · Ctrl+K search · Alt+1..0 screens
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable));
      if (e.key === "?" && !typing) {
        e.preventDefault();
        setKeysOpen((o) => !o);
        return;
      }
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        (document.querySelector(".search-box input") as HTMLInputElement | null)?.focus();
        return;
      }
      if (e.altKey && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        const idx = Number(e.key) === 0 ? 9 : Number(e.key) - 1;
        navigate(ROUTE_ORDER[idx]);
        return;
      }
    };
    const onShowKeys = () => setKeysOpen(true);
    window.addEventListener("keydown", on);
    window.addEventListener("omp:show-keys", onShowKeys);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("omp:show-keys", onShowKeys);
    };
  }, []);

  // "Open with OMP" / default-player launches: media files arrive via the
  // command line (drained once) and via omp://open-path for later launches.
  useEffect(() => {
    if (!isTauri) return;
    const AUDIO = new Set(["mp3", "flac", "m4a", "wav", "ogg", "oga", "opus", "aac", "wma"]);
    const IMAGE = new Set(["jpg", "jpeg", "png", "webp", "bmp", "gif", "avif", "tif", "tiff"]);
    const openPath = (p: string) => {
      if (!p) return;
      const ext = (p.split(".").pop() || "").toLowerCase();
      const name = p.split(/[\\/]/).pop() || p;
      if (ext === "ompj") {
        void openProjectPath(p).then((ok) => {
          if (ok) navigate("editor");
        });
      } else if (ext === "m3u" || ext === "m3u8") {
        // IPTV playlist → import into Online → Live TV, then land there
        void invoke<string | null>("online_read_file", { path: p }).then((text) => {
          if (!text) { toast("Could not read that playlist", "err"); return; }
          const parsed = parseM3U(text, name);
          if (!parsed.length) { toast("No channels found in that playlist", "err"); return; }
          const { added, total } = importChannels(parsed, name);
          toast(`Imported ${added} new channel${added === 1 ? "" : "s"} (${total} total)`, "ok");
          navigate("online");
        });
      } else if (ext === "omptheme") {
        // Phase 6: double-clicked theme file → validate + apply instantly
        void invoke<string | null>("online_read_file", { path: p }).then((text) => {
          const parsed = text ? parseOmpTheme(text) : null;
          if (!parsed) { toast("Not a valid OMP theme file", "err"); return; }
          update(parsed.patch);
          toast(`Theme "${parsed.name}" applied`, "ok");
          navigate("themes");
        });
      } else if (AUDIO.has(ext)) {
        const t: AudioTrack = {
          id: p, kind: "file", src: p, title: name,
          artist: "External file", album: "", thumb: "", duration: 0,
        };
        playTracks([t], 0);
        navigate("music");
      } else if (IMAGE.has(ext)) {
        externalImage.set({ img: { path: p, name } });
        navigate("gallery");
      } else {
        customMedia.set({ name, url: fileSrc(p), path: p, startAt: 0 });
        navigate("player");
      }
    };
    void invoke<string[]>("pending_open_paths").then((ps) => ps?.forEach(openPath)).catch(() => { /* best-effort at boot */ });
    openPathRef.current = openPath; // drag & drop reuses this exact routing
    let un: (() => void) | undefined;
    void tauriListen<string>("omp://open-path", openPath).then((fn) => { un = fn; });
    return () => { un?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v0.13.0 — drag & drop anything: files dropped anywhere on the window take
  // the exact same route as "Open with OMP" (video → Player, audio → Music,
  // images → Gallery, .m3u → Live TV, .omptheme → Theme Studio, .ompj → Editor)
  useEffect(() => {
    if (!isTauri) return;
    let un: (() => void) | undefined;
    let alive = true;
    void getCurrentWebview().onDragDropEvent((ev) => {
      const e = ev.payload;
      if (e.type === "drop") {
        setDragOver(false);
        (e.paths ?? []).forEach((p) => openPathRef.current(p));
      } else if (e.type === "leave") {
        setDragOver(false);
      } else {
        setDragOver(true); // enter / over
      }
    }).then((fn) => { if (alive) un = fn; else fn(); });
    return () => { alive = false; un?.(); };
  }, []);

  const update = (patch: Partial<Settings>) => {
    setSettings((cur) => {
      const next = { ...cur, ...patch };
      saveSettings(next);
      applySettings(next);
      // safe mode holds the effects down even if settings ask for full glass
      if (safeGfx.current) document.documentElement.classList.add("reduced");
      return next;
    });
  };

  const toggleTheme = () =>
    update({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" });

  const toggleEffects = () =>
    update({ effects: document.documentElement.classList.contains("reduced") ? "full" : "reduced" });

  // v0.15.2 — one tap: the FULL flight-recorder report (boot log, safe-mode
  // decisions, WebView2 version, engine probe trail) into the clipboard
  const copyCrashReport = async () => {
    try {
      const text = (await invoke<string>("omp_diag_pack")) ?? "";
      await navigator.clipboard.writeText(text);
      toast("Crash report copied — paste it to the developer", "ok");
    } catch {
      toast("Could not copy the crash report", "err");
    }
  };

  const hideSidebar = route === "player" && vidPlaying && settings.autoHideSidebar !== false;

  const screen = useMemo(() => {
    switch (route) {
      case "player": return <Player settings={settings} />;
      case "music": return <Music query={query} />;
      case "gallery": return <Gallery query={query} />;
      case "editor": return <Editor settings={settings} />;
      case "online": return <OnlineBoundary><Suspense fallback={<div className="empty" style={{ padding: 80 }}><div className="t">Loading online…</div></div>}><Online query={query} /></Suspense></OnlineBoundary>;
      case "downloads": return <Downloader />;
      case "widget": return <WidgetPage />;
      case "library": return <Library query={query} />;
      case "themes": return <Themes settings={settings} update={update} />;
      case "settings": return <SettingsScreen settings={settings} update={update} />;
      default: return <Home query={query} />;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, query, settings]);

  return (
    <>
      {/* VLC-style: the native menu is ours — right-click anywhere for context
          actions (inputs keep their native menu for copy/paste) */}
      <div
        className={`shell ${hideSidebar ? "video-playing" : ""}`}
        onContextMenu={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) return;
          e.preventDefault();
        }}
      >
        <TitleBar
          query={query}
          onQuery={setQuery}
          onToggleTheme={toggleTheme}
          theme={(document.documentElement.dataset.theme as "dark" | "light") || "dark"}
          onToggleEffects={toggleEffects}
          effectsReduced={document.documentElement.classList.contains("reduced")}
        />
        <div className="shell-body">
          {hideSidebar && (
            <div
              className="sidebar-peek"
              onMouseEnter={() => setPeek(true)}
              aria-hidden="true"
            />
          )}
          <Sidebar
            rail={settings.sidebarRail}
            peek={hideSidebar && peek}
            onPeekEnd={() => setPeek(false)}
          />
          <main className={`main ${route === "player" ? "no-pad" : ""}`} style={{ position: "relative" }}>
            {screen}
          </main>
        </div>
      </div>

      {route !== "player" && <NowPlayingBar />}
      {crashRecov && (
        <div className="crash-banner" role="status">
          <span className="cb-ico"><Icon name="restore" size={20} /></span>
          <div className="cb-txt">
            <div className="cb-t">OMP didn&apos;t close cleanly last time</div>
            <div className="cb-s">This launch runs in maximum-compatibility mode — software UI and software video, so it should survive anything. If it crashed while playing something, send the report.</div>
          </div>
          <div className="cb-row">
            <button className="btn accent" onClick={() => { void copyCrashReport(); }}>
              <Icon name="info" size={14} /> Copy crash report
            </button>
            <button className="btn" onClick={() => setCrashRecov(false)}>
              <Icon name="check" size={14} /> Got it
            </button>
          </div>
        </div>
      )}
      {dragOver && (
        <div className="drop-veil" aria-hidden="true">
          <div className="dv-box">
            <Icon name="download" size={30} />
            <div className="dv-t">Drop to play</div>
            <div className="dv-s">Video · Music · Images · Playlists (.m3u) · Themes (.omptheme)</div>
          </div>
        </div>
      )}
      <Toasts />
      <ContextMenuHost />
      {keysOpen && <ShortcutsModal groups={SHORTCUT_GROUPS} onClose={() => setKeysOpen(false)} />}

      {/* boot splash — FIRST LAUNCH ONLY (v0.15.0): repeat launches show
          the app instantly; the web fallback splash is skipped entirely */}
      {!bootGone && FIRST_BOOT && (
        <div className={`boot ${booted ? "done" : ""}`} aria-hidden={booted}>
          <div className="card">
            <img src="./icon-512.png" alt="OMP" />
            <div className="word">OMP</div>
            <div className="tag">Every Format. One Player. Open to All.</div>
            <div className="bar"><i /></div>
          </div>
        </div>
      )}
    </>
  );
}
