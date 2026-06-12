// Рисование линий по PointGroup (переиспользуется эффектом «линии»). Топология:
//  - native:  родные рёбра группы (скелет руки) ИЛИ цепь по индексу, если рёбер нет;
//  - chain:   цепь по порядку точек;
//  - nearest: все пары ближе nearestDist (как constellation).
// Рисует прямо в Canvas2D-контекст (ARCHITECTURE §0.2/§3 P1) — без SVG-строк.

import { getPointAttr, getPointAttrVec, type PointGroup } from "../core/types";
import { serpCurve, type SerpAxis } from "./constellationUtil";

export interface LineSettings {
  topology: "native" | "chain" | "nearest";
  nearestDist: number;
  maxLinks: number; // макс. связей на точку в режиме "nearest" (0 = все в пределах дистанции)
  gradient: boolean;
  colorA: string;
  colorB: string;
  width: number;
  widthRandom: number;
  curve: number;
  axis: SerpAxis;
  showNodes: boolean;
  nodeScaleMin: number;
  nodeScaleMax: number;
  labelChance: number;
}

// детерминированный «рандом» 0..1 по числу (стабилен между кадрами)
const h01 = (n: number) => { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); };

// Достаём настройки линий из params модификатора (с дефолтами на всякий случай).
export function toLineSettings(p: Record<string, number | string | boolean>): LineSettings {
  return {
    topology: (p.topology as LineSettings["topology"]) ?? "native",
    nearestDist: Number(p.nearestDist ?? 0.18),
    maxLinks: Number(p.maxLinks ?? 0),
    gradient: !!p.gradient,
    colorA: String(p.colorA ?? "#3cffaa"),
    colorB: String(p.colorB ?? "#36e6ff"),
    width: Number(p.width ?? 1.6),
    widthRandom: Number(p.widthRandom ?? 0.4),
    curve: Number(p.curve ?? 0.35),
    axis: (p.axis as SerpAxis) ?? "auto",
    showNodes: !!p.showNodes,
    nodeScaleMin: Number(p.nodeScaleMin ?? 1.2),
    nodeScaleMax: Number(p.nodeScaleMax ?? 4),
    labelChance: Number(p.labelChance ?? 0),
  };
}

export function drawLines(
  ctx: CanvasRenderingContext2D,
  group: PointGroup,
  // U1: map принимает опц. z (3D-точки). z===undefined → 2D-путь байт-в-байт (плоские продюсеры);
  // z задан → проекция через камеру облака / fakePerspective (см. ModifierOverlay).
  map: (nx: number, ny: number, z?: number) => readonly [number, number],
  s: LineSettings,
): void {
  const pts = group.points;
  if (pts.length < 1) return;
  const scr = pts.map((p) => map(p.x, p.y, p.z));
  // Размер узлов/линий масштабируется атрибутом pscale (SoA attrs, T2-1). Фолбэк: устар. values[],
  // затем 1.0. getPointAttr скрывает источник (attrs vs legacy values) — back-compat сохранён.
  const vals = getPointAttr(group, "pscale") ?? pts.map(() => 1);
  const colA = group.color ?? s.colorA;
  // Per-точечный цвет Cd (T2-2): если у группы есть векторный атрибут "Cd" (comps=3, rgb 0..1),
  // красим узлы И линии этим цветом, переопределяя colorA/colorB/градиент. Фолбэк — прежнее поведение.
  const hasCd = !!group.attrs?.some((a) => a.name === "Cd");
  const cdCss: string[] | null = hasCd
    ? pts.map((_, i) => {
        const v = getPointAttrVec(group, "Cd", i);
        if (!v) return colA;
        const r = Math.round(v[0] * 255), g = Math.round(v[1] * 255), b = Math.round(v[2] * 255);
        return `rgb(${r},${g},${b})`;
      })
    : null;

  // строим список рёбер по топологии
  const edges: [number, number][] = [];
  if (s.topology === "native" && group.links && group.links.length) {
    for (const e of group.links) edges.push(e);
  } else if (s.topology === "nearest") {
    // k ближайших на точку в пределах дистанции (maxLinks=0 -> все в пределах дистанции)
    const md = s.nearestDist * s.nearestDist;
    const maxL = Math.max(0, Math.round(s.maxLinks));
    const seen = new Set<number>();
    for (let i = 0; i < pts.length; i++) {
      const cand: { j: number; d: number }[] = [];
      for (let j = 0; j < pts.length; j++) {
        if (j === i) continue;
        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
        const d = dx * dx + dy * dy;
        if (d <= md) cand.push({ j, d });
      }
      cand.sort((a, b) => a.d - b.d);
      const lim = maxL > 0 ? Math.min(maxL, cand.length) : cand.length;
      for (let k = 0; k < lim; k++) {
        const j = cand[k].j;
        const key = i < j ? i * 100000 + j : j * 100000 + i; // дедуп рёбер
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push([i, j]);
      }
    }
  } else {
    // chain (или native без рёбер) — последовательная цепь по индексу
    for (let i = 0; i + 1 < pts.length; i++) edges.push([i, i + 1]);
  }

  const denom = Math.max(0.001, s.nodeScaleMax);
  ctx.lineCap = "round";
  for (const [a, b] of edges) {
    const A = scr[a], B = scr[b];
    if (!A || !B) continue;
    const wf = (s.nodeScaleMin + (s.nodeScaleMax - s.nodeScaleMin) * ((vals[a] + vals[b]) * 0.5)) / denom;
    const sw = Math.max(0.2, s.width * wf * (1 + (h01(a * 131 + b) - 0.5) * 2 * s.widthRandom));
    if (cdCss) {
      // Cd: градиент по per-точечному цвету Cd[a]->Cd[b] (переопределяет colorA/B/gradient).
      const g = ctx.createLinearGradient(A[0], A[1], B[0], B[1]);
      g.addColorStop(0, cdCss[a]); g.addColorStop(1, cdCss[b]);
      ctx.strokeStyle = g;
    } else if (s.gradient) {
      const g = ctx.createLinearGradient(A[0], A[1], B[0], B[1]);
      g.addColorStop(0, colA); g.addColorStop(1, s.colorB);
      ctx.strokeStyle = g;
    } else {
      ctx.strokeStyle = colA;
    }
    ctx.lineWidth = sw;
    ctx.beginPath();
    serpCurve(ctx, A[0], A[1], B[0], B[1], s.curve, s.axis);
    ctx.stroke();
  }

  if (s.showNodes) {
    ctx.fillStyle = colA;
    for (let i = 0; i < scr.length; i++) {
      const [x, y] = scr[i];
      const r = Math.max(0.3, s.nodeScaleMin + (s.nodeScaleMax - s.nodeScaleMin) * vals[i]);
      ctx.fillStyle = cdCss ? cdCss[i] : colA; // Cd переопределяет цвет узла per-точечно
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      if (h01(i * 7.31) < s.labelChance) {
        const lbl = (((h01(i * 3.13) * 0xfff) | 0).toString(16).toUpperCase().padStart(3, "0"));
        ctx.fillStyle = s.colorB;
        ctx.font = "9px monospace";
        ctx.fillText(lbl, x + 4, y - 4);
      }
    }
  }
}
