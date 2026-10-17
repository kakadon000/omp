import { useEffect, useMemo, useState } from "react";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toast";
import { ContextMenuHost } from "./components/ContextMenu";
import { ShortcutsModal, SHORTCUT_GROUPS } from "./components/ShortcutsModal";
import { useRoute, navigate, type Route } from "./lib/router";
import { getShellInfo, invoke, isTauri } from "./lib/tauri";
import {
  loadSettings, saveSettings, applySettings,
  type Settings,
} from "./lib/store";
import { Home } from "./screens/Home";
import { Player } from "./screens/Player";
import { Music, NowPlayingBar } from "./screens/Music";
import { Gallery } from "./screens/Gallery";
import { Editor } from "./screens/Editor";
import { Online } from "./screens/Online";
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
      case "editor": return <Editor />;
      case "online": return <Online query={query} />;
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
