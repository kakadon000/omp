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
- **Theme Studio** — dark/light/system, five tasteful accents **or any color
  you pick**, ten one-tap presets, themes that travel as `.omptheme` files,
  adjustable transparency, Reduced Effects for low-end PCs.

## What's new in v0.15.8 — tested on real Windows before it ships

- **The release pipeline is now smoke-gated.** Seven fix rounds shipped blind
  and every one of them had to be tested by hand on a broken machine — that
  ends here. CI now builds OMP, then **launches the real exe on a real
  Windows machine four times** — a fresh first boot, the exact rescue boot
  a broken machine takes, a normal boot after a clean exit, and a forced
  opaque+GPU combination — and checks every launch for the boot handshake,
  a live process, the absence of crash reports **and actual visible content
  in the window** (PrintWindow capture + pixel variance, with Notepad and
  Edge probes proving the harness and the machine can display content).
  Screenshots and boot logs are kept as evidence. The GitHub release is
  created only if every check passes: a build that cannot start on Windows
  can never reach the releases page again.
- **And the gate caught THE disease on day one — the one that ate seven
  rounds.** On the runner, OMP's window was flat in every mode — page fully
  alive (frames firing, handshake passing, zero errors) while nothing
  reached the screen — on a machine where Edge rendered perfectly. Root
  cause, verified in the tauri/wry sources: **WebView2's controller has its
  own visibility flag, and it does not follow the window.** OMP creates its
  windows hidden and shows them after the handshake (the v0.15.1 anti-blur
  change — the very round this odyssey began), and showing the window only
  showed the HWND: the controller stayed invisible forever, so WebView2
  never presented a single frame. The interface literally ran inside an
  invisible webview behind a colored rectangle. **v0.15.8 adds the
  controller rule: every show now shows both halves — the window and the
  webview controller — everywhere** (handshake show, failsafe show, widget
  restore, second-launch show, splash).
- **Defense in depth for broken machines: safe graphics never builds
  glass.** Safe mode now uses only the opaque window profiles, where what
  you see is the software-rendered interface itself over a solid surface —
  a machine rescued into safe mode physically cannot show a transparent
  void even if its compositor is sick. Glass stays a healthy-machine
  feature.
- **Reports name the WebView2 runtime correctly on Edge-less machines** —
  the version lookup falls back to the runtime's own Evergreen registry key
  (the smoke runner had the runtime installed with Edge absent, and reports
  used to claim "not found in registry").
- Everything else stays: identical engine flags for every window, the
  window ladder with its remembered profile, hung-process cleanup,
  never-silent dialogs, Desktop reports, the panic guard, pre-boot recovery
  and the embedded WebView2 installer.

## What's new in v0.15.7 — safe graphics, the right way

- **The engine rule gets its second half.** v0.15.6 fixed window creation by
  giving every window identical engine flags — but that also removed the only
  fix that ever made a black-screen machine paint: safe mode could no longer
  switch the interface renderer to software. A machine with a broken GPU
  compositor runs OMP's interface code perfectly while the window stays
  black — the handshake even passes, so no report fires. v0.15.7 restores the
  software-rendering rescue through the one channel that cannot create an
  engine mismatch: a single process-wide override that Microsoft's own
  WebView2 loader applies **identically to every window** — the splash, all
  four window profiles and the desktop widget. Error 0x8007139F stays
  impossible in both modes, by construction.
- **The silent single-instance lock.** A hung, invisible OMP.exe left behind
  by a crashed session kept the "already running" lock forever — every new
  launch was swallowed with no window, no report, no log. OMP now clears a
  windowless leftover older than two minutes before the engine starts. A
  running OMP with a visible window is never touched.
- **The boot log now records the exact engine flags** each launch runs with,
  so the next report tells us instantly which rendering path was live.
- Everything else stays: the window ladder with its remembered profile,
  never-silent dialogs, Desktop reports, the panic guard, pre-boot recovery
  and the embedded WebView2 installer.

## What's new in v0.15.6 — the engine rule

- **Your second report cracked it for real.** The v0.15.5 report showed all
  four window profiles failing with the IDENTICAL error — which proved the
  window style was never the problem. The real difference between the
  splashscreen (which worked) and every main-window rung (which died) was
  the **browser arguments**: OMP's safety mode — active on every fresh
  install and every post-crash boot — asked the WebView2 engine for
  different startup flags than the splash window had already started the
  engine with. Windows allows exactly one engine start per app profile, so
  any mismatch means nothing may open: **0x8007139F**, every launch, since
  v0.15.1.
- **THE ENGINE RULE.** Browser arguments are now identical for every window
  OMP ever creates — one rule, zero exceptions, and no hand-typed copies of
  engine defaults (the engine appends its own flags per window, so only
  *no custom args at all* is safe). Safety mode keeps working through
  software video, reduced glass, the plain-window rungs and the boot
  handshake — the window ladder from v0.15.5 stays exactly as it was.
- **Pre-boot engine recovery.** Before the interface builds, OMP now sweeps
  away `msedgewebview2.exe` processes left behind by crashed sessions
  (they hold the browser profile with stale engine flags). Never touches a
  running OMP instance, and on healthy machines it costs nothing.
- **Self-healing browser profile.** If window creation ever fails on every
  rung, the next launch **factory-resets OMP's own browser profile
  (EBWebView) automatically** — no more manual folder deleting. Capped at
  three attempts, cleared the moment the interface proves itself alive.
