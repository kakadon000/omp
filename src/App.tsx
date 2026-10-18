import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { Toasts, toast } from "./components/Toast";
import { ContextMenuHost } from "./components/ContextMenu";
import { ShortcutsModal, SHORTCUT_GROUPS } from "./components/ShortcutsModal";
import { useRoute, navigate, type Route } from "./lib/router";
import { getShellInfo, invoke, isTauri, tauriListen } from "./lib/tauri";
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
// Online screen is code-split (bundled ≠ loaded: iframes + search UI only
// download when first visited)
const Online = lazy(() =>
  import("./screens/Online").then((m) => ({ default: m.Online })),
);
import { WidgetPage } from "./screens/Widget";
import { Library } from "./screens/Library";
import { Themes } from "./screens/Themes";
import { Settings as SettingsScreen } from "./screens/Settings";

const ROUTE_ORDER: Route[] = [
  "home", "player", "music", "gallery", "editor",
  "online", "widget", "library", "themes", "settings",
];

export default function App() {
  const route = useRoute();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [query, setQuery] = useState("");
  const [booted, setBooted] = useState(false);
  const [bootGone, setBootGone] = useState(false);
  const [vidPlaying, setVidPlaying] = useState(false);
  const [peek, setPeek] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);

  // boot: apply settings, ask the shell for OS info, close native splash
  useEffect(() => {
    applySettings(settings);
    void initEngine(settings.engine); // resolve mpv availability before the Player mounts
    getShellInfo().then((info) => {
      if (info && info.win !== "other") document.documentElement.dataset.win = info.win;
    });
    const t = setTimeout(() => {
      setBooted(true);
      if (isTauri) invoke("close_splash");
    }, 900);
    // fully unmount the boot overlay shortly after the fade — an invisible
    // overlay with an infinite loading animation burns CPU forever
    const t2 = setTimeout(() => setBootGone(true), 1500);
    return () => { clearTimeout(t); clearTimeout(t2); };
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
    void tauriListen<{ kind: string; phase: string }>("omp://repair", (e) => {
      if (e.phase === "done" && e.kind === "engine") {
        toast("Engine repaired — native playback restored ⚡", "ok");
      } else if (e.phase === "error" && e.kind === "engine") {
        toast("Auto-repair failed — Settings → Engine & tools has the details", "err");
      }
    }).then((fn) => { un = fn; });
    return () => { un?.(); };
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
    void invoke<string[]>("pending_open_paths").then((ps) => ps?.forEach(openPath));
    let un: (() => void) | undefined;
    void tauriListen<string>("omp://open-path", openPath).then((fn) => { un = fn; });
    return () => { un?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (patch: Partial<Settings>) => {
    setSettings((cur) => {
      const next = { ...cur, ...patch };
      saveSettings(next);
      applySettings(next);
      return next;
    });
  };

  const toggleTheme = () =>
    update({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" });

  const toggleEffects = () =>
    update({ effects: document.documentElement.classList.contains("reduced") ? "full" : "reduced" });

  const hideSidebar = route === "player" && vidPlaying && settings.autoHideSidebar !== false;

  const screen = useMemo(() => {
    switch (route) {
      case "player": return <Player settings={settings} />;
      case "music": return <Music query={query} />;
      case "gallery": return <Gallery query={query} />;
      case "editor": return <Editor settings={settings} />;
      case "online": return <Suspense fallback={<div className="empty" style={{ padding: 80 }}><div className="t">Loading online…</div></div>}><Online query={query} /></Suspense>;
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
      <Toasts />
      <ContextMenuHost />
      {keysOpen && <ShortcutsModal groups={SHORTCUT_GROUPS} onClose={() => setKeysOpen(false)} />}

      {/* boot splash (native app uses the real splash window; web shows this) */}
      {!bootGone && (
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
