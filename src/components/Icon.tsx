import type { CSSProperties } from "react";

// Inline SVG icon set — Fluent-style 1.6px stroke, currentColor.
const P: Record<string, React.ReactNode> = {
  home: <path d="M3.5 9.5 12 3l8.5 6.5V20a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1Z" />,
  play: <path d="M7 4.8v14.4c0 .8.9 1.3 1.6.9l11.2-7.2c.6-.4.6-1.4 0-1.8L8.6 3.9c-.7-.4-1.6.1-1.6.9Z" fill="currentColor" stroke="none" />,
  pause: <path d="M7 4.5h3.2v15H7zM13.8 4.5H17v15h-3.2z" fill="currentColor" stroke="none" />,
  prev: <><path d="M6 5v14M18.5 5.6v12.8c0 .8-.9 1.3-1.6.8L8 12.8a1 1 0 0 1 0-1.6l8.9-6.4c.7-.5 1.6 0 1.6.8Z" fill="none" /></>,
  next: <><path d="M18 5v14M5.5 5.6v12.8c0 .8.9 1.3 1.6.8l8.9-6.4a1 1 0 0 0 0-1.6L7.1 4.8c-.7-.5-1.6 0-1.6.8Z" fill="none" /></>,
  music: <><path d="M9 18.5V6.2c0-.5.3-.9.8-1l8-1.8c.6-.2 1.2.4 1.2 1v11.6" /><circle cx="6.5" cy="18.5" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></>,
  image: <><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5Z" /><path d="m4 16 4.5-4.5c.6-.6 1.5-.6 2 0L15 16M14 13.5l1.8-1.8c.6-.6 1.5-.6 2 0L20 14" /><circle cx="9" cy="8.7" r="1.4" /></>,
  scissors: <><circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><path d="M8.2 7.6 20 18M20 6 8.2 16.4" /></>,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.7 2.3 4 5.2 4 8.5s-1.3 6.2-4 8.5c-2.7-2.3-4-5.2-4-8.5s1.3-6.2 4-8.5Z" /></>,
  layers: <><path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" /><path d="m4.5 11.5 7.5 4 7.5-4M4.5 15.5l7.5 4 7.5-4" /></>,
  folder: <path d="M3.5 6.5c0-.8.7-1.5 1.5-1.5h4l2 2.5h8c.8 0 1.5.7 1.5 1.5v9c0 .8-.7 1.5-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" />,
  palette: <><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 2-.9 2-2 0-.6-.3-1-.6-1.4-.3-.4-.6-.8-.6-1.4 0-1.1.9-2 2-2h2.4c1.8 0 3.3-1.5 3.3-3.2C20.5 6.4 16.7 3.5 12 3.5Z" /><circle cx="8" cy="10" r="1.2" fill="currentColor" stroke="none" /><circle cx="12" cy="7.5" r="1.2" fill="currentColor" stroke="none" /><circle cx="16" cy="10" r="1.2" fill="currentColor" stroke="none" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 3.8l1 2.2 2.4-.5 1.4 2-1.5 1.9 1.5 1.9-1.4 2-2.4-.5-1 2.2h-2.4l-1-2.2-2.4.5-1.4-2L7.1 12 5.6 10.1l1.4-2 2.4.5 1-2.2h2.4Z" transform="rotate(18 12 12)" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  sun: <><circle cx="12" cy="12" r="4.2" /><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4" /></>,
  moon: <path d="M20 13.6A8 8 0 0 1 10.4 4 8 8 0 1 0 20 13.6Z" />,
  volume: <><path d="M4 9.5v5h3.2L12 19V5L7.2 9.5H4Z" fill="currentColor" stroke="none" /><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" /></>,
  mute: <><path d="M4 9.5v5h3.2L12 19V5L7.2 9.5H4Z" fill="currentColor" stroke="none" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></>,
  minimize: <path d="M5 12h14" />,
  maximize: <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />,
  restore: <><path d="M8 8.5V6.6c0-.6.4-1.1 1.1-1.1h8.3c.7 0 1.1.5 1.1 1.1v8.3c0 .6-.4 1.1-1.1 1.1h-1.9" /><rect x="5.5" y="8.5" width="10" height="10" rx="1.1" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  shuffle: <path d="M3.5 7h4l9 10h4M17.5 4l3 3-3 3M17.5 14l3 3-3 3M3.5 17h4l2.6-2.9M14.4 9.9 16.5 7" />,
  repeat: <><path d="M17 3.5 20 6.5l-3 3" /><path d="M4 12V9.8A3.3 3.3 0 0 1 7.3 6.5H20M7 20.5 4 17.5l3-3" /><path d="M20 12v2.2a3.3 3.3 0 0 1-3.3 3.3H4" /></>,
  fullscreen: <path d="M4 9V5.5C4 4.7 4.7 4 5.5 4H9M15 4h3.5C19.3 4 20 4.7 20 5.5V9M20 15v3.5c0 .8-.7 1.5-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />,
  exitFullscreen: <path d="M9 4v3.5C9 8.3 8.3 9 7.5 9H4M20 9h-3.5C15.7 9 15 8.3 15 7.5V4M15 20v-3.5c0-.8.7-1.5 1.5-1.5H20M4 15h3.5C8.3 15 9 15.7 9 16.5V20" />,
  pip: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><rect x="12" y="12" width="6.5" height="4.5" rx="1" fill="currentColor" stroke="none" /></>,
  gauge: <><path d="M4.5 13.5a7.5 7.5 0 1 1 15 0" /><path d="m12 13.5 3.8-4.6" /><path d="M4 18.5h16" /></>,
  cc: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="M10.5 10.2c-.4-.5-1-.8-1.7-.8-1.3 0-2.3 1.1-2.3 2.6s1 2.6 2.3 2.6c.7 0 1.3-.3 1.7-.8M18 10.2c-.4-.5-1-.8-1.7-.8-1.3 0-2.3 1.1-2.3 2.6s1 2.6 2.3 2.6c.7 0 1.3-.3 1.7-.8" /></>,
  stepF: <><path d="M6 5.6v12.8c0 .8.9 1.3 1.6.8l7.9-5.7a1 1 0 0 0 0-1.6L7.6 4.8c-.7-.5-1.6 0-1.6.8ZM18.5 5v14" /></>,
  stepB: <><path d="M18 5.6v12.8c0 .8-.9 1.3-1.6.8l-7.9-5.7a1 1 0 0 1 0-1.6l7.9-5.7c.7-.5 1.6 0 1.6.8ZM5.5 5v14" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevronD: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  chevronL: <path d="M14.5 6.5 9 12l5.5 5.5" />,
  chevronR: <path d="M9.5 6.5 15 12l-5.5 5.5" />,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5" /><circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" /></>,
  alert: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V13" /><circle cx="12" cy="16.2" r="0.7" fill="currentColor" stroke="none" /></>,
  film: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M8 4.5v15M16 4.5v15M3.5 9.5H8M3.5 14.5H8M16 9.5h4.5M16 14.5h4.5" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2.2" /></>,
  star: <path d="m12 3.8 2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8L12 3.8Z" />,
  trophy: (
    <>
      <path d="M8 4h8v4.5a4 4 0 0 1-8 0V4Z" />
      <path d="M8 5H5v1.5A2.5 2.5 0 0 0 7.5 9H8" />
      <path d="M16 5h3v1.5A2.5 2.5 0 0 1 16.5 9H16" />
      <path d="M12 12.5V16" />
      <path d="M9.5 19c0-1.7 1.1-3 2.5-3s2.5 1.3 2.5 3" />
      <path d="M8 19h8" />
    </>
  ),
  history: (
    <>
      <path d="M4 5.5v4h4" />
      <path d="M4.9 9.5A8 8 0 1 1 4 12.5" />
      <path d="M12 8v4.5l3 1.8" />
    </>
  ),
  pen: <path d="M4.5 19.5 5.3 16 16.7 4.6a1.7 1.7 0 0 1 2.4 0l.3.3a1.7 1.7 0 0 1 0 2.4L7.9 18.7l-3.4.8Z" />,
  crop: <path d="M7 3.5V17h13.5M3.5 7H17v13.5" />,
  square: <rect x="5" y="5" width="14" height="14" rx="1.5" />,
  circle: <circle cx="12" cy="12" r="7.5" />,
  arrow: <path d="M6 18 18 6M9.5 6H18v8.5" />,
  type: <path d="M5.5 6.5V4.5h13v2M12 4.5V19.5M9 19.5h6" />,
  undo: <><path d="M8 6 4.5 9.5 8 13" /><path d="M4.5 9.5H14a5.5 5.5 0 1 1 0 11H8" /></>,
  redo: <><path d="m16 6 3.5 3.5L16 13" /><path d="M19.5 9.5H10a5.5 5.5 0 1 0 0 11h6" /></>,
  download: <path d="M12 4v11M7 10.5 12 15.5l5-5M4.5 19.5h15" />,
  rocket: <><path d="M12 15.5c5.5-3.5 7.5-8 7.5-11-3 0-7.5 2-11 7.5L12 15.5ZM8.5 12 5 13l2 2M12 15.5l-1 3.5-2-2" /><circle cx="14.5" cy="9.5" r="1.4" /></>,
  heart: <path d="M12 19.5c-4.5-2.8-7.5-5.6-7.5-9a4 4 0 0 1 7.5-2 4 4 0 0 1 7.5 2c0 3.4-3 6.2-7.5 9Z" />,
  list: <><path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12" /><circle cx="4.5" cy="6.5" r="1" fill="currentColor" stroke="none" /><circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="4.5" cy="17.5" r="1" fill="currentColor" stroke="none" /></>,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1.2" /><rect x="13" y="4" width="7" height="7" rx="1.2" /><rect x="4" y="13" width="7" height="7" rx="1.2" /><rect x="13" y="13" width="7" height="7" rx="1.2" /></>,
  radio: <><circle cx="12" cy="12" r="2" /><path d="M7.7 7.7a6 6 0 0 0 0 8.6M16.3 7.7a6 6 0 0 1 0 8.6M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" /></>,
  zoomIn: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5M11 8.5v5M8.5 11h5" /></>,
  zoomOut: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5M8.5 11h5" /></>,
  rotate: <><path d="M20 12a8 8 0 1 1-2.5-5.8" /><path d="M20 3.5V8h-4.5" /></>,
  slideshow: <><rect x="3.5" y="6" width="13" height="10" rx="1.5" /><path d="M20.5 7v10" /><path d="m8 9 3.5 2L8 13v-4Z" fill="currentColor" stroke="none" /></>,
  trash: <><path d="M4.5 6.5h15M9.5 6.5V5c0-.6.4-1 1-1h3c.6 0 1 .4 1 1v1.5M6.5 6.5 7 19c0 .8.7 1.5 1.5 1.5h7c.8 0 1.5-.7 1.5-1.5l.5-12.5" /><path d="M10 10.5v6M14 10.5v6" /></>,
  save: <><path d="M5.5 4.5h10.2L19.5 8.3v11.2a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z" /><path d="M8 4.5V9h7V4.5M8 20.5v-6h8v6" /></>,
  sparkle: <path d="M12 4.5 13.8 10 19.5 12 13.8 14 12 19.5 10.2 14 4.5 12 10.2 10 12 4.5Z" />,
  cast: <><path d="M3.5 8V6.5C3.5 5.7 4.2 5 5 5h14c.8 0 1.5.7 1.5 1.5v11c0 .8-.7 1.5-1.5 1.5h-6" /><path d="M3.5 12a7 7 0 0 1 7 7M3.5 15.5A3.5 3.5 0 0 1 7 19" /><circle cx="3.8" cy="19" r="0.7" fill="currentColor" stroke="none" /></>,
  pin: <path d="M9 4.5h6M12 4.5V10c0 2 3 3 3 5.5v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-1c0-2.5 3-3.5 3-5.5" transform="translate(0 1.5)" />,
  external: <path d="M14 4.5h5.5V10M19.5 4.5 11 13M9 6H6.5C5.4 6 4.5 6.9 4.5 8v9.5c0 1.1.9 2 2 2H16c1.1 0 2-.9 2-2V15" />,
  database: <><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" /><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" /></>,
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, style }: { name: string; size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      {P[name] ?? P.info}
    </svg>
  );
}