- **Everything else stays**: never-silent dialogs, Desktop reports, panic
  guard, embedded WebView2 installer, crash memory, mpv self-healing.

## What's new in v0.15.5 — the ladder

- **The field report cracked the case.** The first OMP-report.txt from the
  wild showed the WebView2 Runtime perfectly healthy — but the main
  window's webview creation dying with **Windows error 0x8007139F** ("The
  group or resource is not in the correct state"). The splashscreen, built
  moments earlier with nearly identical flags, succeeded. The deltas:
  `shadow(true)` and the safe-mode `--disable-gpu` browser args. One failed
  window creation used to kill the whole app — that was four rounds of
  "I ran it and nothing happens".
- **The window ladder.** The main window is now built on a ladder of four
  progressively plainer profiles: full glass → no shadow → no transparency
  → fully vanilla (native decorations, no custom GPU flags). The first
  profile the machine accepts **wins and is remembered** (`ui.winrung`) —
  later boots open straight into the profile that works. A machine that
  rejects glass gets a window that works instead of no app at all.
- **Every rung is logged.** Failed profiles land in the boot log and in
  OMP-report.txt, so a future report names the exact profile that fixed
  (or broke) a machine.
- **Never silent stays.** The v0.15.4 pre-boot guard, native failure
  dialogs, panic hook, Desktop reports and the embedded WebView2
  installer are all unchanged.

## What's new in v0.15.4 — never silent

- **The pre-boot guard.** Four rounds of "I ran it and nothing happens"
  traced to one hole: failures that happen BEFORE the app builds — most
  often a missing or broken **WebView2 Runtime** — died through a panic
  that Windows swallowed completely (no window, no report, no log, nothing).
  OMP now checks the WebView2 Runtime **before anything is built**. If it
  cannot answer, a real Windows dialog explains the fix, OMP-report.txt
  lands on the Desktop, and OMP offers to open the official Microsoft
  repair page itself.
- **No more silent deaths.** The old crash-on-boot path (a `.expect()` on
  the window-system build, invisible behind the windowed subsystem) is
  gone. Every startup failure now ends in a **visible dialog naming the
  exact failure** plus a Desktop report — even if the interface never
  existed at all.
- **Panic guard.** A panic hook is installed as the very first line of the
  process: any internal crash leaves OMP-report.txt on the Desktop, and
  pre-boot crashes also pop a real Windows message box.
- **Repeat-failure alarm.** If boots keep failing, OMP no longer relies on
  a file you may never notice: it pops a **visible Windows dialog** with
  the official repair page.
- **Installer fix.** The setup now embeds the WebView2 bootstrapper
  (installed from inside the installer). Note: the `.msi` format never
  installs WebView2 — if you installed with the MSI, run the `-setup.exe`
  once.

## What's new in v0.15.3 — the black box

- **The flight recorder.** OMP now logs every boot decision, graphics-mode
  grade, paint verification and engine operation into a rolling log file in
  its data folder. When something goes wrong, the story of exactly what
  happened is already on disk — no more debugging from vibes.
- **The Desktop report.** When OMP hits trouble — a boot that never painted,
  a crash, a recovery — a file named **OMP-report.txt appears on the
  Desktop by itself**, written by native code that works even when the
  interface is completely dead. It contains the boot log, the WebView2
  runtime version, the graphics-mode decisions and the engine probe trail,
  plus plain-language instructions for the most common causes. The user
  just drags it into a chat — no buttons, no copying, no in-app UI needed.
- **Plain-window escalation.** If the interface fails to boot twice in a
  row, OMP launches as a **plain opaque window** — no transparency, no DWM
  glass material — the most conservative surface Windows can draw. Even
  compositor-level breakage cannot stop the app; at that point the Desktop
  report names the WebView2 runtime as the suspect and links the official
  repair installer.
- **Report a problem, everywhere.** Settings → Report a problem: one click
  copies the full report, another saves it to the Desktop. The crash banner
  and the player rescue card now deliver the same complete report with a
  single tap.

## What's new in v0.15.2 — playback that cannot die

- **The video engine joins the self-healing system.** v0.15.1 taught the
  window to survive broken GPU drivers — but mpv still ran its D3D11 video
  output and hardware decode straight into the same wall (the "nothing
  plays, it crashes" reports). On any machine running in safe mode, video
  now renders through **WARP — the D3D11 software rasterizer built into
  every Windows install** — and hardware decoding is force-disabled. Zero
  GPU-driver code runs during playback; if the machine can run OMP at all,
  it can play video.
- **Crash memory.** Every session is armed with a marker on disk. A crash,
  hard kill or power loss leaves it behind, and the NEXT launch grades
  itself as a rescue: software UI **and** software video, automatically —
  plus a recovery banner explaining what happened. A clean exit retires the
  marker, so healthy machines never see it.
- **Copy crash report, one tap.** The recovery banner offers a button that
  puts the shell facts and the engine log on the clipboard — no more "it
  just crashes" with nothing to debug. (The player's rescue card keeps its
  Copy diagnostics too.)

## What's new in v0.15.1 — the boot that cannot fail

- **The window can never appear empty again.** The main window is now shown
  ONLY after the app's interface has actually rendered something (a boot
  handshake between the webview and the shell). The "see-through blurred
  wallpaper with nothing inside" state from the v0.15.0 reports is
  structurally impossible now — no handshake, no window.
