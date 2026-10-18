import { useState, useEffect, useSyncExternalStore } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import type { Settings as SettingsShape } from "../lib/store";
import { APP_VERSION, isTauri, invoke } from "../lib/tauri";
import { navigate } from "../lib/router";
import { engineStore, initEngine } from "../lib/engine";
import { resetEngineProbe, audioDiag } from "../lib/audio";
import { ffmpegStatus } from "../lib/editor";
import { loadYtKey, saveYtKey, ytTestKey, loadChannels, ytdlpStatus } from "../lib/online";
import {
  getStats, rescan as libRescan, cancelScan, onScanEvent,
  type LibraryStats,
} from "../lib/library";

type EngineDiag = {
  available: boolean;
  initialized: boolean;
  dll_path: string;
  probed_path: string;
  load_error: number;
  version: string | null;
  attempts?: string[];
};

/** Human-readable hints for the Win32 LoadLibrary error codes users hit. */
function loadErrorHint(code: number): string {
  switch (code) {
    case 2:
      return "the file was not found — reinstall OMP";
    case 5:
      return "access denied — your antivirus is most likely blocking it; add OMP to the allowlist";
    case 126:
      return "the DLL (or one of its dependencies) is missing or blocked — reinstall OMP and check your antivirus";
    case 193:
      return "wrong architecture — reinstall the 64-bit installer";
    case 1114:
      return "the DLL failed during initialisation — update your GPU driver and try again";
    default:
      return "reinstall OMP, and allow it in your antivirus if it keeps failing";
  }
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="track"><span className="thumb" /></span>
    </label>
  );
}

