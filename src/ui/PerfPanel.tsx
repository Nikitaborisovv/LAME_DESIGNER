import { useEffect, useState } from "react";
import { perf } from "../core/perf";

// Диагностический оверлей: per-stage ms + частоты. Тоггл по клавише «P» (рус. «з»).
// Пока скрыт — perf.enabled=false, сбор метрик отключён (нулевой оверхед).
// Цвет строки: зелёный < 4ms, жёлтый < 12ms, красный иначе (только для ms-стадий).
function msColor(ms: number) {
  if (ms <= 0) return "#7fd4ff";
  if (ms < 4) return "#5dff9b";
  if (ms < 12) return "#ffd23c";
  return "#ff5d5d";
}

export function PerfPanel() {
  const [on, setOn] = useState(false);
  const [rows, setRows] = useState<{ name: string; ema: number; max: number; rate: number }[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "p" && e.key !== "P" && e.key !== "з" && e.key !== "З") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      setOn((v) => {
        const nv = !v;
        perf.enabled = nv;
        if (nv) perf.reset();
        return nv;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!on) return;
    let raf = 0, last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 250) return;
      last = t;
      perf.flush(performance.now());
      setRows(perf.snapshot());
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [on]);

  if (!on) return null;
  return (
    <div
      style={{
        position: "fixed", top: 8, left: 8, zIndex: 9999,
        font: "11px/1.45 ui-monospace, monospace",
        background: "rgba(6,10,16,0.82)", color: "#cfe6ff",
        border: "1px solid #1d3550", borderRadius: 6, padding: "6px 8px",
        minWidth: 220, pointerEvents: "none", whiteSpace: "pre",
        backdropFilter: "blur(2px)",
      }}
    >
      <div style={{ color: "#7fd4ff", marginBottom: 4, fontWeight: 700 }}>PERF · «P» скрыть</div>
      {rows.map((r) => (
        <div key={r.name} style={{ display: "flex", justifyContent: "space-between", gap: 14 }}>
          <span style={{ color: "#8aa6c8" }}>{r.name}</span>
          <span style={{ color: msColor(r.ema) }}>
            {r.ema > 0 ? r.ema.toFixed(1) + "ms" : ""}
            {r.max > 0 ? " ↑" + r.max.toFixed(0) : ""}
            {r.rate > 0 ? "  " + r.rate.toFixed(0) + "/s" : ""}
          </span>
        </div>
      ))}
      {!rows.length && <div style={{ color: "#8aa6c8" }}>жду метрик… (загрузи видео)</div>}
    </div>
  );
}
