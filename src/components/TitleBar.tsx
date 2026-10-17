import { useState } from "react";
import { Icon } from "./Icon";
import { invoke, isTauri } from "../lib/tauri";
import type { Route } from "../lib/router";

export function TitleBar({
  query,
  onQuery,
  onToggleTheme,
  theme,
  onToggleEffects,
  effectsReduced,
}: {
  query: string;
  onQuery: (q: string) => void;
  onToggleTheme: () => void;
  theme: "dark" | "light";
  onToggleEffects: () => void;
  effectsReduced: boolean;
}) {
  const [maxed, setMaxed] = useState(false);

  const winMax = async () => {
    const r = await invoke<boolean>("win_max_toggle");
    setMaxed(!!r);
  };

  return (
    <header className="titlebar">
      <div className="tb-brand">
        <img src="./favicon.png" alt="" />
        <span>OMP</span>
      </div>

      <div className="tb-search">
        <div className="search-box">
          <Icon name="search" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search media, music, photos…"
            spellCheck={false}
            aria-label="Search"
          />
          {query && (
            <button className="icon-btn sm subtle" onClick={() => onQuery("")} aria-label="Clear search">
              <Icon name="close" size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="tb-right">
        <button
          className="icon-btn tip"
          data-tip={theme === "dark" ? "Light mode" : "Dark mode"}
          onClick={onToggleTheme}
          aria-label="Toggle theme"
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>
        <button
          className={`icon-btn tip ${effectsReduced ? "on" : ""}`}
          data-tip={effectsReduced ? "Effects: reduced" : "Effects: full"}
          onClick={onToggleEffects}
          aria-label="Toggle effects"
        >
          <Icon name="sparkle" />
        </button>
        {isTauri && (
          <>
            <span className="tb-sep" />
            <button className="win-btn" onClick={() => invoke("win_min")} aria-label="Minimize">
              <Icon name="minimize" />
            </button>
            <button className="win-btn" onClick={winMax} aria-label="Maximize">
              <Icon name={maxed ? "restore" : "maximize"} />
            </button>
            <button className="win-btn close" onClick={() => invoke("win_close")} aria-label="Close">
              <Icon name="close" />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
