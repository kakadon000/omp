import { useState } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { isTauri, invoke } from "../lib/tauri";
import type { Settings, Theme, EffectsMode, Accent } from "../lib/store";
import {
  PRESETS,
  NAMED_ACCENT_HEX,
  deriveAccent,
  hexToRgb,
  serializeTheme,
  parseOmpTheme,
  type NamedAccent,
  type ThemePreset,
} from "../lib/theme";

const ACCENTS: { id: NamedAccent; label: string }[] = [
  { id: "blue", label: "Fluent Blue" },
  { id: "teal", label: "Quiet Teal" },
  { id: "violet", label: "Soft Violet" },
  { id: "amber", label: "Warm Amber" },
  { id: "graphite", label: "Graphite" },
];

function presetAccentHex(p: ThemePreset): string {
  return p.accent === "custom" ? p.customAccent || "#ff7a00" : NAMED_ACCENT_HEX[p.accent];
}

function presetActive(s: Settings, p: ThemePreset): boolean {
  return (
    s.theme === p.theme &&
    s.accent === p.accent &&
    (p.accent !== "custom" || (s.customAccent || "").toLowerCase() === (p.customAccent || "").toLowerCase()) &&
    Math.abs(s.transparency - p.transparency) < 0.02 &&
    s.effects === p.effects
  );
}