- **Safe graphics mode, automatically.** If a launch ever fails to paint
  (broken GPU drivers or a broken WebView2 update — the usual suspects on
  the machines that reported a blank window), the next launch relaunches
  the interface with software rendering, which paints reliably on every
  machine. Healthy machines never notice; broken ones heal themselves on
  the relaunch. Glass effects stay reduced while it's active so the CPU
  isn't asked to blur the whole UI.
- **Something always paints instantly.** A static boot card (logo, tagline,
  progress bar) is baked directly into the page — it shows the moment the
  webview can rasterize anything, even if the app bundle is still parsing.
  If startup is unusually slow, the card says so and offers a one-tap
  Reload. Bundle crashes surface as a readable message instead of a
  see-through window.
- **The 8-second failsafe stays**: if the interface never proves itself,
  the window surfaces anyway and the machine is marked for safe-graphics
  relaunch. The splash, the handshake and the failsafe all retry — a slow
  IPC bridge on a cold disk can no longer strand the boot.

## What's new in v0.15.0 — instant launch, and a splash that behaves

- **The loading screen shows ONCE — first launch only.** A marker in OMP's
  data folder remembers the first successful boot; every launch after that
  the main window appears **instantly** — no splash, no waiting, no animated
  bar. If the UI ever failed to boot, the splash comes back for one more
  try (and a 10-second failsafe guarantees the splash can never trap the
  app again — exactly the "stuck here" report).
- **The splash card is properly rounded now** — a floating glass card with
  a soft stroke and shadow, not a sharp-edged rectangle sitting on your
  wallpaper.
- **Faster everything at boot:** OS info, the update check and the engine
  health probe now wait ~2.5s behind the first paint instead of racing it —
  opening OMP and starting a video happens with the full window already up.
- **"Not playing" now tells you why — and offers real exits.** When a file
  can't decode in the built-in view (engine down + HEVC/MKV is the classic),
  the player used to show a silent black box. Now you get a rescue card:
  **Repair engine** (one tap, progress toasts), **Copy diagnostics**, and
  **Try again** — plus a 12-second stall watchdog so even header-level
  failures surface instead of hanging forever.
- **Untouched by design:** radio, engine internals, EQ, sleep timer, Theme
  Studio, Online tabs, drag & drop, downloader, editor behavior.

## What's new in v0.14.1 — nothing stuck, ever

- **The editor's "reading media…" can no longer hang.** When a clip's codec
  can't decode in the built-in preview (HEVC is the usual suspect) or the
  native engine is unavailable, the editor now asks the **bundled FFmpeg** to
  read duration and dimensions straight from the container — no engine, no
  decode, ~instant. Trim, scrub, A-B overlays and export all come back to
  life, and the info panel always tells the truth: reading, read, or
  "metadata unavailable — trim & export still work".
- **Hung engine attach can't freeze the editor.** A broken engine DLL can
  hang *during* attach instead of returning an error — the editor now races
  a 6-second deadline and falls back to the built-in preview either way.
- **Every loading state got an error path.** "Loading playlists…" on Home
  (plus Music and Library playlists, Music library, stats counters) now
  resolve on failure and carry a 6-second deadline backstop — a hiccuping
  DB command can never leave an eternal spinner again.
- **Downloader hardening:** the Fetch button can no longer stick on
  "Resolving…" if the resolve command errors, and the yt-dlp pill now shows
  an honest "checking…" while the engine probe runs instead of jumping
  straight to "missing".
- **Online screen self-heal:** if the lazy-loaded Online module ever fails
  to arrive, you get a Retry card instead of a frozen "Loading online…".
- **Untouched by design:** radio, engine internals, self-heal, EQ, sleep
  timer, Theme Studio, Online tabs, drag & drop, the downloader itself.

## What's new in v0.14.0 — the Downloader, and an editor that never dies

- **Downloader — save videos from anywhere.** A new screen (sidebar + Home
  tile) driven by the same official **yt-dlp** engine OMP has bundled since
  v0.9.0 — which means **YouTube, Instagram, X/Twitter, TikTok, Facebook,
  LinkedIn and 1000+ other platforms** all work through one paste box. Paste
  a link, hit Fetch, get the real title, channel, duration and thumbnail,
  pick a quality (**Best / 1080p / 720p / 480p / MP3 audio**), and watch the
  accent progress bar with live speed and ETA. Separate video+audio streams
  are merged by the bundled FFmpeg; MP3 extraction uses it too. Files land
  in a folder you choose (defaults to OMP's data folder → Downloads, change
  it any time), history is kept in the local SQLite library, and every job
  can be cancelled with a real process kill. Up to four downloads at once.
- **The editor is no longer hostage to the engine.** Previously, if the mpv
  engine was missing or refused to attach on your machine, the Editor showed
  a toast and died — no preview at all. Now it falls back to a built-in
  WebView preview (asset protocol): trim, crop, overlays and the timeline
  keep working, and **export was never affected anyway** because it runs on
  the bundled FFmpeg, independent of mpv. If a codec can't decode in the
  built-in view (MKV/HEVC on some machines), an honest note tells you
  export still works.
- **Export-stuck bug fixed.** The export modal subscribed to FFmpeg's
  progress events *after* starting FFmpeg — a short clip could finish
  before the listener attached and leave the modal stuck at "Rendering…
  0%" forever. Listeners now attach first, with stale-render protection.
- **Editor polish:** hold-and-drag scrubbing anywhere on the timeline,
  ±5s skip buttons, 0.5×–2× speed chips (native engine and preview alike),
  Space no longer re-triggers the button you just clicked (the classic
  "space does nothing" feel), and a friendlier transport row.
