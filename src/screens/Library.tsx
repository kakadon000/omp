import { useState } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import { navigate } from "../lib/router";
import { loadHistory, clearHistory, type HistItem } from "../lib/store";
import { fmtClock } from "../lib/format";

export function Library({ query }: { query: string }) {
  const [tab, setTab] = useState<"history" | "playlists">("history");
  const [hist, setHist] = useState<HistItem[]>(() => loadHistory());
  const q = query.toLowerCase();
  const items = hist.filter((h) => !q || h.name.toLowerCase().includes(q));

  const kindIcon = (k: HistItem["kind"]) => (k === "video" ? "film" : k === "music" ? "music" : "image");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div className="seg">
          <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>History</button>
          <button className={tab === "playlists" ? "on" : ""} onClick={() => setTab("playlists")}>Playlists</button>
        </div>
        <span style={{ flex: 1 }} />
        {tab === "history" && hist.length > 0 && (
          <button className="btn sm danger" onClick={() => { clearHistory(); setHist([]); toast("History cleared", "ok"); }}>
            <Icon name="trash" size={14} /> Clear history
          </button>
        )}
      </div>

      {tab === "history" && (
        <div className="card" style={{ padding: 8 }}>
          {items.map((h) => (
            <div
              key={`${h.id}-${h.at}`}
              className="hist-row"
              onClick={() => navigate(h.kind === "music" ? "music" : h.kind === "image" ? "gallery" : "player")}
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
          {items.length === 0 && (
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
                onClick={() => toast("Playlist editing arrives with the SQLite library (Phase 2)", "info")}>
                <span className="icon-btn sm" style={{ background: "var(--accent-dim)", color: "var(--accent)", marginBottom: 8 }}>
                  <Icon name={p.icon} size={14} />
                </span>
                <div className="v" style={{ fontSize: 16 }}>{p.name}</div>
                <div className="k">{p.n} items</div>
              </div>
            ))}
          </div>
          <button className="btn" onClick={() => toast("Playlist creation arrives with Phase 2", "info")}>
            <Icon name="plus" size={15} /> New playlist
          </button>
        </>
      )}
    </div>
  );
}
