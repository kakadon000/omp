import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { openContextMenu } from "../components/ContextMenu";
import { navigate } from "../lib/router";
import { loadHistory, clearHistory, removeHistory, customMedia, type HistItem } from "../lib/store";
import { isTauri } from "../lib/tauri";
import { fmtClock, fmtTime, fmtSize } from "../lib/format";
import {
  type MediaItem, type ScanEvent,
  listItems, continueList, addFolder, rescan, cancelScan,
  removeItem, removeFolder, getFolders, pickFolder, playItem, onScanEvent,
  fileSrc, notePlay, revealFile,
} from "../lib/library";

/* ------------------------- library tab ------------------------- */

function durLabel(s: number): string {
  if (!s || s <= 0) return "";
  if (s < 3600) return fmtTime(s);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function LibCard({ it, onMenu, wide }: {
  it: MediaItem;
  onMenu: (e: React.MouseEvent, it: MediaItem) => void;
  wide?: boolean;
}) {
  const progress = it.duration > 0 && it.position > 5 ? Math.min(96, (it.position / it.duration) * 100) : 0;
  const res = it.height >= 2160 ? "4K" : it.height >= 1440 ? "2K" : it.height >= 1000 ? "1080p" : it.height >= 700 ? "720p" : it.height > 0 ? `${it.height}p` : "";
  const sub = it.kind === "audio"
    ? [it.acodec.toUpperCase(), fmtSize(it.size)].filter(Boolean).join(" · ")
    : [res, it.container, fmtSize(it.size)].filter(Boolean).join(" · ");
  return (
    <div
      className={`lib-card ${wide ? "wide" : ""}`}
      onClick={() => void playItem(it)}
      onContextMenu={(e) => onMenu(e, it)}
      title={it.path}
    >
      <div className="lib-thumb">
        {it.thumb ? (
          <img src={fileSrc(it.thumb)} alt="" loading="lazy" />
        ) : (
          <span className="lib-fallback"><Icon name={it.kind === "audio" ? "music" : "film"} size={22} /></span>
        )}
        {durLabel(it.duration) && <span className="lib-dur">{durLabel(it.duration)}</span>}
        {progress > 0 && <span className="lib-prog" style={{ width: `${progress}%` }} />}
      </div>
      <div className="lib-meta">
        <div className="lib-title">{it.title}</div>
        <div className="lib-sub">{sub || "—"}</div>
      </div>
    </div>
  );
}

export function Library({ query }: { query: string }) {
  const [tab, setTab] = useState<"library" | "history" | "playlists">("library");

  /* ---- library (SQLite) state ---- */
  const [items, setItems] = useState<MediaItem[]>([]);
  const [cont, setCont] = useState<MediaItem[]>([]);
  const [foldersList, setFoldersList] = useState<string[]>([]);
  const [sort, setSort] = useState<"added" | "recent" | "title" | "duration" | "plays">("added");
  const [kind, setKind] = useState<"all" | "video" | "audio">("all");
  const [scan, setScan] = useState<ScanEvent | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const reloadRef = useRef<() => void>(() => {});

  const reload = useCallback(async () => {
    const q = query.trim();
    const [list, c, f] = await Promise.all([
      listItems(q, kind, sort),
      tab === "library" ? continueList() : Promise.resolve([]),
      getFolders(),
    ]);
    setItems(list);
    setCont(c);
    setFoldersList(f);
  }, [query, kind, sort, tab]);
  reloadRef.current = () => void reload();

  useEffect(() => {
    if (tab !== "library") return;
    void reload();
  }, [tab, reload]);

  // scan progress events → banner + auto refresh when finished
  useEffect(() => {
    return onScanEvent((e) => {
      setScan(e);
      setScanning(e.phase !== "done");
      if (e.phase === "done") {
        reloadRef.current();
        toast(`Library updated — ${e.found > 0 ? `${e.found} new file${e.found === 1 ? "" : "s"}` : "already up to date"}`, "ok");
      }
    });
  }, []);

  // pick up a scan that was already running (e.g. after re-opening the screen)
  useEffect(() => {
    void (async () => {
      const f = await getFolders();
      setFoldersList(f);
    })();
  }, []);

  const doAddFolder = async () => {
    const dir = await pickFolder();
    if (!dir) return;
    setBusy(true);
    const ok = await addFolder(dir);
    setBusy(false);
    if (ok) {
      toast("Scanning folder — incremental, cancellable, playback-safe", "info");
      setScanning(true);
      setFoldersList(await getFolders());
    }
  };

  const doRescan = async () => {
    if (await rescan()) {
      setScanning(true);
      toast("Rescan started", "info");
    }
  };

  const libMenu = (e: React.MouseEvent, it: MediaItem) => {
    e.preventDefault();
    e.stopPropagation();
    const canResume = it.duration > 0 && it.position > 5 && it.position / it.duration < 0.95;
    openContextMenu(e.clientX, e.clientY, [
      { label: "Play", icon: "play", onClick: () => void playItem(it) },
      ...(canResume
        ? [{
            label: `Resume at ${fmtTime(it.position)}`, icon: "stepF",
            onClick: () => void playItem(it), // playItem resumes automatically
          }]
        : []),
      ...(canResume
        ? [{
            label: "Play from start", icon: "rotate",
            onClick: () => {
              customMedia.set({
                name: it.title,
                url: fileSrc(it.path),
                path: it.path,
                startAt: 0,
              });
              void notePlay(it.path);
              navigate("player");
            },
          }]
        : []),
      { sep: true },
      { label: "Open file location", icon: "folder", onClick: () => void revealFile(it.path) },
      { sep: true },
      {
        label: "Remove from library", icon: "trash", danger: true,
        onClick: async () => {
          if (await removeItem(it.id)) {
            toast("Removed from library", "ok");
            reloadRef.current();
          }
        },
    },
    ], it.title);
  };

  /* ---- history (kept from v0.2) ---- */
  const [hist, setHist] = useState<HistItem[]>(() => loadHistory());
  const q = query.toLowerCase();
  const histItems = hist.filter((h) => !q || h.name.toLowerCase().includes(q));
  const kindIcon = (k: HistItem["kind"]) => (k === "video" ? "film" : k === "music" ? "music" : "image");
  const histMenu = (e: React.MouseEvent, h: HistItem) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      {
        label: "Open", icon: "play",
        onClick: () => navigate(h.kind === "music" ? "music" : h.kind === "image" ? "gallery" : "player"),
      },
      { sep: true },
      {
        label: "Remove from history", icon: "trash", danger: true,
        onClick: () => { setHist(removeHistory(h.id, h.at)); toast("Removed from history", "ok"); },
      },
      {
        label: "Clear all history", icon: "trash", danger: true,
        onClick: () => { clearHistory(); setHist([]); toast("History cleared", "ok"); },
      },
    ], h.name);
  };

  const totalMedia = items.length;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div className="seg">
          <button className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>Library</button>
          <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>History</button>
          <button className={tab === "playlists" ? "on" : ""} onClick={() => setTab("playlists")}>Playlists</button>
        </div>
        <span style={{ flex: 1 }} />
        {tab === "library" && (
          <>
            {scanning && (
              <button className="btn sm" onClick={() => { void cancelScan(); toast("Cancelling scan…", "info"); }}>
                <Icon name="close" size={14} /> Cancel scan
              </button>
            )}
            <button className="btn sm" onClick={() => void doRescan()} disabled={scanning || busy}>
              <Icon name="rotate" size={14} /> Rescan
            </button>
            <button className="btn sm accent" onClick={() => void doAddFolder()} disabled={busy}>
              <Icon name="plus" size={14} /> Add folder
            </button>
          </>
        )}
        {tab === "history" && hist.length > 0 && (
          <button className="btn sm danger" onClick={() => { clearHistory(); setHist([]); toast("History cleared", "ok"); }}>
            <Icon name="trash" size={14} /> Clear history
          </button>
        )}
      </div>

      {tab === "library" && (
        <>
          {/* scan progress banner */}
          {scanning && scan && (
            <div className="scan-bar">
              <span className="spinner" />
              <div className="scan-text">
                <b>
                  {scan.phase === "walk"
                    ? `Scanning folders — ${scan.found} file${scan.found === 1 ? "" : "s"} found`
                    : `Analyzing — ${scan.done} / ${scan.total}`}
                </b>
                {scan.current && <span>{scan.current}</span>}
              </div>
              {scan.total > 0 && scan.phase === "probe" && (
                <div className="scan-track"><i style={{ width: `${Math.round((scan.done / Math.max(1, scan.total)) * 100)}%` }} /></div>
              )}
            </div>
          )}

          {/* library folders */}
          {foldersList.length > 0 && (
            <div className="lib-folders">
              <Icon name="folder" size={14} />
              {foldersList.map((f) => (
                <span key={f} className="folder-chip" title={f}>
                  {f.split(/[\\/]/).filter(Boolean).pop() || f}
                  <button
                    aria-label={`Remove ${f}`}
                    onClick={async () => {
                      if (await removeFolder(f)) { toast("Folder removed", "ok"); reloadRef.current(); }
                    }}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* filters */}
          {totalMedia > 0 && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
              <div className="seg">
                {(["all", "video", "audio"] as const).map((k) => (
                  <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                    {k === "all" ? "All" : k === "video" ? "Videos" : "Music"}
                  </button>
                ))}
              </div>
              <div className="seg">
                {([["added", "Newest"], ["recent", "Recently played"], ["title", "A–Z"], ["duration", "Longest"], ["plays", "Most played"]] as const).map(([k, label]) => (
                  <button key={k} className={sort === k ? "on" : ""} onClick={() => setSort(k)}>{label}</button>
                ))}
              </div>
              <span style={{ fontSize: 12, color: "var(--text-3)" }}>{totalMedia} indexed</span>
            </div>
          )}

          {/* continue watching */}
          {cont.length > 0 && (
            <>
              <div className="section-label" style={{ marginTop: 4 }}>Continue watching</div>
              <div className="cont-row">
                {cont.map((it) => <LibCard key={`c-${it.id}`} it={it} onMenu={libMenu} wide />)}
              </div>
            </>
          )}

          {/* grid */}
          {items.length > 0 ? (
            <div className="lib-grid">
              {items.map((it) => <LibCard key={it.id} it={it} onMenu={libMenu} />)}
            </div>
          ) : (
            <div className="card">
              <div className="empty">
                <Icon name={foldersList.length ? "search" : "database"} />
                <div className="t">{foldersList.length ? (query ? "No matches" : "Nothing here yet") : "Build your library"}</div>
                <div className="d">
                  {foldersList.length
                    ? query ? `Nothing matches "${query}".` : "Rescan your folders, or add media by opening files — anything you play lands here with real metadata."
                    : "Point OMP at a folder of videos or music. The scanner is incremental and cancellable, thumbnails and metadata are extracted with the native engine, and everything stays on your device."}
                </div>
                {!foldersList.length && (
                  <button className="btn accent" style={{ marginTop: 12 }} onClick={() => void doAddFolder()} disabled={busy}>
                    <Icon name="folder" size={15} /> Add a folder
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {tab === "history" && (
        <div className="card" style={{ padding: 8 }}>
          {histItems.map((h) => (
            <div
              key={`${h.id}-${h.at}`}
              className="hist-row"
              onClick={() => navigate(h.kind === "music" ? "music" : h.kind === "image" ? "gallery" : "player")}
              onContextMenu={(e) => histMenu(e, h)}
            >
              <div className="hist-thumb">
                {h.thumb ? <img src={h.thumb} alt="" loading="lazy" /> : <Icon name={kindIcon(h.kind)} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>{h.kind === "video" ? "Video" : h.kind === "music" ? "Music" : "Image"} · {fmtClock(h.at)}</div>
              </div>
              <Icon name="chevronR" size={15} />
            </div>
          ))}
          {histItems.length === 0 && (
            <div className="empty">
              <Icon name="clock" />
              <div className="t">{query ? "No matches" : "Nothing watched yet"}</div>
              <div className="d">{query ? `Nothing matches "${query}".` : "Play something and your history will appear here. Stored only on your device — OMP has zero tracking."}</div>
            </div>
          )}
        </div>
      )}

      {tab === "playlists" && (
        <>
          <div className="stat-grid" style={{ marginBottom: 18, gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
            {[
              { name: "Favourites", icon: "heart", n: 12 },
              { name: "Focus Mix", icon: "sparkle", n: 8 },
              { name: "Watch Later", icon: "clock", n: 5 },
              { name: "Road Trip", icon: "rocket", n: 24 },
            ].map((p) => (
              <div key={p.name} className="card hover stat" style={{ cursor: "pointer", padding: 16 }}
                onClick={() => toast("Smart playlists land with Phase 3 (music) — the SQLite core is live today", "info")}>
                <span className="icon-btn sm" style={{ background: "var(--accent-dim)", color: "var(--accent)", marginBottom: 8 }}>
                  <Icon name={p.icon} size={14} />
                </span>
                <div className="v" style={{ fontSize: 16 }}>{p.name}</div>
                <div className="k">{p.n} items</div>
              </div>
            ))}
          </div>
          <button className="btn" onClick={() => toast("Playlist creation lands with Phase 3 — the SQLite core is live today", "info")}>
            <Icon name="plus" size={15} /> New playlist
          </button>
        </>
      )}
    </div>
  );
}