- **Untouched by design:** radio, engine internals, self-heal, EQ, sleep
  timer, Theme Studio, Online tabs, drag & drop.

## What's new in v0.13.0 — drag & drop anything, your week in bars

- **Drag & drop anything.** Drop files anywhere on the OMP window and they
  take the exact same route as "Open with OMP": video → Player, audio →
  Music, images → Gallery, `.m3u`/`.m3u8` → imported into Live TV,
  `.omptheme` → applied instantly, `.ompj` → opened in the Editor. A glass
  veil with a dashed accent border tells you the drop is live before you let
  go. Multiple files at once work too — every dropped path is routed on its
  own merits.
- **This week — your time, honestly charted.** Home's right rail now has a
  card with seven daily bars (your accent, of course) splitting **video**
  (solid) from **music** (45% wash), a big total on top and a legend, with
  per-day tooltips ("Video 1h 12m · Music 34m"). The counter is delta-based
  and seek-proof: time only counts when the engine's clock actually moves
  forward in small realistic steps, so pauses, seeks and engine rebuilds
  never inflate your numbers. Days roll on a 14-day window in localStorage —
  nothing leaves your machine.
- **A quiet update nudge.** Once a week at boot, OMP quietly asks GitHub
  whether a newer release exists — and only speaks up when one does, with a
  single toast pointing at Settings → About. Offline? Silence. Same version?
  Silence. No popup spam, ever.
- **Under the hood this round:** the open-with router is now shared verbatim
  by "Open with OMP", command-line launches and drag & drop (one code path —
  one set of behaviors), and everything is pure frontend again: self-heal,
  equalizer, sleep timer, Theme Studio, Online tabs — all untouched.

## What's new in v0.12.0 — Home, redesigned

- **Hero 2.0.** The welcome banner grew into a real dashboard header: an
  ambient single-accent glow that follows whatever accent you picked in the
  Theme Studio, the real date next to the tagline, a version chip, and five
  one-tap actions (Open media, Resume, Music, Online, Editor). The engine
  status moved up here too — a green/red pill in the top-right corner shows
  "Engine ready" or "Engine needs repair" with the mpv version, and one click
  lands you in Settings → Engine & tools.
- **Quick-launch tiles.** Six live tiles under the hero: Videos, Music,
  Gallery, Online, Editor and Widget — each with an accent icon chip and a
  live subtitle (real database counts for Videos and Music once the library
  has scanned, format hints for the rest).
- **Recently played, upgraded.** The tiny text chips became poster tiles with
  thumbnails, names and relative timestamps, and each tile has a right-click
  menu: open it, or remove it from history. The section header now has a
  Clear button that wipes the whole history in one go.
- **Continue watching, upgraded.** Cards now show a "x% left" pill on the
  thumbnail, an accent progress bar, a gentle hover lift and a subtle poster
  zoom — the section header shows how many are waiting.
- **Library at a glance, upgraded.** Stat cards got accent icon chips so
  Videos / Tracks / Folders read at a glance instead of floating numbers.
- **Playlists, upgraded.** Each row now carries an accent playlist chip and
  reveals a play bubble on hover; the section header shows the playlist count.
- **System card, upgraded.** Icon rows for Version / Engine / License, the
  health dot, and a full-width "Engine & tools" button straight into Settings.
- **Motion with manners.** The screen fades up in two gentle stages on entry —
  and both Reduced Effects mode and Windows' prefers-reduced-motion turn it
  off completely, as with every animation in OMP.

## What's new in v0.11.0 — the sleep timer and a Home screen that tells the truth

- **Sleep timer — the bedtime feature.** Player → moon button (or the
  right-click menu → Sleep timer) and Music → the now-playing bar's moon:
  pause everything after **15 / 30 / 60 minutes** or **after the current
  track/video**. It pauses — mpv, the web audio element, the Player's video —
  it does not close the app, and a countdown tooltip shows the time remaining.
  The "after this one" hold is shared between music and video (whichever ends
  first consumes it), so it always stops exactly where you are, never mid-
  advance into the next queue item.
- **Music shuffle & repeat, one tap away.** Both flags existed in the engine
  since v0.6 but were only reachable from the desktop widget; the now-playing
  bar now has proper toggle buttons that light up with the accent.
- **Home → Your playlists is real now.** The old "Quick playlists" card was a
  hardcoded fake (Favourites / Focus Mix / Watch Later with invented counts).
  It lists your actual SQLite playlists with real track counts; click plays
  the playlist through the native engine, right-click deletes it, and empty
  state explains how to build one in Music.
- **Home → Library at a glance is real now.** Instead of static demo numbers
  it shows the live SQLite counters: your videos, tracks, and folders.
- **Home → System shows the live engine status.** "WebView2 · Phase 1" was
  stale since v0.3.0 — it now shows the actual mpv engine version with a
  green/red health dot, so a quarantined engine is visible on the very first
  screen instead of only inside Settings.
- **Home → Recently played.** The last eight things you opened (videos,
  music, images) as one-click chips with relative timestamps.

## What's new in v0.10.1 — self-heal, the sticky equalizer, and polish

- **OMP now repairs itself without being asked.** On every boot the app runs
  the component health probe; if the mpv engine is missing or refused (the
  classic antivirus-quarantine situation) or the YouTube extractor is gone,
  the official one-click repair **starts automatically in the background** —
  with a toast when it begins and a toast when the engine is back. Throttled
  to once per 24 hours per machine, and it never touches the 164 MB editor
  exporter (that stays a manual button in Engine & tools). This closes the
  loop on the "nothing plays" family: install → engine dead → OMP notices →
  OMP fixes it → native playback restored, no support message required.
