// v0.14.0 — Downloader screen: paste a link, pick a quality, watch it land.
// Powered by the bundled yt-dlp (YouTube · Instagram · X · TikTok · Facebook
// · LinkedIn + 1000 more) and the bundled FFmpeg for merging / MP3 extraction.

import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { invoke, isTauri } from "../lib/tauri";
import { fmtTime } from "../lib/format";
import {
  dlStore, wireDlEvents, fetchInfo, startDownload, cancelJob, removeJob,
  dlStatus, dlHistory, dlHistoryClear, savedDir, rememberDir,
  type DlInfo, type DlStatus, type DlHist,
} from "../lib/downloader";

type Qual = "best" | "1080" | "720" | "480" | "audio";

const QUALS: { q: Qual; label: string }[] = [
  { q: "best", label: "Best" },
  { q: "1080", label: "1080p" },
  { q: "720", label: "720p" },
  { q: "480", label: "480p" },
  { q: "audio", label: "MP3" },
];

export function Downloader() {
  const jobs = useSyncExternalStore(dlStore.sub, dlStore.get);
  const [status, setStatus] = useState<DlStatus | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<DlInfo | null>(null);
  const [qual, setQual] = useState<Qual>("best");
  const [dir, setDir] = useState(savedDir());
  const [hist, setHist] = useState<DlHist[]>([]);

  // status + events + default folder + history
  useEffect(() => {
    if (!isTauri) return;
    void wireDlEvents();
    void dlStatus().then((s) => setStatus(s)).catch(() => setStatus({ available: false, path: "", version: "", ffmpeg: false }));
    if (!savedDir()) {
      void import("@tauri-apps/api/path").then(({ appDataDir }) =>
        appDataDir().then((base) => {
          const d = `${base.replace(/[\\/]+$/, "")}\\Downloads`;
          rememberDir(d);
          setDir(d);
        }).catch(() => { /* keep the manual folder picker */ })
      );
    }
    void dlHistory().then(setHist).catch(() => setHist([]));
  }, []);

  const refreshHist = () => void dlHistory().then(setHist);

  const pickDir = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const p = await open({ directory: true });
      if (typeof p === "string" && p) {
        rememberDir(p);
        setDir(p);
      }
    } catch { /* dialog cancelled */ }
  };

  const doFetch = async () => {
    const u = url.trim();
    if (!u) return;
    setBusy(true);
    setInfo(null);
    try {
      const r = await fetchInfo(u);
      if (!r) {
        toast("Could not resolve that link — is it public and supported?", "err");
        return;
      }
      setInfo(r);
    } catch {
      // v0.14.1 — a rejected fetch used to leave the button on "Resolving…" forever
      toast("Could not resolve that link — is it public and supported?", "err");
    } finally {
      setBusy(false);
    }
  };

  const maxH = info?.formats.reduce((a, f) => Math.max(a, f.height), 0) || 0;

  const doDownload = () => {
    if (!info || !dir) return;
    startDownload(info, qual, dir);
    toast("Download started", "ok");
  };

  const reveal = (p: string) => void invoke("library_reveal", { path: p });

  /* ---------------- web demo — honest wall ---------------- */
  if (!isTauri) {
    return (
      <div>
        <div className="page-title" style={{ fontSize: 22 }}>Downloader</div>
        <div className="page-sub">Save videos from YouTube, Instagram, X and 1000+ more sites</div>
        <div className="card ed-empty" style={{ marginTop: 14 }}>
          <span className="icon-btn lg" style={{ background: "var(--accent-dim)", color: "var(--accent)", borderRadius: 99 }}>
            <Icon name="download" size={26} />
          </span>
          <div style={{ fontSize: 15.5, fontWeight: 600, marginTop: 10 }}>Desktop feature</div>
          <div style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 4, maxWidth: 420, textAlign: "center" }}>
            Downloads run on the real yt-dlp engine bundled inside the OMP desktop app.
            Grab the installer from the release page and paste any video link there.
          </div>
        </div>
      </div>
    );
  }

  const engineOk = !!status?.available;

  return (
    <div className="dl-root">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div className="page-title" style={{ fontSize: 22 }}>Downloader</div>
          <div className="page-sub">YouTube · Instagram · X · TikTok · Facebook · LinkedIn + 1000 more</div>
        </div>
        <span style={{ flex: 1 }} />
        <button
          className={`hero-engine ${status ? (engineOk ? "ok" : "bad") : ""}`}
          onClick={() => { /* informational pill */ }}
          style={{ cursor: "default" }}
          title={status?.path || "yt-dlp"}
        >
          <span className={`health-dot ${status ? (engineOk ? "ok" : "bad") : ""}`} />
          <span className="he-col">
            <span className="he-t">{status ? (engineOk ? `yt-dlp ${status?.version || "ready"}` : "yt-dlp missing") : "yt-dlp — checking…"}</span>
            <span className="he-s">{status ? (engineOk ? "bundled engine · local" : "Settings → Engine & tools → Repair") : "talking to the bundled engine"}</span>
          </span>
        </button>
      </div>

      {/* ---------- link box ---------- */}
      <div className="card dl-linkbox anim-in">
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="input"
            placeholder="Paste any video link — https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void doFetch(); }}
            spellCheck={false}
          />
          <button className="btn accent" onClick={() => void doFetch()} disabled={busy || !url.trim()}>
            {busy ? <Icon name="clock" size={15} /> : <Icon name="globe" size={15} />}
            {busy ? "Resolving…" : "Fetch"}
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>
            <Icon name="folder" size={12} style={{ verticalAlign: -2 }} /> Save to
          </span>
          <span className="chip" style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}>{dir || "…"}</span>
          <button className="btn sm" onClick={() => void pickDir()}>Change folder</button>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>Files stay on your PC — nothing is uploaded.</span>
        </div>
      </div>

      {/* ---------- info + quality ---------- */}
      {info && (
        <div className="card dl-info anim-in">
          {info.thumb && <img className="dl-thumb" src={info.thumb} alt="" />}
          <div className="dl-info-main">
            <div className="dl-title">{info.title}</div>
            <div className="dl-meta">
              {info.uploader && <span>{info.uploader}</span>}
              {info.duration > 0 && <span>{fmtTime(info.duration)}</span>}
              {info.extractor && <span className="chip" style={{ fontSize: 10, padding: "1px 8px" }}>{info.extractor}</span>}
              {info.is_live && <span className="chip" style={{ fontSize: 10, padding: "1px 8px" }}>LIVE</span>}
            </div>
            <div className="prop-label" style={{ marginTop: 12 }}>Quality</div>
            <div className="seg" style={{ marginBottom: 12 }}>
              {QUALS.map(({ q, label }) => {
                const h = q === "1080" || q === "720" || q === "480" ? Number(q) : 0;
                const disabled = h > 0 && maxH > 0 && h > maxH;
                return (
                  <button key={q} className={qual === q ? "on" : ""} disabled={disabled} onClick={() => setQual(q)}>
                    {label}
                  </button>
                );
              })}
            </div>
            <button className="btn accent" onClick={doDownload}>
              <Icon name="download" size={15} /> Download
            </button>
          </div>
        </div>
      )}

      {/* ---------- active jobs ---------- */}
      {jobs.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 18 }}>Active &amp; recent</div>
          <div className="card dl-jobs">
            {jobs.map((j) => (
              <div key={j.id} className="dl-job">
                <div className="dl-job-top">
                  <span className="dl-job-t">{j.title}</span>
                  <span className="chip" style={{ fontSize: 10, padding: "1px 8px" }}>
                    {j.quality === "audio" ? "MP3" : j.quality === "best" ? "Best" : `${j.quality}p`}
                  </span>
                  <span style={{ flex: 1 }} />
                  {j.phase === "progress" || j.phase === "queued" ? (
                    <>
                      <span className="dl-job-stat">{j.pct.toFixed(1)}%{j.speed ? ` · ${j.speed}` : ""}{j.eta ? ` · ETA ${j.eta}` : ""}</span>
                      <button className="btn sm danger" onClick={() => cancelJob(j.id)}>Cancel</button>
                    </>
                  ) : j.phase === "done" ? (
                    <>
                      <span className="dl-job-stat ok">Done</span>
                      {j.path && <button className="btn sm" onClick={() => reveal(j.path)}><Icon name="folder" size={12} /> Show in folder</button>}
                      <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => removeJob(j.id)} aria-label="Clear row"><Icon name="close" size={12} /></button>
                    </>
                  ) : j.phase === "cancelled" ? (
                    <>
                      <span className="dl-job-stat">Cancelled</span>
                      <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => removeJob(j.id)} aria-label="Clear row"><Icon name="close" size={12} /></button>
                    </>
                  ) : (
                    <>
                      <span className="dl-job-stat err" title={j.error}>Failed — {j.error.slice(0, 80)}</span>
                      <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => removeJob(j.id)} aria-label="Clear row"><Icon name="close" size={12} /></button>
                    </>
                  )}
                </div>
                <div className="bar-track" style={{ marginTop: 6 }}>
                  <div
                    className={`bar-fill ${j.phase === "error" ? "err" : ""}`}
                    style={{ width: `${j.phase === "error" ? 100 : j.phase === "done" ? 100 : j.pct}%`, opacity: j.phase === "error" ? 0.35 : 1 }}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ---------- history ---------- */}
      {hist.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 18 }}>
            Downloaded
            <button className="btn sm" style={{ marginLeft: 10 }} onClick={() => { void dlHistoryClear().then(refreshHist); toast("Download history cleared", "ok"); }}>
              <Icon name="trash" size={12} /> Clear list
            </button>
          </div>
          <div className="card dl-hist">
            {hist.map((h, i) => (
              <div key={`${h.created}-${i}`} className="dl-hrow">
                <Icon name={h.quality === "audio" ? "music" : "film"} size={15} />
                <span className="dl-hr-t">{h.title}</span>
                <span className="chip" style={{ fontSize: 10, padding: "1px 8px" }}>{h.quality === "audio" ? "MP3" : h.quality === "best" ? "Best" : `${h.quality}p`}</span>
                <span style={{ flex: 1 }} />
                {h.path && <button className="btn sm" onClick={() => reveal(h.path)}><Icon name="folder" size={12} /> Folder</button>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
