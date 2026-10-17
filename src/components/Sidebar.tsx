import { Icon } from "./Icon";
import { navigate, type Route } from "../lib/router";
import { APP_VERSION } from "../lib/tauri";

const ITEMS: { r: Route; icon: string; label: string; sep?: boolean }[] = [
  { r: "home", icon: "home", label: "Home" },
  { r: "player", icon: "film", label: "Player" },
  { r: "music", icon: "music", label: "Music" },
  { r: "gallery", icon: "image", label: "Gallery" },
  { r: "editor", icon: "scissors", label: "Editor", sep: true },
  { r: "online", icon: "globe", label: "Online" },
  { r: "widget", icon: "layers", label: "Widget" },
  { r: "library", icon: "folder", label: "Library", sep: true },
  { r: "themes", icon: "palette", label: "Theme Studio" },
  { r: "settings", icon: "gear", label: "Settings" },
];

export function Sidebar({ rail }: { rail: boolean }) {
  return (
    <nav className={`sidebar ${rail ? "rail" : ""}`} aria-label="Main navigation">
      {ITEMS.map((it) => (
        <NavItem key={it.r} {...it} rail={rail} />
      ))}
      <div className="side-grow" />
      <div className="side-foot">
        <span>v{APP_VERSION}</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>GPL-3.0</span>
      </div>
    </nav>
  );
}

function NavItem({ r, icon, label, sep, rail }: { r: Route; icon: string; label: string; sep?: boolean; rail: boolean }) {
  return (
    <>
      {sep && <div className="side-sep side-extra" />}
      <button
        className={`side-item`}
        data-route={r}
        onClick={() => navigate(r)}
        title={rail ? label : undefined}
        aria-current={undefined}
      >
        <Icon name={icon} />
        <span className="label">{label}</span>
      </button>
    </>
  );
}
