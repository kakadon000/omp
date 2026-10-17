import { useEffect, useState } from "react";
import { Icon } from "./Icon";

type ToastItem = { id: number; msg: string; type: "ok" | "err" | "info" };
type Emit = { id: number; msg: string; type: ToastItem["type"] };

let counter = 0;
const listeners = new Set<(t: Emit) => void>();

export function toast(msg: string, type: ToastItem["type"] = "info") {
  const e = { id: ++counter, msg, type };
  listeners.forEach((f) => f(e));
}

export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const on = (e: Emit) => {
      setItems((cur) => [...cur, e]);
      setTimeout(() => {
        setItems((cur) => cur.map((t) => (t.id === e.id ? { ...t, msg: t.msg, out: true } as ToastItem & { out?: boolean } : t)));
        setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== e.id)), 220);
      }, 3200);
    };
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, []);

  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>
          <Icon name={t.type === "ok" ? "check" : t.type === "err" ? "alert" : "info"} />
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}
