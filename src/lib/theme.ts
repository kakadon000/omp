// Phase 6 — Theme Studio engine.
// Color math for custom accents, the built-in preset gallery, and
// .omptheme import/export (serialize + validate). Standalone on purpose:
// no imports from the store, so store.ts can pull from here without cycles.

export type ThemeMode = "dark" | "light";
export type NamedAccent = "blue" | "teal" | "violet" | "amber" | "graphite";
export type AccentChoice = NamedAccent | "custom";
export type Effects = "auto" | "full" | "reduced";

export type ThemePreset = {
  id: string;
  name: string;
  desc: string;
  theme: ThemeMode;
  accent: AccentChoice;
  customAccent?: string; // hex when accent === "custom"
  transparency: number;
  effects: Effects;
};

/** Built-in gallery. Custom-accent presets double as a showcase for the
 *  custom color engine — the accent hexes below are not in tokens.css. */
export const PRESETS: ThemePreset[] = [
  { id: "fluent-dark", name: "Fluent Dark", desc: "The OMP signature", theme: "dark", accent: "blue", transparency: 0.78, effects: "auto" },
  { id: "fluent-light", name: "Fluent Light", desc: "Clean daylight glass", theme: "light", accent: "blue", transparency: 0.78, effects: "auto" },
  { id: "ocean", name: "Ocean", desc: "Deep water glass", theme: "dark", accent: "teal", transparency: 0.85, effects: "auto" },
  { id: "sunset", name: "Sunset", desc: "Warm coral glow", theme: "dark", accent: "custom", customAccent: "#ff8a50", transparency: 0.8, effects: "auto" },
  { id: "rose", name: "Rose", desc: "Soft pink neon", theme: "dark", accent: "custom", customAccent: "#ff6b8a", transparency: 0.82, effects: "auto" },
  { id: "forest", name: "Forest", desc: "Calm green glass", theme: "dark", accent: "custom", customAccent: "#58c776", transparency: 0.78, effects: "auto" },
  { id: "cyberpunk", name: "Cyberpunk", desc: "Hot magenta, full FX", theme: "dark", accent: "custom", customAccent: "#ff2e88", transparency: 0.88, effects: "full" },
  { id: "nord", name: "Nord", desc: "Frost blue, low blur", theme: "dark", accent: "custom", customAccent: "#88c0d0", transparency: 0.6, effects: "auto" },
  { id: "gold", name: "Gold", desc: "Champagne luxury", theme: "dark", accent: "custom", customAccent: "#ffc94d", transparency: 0.75, effects: "auto" },
  { id: "paper", name: "Paper", desc: "Flat light, minimal blur", theme: "light", accent: "graphite", transparency: 0.3, effects: "reduced" },
];

/** Named-accent swatch colors (matches tokens.css, used for preset art). */
export const NAMED_ACCENT_HEX: Record<NamedAccent, string> = {
  blue: "#4cc2ff",
  teal: "#45d0c8",
  violet: "#b6a6ff",
  amber: "#ffc76b",
  graphite: "#c2c7d4",
};

/* ------------------------------ color math ------------------------------ */

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear mix of `hex` toward `other` by `amount` (0..1). */
export function mixHex(hex: string, other: string, amount: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(other);
  if (!a || !b) return hex;
  const t = Math.min(1, Math.max(0, amount));
  return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}

/** WCAG relative luminance, 0 (black) .. 1 (white). */
export function relLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const lin = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export type DerivedAccent = { accent: string; strong: string; text: string; dim: string };

/** Derive the four accent CSS variables from any base hex, following the same
 *  visual rules as the named palettes in tokens.css:
 *  - dark theme: light accent on dark glass, dark label text on accent, 14% dim
 *  - light theme: accent darkened until readable on white, white label text, 10% dim
 *  Very dark colors are lifted in dark mode (invisible on glass otherwise). */
export function deriveAccent(hex: string, mode: ThemeMode): DerivedAccent | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  const dim = mode === "dark" ? 0.14 : 0.1;
  if (mode === "dark") {
    let eff = hex.trim().toLowerCase();
    if (!eff.startsWith("#")) eff = `#${eff}`;
    if (relLuminance(eff) < 0.16) eff = mixHex(eff, "#ffffff", 0.5);
    const text = relLuminance(eff) > 0.45 ? mixHex(eff, "#000000", 0.78) : "#ffffff";
    return {
      accent: eff,
      strong: mixHex(eff, "#000000", 0.22),
      text,
      dim: `rgba(${r}, ${g}, ${b}, ${dim})`,
    };
  }
  let eff = hex.trim().toLowerCase();
  if (!eff.startsWith("#")) eff = `#${eff}`;
  if (relLuminance(eff) > 0.5) eff = mixHex(eff, "#000000", 0.52);
  return {
    accent: eff,
    strong: mixHex(eff, "#ffffff", 0.14),
    text: "#ffffff",
    dim: `rgba(${r}, ${g}, ${b}, ${dim})`,
  };
}

/* ------------------------- .omptheme import/export ------------------------- */

export type OmpThemeFile = {
  v: 1;
  type: "omp-theme";
  name: string;
  theme: ThemeMode | "system";
  accent: AccentChoice;
  customAccent: string | null;
  transparency: number;
  effects: Effects;
};

export type ThemePatch = {
  theme: ThemeMode | "system";
  accent: AccentChoice;
  customAccent: string | null;
  transparency: number;
  effects: Effects;
};

export function serializeTheme(t: OmpThemeFile): string {
  return JSON.stringify(t, null, 2);
}

/** Parse + validate an .omptheme payload. Returns null for anything that is
 *  not a version-1 OMP theme; every field is clamped before it reaches the UI. */
export function parseOmpTheme(text: string): { name: string; patch: ThemePatch } | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (o.type !== "omp-theme" || o.v !== 1) return null;

  const theme = o.theme === "light" || o.theme === "dark" || o.theme === "system" ? o.theme : null;
  const accentRaw = typeof o.accent === "string" ? o.accent : "";
  const accents: AccentChoice[] = ["blue", "teal", "violet", "amber", "graphite", "custom"];
  const accent = accents.includes(accentRaw as AccentChoice) ? (accentRaw as AccentChoice) : null;
  const effectsRaw = typeof o.effects === "string" ? o.effects : "";
  const effects: Effects = effectsRaw === "full" || effectsRaw === "reduced" ? effectsRaw : "auto";
  let customAccent: string | null = null;
  if (typeof o.customAccent === "string" && hexToRgb(o.customAccent)) {
    customAccent = rgbToHex(...(hexToRgb(o.customAccent) as [number, number, number]));
  }
  if (!theme || !accent || (accent === "custom" && !customAccent)) return null;

  const transparencyRaw = typeof o.transparency === "number" ? o.transparency : 0.78;
  const transparency = Math.min(1, Math.max(0.1, transparencyRaw));
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 60) : "Imported theme";

  return { name, patch: { theme, accent, customAccent, transparency, effects } };
}
