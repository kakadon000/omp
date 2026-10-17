import { useEffect, useState } from "react";

const ROUTES = [
  "home", "player", "music", "gallery", "editor",
  "online", "widget", "library", "themes", "settings",
] as const;

export type Route = (typeof ROUTES)[number];

export function normalizeRoute(h: string): Route {
  const r = h.replace(/^#\/?/, "").split("?")[0];
  return (ROUTES as readonly string[]).includes(r) ? (r as Route) : "home";
}

export function navigate(r: Route) {
  if (normalizeRoute(location.hash) === r) return;
  location.hash = `#/${r}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => normalizeRoute(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(normalizeRoute(location.hash));
      document.querySelector(".main")?.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