- **Audio equalizer (Settings → Playback).** Flat · Bass · Vocal · Treble ·
  Rock — real ffmpeg filter chains (`bass`/`treble` biquads, peak filters)
  applied by the native engine instantly, for music and video alike, and
  persisted. The preset re-sticks itself after every engine rebuild
  (audio↔video takeovers reset the filter chain on the mpv side) and after
  every fresh engine attach.
- **The desktop widget follows your accent.** The floating player used to
  ship a hardcoded blue; it now reads the Theme Studio choice at boot — named
  accents and custom colors alike — so a Cyberpunk setup gets a Cyberpunk
  widget.
- **System dark/light is now live.** With Theme = System, flipping Windows'
  app mode used to leave the app in the old look until you poked a setting;
  a `prefers-color-scheme` listener re-applies everything (including custom
  accent contrast math) the moment the OS switches.
- **Theme Studio field sync fix.** The hex input could show a stale value
  after applying a custom-accent preset or importing a theme; it now tracks
  the live setting.

## What's new in v0.10.0 — the Theme Studio: any color, ten presets, themes as files

- **Custom accent — any color you want.** The five built-in accents are joined
  by a color picker and a hex field. Pick any color and OMP derives the whole
  palette from it live — the accent shade, the pressed/darker variant, the
  readable label text on top of it, and the translucent tint — for both dark
  and light mode (very dark picks are automatically lifted so they stay
  visible on glass; very bright picks are darkened in light mode for contrast).
  The derived shades update across the entire app instantly.
- **Ten presets, one tap.** The Theme Studio opens with a preset gallery:
  Fluent Dark, Fluent Light, Ocean, Sunset, Rose, Forest, Cyberpunk, Nord,
  Gold and Paper — each with its own accent, blur strength and effects level.
  Custom-color presets double as a showcase of the new color engine.
- **Themes travel as files: `.omptheme`.** Export your current theme (theme,
  accent, custom color, transparency, effects) to a small JSON file from the
  Theme Studio, and double-click any `.omptheme` file in Explorer to apply it
  instantly — OMP registers the association, validates the payload (type,
  version, color format, clamped values) and applies it in one click. Share
  your setup with friends; nothing touches your media library.
- **In-app update check (Settings → About).** One button hits the GitHub
  Releases API from the Rust shell (async — never blocks the UI) and compares
  the latest tag with your version: "You're on the latest version" or "OMP
  vX.Y is out" with a direct link to the download page. No telemetry, just a
  public API call you could make yourself.
- **Under the hood:** `theme.ts` color engine (relative-luminance contrast
  math), custom-accent variables applied as inline overrides over the palette
  stylesheet, `export_theme_file` + `check_update` Rust commands, and the
  `.omptheme` file type added to the open-with/single-instance pipeline.

## What's new in v0.9.1 — self-repair, the in-built YouTube API, and tabs

- **Engine & tools repair center (Settings → Playback).** The v0.9.0 bundle was
  verified byte-perfect — the installer ships a valid 206-export `mpv-2.dll`,
  `yt-dlp.exe` and `ffmpeg.exe` — so a dead engine on a user machine means
  something machine-side (antivirus quarantine, stale install). Until now OMP
  could only *say* that. Now it can *fix* it: the new repair center lists every
  bundled component with its exact path and size, shows the loader's attempt
  trail ("not present in this install" vs "load refused by Windows"), and can
  **re-download the official binaries with one click** — yt-dlp from the
  yt-dlp project, the engine from the official mpv-winbuild builds (downloaded,
  extracted in-app, re-probed) — into a writable location (install resources
  for per-user installs, else app data). No admin, no reinstall.
- **The in-built YouTube API got better: zero processes, zero keys.** Search
  now runs through the same innerTube interface the YouTube site itself uses,
  straight from the Rust shell — no API key, no bundled extractor needed,
  nothing for antivirus to delete. The keyless chain is: in-built search →
  bundled extractor → your own Data API key (Settings → Online). With a healthy
  engine, results and pasted links still play natively with hardware decode.
- **The Online screen finally has the obvious tab bar:** **Video · Sports ·
  Music · Live TV · Radio**. Sports is a first-class tab — one-tap presets for
  football, cricket, NBA, F1, tennis, UFC, WWE and more, opening with live
  highlights on the spot.
- **More on the Online screen:** search history chips (tap to re-run),
  favorites — star any result, replay it from the Favorites row — and an
  honest engine banner with a one-click fix when native playback is unavailable.
- **Music is honest about fallback:** when the native engine is inactive, the
  Music screen says the built-in audio engine is playing and points to the
  repair center instead of failing silently.
- **Diagnostics that name absences:** the loader previously logged nothing for
  a missing DLL file, which read as "loader did nothing". Now every candidate
  is logged: present-but-refused, foreign-copy-rejected, or simply gone
  (antivirus?) — and "Copy diagnostics" carries all of it.

## What's new in v0.9.0 — the engine that always starts + built-in YouTube

- **The engine loader is now defensive end to end.** On some machines a
  foreign DLL that merely shares the name `mpv-2.dll` was loaded first and
  trusted blindly — no mpv exports, engine dead, and every downstream
  feature (videos, IPTV, radio, thumbnails) silently broken while Settings
  said "DLL found but did not initialise". Every loader candidate is now
  symbol-verified before acceptance, the bundled `resources\mpv-2.dll` is
  tried FIRST, and rejected modules are freed and skipped. If the full
  tuned option set is refused, the engine retries with a bare minimum set
  before giving up — and the exact failure reason lands in diagnostics.
