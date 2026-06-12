// Растеризация форм на точках (конвертер Splat: PointSet -> Map2D). Рисует залитую форму на
// каждой точке группы в Canvas2D-контекст; результат уходит CanvasTexture'ой в видео-шейдер
// (см. SplatMask + flatShader uSplat). Координаты точек норм. 0..1; map() -> пиксели канваса.

import type { PointGroup } from "../core/types";

export interface SplatSettings {
  shape: "square" | "disc";
  mode: "overlay" | "alpha"; // композит в шейдере (читается продюсером для uSplatMode)
  size: number;        // доля кадра (радиус)
  sizeByValue: number; // 0..1 — насколько размер ∝ value точки
  color: string;
  opacity: number;     // 0..1
  feather: number;     // 0..1 — мягкость края (радиальный градиент, для диска)
}

const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);

export function toSplatSettings(p: Record<string, number | string | boolean>): SplatSettings {
  return {
    shape: p.shape === "disc" ? "disc" : "square",
    mode: p.mode === "alpha" ? "alpha" : "overlay",
    size: num(p.size, 0.04),
    sizeByValue: num(p.sizeByValue, 0.5),
    color: str(p.colorA, "#ffffff"),
    opacity: num(p.opacity, 1),
    feather: num(p.feather, 0),
  };
}

// Растеризовать формы группы в ctx. unit = px-масштаб для size (обычно высота канваса-кадра).
export function drawSplats(
  ctx: CanvasRenderingContext2D,
  group: PointGroup,
  map: (nx: number, ny: number) => readonly [number, number],
  s: SplatSettings,
  unit: number,
) {
  const pts = group.points;
  if (!pts.length) return;
  const vals = group.values ?? pts.map(() => 1);
  ctx.globalAlpha = Math.max(0, Math.min(1, s.opacity));
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const v = Math.max(0, Math.min(1, vals[i] ?? 1));
    const scale = (1 - s.sizeByValue) + s.sizeByValue * v; // value модулирует размер
    const r = Math.max(0.5, s.size * unit * scale);
    const [x, y] = map(p.x, p.y);
    if (s.shape === "disc") {
      if (s.feather > 0) {
        const inner = r * (1 - Math.min(0.99, s.feather));
        const g = ctx.createRadialGradient(x, y, inner, x, y, r);
        g.addColorStop(0, s.color);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = s.color;
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = s.color;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
  ctx.globalAlpha = 1;
}