export function Settings({ settings, update }: { settings: SettingsShape; update: (p: Partial<SettingsShape>) => void }) {
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const eng = useSyncExternalStore(engineStore.sub, engineStore.get);
  const [diag, setDiag] = useState<EngineDiag | null>(null);
  const [ffFound, setFfFound] = useState<{ found: boolean; path: string } | null>(null);
  const [ytdlp, setYtdlp] = useState<{ available: boolean; path: string } | null>(null);
  const [key, setKey] = useState(() => loadYtKey());
  const [keyMsg, setKeyMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const [chCount, setChCount] = useState(() => loadChannels().length);
  useEffect(() => {
    const fn = () => setChCount(loadChannels().length);
    window.addEventListener("omp://channels-changed", fn as EventListener);
    return () => window.removeEventListener("omp://channels-changed", fn as EventListener);
  }, []);
  const [retesting, setRetesting] = useState(false);

  // live SQLite stats + scan status
  useEffect(() => {
    void getStats().then(setStats);
    return onScanEvent((e) => {
      if (e.phase === "done") void getStats().then(setStats);
      else setStats((s) => (s ? { ...s, scanning: true } : s));
    });
  }, []);

  // v0.6.1: real engine diagnostics — what used to be a vague "missing"
  // feeling in this screen is now an exact, visible engine status
  useEffect(() => {
    if (!isTauri) return;
    void invoke<EngineDiag>("mpv_diag").then((d) => setDiag(d));
    void ffmpegStatus().then(setFfFound);
    void ytdlpStatus().then(setYtdlp);
  }, [eng.available]);

  const scanning = !!stats?.scanning;

  const setEngine = (pref: "auto" | "mpv" | "web") => {
    update({ engine: pref });
    void initEngine(pref).then((info) => {
      if (pref !== "web" && !info.available) {
        toast("Native mpv engine not found in this install — staying on WebView", "info");
      }
    });
  };

  // v0.6.2 — re-probe the engine DLL without restarting OMP (e.g. after the
  // user whitelists it in antivirus). Also resets the audio service's
  // broken-engine latch so the native path is tried again immediately.
  const retestEngine = async () => {
    setRetesting(true);
    try {
      const ok = await invoke<boolean>("mpv_retest");
      resetEngineProbe();
      await initEngine(settings.engine);
      const d = await invoke<EngineDiag>("mpv_diag");
      setDiag(d);
      toast(
        ok ? "Engine loads now — try playing music again" : "Engine still unavailable — see the message below",
        ok ? "ok" : "err"
      );
    } finally {
      setRetesting(false);
    }
  };

  const rescan = async () => {
    if (await libRescan()) toast("Rescan started — incremental and cancellable", "info");
  };

  return (
    <div className="settings-wrap">
      <div className="page-head">
        <div className="page-title">Settings</div>
        <div className="page-sub">Everything is stored locally. No accounts, no telemetry.</div>
      </div>

      <div className="section-label">Appearance</div>
      <div className="card">
        <div className="row">
          <span className="icon-btn"><Icon name="moon" /></span>
          <div className="row-main">
            <div className="row-title">Theme</div>
          </div>
          <div className="seg">
            {(["dark", "light", "system"] as const).map((t) => (
              <button key={t} className={settings.theme === t ? "on" : ""} onClick={() => update({ theme: t })}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="palette" /></span>
          <div className="row-main">
            <div className="row-title">Accent color</div>
            <div className="row-desc">One accent, five tasteful presets</div>
          </div>
          <button className="btn sm" onClick={() => navigate("themes")}>Open Theme Studio</button>
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="sparkle" /></span>
          <div className="row-main">
            <div className="row-title">Transparency</div>
            <div className="row-desc">Glass blur strength · {Math.round(settings.transparency * 100)}%</div>
            <input
              type="range" className="slider" min={10} max={100} value={Math.round(settings.transparency * 100)}
              style={{ ["--fill" as string]: `${((settings.transparency * 100 - 10) / 90) * 100}%`, maxWidth: 280 }}
              onChange={(e) => update({ transparency: Number(e.target.value) / 100 })}
            />
          </div>
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="gauge" /></span>
          <div className="row-main">
            <div className="row-title">Effects</div>
            <div className="row-desc">Reduced mode for low-end hardware</div>
          </div>
          <div className="seg">
            {(["auto", "full", "reduced"] as const).map((m) => (
              <button key={m} className={settings.effects === m ? "on" : ""} onClick={() => update({ effects: m })}>
                {m === "auto" ? "Auto" : m === "full" ? "Full" : "Reduced"}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="list" /></span>
          <div className="row-main">
            <div className="row-title">Compact sidebar</div>
            <div className="row-desc">Icon rail instead of full-width navigation</div>
          </div>
          <Switch on={settings.sidebarRail} onChange={(v) => update({ sidebarRail: v })} />
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="film" /></span>
          <div className="row-main">
            <div className="row-title">Auto-hide sidebar during video playback</div>
            <div className="row-desc">Cinema mode — hover the left edge to peek it back</div>
          </div>
          <Switch on={settings.autoHideSidebar !== false} onChange={(v) => update({ autoHideSidebar: v })} />
        </div>
      </div>

      <div className="section-label">Playback</div>
      {isTauri && !eng.available && (
        <div className="card engine-warn">
          <span className="icon-btn" style={{ color: "var(--warn, #ffb454)" }}><Icon name="alert" /></span>
          <div className="row-main">
            <div className="row-title">Native mpv engine not active</div>
            <div className="row-desc">
              {diag && diag.load_error
                ? `The bundled engine DLL exists but Windows refused to load it (error ${diag.load_error}): ${loadErrorHint(diag.load_error)}. Music still plays via the built-in audio engine.`
                : diag && diag.dll_path
                  ? "The engine DLL was found but did not initialise — reinstalling usually fixes this. Music still plays via the built-in audio engine."
                  : "This install can't find the bundled engine. Music still plays via the built-in audio engine; videos fall back to WebView2 (higher CPU, fewer formats). Re-run the latest installer — it closes OMP and repairs locked files automatically."}
              {diag && diag.attempts && diag.attempts.length > 0 && (
                <span style={{ display: "block", marginTop: 6, fontFamily: "var(--mono, monospace)", fontSize: 11, color: "var(--text-3)" }}>
                  {diag.attempts.join(" · ")}
                </span>
              )}
            </div>
          </div>
          <button className="btn sm" disabled={retesting} onClick={() => void retestEngine()}>
            <Icon name="rotate" size={14} /> {retesting ? "Testing…" : "Re-test engine"}
          </button>
        </div>
      )}
      <div className="card">
        <div className="row">
          <span className="icon-btn"><Icon name="rocket" /></span>
          <div className="row-main">
            <div className="row-title">Playback engine</div>
            <div className="row-desc">
              {isTauri
                ? eng.kind === "mpv"
                  ? `Native mpv active${eng.version ? ` · libmpv API ${eng.version}` : ""} — VLC-grade CPU, every codec`
                  : eng.available
                    ? "WebView2 — native mpv available, pick Auto or mpv to enable"
                    : "WebView2 — native engine not bundled in this install"
                : "WebView2 — the web demo always uses the browser engine"}
            </div>
          </div>
          <div className="seg">
            {(["auto", "mpv", "web"] as const).map((m) => (
              <button key={m} className={settings.engine === m ? "on" : ""} onClick={() => setEngine(m)}>
                {m === "auto" ? "Auto" : m === "mpv" ? "mpv" : "WebView"}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="info" /></span>
          <div className="row-main">
            <div className="row-title">Copy diagnostics</div>
            <div className="row-desc">Copies engine + audio session details as text — paste it in a message when something doesn't work and it pinpoints the broken leg instantly</div>
          </div>
          <button
            className="btn sm"
            onClick={async () => {
              try {
                const shell = await invoke<Record<string, unknown>>("shell_info").catch(() => null);
                const d = await invoke<EngineDiag>("mpv_diag").catch(() => null);
                const payload = {
                  app: APP_VERSION,
                  shell,
                  engine: eng,
                  engineDiag: d,
                  ytdlp,
                  audio: audioDiag(),
                };
                await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
                toast("Diagnostics copied — paste it to the developer", "ok");
              } catch {
                toast("Could not access the clipboard", "err");
              }
            }}
          >
            <Icon name="save" size={13} /> Copy
          </button>
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="scissors" /></span>
          <div className="row-main">
            <div className="row-title">Editor exporter · FFmpeg</div>
            <div className="row-desc" style={{ wordBreak: "break-all" }}>
              {ffFound === null
                ? "Checking…"
                : ffFound.found
                  ? `Bundled — editor exports MP4 / WebM / GIF (${ffFound.path})`
                  : "Not found — reinstall the latest OMP to enable editor export"}
            </div>
          </div>
          <span className={`chip ${ffFound?.found ? "" : "kf-chip"}`} style={ffFound ? { color: ffFound.found ? "var(--accent)" : "var(--warn, #ffb454)" } : undefined}>
            {ffFound ? (ffFound.found ? "ready" : "missing") : "…"}
          </span>
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="rocket" /></span>
          <div className="row-main">
            <div className="row-title">Hardware acceleration</div>
            <div className="row-desc">Use the GPU when available · software decoding fallback stays on</div>
          </div>
          <Switch on={settings.hwAccel} onChange={(v) => update({ hwAccel: v })} />
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="download" /></span>
          <div className="row-main">
            <div className="row-title">YouTube extractor · yt-dlp</div>
            <div className="row-desc" style={{ wordBreak: "break-all" }}>
              {ytdlp === null
                ? "Checking…"
                : ytdlp.available
                  ? `Built in — keyless YouTube search + native playback of YouTube and 1000+ sites (${ytdlp.path})`
                  : "Not found — reinstall the latest OMP for keyless search and native YouTube playback"}
            </div>
          </div>
          <span className={`chip ${ytdlp?.available ? "" : "kf-chip"}`} style={ytdlp ? { color: ytdlp.available ? "var(--accent)" : "var(--warn, #ffb454)" } : undefined}>
            {ytdlp ? (ytdlp.available ? "ready" : "missing") : "…"}
          </span>
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="music" /></span>
          <div className="row-main">
            <div className="row-title">Background playback</div>
            <div className="row-desc">Closing OMP while music plays keeps it going — the desktop widget takes over</div>
          </div>
          <Switch
            on={settings.bgPlayback !== false}
            onChange={(v) => {
              update({ bgPlayback: v });
              void invoke("set_background_playback", { v });
            }}
          />
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="rocket" /></span>
          <div className="row-main">
            <div className="row-title">Default player</div>
            <div className="row-desc">OMP registers for videos, music and images — pick it in Windows "Open with", or open Default apps to set it system-wide</div>
          </div>
          <button className="btn sm" onClick={() => { void invoke("open_default_apps"); }}>
            <Icon name="external" size={14} /> Default apps
          </button>
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="gauge" /></span>
          <div className="row-main">
            <div className="row-title">Default speed</div>
          </div>
          <div className="seg">
            {[0.75, 1, 1.25, 1.5].map((r) => (
              <button key={r} className={settings.defaultSpeed === r ? "on" : ""} onClick={() => update({ defaultSpeed: r })}>
                {r === 1 ? "1×" : `${r}×`}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="stepF" /></span>
          <div className="row-main">
            <div className="row-title">Seek step (arrow keys)</div>
          </div>
          <div className="seg">
            {[5, 10, 30].map((s) => (
              <button key={s} className={settings.seekStep === s ? "on" : ""} onClick={() => update({ seekStep: s })}>
                {s}s
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="section-label">Online</div>
      <div className="card">
        <div className="row">
          <span className="icon-btn"><Icon name="play" /></span>
          <div className="row-main">
            <div className="row-title">YouTube Data API key</div>
            <div className="row-desc">
              Optional — search already works out of the box through the built-in extractor. A key makes
              search faster and richer (durations, view counts); free tier is 10,000 units/day (~5,000
              searches). The key stays in this browser profile, never uploaded.
              {" "}
              <button
                className="btn ghost sm"
                style={{ height: 22, padding: "0 8px", fontSize: 11 }}
                onClick={() => void invoke("open_url", { url: "https://developers.google.com/youtube/v3/getting-started" })}
              >
                <Icon name="external" size={11} /> How to get one
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                type="password"
                className="input"
                style={{ flex: 1, minWidth: 200, fontFamily: "var(--mono, monospace)", fontSize: 12 }}
                placeholder="AIza…"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <button
                className="btn sm"
                onClick={() => {
                  saveYtKey(key);
                  setKeyMsg(key ? "Saved" : "Cleared");
                  if (key) {
                    setTesting(true);
                    void ytTestKey(key).then((r) => {
                      setKeyMsg(`${r.ok ? "✓" : "✗"} ${r.msg}`);
                      setTesting(false);
                    });
                  }
                }}
              >
                Save & test
              </button>
            </div>
            {keyMsg && <div style={{ fontSize: 11.5, color: keyMsg.startsWith("✓") ? "var(--ok)" : keyMsg.startsWith("✗") ? "var(--err, #ff6b6b)" : "var(--text-3)", marginTop: 6 }}>{testing ? "Testing…" : keyMsg}</div>}
          </div>
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="cast" /></span>
          <div className="row-main">
            <div className="row-title">IPTV playlists</div>
            <div className="row-desc">
              {chCount > 0
                ? `${chCount} channels imported · M3U / M3U8 · streams play through the native engine`
                : "No playlists yet — import an M3U / M3U8 file on the Online → Live TV tab"}
            </div>
          </div>
          <button className="btn sm" onClick={() => navigate("online")}>
            <Icon name="cast" size={13} /> Open Live TV
          </button>
        </div>
      </div>

      <div className="section-label">Library</div>
      <div className="card">
        <div className="row">
          <span className="icon-btn"><Icon name="folder" /></span>
          <div className="row-main">
            <div className="row-title">Scan folders</div>
            <div className="row-desc">Incremental, cancellable — never blocks playback · manage folders in the Library screen</div>
          </div>
          {scanning ? (
            <button className="btn sm" onClick={() => { void cancelScan(); toast("Cancelling scan…", "info"); }}>
              <Icon name="close" size={14} /> Cancel
            </button>
          ) : (
            <button className="btn sm" onClick={() => void rescan()}><Icon name="rotate" size={14} /> Rescan</button>
          )}
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="database" /></span>
          <div className="row-main">
            <div className="row-title">Storage</div>
            <div className="row-desc">
              {stats
                ? `SQLite library · ${stats.videos} video${stats.videos === 1 ? "" : "s"} · ${stats.audio} track${stats.audio === 1 ? "" : "s"} · ${stats.thumbs} thumbnail${stats.thumbs === 1 ? "" : "s"} · ${stats.folders} folder${stats.folders === 1 ? "" : "s"}`
                : "SQLite library — stored locally"}
            </div>
          </div>
          <button className="btn sm" onClick={() => navigate("library")}><Icon name="grid" size={14} /> Open</button>
        </div>
      </div>

      <div className="section-label">About</div>
      <div className="card about-hero" style={{ borderBottom: "1px solid var(--stroke)", borderRadius: "var(--radius-lg) var(--radius-lg) 0 0" }}>
        <img src="./icon-512.png" alt="OMP" />
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 19, fontWeight: 600 }}>OMP — Open Media Player</div>
          <div style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 2 }}>Every Format. One Player. Open to All.</div>
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            <span className="badge accent">v{APP_VERSION}</span>
            <span className="badge">GPL-3.0-or-later</span>
            <span className="badge">Windows 10 · 11</span>
            <span className="badge">{isTauri ? "Desktop" : "Web demo"}</span>
          </div>
        </div>
      </div>
      {isTauri && diag && (
        <div className="card">
          <div className="row">
            <div className="row-main">
              <div className="row-title">Engine diagnostics</div>
              <div className="row-desc" style={{ wordBreak: "break-all" }}>
                {diag.available
                  ? `libmpv ${diag.version ?? "?"} · ${diag.initialized ? "engine running" : "engine ready (loads on demand)"}${diag.dll_path ? ` · ${diag.dll_path}` : ""}`
                  : diag.load_error
                    ? `Engine DLL failed to load (Windows error ${diag.load_error}) — ${loadErrorHint(diag.load_error)}${diag.probed_path ? ` · ${diag.probed_path}` : ""}`
                    : "No engine DLL found in this install — reinstall OMP."}
              </div>
            </div>
            {!diag.available && (
              <button className="btn sm" disabled={retesting} onClick={() => void retestEngine()}>
                <Icon name="rotate" size={14} /> {retesting ? "Testing…" : "Re-test"}
              </button>
            )}
            <span className="badge" style={diag.available ? { color: "var(--accent)", borderColor: "var(--accent-dim)" } : undefined}>
              {diag.available ? "OK" : "FAIL"}
            </span>
          </div>
        </div>
      )}
      <div className="card">
        <div className="row">
          <div className="row-main">
            <div className="row-title">Source code</div>
            <div className="row-desc">Built with Tauri 2 · Rust · React · TypeScript · mpv · FFmpeg · libvips</div>
          </div>
          <button className="btn sm" onClick={() => toast("Repo link lives on the project website", "info")}>
            <Icon name="external" size={14} /> GitHub
          </button>
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-title">License & notices</div>
            <div className="row-desc">GPL-3.0-or-later · dependency notices ship with every release</div>
          </div>
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-title">Privacy</div>
            <div className="row-desc">No advertising. No tracking. History and settings stay on your device.</div>
          </div>
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-title">Reset app data</div>
            <div className="row-desc">Clears settings, progress and history on this device</div>
          </div>
          <button
            className="btn sm danger"
            onClick={() => {
              ["omp.settings", "omp.progress", "omp.history"].forEach((k) => localStorage.removeItem(k));
              toast("App data cleared — reloading", "ok");
              setTimeout(() => location.reload(), 800);
            }}
          >
            <Icon name="trash" size={14} /> Reset
          </button>
        </div>
      </div>
    </div>
  );
}
