import { useEffect, useMemo, useState } from "react";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toast";
import { useRoute } from "./lib/router";
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

export default function App() {
  const route = useRoute();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [query, setQuery] = useState("");
  const [booted, setBooted] = useState(false);

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
    return () => clearTimeout(t);
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
      <div className="shell">
        <TitleBar
          query={query}
          onQuery={setQuery}
          onToggleTheme={toggleTheme}
          theme={(document.documentElement.dataset.theme as "dark" | "light") || "dark"}
          onToggleEffects={toggleEffects}
          effectsReduced={document.documentElement.classList.contains("reduced")}
        />
        <div className="shell-body">
          <Sidebar rail={settings.sidebarRail} />
          <main className={`main ${route === "player" ? "no-pad" : ""}`} style={{ position: "relative" }}>
            {screen}
          </main>
        </div>
      </div>

      {route !== "player" && <NowPlayingBar />}
      <Toasts />

      {/* boot splash (native app uses the real splash window; web shows this) */}
      <div className={`boot ${booted ? "done" : ""}`} aria-hidden={booted}>
        <div className="card">
          <img src="./icon-512.png" alt="OMP" />
          <div className="word">OMP</div>
          <div className="tag">Every Format. One Player. Open to All.</div>
          <div className="bar"><i /></div>
        </div>
      </div>
    </>
  );
}
