import { useState, useSyncExternalStore } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import type { Settings } from "../lib/store";
import { APP_VERSION, isTauri } from "../lib/tauri";
import { navigate } from "../lib/router";
import { engineStore, initEngine } from "../lib/engine";

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="track"><span className="thumb" /></span>
    </label>
  );
}

export function Settings({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const [scanning, setScanning] = useState(false);
  const eng = useSyncExternalStore(engineStore.sub, engineStore.get);

  const setEngine = (pref: "auto" | "mpv" | "web") => {
    update({ engine: pref });
    void initEngine(pref).then((info) => {
      if (pref !== "web" && !info.available) {
        toast("Native mpv engine not found in this install — staying on WebView", "info");
      }
    });
  };

  const rescan = () => {
    setScanning(true);
    setTimeout(() => {
      setScanning(false);
      toast("Library scan complete — incremental, cancellable (Phase 2 brings the real scanner)", "ok");
    }, 1400);
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
          <span className="icon-btn"><Icon name="rocket" /></span>
          <div className="row-main">
            <div className="row-title">Hardware acceleration</div>
            <div className="row-desc">Use the GPU when available · software decoding fallback stays on</div>
          </div>
          <Switch on={settings.hwAccel} onChange={(v) => update({ hwAccel: v })} />
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

      <div className="section-label">Library</div>
      <div className="card">
        <div className="row">
          <span className="icon-btn"><Icon name="folder" /></span>
          <div className="row-main">
            <div className="row-title">Scan folders</div>
            <div className="row-desc">Incremental, cancellable — never blocks playback</div>
          </div>
          {scanning ? <div className="spinner" /> : <button className="btn sm" onClick={rescan}><Icon name="rotate" size={14} /> Rescan</button>}
        </div>
        <div className="row">
          <span className="icon-btn"><Icon name="database" /></span>
          <div className="row-main">
            <div className="row-title">Storage</div>
            <div className="row-desc">SQLite library arrives in Phase 2 · settings use local storage today</div>
          </div>
          <span className="badge">12 items indexed</span>
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