- **Built-in YouTube — no API key needed.** OMP now bundles yt-dlp: search
  YouTube out of the box (Settings → Online shows the extractor status),
  and when the native engine is healthy, pasted links and search results
  play **natively in OMP** — hardware decoded, VLC-grade controls, a
  fraction of the WebView embed's CPU. The embed remains as fallback with
  a one-click "Native player" upgrade button.
- **All-format URL support.** The same extractor teaches mpv YouTube,
  Twitter/X, TikTok, Instagram, Vimeo, Twitch VODs, Bilibili, SoundCloud
  and 1000+ other sites — paste any link, OMP plays it. Formats are capped
  at 1080p with h264 preferred so hardware decode engages on every GPU.
- **Video previews that never depend on the engine.** Library thumbnails,
  durations, resolutions and tags now fall back to the bundled FFmpeg when
  mpv probing is unavailable — previews work on every machine.
- **YouTube links can no longer spin the demuxer.** Without the extractor,
  YouTube URLs are refused cleanly instead of being fed to mpv as raw HTML.
- **Diagnostics that actually explain.** The engine card and Copy
  diagnostics now include the full loader attempt trail (which file was
  accepted, rejected, or refused and why) plus the extractor state.

## What's new in v0.8.1 — the audio-chain fix round

- **Track-switch chaos: root cause removed.** mpv fires an end-of-file event
  for *ordinary* transitions (pressing Stop, switching to the next song).
  Those were surfacing as errors — every track change showed a fake
  "Playback failed" toast and armed an auto-skip that machine-gunned through
  the queue. Only real decode errors are errors now; Stop and track switches
  are silent and instant.
- **No more zombie playback.** If the engine dies mid-song the UI now says
  so — and pressing play rebuilds the engine with the current track instead
  of doing nothing.
- **No more double audio.** The built-in fallback engine can no longer keep
  playing underneath the native engine after "Re-test engine".
- **Radio that heals.** A dropped station stream auto-reconnects once
  (throttled) and then stops honestly — never a fake ON AIR again.
- **Copy diagnostics** — one button in Settings → Playback copies the exact
  engine + audio session state as text, so a bug report pinpoints the broken
  leg instantly.

## What's new in v0.8.0 — Phase 5: online media

- **Dedicated YouTube experience.** Paste any YouTube link (watch, shorts,
  youtu.be, live, embed, or playlist) and it plays instantly in a theater
  embed — no account, no key. Optional search uses **your own** free YouTube
  Data API key (10,000 units/day from Google): results show real thumbnails,
  durations, channels and view counts. Everything runs on YouTube's official
  nocookie embed player — authorized interfaces only, no scraping, and your
  key stays local.
- **IPTV that actually plays.** Import standard **M3U / M3U8** playlists (the
  format every IPTV provider exports), browse channels with logos and group
  filters, and streams open through the **native mpv engine** — HLS, TS and
  direct HTTP streams decode with the same pipeline as your local files.
  Nothing runs in the background when you stop watching. Playlists can also be
  opened by double-click (.m3u / .m3u8 are now registered OMP file types).
- **Radio is real.** The Online → Radio tab now drives the same engine session
  as the Music screen: the four curated stations, your custom stations, live
  ICY "now playing" titles, stop/add/remove — and the desktop widget follows
  along.
- **YouTube Music tab** — music-scoped search (same optional key) plus a
  one-click jump to the official YouTube Music in your browser.
- **Bundled ≠ loaded** — the whole Online screen is code-split and only
  downloads when you first visit it; the main window stays lean.
- **Built-in public channels** — NASA TV and Red Bull TV ship preconfigured,
  legal and free, so Live TV works out of the box.

## What's new in v0.7.0 — Phase 4: the lightweight editor

- **Real editing, same engine.** The Editor screen now loads any video OMP can
  play (MKV, HEVC, AVI, WebM, MP4…) and previews it through the native mpv
  engine — scrub, trim, annotate on the real picture, not a proxy.
- **Trim** with a scrubbable timeline: drag the selection, the preview loops
  inside it, exports only the kept range.
- **Crop** with corner handles over the full frame; the preview, overlays and
  the export all agree on the crop window.
- **Timed overlays** — rectangles, circles, arrows and text with color, stroke
  and font controls. Each overlay has an in/out point on the keyframe lane, so
  annotations appear exactly when you place them (set in/out at the playhead
  with one click).
- **Undo / redo** — Ctrl+Z / Ctrl+Y (40 steps) across every edit.
- **Projects as .ompj** — JSON project files, auto-saved locally, reopenable
  from the app or by double-click (.ompj is now a registered OMP file type).
- **True FFmpeg export** — MP4 (H.264 + AAC, three quality presets), WebM
  (VP9 + Opus) and animated GIF (palette-optimized) with live progress and a
  real cancel (kills the encoder). Overlays are burned in pixel-perfect via
  pre-rendered PNG frames, so the export matches the preview exactly.
- **Diagnostics** — Settings shows the bundled FFmpeg exporter status and path.

## What's new in v0.6.2 — music that always plays + widget 2.0

