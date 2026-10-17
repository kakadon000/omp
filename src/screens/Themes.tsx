import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import type { Settings, Accent, Theme, EffectsMode } from "../lib/store";

const ACCENTS: { id: Accent; label: string; dot: string }[] = [
  { id: "blue", label: "Fluent Blue", dot: "#4cc2ff" },
  { id: "teal", label: "Quiet Teal", dot: "#45d0c8" },
  { id: "violet", label: "Soft Violet", dot: "#b6a6ff" },
  { id: "amber", label: "Warm Amber", dot: "#ffc76b" },
  { id: "graphite", label: "Graphite", dot: "#c2c7d4" },
];

export function Themes({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  return (
    <div style={{ maxWidth: 780 }}>
      <div className="page-head">
        <div className="page-title">Theme Studio</div>
        <div className="page-sub">One accent. Two themes. Full control over effects. Import/export arrives in Phase 6.</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 20, alignItems: "start" }}>
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
                <span className="swatch-dot" style={{ background: a.dot }} />
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{a.label}</span>
                {settings.accent === a.id && <span style={{ marginLeft: "auto", color: "var(--accent)" }}><Icon name="check" size={16} /></span>}
              </div>
            ))}
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
            onClick={() => { update({ theme: "dark", accent: "blue", transparency: 0.65, effects: "auto" }); toast("Theme reset to defaults", "ok"); }}
          >
            <Icon name="undo" size={15} /> Reset to defaults
          </button>
        </div>
      </div>
    </div>
  );
}
