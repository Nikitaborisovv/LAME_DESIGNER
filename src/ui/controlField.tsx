// Универсальный рендерер одной крутилки по ControlSpec из реестра слоёв.
// Используется и инспектором слоя, и блоком глобальных настроек сцены — единый стиль,
// data-driven (никакого дублирования разметки на каждый эффект).

import type { ControlSpec } from "../core/layerRegistry";
import type { SceneConfig } from "../core/types";

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="row">
      <span>{label}</span>
      {children}
    </label>
  );
}

// Хелперы-конструкторы спеков (для блока глобальных настроек в Controls).
export const R = (field: keyof SceneConfig, label: string, min: number, max: number, step: number): ControlSpec =>
  ({ field, type: "range", label, min, max, step });
export const C = (field: keyof SceneConfig, label: string): ControlSpec => ({ field, type: "check", label });
export const COL = (field: keyof SceneConfig, label: string): ControlSpec => ({ field, type: "color", label });
export const T = (field: keyof SceneConfig, label: string): ControlSpec => ({ field, type: "text", label });
export const SEL = (field: keyof SceneConfig, label: string, options: [string, string][]): ControlSpec =>
  ({ field, type: "select", label, options });

export function Field({ spec, value, onChange }: { spec: ControlSpec; value: unknown; onChange: (v: unknown) => void }) {
  const { type, label, min, max, step, options } = spec;

  if (type === "check") {
    return (
      <Row label={label}>
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      </Row>
    );
  }
  if (type === "color") {
    return (
      <Row label={label}>
        <input type="color" value={String(value ?? "#000000")} onChange={(e) => onChange(e.target.value)} />
      </Row>
    );
  }
  if (type === "text") {
    return (
      <Row label={label}>
        <input type="text" value={String(value ?? "")} placeholder="…" onChange={(e) => onChange(e.target.value)} />
      </Row>
    );
  }
  if (type === "select") {
    return (
      <Row label={label}>
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {(options ?? []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Row>
    );
  }
  if (type === "palette") return null; // палитра рендерится отдельным PaletteControl (нужен доступ к levels)
  // range — серая тонкая линия + розовое заполнение (по --val) + поле ручного ввода (T0d)
  const num = typeof value === "number" ? value : 0;
  const lo = min ?? 0, hi = max ?? 1;
  const pct = hi > lo ? Math.max(0, Math.min(100, ((num - lo) / (hi - lo)) * 100)) : 0;
  const numStyle: React.CSSProperties = {
    width: 52, fontSize: 11, padding: "1px 4px", borderRadius: 4, textAlign: "right",
    border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.3)",
    color: "#eef2f8", fontVariantNumeric: "tabular-nums", flexShrink: 0,
  };
  return (
    <Row label={label}>
      <div style={{ display: "flex", gap: 4, alignItems: "center", width: "100%" }}>
        <input type="range" min={min} max={max} step={step} value={num}
          style={{ ["--val" as string]: `${pct}%`, flex: 1, minWidth: 0 } as React.CSSProperties}
          onChange={(e) => onChange(+e.target.value)} />
        <input type="number" value={num} min={min} max={max} step={step} style={numStyle}
          onChange={(e) => { const v = +e.target.value; if (!isNaN(v)) onChange(Math.max(lo, Math.min(hi, v))); }} />
      </div>
    </Row>
  );
}

// нормализуем палитру к длине 16 (повторяя последний цвет)
function pad16(p: string[] | undefined, fallback: string): string[] {
  const a = (p ?? []).slice(0, 16);
  while (a.length < 16) a.push(a[a.length - 1] ?? fallback);
  return a;
}

// Палитра монохрома: показывает `levels` свотчей (растёт с числом цветов), каждый красится;
// селект пресетов заполняет палитру и ставит число цветов.
export function PaletteControl({
  palette, levels, glowMask, onPalette, onLevels, onGlow, presets,
}: {
  palette: string[] | undefined;
  levels: number;
  glowMask: boolean[] | undefined;
  onPalette: (p: string[]) => void;
  onLevels: (n: number) => void;
  onGlow: (mask: boolean[]) => void;
  presets: { name: string; colors: string[] }[];
}) {
  const pal = pad16(palette, "#000000");
  const gm = (glowMask ?? []).slice(0, 16);
  while (gm.length < 16) gm.push(false);
  const n = Math.max(1, Math.min(16, Math.round(levels || 1)));
  return (
    <div className="palette-control">
      <Row label="палитра">
        <select
          value=""
          onChange={(e) => {
            const p = presets[+e.target.value];
            if (!p) return;
            const np = pal.slice();
            p.colors.forEach((c, i) => { if (i < 16) np[i] = c; });
            onLevels(Math.min(16, p.colors.length));
            onPalette(np);
          }}
        >
          <option value="" disabled>пресет…</option>
          {presets.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
        </select>
      </Row>
      <div className="palette-swatches">
        {Array.from({ length: n }).map((_, i) => (
          <input
            key={i}
            type="color"
            className={gm[i] ? "glow" : undefined}
            value={pal[i]}
            title={`цвет ${i + 1} · 2× клик — свечение`}
            onChange={(e) => { const np = pal.slice(); np[i] = e.target.value; onPalette(np); }}
            onDoubleClick={() => { const ng = gm.slice(); ng[i] = !ng[i]; onGlow(ng); }}
          />
        ))}
      </div>
      <small style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.4 }}>
        2× клик по цвету → свечение (розовая рамка). Размер/сила — ниже.
      </small>
    </div>
  );
}