- **Music bulletproofed at the engine root.** Three stacked causes found and
  fixed: (1) the libmpv core was initialised with mpv's default `idle=no` —
  an empty core **shuts itself down immediately**, so audio sessions could be
  born dead before the first song ever loaded (`idle=yes` now); (2) audio
  attaches used to build the *video* pipeline too (child HWND + embedded
  surface + GPU video output) — audio now runs **surface-less** (`vo=null`,
  no HWND), so machines whose video path fails can still play every audio
  format, and audio/video sessions cleanly rebuild the engine when they
  take over from each other; (3) when the engine core dies, the stale
  instance now un-registers itself so the next play re-attaches instead of
  failing forever.
- **A music engine that cannot die.** If libmpv is missing or blocked on
  your machine (antivirus quarantine is the #1 cause), OMP no longer gives
  up: the built-in WebView audio engine takes over automatically and plays
  your files through the asset protocol — same queue, shuffle, repeat,
  desktop widget and progress. A toast tells you when it happens, and
  **Settings → Playback → Re-test engine** re-probes the DLL after you fix
  the cause (no restart needed).
- **Engine errors are now words, not silence.** Failed attaches carry the
  exact reason (`mpv_initialize failed: …`) to toasts and diagnostics, the
  Win32 load-error codes got human hints (5 = antivirus, 126 = blocked DLL,
  193 = wrong arch, 1114 = GPU runtime), and playback errors mid-file no
  longer freeze the UI on a fake "playing" state — you get a toast and an
  auto-skip to the next track.
- **Windows media keys + media overlay.** Title, artist and cover art now
  surface in the Windows media flyout, and your keyboard's media keys
  (play/pause/next/previous) control OMP.
- **Widget 2.0.** Tap any queue row to jump to that track, shuffle and
  repeat toggles, double-click the artwork to bring OMP back, a CSS-only
  playing indicator (zero timers, zero CPU when paused) and **position
  memory** — the widget reopens exactly where you dragged it, clamped so it
  can never get lost off-screen.
- **More translucent, less work.** Dark-theme surfaces and the widget card
  got lighter alpha layers (airier glass), and the panel blur dropped its
  `saturate()` pass — same look, cheaper compositing. The audio broadcast
  to the widget no longer re-sends the whole queue at the 4 Hz progress
  tick (queue travels only when it changes).

## What's new in v0.6.1 — the bug-fix round

- **Desktop widget: fixed.** The widget window was created inside a
  *synchronous* command — on Windows that deadlocks the event loop (the
  builder waits for the loop, the loop waits for the command): the widget
  came up white/frozen and could take the app with it. Window creation is
  now an async command per the Tauri contract. The native drop shadow is
  off (it also drew a 1 px white border on frameless windows) and the card
  dropped its `backdrop-filter` — the blur sampled the whole desktop on
  every compositor frame and made **dragging feel slow and glitchy**. The
  widget now drags butter-smooth.
- **Music: no more silent failures.** An HTMLAudioElement can't play a raw
  filesystem path, so the old web fallback inside the app meant "playing"
  with zero sound. The audio service now verifies the engine attach result
  (with one retry), checks the `mpv_load` result, and surfaces a real error
  toast instead of pretending. **Settings → About → Engine diagnostics**
  shows the exact engine state — DLL path, libmpv version, and the raw
  Windows error code if the DLL refuses to load (antivirus quarantine and
  missing GPU runtimes are the usual culprits).
- **Previews everywhere.** The Gallery now reads **real scanned images**
  (jpg/png/webp/bmp/gif/avif/tiff) from the library database — every photo
  in your scanned folders shows as a live thumbnail with the lightbox
  viewer (rescan your folders once to index images). Album art and video
  thumbnails now use the correct per-platform asset URL — the hand-rolled
  `asset://` links silently 404'd on Windows WebView2.
- **Default player.** OMP now registers file associations for videos,
  music and images at install time — right-click any media file →
  *Open with → OMP*, or hit Settings → Playback → Default apps to set it
  system-wide. Double-clicking more files goes to the running app
  (single-instance), and files passed at launch open instantly: video →
  Player, audio → Music, image → Gallery.
- **The Playlists tab is real.** The Library screen's Playlists tab now
  manages the actual SQLite playlists (create, view tracks, remove items,
  delete, play) instead of demo cards.
- **Rounder, tighter UI** — cards, panels, chips and menus got the full
  Fluent radius treatment (Windows 10 keeps its tighter corners).

## What's new in v0.6.0 — Phase 3: Music & widgets

- **The real music library** — every audio file OMP scans gets its embedded
  album art extracted to a JPEG (mpv decodes the cover track exactly like a
  video thumbnail), and ID3/FLAC/Vorbis tags (artist · album · genre) land in
  SQLite. The Music screen groups albums with real covers, searches across
  tags, and remembers per-track progress and play counts.
- **SQLite playlists** — create playlists, add tracks from any track's
  right-click menu, play or delete them from the Music screen. Stored in the
  same library database, resolved live against your files.
- **Internet radio** — five built-in stations (SomaFM, Radio Paradise), one
  click to play via the native engine, **live "now playing" titles** streamed
  from the station's ICY metadata, and add-your-own stream URL (right-click a
  custom station to remove it).
- **A real desktop widget** — a frameless, translucent, always-on-top second
  window: artwork, title, seek bar, transport controls; expands to show the
  queue and volume. Drag it anywhere by its header.
- **Background playback** — close the main window while music plays and OMP
  keeps going: the window hides, the widget pops up, the music never stops.
  Quit from the widget menu when you're done (toggle in Settings →
  Background playback).