export function Themes({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  // local hex text field state — commits to settings on every valid change
  const [hexText, setHexText] = useState<string>(settings.customAccent || "#ff7a00");

  const applyPreset = (p: ThemePreset) => {
    update({
      theme: p.theme,
      accent: p.accent,
      customAccent: p.customAccent ?? null,
      transparency: p.transparency,
      effects: p.effects,
    });
    toast(`${p.name} theme applied`, "ok");
  };

  const commitHex = (raw: string) => {
    setHexText(raw);
    if (hexToRgb(raw)) update({ accent: "custom", customAccent: raw });
  };

  const exportTheme = async () => {
    if (!isTauri) { toast("Theme export runs in the desktop app", "info"); return; }
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: "my-omp-theme.omptheme",
        filters: [{ name: "OMP theme", extensions: ["omptheme"] }],
      });
      if (!path) return;
      const name = (path.split(/[\\/]/).pop() || "my-theme").replace(/\.omptheme$/i, "");
      const ok = await invoke<boolean>("export_theme_file", {
        path,
        contents: serializeTheme({
          v: 1,
          type: "omp-theme",
          name,
          theme: settings.theme,
          accent: settings.accent,
          customAccent: settings.customAccent,
          transparency: settings.transparency,
          effects: settings.effects,
        }),
      });
      toast(ok ? `Theme exported → ${name}.omptheme` : "Could not write the theme file", ok ? "ok" : "err");
    } catch {
      toast("Theme export failed", "err");
    }
  };

  const importTheme = async () => {
    if (!isTauri) { toast("Theme import runs in the desktop app", "info"); return; }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: "OMP theme", extensions: ["omptheme"] }],
      });
      if (typeof path !== "string") return;
      const text = await invoke<string | null>("online_read_file", { path });
      const parsed = text ? parseOmpTheme(text) : null;
      if (!parsed) { toast("Not a valid OMP theme file", "err"); return; }
      update(parsed.patch);
      if (parsed.patch.customAccent) setHexText(parsed.patch.customAccent);
      toast(`Theme "${parsed.name}" applied`, "ok");
    } catch {
      toast("Theme import failed", "err");
    }
  };

  const customDot = settings.customAccent || hexText || "#ff7a00";

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="page-head">
        <div className="page-title">Theme Studio</div>
        <div className="page-sub">Ten presets, any color you want, and themes that travel as files — export yours, import a friend's.</div>
      </div>

      <div className="section-label">Presets</div>
      <div className="preset-grid">
        {PRESETS.map((p) => {
          const on = presetActive(settings, p);
          const hex = presetAccentHex(p);
          const dark = p.theme === "dark";
          return (
            <button key={p.id} className={`preset-card ${on ? "on" : ""}`} onClick={() => applyPreset(p)} title={`Apply ${p.name}`}>
              <span className="preset-swatch" style={{ background: `linear-gradient(135deg, ${hex} ${dark ? "56" : "70"}%, ${dark ? "#14161c" : "#eef1f6"} 100%)` }}>
                <span className="preset-chip" style={{ background: hex }} />
                {on && (
                  <span className="preset-check"><Icon name="check" size={12} /></span>
                )}
              </span>
              <span className="preset-body">
                <span className="preset-name">{p.name}</span>
                <span className="preset-desc">{p.desc}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 20, alignItems: "start", marginTop: 22 }}>
        <div>
          <div className="section-label">Theme</div>
          <div className="card" style={{ padding: 14, display: "flex", gap: 10 }}>
            {(["dark", "light", "system"] as Theme[]).map((t) => (
              <button key={t} className={`swatch-accent ${settings.theme === t ? "on" : ""}`} style={{ flex: 1 }} onClick={() => update({ theme: t })}>
                <span style={{ fontSize: 13, fontWeight: 600, textTransform: "capitalize" }}>{t}</span>
              </button>
            ))}
          </div>

          <div className="section-label">Accent</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ACCENTS.map((a) => (
              <div key={a.id} className={`swatch-accent ${settings.accent === a.id ? "on" : ""}`} onClick={() => update({ accent: a.id })}>
                <span className="swatch-dot" style={{ background: NAMED_ACCENT_HEX[a.id] }} />
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{a.label}</span>
                {settings.accent === a.id && <span style={{ marginLeft: "auto", color: "var(--accent)" }}><Icon name="check" size={16} /></span>}
              </div>
            ))}

            {/* custom color row — Phase 6 */}
            <div className={`swatch-accent ${settings.accent === "custom" ? "on" : ""}`} style={{ flexWrap: "wrap" }}>
              <div className="color-pick-row" style={{ width: "100%" }}>
                <input
                  type="color"
                  aria-label="Pick a custom accent color"
                  value={/^#[0-9a-fA-F]{6}$/.test(customDot) ? customDot : "#ff7a00"}
                  onChange={(e) => commitHex(e.target.value)}
                />
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>Custom color</span>
                <input
                  className="hex-input"
                  value={hexText}
                  placeholder="#ff7a00"
                  spellCheck={false}
                  maxLength={7}
                  onChange={(e) => commitHex(e.target.value)}
                  onFocus={() => { if (settings.accent !== "custom") update({ accent: "custom", customAccent: hexText }); }}
                  style={{ marginLeft: "auto" }}
                />
              </div>
              {settings.accent === "custom" && hexToRgb(hexText) && (
                <div className="color-derived" style={{ width: "100%" }}>
                  {(() => {
                    const d = deriveAccent(hexText, settings.theme === "light" ? "light" : "dark");
                    if (!d) return null;
                    return (
                      <>
                        <span title="accent" style={{ background: d.accent }} />
                        <span title="accent-strong" style={{ background: d.strong }} />
                        <span title="accent-text · on accent" style={{ background: d.accent, color: d.text, fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>A</span>
                        <span title="accent-dim" style={{ background: d.dim, boxShadow: "inset 0 0 0 1px var(--stroke)" }} />
                        <em>derived shades update live across the whole app</em>
                      </>
                    );
                  })()}
                </div>
              )}
              {settings.accent === "custom" && (
                <span style={{ marginLeft: "auto", color: "var(--accent)" }}><Icon name="check" size={16} /></span>
              )}
            </div>
          </div>

          <div className="section-label">Transparency</div>
          <div className="card row" style={{ borderBottom: "none" }}>
            <div className="row-main">
              <div className="row-title">Glass blur strength · {Math.round(settings.transparency * 100)}%</div>
              <div className="row-desc">How strongly Mica-style surfaces blur the backdrop</div>
              <input
                type="range" className="slider" min={10} max={100} value={Math.round(settings.transparency * 100)}
                style={{ ["--fill" as string]: `${((settings.transparency * 100 - 10) / 90) * 100}%`, maxWidth: 320 }}
                onChange={(e) => update({ transparency: Number(e.target.value) / 100 })}
              />
            </div>
          </div>

          <div className="section-label">Effects</div>
          <div className="card" style={{ padding: 14, display: "flex", gap: 10, alignItems: "center" }}>
            <div className="seg">
              {(["auto", "full", "reduced"] as EffectsMode[]).map((m) => (
                <button key={m} className={settings.effects === m ? "on" : ""} onClick={() => update({ effects: m })}>
                  {m === "auto" ? "Auto" : m === "full" ? "Full" : "Reduced"}
                </button>
              ))}
            </div>
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>
              Reduced disables blur + animations for low-end PCs
            </span>
          </div>

          <div className="section-label">Import / export</div>
          <div className="card" style={{ padding: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn" onClick={() => void importTheme()}>
              <Icon name="folder" size={15} /> Import theme…
            </button>
            <button className="btn" onClick={() => void exportTheme()}>
              <Icon name="save" size={15} /> Export current theme
            </button>
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>
              .omptheme files — double-click one in Explorer to apply it instantly
            </span>
          </div>
        </div>

        {/* live preview */}
        <div>
          <div className="section-label">Live preview</div>
          <div className="theme-preview glass" style={{ background: "var(--surface)" }}>
            <div className="tp-bar" style={{ borderBottom: "1px solid var(--stroke)" }}>
              <img src="./favicon.png" alt="" style={{ width: 16, height: 16, borderRadius: 5 }} />
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em" }}>OMP</span>
              <span style={{ flex: 1 }} />
              <span className="tp-dot" style={{ background: "var(--accent)" }} />
              <span className="tp-dot" style={{ background: "var(--surface-3)" }} />
            </div>
            <div className="tp-body" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <span className="tp-chip" style={{ background: "var(--accent)", color: "var(--accent-text)", fontWeight: 600 }}>Play</span>
                <span className="tp-chip" style={{ background: "var(--surface-2)", border: "1px solid var(--stroke)" }}>Pause</span>
                <span className="tp-chip" style={{ background: "var(--accent-dim)", color: "var(--accent)", fontWeight: 600 }}>1.5×</span>
              </div>
              <div className="bar-track"><div className="bar-fill" style={{ width: "62%" }} /></div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="icon-btn sm" style={{ background: "var(--surface-2)" }}><Icon name="prev" size={13} /></span>
                <span className="icon-btn sm" style={{ background: "var(--accent)", color: "var(--accent-text)" }}><Icon name="play" size={13} /></span>
                <span className="icon-btn sm" style={{ background: "var(--surface-2)" }}><Icon name="next" size={13} /></span>
                <span style={{ fontSize: 11, color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>1:12 / 3:40</span>
              </div>
            </div>
          </div>
          <button
            className="btn" style={{ width: "100%", marginTop: 12 }}
            onClick={() => { update({ theme: "dark", accent: "blue", customAccent: null, transparency: 0.78, effects: "auto" }); setHexText("#ff7a00"); toast("Theme reset to defaults", "ok"); }}
          >
            <Icon name="undo" size={15} /> Reset to defaults
          </button>
          <div className="card" style={{ marginTop: 12, padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Theme files travel</div>
            <div style={{ fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.5 }}>
              Export writes a small <code style={{ fontFamily: "var(--mono)" }}>.omptheme</code> file with your theme, accent and effects. Anyone can double-click it to get the exact same look — perfect for sharing your setup.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
