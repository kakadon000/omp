# OMP — Open Media Player

**Every Format. One Player. Open to All.**

OMP is a custom-built, lightweight Windows media platform. It owns the interface
and application experience, and reuses proven media engines (mpv, FFmpeg,
libvips) for playback and processing — so effort goes into what makes OMP
distinctive, not into reinventing video decoding.

![OMP player](website/assets/app-player.png)

## Highlights

- **Universal playback** — video & music, playlists, subtitles (SRT/WebVTT),
  playback speed, frame stepping, multiple audio tracks, optional hardware
  acceleration, software-decoding fallback.
- **Windows 10 & 11, tuned separately** — Mica on Windows 11, Acrylic on
  Windows 10, explicit runtime detection, plus a Reduced Effects mode.
- **Gallery & library** — images, folders, thumbnails, search, metadata, zoom,
  rotation, slideshows. Incremental, cancellable scans that never stall playback.
- **Lightweight editor** — trim, crop, shapes, arrows, text, keyframes,
  undo/redo, editable `.ompj` projects, FFmpeg-based export.
- **Music & desktop widget** — album artwork, playlists, radio, and a floating
  player that works with the main window closed.
- **Online media** — dedicated YouTube experience, authorized IPTV and radio.
  No OMP-inserted ads, ever.
- **Theme Studio** — dark/light/system, five tasteful accents, adjustable
  transparency, Reduced Effects for low-end PCs.

## What's new in v0.2.0 — VLC-grade control

- **Fixed: dead timeline** — the seek bar now uses a proper scrub state
  machine (drag, click, keyboard — no more snap-back), plus hover time
  preview and a buffered-progress bar. Sources served without HTTP Range
  support (which made Chromium collapse the seekable range to zero and
  reject every seek) are auto-upgraded to a fully seekable blob copy.
- **Fixed: ~30% CPU during playback** — the boot splash now unmounts
  instead of running an invisible infinite animation forever, and
  backdrop-blur was removed from layers rendered on top of video frames.
- **Right-click everywhere** — full VLC-style context menu on the video
  (speed, jump, aspect, zoom, rotate, adjustments, delays, loop, snapshot,
  stats…), plus menus on the queue, Home cards, history, music and photos.
- **Cinema sidebar** — the navigation sidebar hides itself while video
  plays and peeks back from the left edge (toggle in Settings).
- **30+ hotkeys** — Space/K, J/L, 0–9, Ctrl+G, B (A-B loop), T (snapshot),
  Z (rotate), +/- zoom, [ ] speed, G/H & Alt+J/K delays, Q, I, Shift+L, R…
  Press <kbd>?</kbd> anywhere for the full map.
- **VLC staples** — A-B loop, loop off/all/one, shuffle, snapshot to PNG,
  aspect ratio & zoom & rotation, brightness/contrast/saturation/hue,
  subtitle & audio delay, volume boost to 200%, stats-for-nerds overlay,
  jump-to-time, real queue management (reorder/remove/add from anywhere),
  auto-hiding fullscreen controls and VLC-style OSD feedback.

## Tech stack

| Component        | Technology                     |
| ---------------- | ------------------------------ |
| Desktop shell    | Tauri 2                        |
| Frontend         | React + TypeScript + Vite      |
| Native backend   | Rust                           |
| Video processing | FFmpeg + FFprobe (Phase 4)     |
| Images           | libvips (Phase 2)              |
| Database         | SQLite (Phase 2)               |
| Project format   | JSON-based `.ompj` (Phase 4)   |
| Online playback  | WebView2 + supported embeds    |

## Development

```bash
npm install
npm run tauri dev      # desktop app (requires Rust + Windows for full effects)
npm run dev            # frontend only, in the browser
npm run build          # typecheck + production web build
npm run tauri build    # Windows installer (NSIS + MSI)
```

## Architecture rules

1. **Own playback adapter** — native mpv integration lives in a dedicated Rust
   module; playback commands never scatter across the frontend. Phase 1 ships
   WebView2 playback (H.264/AAC/WebM) with the adapter seam already in place
   for libmpv.
2. **Bundled ≠ loaded** — heavy components ship but stay out of the runtime
   until needed. The editor, online WebView, advanced image processing and
   Theme Studio are lazy.

## Releases

Windows installers are built automatically by GitHub Actions on every `v*` tag
and published on the [Releases page](https://github.com/kakadon000/omp/releases/latest).

## License

[GPL-3.0-or-later](LICENSE). Every public release includes dependency notices
and build information. OMP itself contains no advertising and no tracking.