- **Engine as a global service** — audio sessions survive navigation (and
  window close); opening a video politely offers "Stop & play video" instead
  of silently hijacking your music.

## What's new in v0.5.0 — the ultra-light engine fix (CPU 70% → done)

Three stacked causes were burning CPU during playback, and all three are now
fixed at the root:

- **The window material fought the video.** OMP's Mica (Win11) / Acrylic
  (Win10) blur-behind stayed attached while the native mpv surface played
  video *underneath* the transparent webview — so Windows recomposited a
  full-window blur on every single video frame. The material now detaches
  the moment playback attaches and returns when it ends. The glass look is
  untouched on every non-playing screen.
- **Glass blur sampled the live video.** Any `backdrop-filter` panel whose
  backdrop included the transparent video tunnel was recomputed per frame.
  All backdrop blurs are now suspended engine-wide while `mpv-live` is
  active (panels switch to their solid surfaces).
- **Silent software decode.** `hwdec=auto-safe` refuses hardware decode on
  non-whitelisted GPU/driver combos and falls back to CPU decoding without
  telling anyone. The engine now requests `hwdec=auto`, adds software-decode
  fast paths (`vd-lavc-fast`, skip-loopfilter) as a safety net, and — most
  importantly — **Stats for nerds (press `I`) now shows the live decode
  path**: `hardware · d3d11va` in green, or an explicit amber
  "software (slower — enable HW accel in Settings)" warning. Nothing is
  silent anymore.

Also in v0.5.0: the stats overlay reports the active renderer, container and
rendered FPS, dropped frames, A/V sync offset and bitrate (probed on demand
at 1 Hz *only while the overlay is open* — zero idle timers, per spec).

## What's new in v0.4.0 — bulletproof installer + the real SQLite library (Phase 2)

- **Fixed: the installer that couldn't install** — v0.3's setup could fail with
  `error writing to file resources\mpv-2.dll` when OMP was still running (or the
  antivirus briefly held the 116 MB engine DLL). A half-installed OMP then ran
  on the heavy WebView fallback — which is exactly why CPU looked *worse*
  (60–70%) after "upgrading". The v0.4 installer force-closes OMP first,
  waits for file handles to release, and retries locked files before
  extracting. Upgrading over any old version now just works.
- **Engine health check** — if the native engine is ever missing from an
  install, Settings says so explicitly instead of silently falling back.
- **Phase 2: the real media library (SQLite)** — point OMP at a folder and it
  builds a searchable, sortable library stored in a local SQLite database:
  * **Real scanner** — walks your folders (with a skip list for system dirs),
    indexes video + audio, prunes vanished files. **Incremental** (unchanged
    files are skipped by size+mtime), **cancellable** (Cancel scan button),
    and **paced on a background thread** so playback never stutters.
    Zero disk activity while idle — nothing scans unless you ask.
  * **Thumbnails** — extracted with a throwaway headless libmpv instance that
    decodes exactly one frame at ~25% into the file. No extra downloads, no
    background churn.
  * **Metadata** — duration, resolution, video/audio codec and container come
    from the same engine that plays your files, so what you see is what plays.
  * **Library UI** — poster grid with duration/quality badges and watch
    progress bars, Continue Watching strip, A–Z / Newest / Recently played /
    Longest / Most played sorting, type filters, folder chips with one-click
    removal, full right-click menus (Play / Resume / Play from start / Open
    file location / Remove).
  * **Resume everywhere** — positions are saved to SQLite for both engines and
    playback resumes where you left off, including files you simply "Open
    with" OMP (they get indexed automatically).
  * **Live storage stats** — Settings shows videos / tracks / thumbnails /
    folders counts from the real database.

## What's new in v0.3.0 — the native mpv engine

- **VLC-grade CPU, for real this time** — OMP now embeds **libmpv** (the same
  engine core mpv/VLC-class players use) as the native playback engine. Video
  decodes with hardware acceleration (D3D11VA) and renders on its own GPU
  surface *below* the transparent UI — measured CPU for normal playback drops
  from ~30-37% (WebView path) to a small fraction of that on the same files.
- **Color adjustments no longer eat the PC** — brightness / contrast /
  saturation / hue are now mpv GPU shader properties (~0% extra CPU) instead of
  CSS filters that forced Chromium to re-process every single frame (the 48.5%
  spike). On the WebView fallback engine the filter is now only applied when a
  value is actually changed from neutral.
- **Every format. Really.** — the bundled GPL libmpv decodes MKV, HEVC/H.265,
  AVI, WMV, FLV, TS, and more, with auto-loaded external subtitles
  (`sub-auto=fuzzy`) and multi-track audio/subtitle menus. The engine streams
  HTTP(S) media natively too.
- **Engine selector** — Settings → Playback engine: Auto (default, uses mpv
  when present), mpv (force native), WebView (compatibility fallback). Stats
  for nerds shows the live engine and libmpv API version.
- **WebView engine still improved** — title chip auto-hides while playing and
  the mouse is idle (windowed too, not just fullscreen), PiP and web-only
  controls are gated per engine, and the UI stops paying for transitions while
  frames are playing.
- **Sane plumbing** — native file dialogs now hand real filesystem paths to
  mpv; snapshots save natively to Pictures\\OMP; the surface tracks the stage
  rect across resizes, fullscreen and DPI changes; the engine shuts down
  cleanly on exit.

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
| Online playback  | YouTube nocookie embeds + bundled yt-dlp → native mpv (1000+ sites) |

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
