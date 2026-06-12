// Общие хелперы для constellation в 2D (Overlay) и 3D (Constellation3D),
// чтобы линии выглядели одинаково.

const parse = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// Цвет вдоль градиента c1->c2 (для подкраски точек/текста), с альфой.
export function tintRgba(c1: string, c2: string, t: number, alpha: number): string {
  const a = parse(c1), b = parse(c2);
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgba(${r},${g},${bl},${alpha.toFixed(3)})`;
}

// Ось касательной node-«лапши»: x — горизонталь (Blender/Unreal), y — вертикаль
// (geometry nodes сверху-вниз), auto — по доминирующей оси отрезка A→B.
export type SerpAxis = "x" | "y" | "auto";

// Контрольные точки «лапши» как в node-редакторах (Houdini/Blender/Unreal): кубическая
// Безье, где провод ВЫХОДИТ и ВХОДИТ вдоль выбранной оси (касательная), изгиб — в середине.
// Длина касательной ~ расстоянию по этой оси; curve масштабирует изгиб.
function serpCtrl(ax: number, ay: number, bx: number, by: number, curve: number, axis: SerpAxis): [number, number, number, number] {
  const dx = bx - ax, dy = by - ay;
  const useX = axis === "auto" ? Math.abs(dx) >= Math.abs(dy) : axis === "x";
  const d = useX ? dx : dy;
  const dir = d >= 0 ? 1 : -1;
  const tan = (Math.abs(d) * 0.5 + 22) * (0.25 + curve * 0.85);
  const c1x = useX ? ax + dir * tan : ax;
  const c1y = useX ? ay : ay + dir * tan; // выход из A вдоль оси
  const c2x = useX ? bx - dir * tan : bx;
  const c2y = useX ? by : by - dir * tan; // вход в B вдоль оси
  return [c1x, c1y, c2x, c2y];
}

// SVG-путь «лапши» (для SVG-оверлеев / renderLines).
export function serpPath(ax: number, ay: number, bx: number, by: number, curve: number, axis: SerpAxis = "x"): string {
  const [c1x, c1y, c2x, c2y] = serpCtrl(ax, ay, bx, by, curve, axis);
  return `M${ax.toFixed(1)} ${ay.toFixed(1)}C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`;
}

// Та же кривая в Canvas2D: выдаёт moveTo + bezierCurveTo в текущий путь (beginPath/stroke — на вызывающем).
export function serpCurve(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, curve: number, axis: SerpAxis = "x"): void {
  const [c1x, c1y, c2x, c2y] = serpCtrl(ax, ay, bx, by, curve, axis);
  ctx.moveTo(ax, ay);
  ctx.bezierCurveTo(c1x, c1y, c2x, c2y, bx, by);
}
