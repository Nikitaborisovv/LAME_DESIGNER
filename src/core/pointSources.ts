// «Производители точек»: какие слои отдают PointField и как их результат-реф
// нормализуется в общий контракт. Модификаторы (линии/точки/метки) читают это
// и рисуют по своим настройкам — не зная, откуда пришли точки.
//
// DataBus (Фаза 2): любой продюсер адресуется по хендлу (= его LayerKind). Модификатор
// может взять точки ЛЮБОГО продюсера через параметр `source` (а не только своего слоя) —
// см. fieldForLayerId + ModifierOverlay. Все точки нормированы 0..1 в координатах видео.

import type {
  HandResult, VisionResult, FaceResult, PeopleFrame, PointField, PointGroup, PointAttr, LayerKind, SceneConfig, DepthFrame, ResolvedProducer, ResolvedMapNode,
} from "./types";
import { getPointAttr } from "./types";
import type { FieldFn } from "./drivers";
import { fbm, mapForRef } from "./mapSources";
import { HAND_CONNECTIONS } from "../ml/handTopology";

const clockSec = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// hex "#rrggbb" -> [r,g,b] в 0..1 (для векторного атрибута Cd). Невалидный -> белый.
const hexRgb01 = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

// Виды слоёв, умеющие отдавать точки (показывают «+ модификатор» в инспекторе и доступны
// как источник в селекторе модификатора). scatter — конвертер Map2D(глубина)->PointSet (фаза C);
// setAttr — конвертер PointSet×Field->PointSet (присвоение атрибута, T2-1).
// U2-b: "force" — ДВОЙНОЙ домен (particle GPU-цепочка + point-producer CPU-резолв). В POINT_PRODUCERS
// он CPU-ветка (вход points → pointForceToField); isParticle("force") тоже true → GPU-ветка (chain).
// Резолвится по резидентности входа: points-вход → CPU-точки; particles-вход → buildParticleSystems.
export const POINT_PRODUCERS: LayerKind[] = ["hands", "motion", "faceMesh", "faceBoxes", "peopleBox", "grid", "scatter", "sample", "setAttr", "transform", "merge", "sort", "trail", "split", "pointForce", "force", "particlesToPoints"];

export function isPointProducer(kind: LayerKind): boolean {
  return POINT_PRODUCERS.includes(kind);
}

// Какие булевы поля SceneConfig надо включить, чтобы продюсер реально ВЫДАВАЛ данные (детектор
// «cook»). Для авто-активации зависимостей (resolveConfig): потребитель поднимает продюсера.
// peopleBox: данные идут от YOLO (peopleMasksEnabled), бокс-оверлей — peopleBoxEnabled (см. isActive).
export const PRODUCER_ENABLE: Partial<Record<LayerKind, (keyof SceneConfig)[]>> = {
  motion: ["motionEnabled"],
  hands: ["handsEnabled"],
  faceMesh: ["faceMeshEnabled"],
  faceBoxes: ["faceBoxesEnabled"],
  peopleBox: ["peopleBoxEnabled", "peopleMasksEnabled"],
  grid: ["gridEnabled"],   // генератор: процедурная сетка, входов нет — просто включить
  scatter: ["scatterEnabled"], // глубину поднимает App (depthActive), точки считаются из карты
  sample: ["sampleEnabled"], // источник-продюсер включается отдельно (или проводом в графе)
  setAttr: ["setAttrEnabled"], // источник-продюсер включается отдельно (провод в графе)
  transform: ["transformEnabled"], // T2-3: источник точек — провод графа
  merge: ["mergeEnabled"],         // T2-3: оба источника — провода графа
  sort: ["sortEnabled"],           // T2-3: источник точек — провод графа
  trail: ["trailEnabled"],         // Trail: источник точек — провод графа (stateful шлейфы)
  split: ["splitEnabled"],         // Split: источник точек — провод графа (фильтр по полю)
  pointForce: ["pointForceEnabled"], // Силы (точки): CPU-солвер, источник — провод графа
  audio: ["audioEnabled"], // авто-активация: ссылка на audioLow/Mid/High/Kick в биндинге
};

// Руки: каждая рука -> группа из 21 точки + рёбра скелета (HAND_CONNECTIONS).
// T1-3: атрибут `id` = handIdx*21 + landmarkIdx — стабилен топологией MediaPipe (ландмарк 0 всегда
// запястье и т.д.); randomPt/Trail «едут» вместе с точкой между кадрами.
export function handsToField(r: HandResult): PointField {
  return {
    kind: "hands",
    groups: r.hands.map((h, hi) => ({
      points: h.landmarks.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      links: HAND_CONNECTIONS,
      values: h.landmarks.map(() => 1),
      attrs: [{ name: "id", data: Float32Array.from(h.landmarks, (_, j) => hi * 21 + j), comps: 1 as const }],
    })),
  };
}

// Движение: центры боксов -> одна группа, соединяемая цепью; value = активность бокса.
export function motionToField(r: VisionResult): PointField {
  const boxes = r.boxes;
  if (!boxes.length) return { kind: "motion", groups: [] };
  return {
    kind: "motion",
    groups: [{
      points: boxes.map((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })),
      chain: true,
      values: boxes.map((b) => Math.max(0, Math.min(1, b.activity))),
    }],
  };
}

// Сетка лица: каждое лицо -> группа точек + рёбра контуров (edges — плоский список пар).
// T1-3: атрибут `id` = faceIdx*512 + landmarkIdx (страйд 512 > 478: вариант с iris не коллизит);
// индекс ландмарка стабилен топологией FaceLandmarker.
export function faceMeshToField(r: FaceResult): PointField {
  return {
    kind: "faceMesh",
    groups: r.meshes.map((mesh, mi) => {
      const links: [number, number][] = [];
      for (let i = 0; i + 1 < mesh.edges.length; i += 2) links.push([mesh.edges[i], mesh.edges[i + 1]]);
      return {
        points: mesh.points.map((p) => ({ x: p.x, y: p.y })),
        links,
        values: mesh.points.map(() => 1),
        attrs: [{ name: "id", data: Float32Array.from(mesh.points, (_, j) => mi * 512 + j), comps: 1 as const }],
      };
    }),
  };
}

// Бокс -> 4 угла замкнутым контуром (линии обводят рамку).
function boxCorners(x: number, y: number, w: number, h: number): PointGroup {
  return {
    points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
    links: [[0, 1], [1, 2], [2, 3], [3, 0]],
    values: [1, 1, 1, 1],
  };
}

// Боксы лиц: группа-рамка на каждое лицо.
export function faceBoxesToField(r: FaceResult): PointField {
  return { kind: "faceBoxes", groups: r.boxes.map((b) => boxCorners(b.x, b.y, b.w, b.h)) };
}

// Боксы людей (YOLOv8-seg): группа-рамка на каждого человека.
export function peopleBoxToField(r: PeopleFrame | null): PointField {
  if (!r) return { kind: "peopleBox", groups: [] };
  return { kind: "peopleBox", groups: r.boxes.map((b) => boxCorners(b.x, b.y, b.w, b.h)) };
}

// Grid (ГЕНЕРАТОР PointSet, 0 входов): процедурная стартовая сетка точек — аналог блока A из
// TD-разбора Particles.4 (ramp1×ramp2→reorder = «пиксель знает свой UV» + noise1-джиттер), но в
// нашей идиоме: обычная PointSet-нода, точки нормированы 0..1. Первый продюсер, живущий БЕЗ видео.
// id = row*cols+col (стабилен при фикс. сетке — randomPt/Trail не пересыпаются); джиттер
// детерминирован хешем (id, seed) → статичное смещение, НЕ дрожит по кадрам (как noise1 в TD).
export function gridToField(p: { cols: number; rows: number; jitter: number; seed: number }): PointField {
  const cols = Math.max(2, Math.min(64, Math.round(p.cols)));
  const rows = Math.max(2, Math.min(64, Math.round(p.rows)));
  const jit = Math.max(0, Math.min(0.5, p.jitter));
  const n = cols * rows;
  const points: { x: number; y: number }[] = new Array(n);
  const ids = new Float32Array(n);
  // детерминированный хеш в 0..1 (fract(sin·большое) — тот же приём, что hash в шейдерах)
  const h = (k: number) => { const s = Math.sin(k * 12.9898 + p.seed * 78.233) * 43758.5453; return s - Math.floor(s); };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const jx = jit ? (h(i * 2 + 1) - 0.5) * (jit / cols) * 2 : 0;
      const jy = jit ? (h(i * 2 + 2) - 0.5) * (jit / rows) * 2 : 0;
      points[i] = { x: clamp01((c + 0.5) / cols + jx), y: clamp01((r + 0.5) / rows + jy) };
      ids[i] = i;
    }
  }
  return {
    kind: "grid",
    groups: [{ points, values: new Array(n).fill(1), attrs: [{ name: "id", data: ids, comps: 1 as const }] }],
  };
}

// Scatter (конвертер Map2D->PointSet, фаза C): прорежённая сетка по карте глубины. Точка в ячейке,
// если глубина проходит порог (ближе/дальше по invert); value = глубина 0..1. Дёшево: крупный шаг +
// потолок точек (иначе lines O(N²)). Это «точки из глубины», которые тянутся в рисовалку (Линии).
export function scatterToField(
  depth: DepthFrame | null | undefined,
  p: { density: number; threshold: number; invert: boolean; maxPoints: number; z3d?: boolean; zScale?: number },
): PointField {
  if (!depth || depth.width < 2 || depth.height < 2) return { kind: "scatter", groups: [] };
  const { data, width, height } = depth;
  const step = Math.max(2, Math.round(p.density));
  const thr = Math.max(0, Math.min(1, p.threshold)) * 255;
  const cap = Math.max(1, Math.round(p.maxPoints));
  const cols = Math.ceil(width / step); // T1-3: ячеек в ряду — для стабильного id ячейки
  // U1: при z3d пишем z = (глубина 0..1)·zScale во ВСЕ точки (даже z=0 на дальних) — потребитель
  // (рисовалка/pointForce/Emitter) единообразно в 3D-ветке; depthScale накладывается на проекции.
  const z3d = !!p.z3d;
  const zScale = p.zScale ?? 1;
  const points: { x: number; y: number; z?: number }[] = [];
  const values: number[] = [];
  const ids: number[] = []; // T1-3: id = cellY*cols + cellX — стабилен при фикс. сетке (density/
  // разрешение); точка «мерцает» порогом, но возвращается с ТЕМ ЖЕ id (randomPt не пересыпается).
  for (let y = step >> 1; y < height && points.length < cap; y += step) {
    for (let x = step >> 1; x < width; x += step) {
      const d = data[y * width + x]; // 0..255
      if (p.invert ? d >= thr : d < thr) continue; // не прошёл порог
      points.push(z3d ? { x: x / width, y: y / height, z: (d / 255) * zScale } : { x: x / width, y: y / height });
      values.push(d / 255);
      ids.push(Math.floor(y / step) * cols + Math.floor(x / step));
      if (points.length >= cap) break;
    }
  }
  return {
    kind: "scatter",
    groups: points.length
      ? [{ points, values, attrs: [{ name: "id", data: Float32Array.from(ids), comps: 1 as const }] }]
      : [],
  };
}

// Sample (конвертер PointSet×Map2D->PointSet, фаза C): берёт точки продюсера и сэмплит в каждую
// ЗНАЧЕНИЕ из карты глубины (value = глубина*gain). Топология (links/chain) сохраняется. Так
// 2D-точки получают атрибут из карты (Z из глубины / value для размера-метки в рисовалке).
export function sampleToField(
  source: PointField | null,
  depth: DepthFrame | null | undefined,
  gain: number,
): PointField {
  if (!source) return { kind: "sample", groups: [] };
  if (!depth || depth.width < 2 || depth.height < 2) return { ...source, kind: "sample" }; // нет карты -> как есть
  const { data, width, height } = depth;
  const groups = source.groups.map((g) => ({
    ...g,
    values: g.points.map((p) => {
      const x = Math.max(0, Math.min(width - 1, Math.round(p.x * width)));
      const y = Math.max(0, Math.min(height - 1, Math.round(p.y * height)));
      return (data[y * width + x] / 255) * gain;
    }),
  }));
  return { kind: "sample", groups };
}

// SetAttr (конвертер PointSet×Field->PointSet, T2-1 / per-element T1-3): присваивает каждой точке
// источника атрибут (name) из Field-сигнала. `field`:
//  • undefined — сигнал не подключён: константа clamp01(gain+offset) (прежний hasField=false);
//  • number    — скалярный сигнал (частный случай): data.fill(clamp01(field·gain+offset)) — путь
//    T2-1 байт-в-байт (compileFieldFn вернул perElement:false);
//  • FieldFn   — per-element цепочка (T1-3): val_j = clamp01(fn({i:j,n,group})·gain+offset) на КАЖДУЮ
//    точку — это и есть Capture («заморозить поле в атрибут»), снят лимит «одно значение на кадр».
// Топология (links/chain) и прочие атрибуты сохраняются. "pscale" синхронизирует устар. values[].
// Cd — векторный (comps=3): цвет точки = lerp(colorLo, colorHi) по val_j (per-point с FieldFn).
// `sel` (T1-3 selection-вход, на точку 0..1): пишем только «выбранным» — итог = lerp(прежнее, новое,
// sel_j); прежнее = существующий атрибут точки, иначе нейтраль (pscale→1, прочие→0; Cd→цвет при t=0
// = colorLo). undefined (нет провода) = sel 1 (все выбраны, путь без lerp — байт-в-байт).
export function setAttrToField(
  source: PointField | null,
  p: { name: string; gain: number; offset: number; field?: number | FieldFn; sel?: number | FieldFn; colorLo?: string; colorHi?: string },
): PointField {
  if (!source) return { kind: "setAttr", groups: [] };
  const isCd = p.name === "Cd";
  const lo = isCd ? hexRgb01(p.colorLo ?? "#000000") : null;
  const hi = isCd ? hexRgb01(p.colorHi ?? "#ffffff") : null;
  const fn: FieldFn | null = typeof p.field === "function" ? p.field : null;
  const scalar = clamp01((typeof p.field === "number" ? p.field : 1) * p.gain + p.offset);
  const selFn: FieldFn | null = typeof p.sel === "function" ? p.sel : null;
  const selScalar = typeof p.sel === "number" ? clamp01(p.sel) : 1;
  const hasSel = p.sel !== undefined;
  const neutral = p.name === "pscale" ? 1 : 0; // прежнее значение, если атрибута у точки не было
  const groups = source.groups.map((g, gi) => {
    const n = g.points.length;
    const others = (g.attrs ?? []).filter((a) => a.name !== p.name);
    const prev = g.attrs?.find((a) => a.name === p.name); // существующий атрибут (для sel-lerp)
    const prevVals = !prev && p.name === "pscale" ? g.values : undefined; // legacy alias
    let attr: PointAttr;
    if (isCd) {
      const data = new Float32Array(n * 3);
      const prevCd = prev && (prev.comps ?? 1) === 3 ? prev.data : null;
      for (let j = 0; j < n; j++) {
        const v = fn ? clamp01(fn({ i: j, n, group: g, gi }) * p.gain + p.offset) : scalar;
        let r = lo![0] + (hi![0] - lo![0]) * v;
        let gc = lo![1] + (hi![1] - lo![1]) * v;
        let b = lo![2] + (hi![2] - lo![2]) * v;
        if (hasSel) {
          const s = selFn ? clamp01(selFn({ i: j, n, group: g, gi })) : selScalar;
          const pr = prevCd ? prevCd[j * 3] : lo![0];      // нейтраль Cd = цвет при t=0 (colorLo)
          const pg = prevCd ? prevCd[j * 3 + 1] : lo![1];
          const pb = prevCd ? prevCd[j * 3 + 2] : lo![2];
          r = pr + (r - pr) * s; gc = pg + (gc - pg) * s; b = pb + (b - pb) * s;
        }
        data[j * 3] = r; data[j * 3 + 1] = gc; data[j * 3 + 2] = b;
      }
      attr = { name: p.name, data, comps: 3 };
    } else if (fn || hasSel) {
      const data = new Float32Array(n);
      for (let j = 0; j < n; j++) {
        let v = fn ? clamp01(fn({ i: j, n, group: g, gi }) * p.gain + p.offset) : scalar;
        if (hasSel) {
          const s = selFn ? clamp01(selFn({ i: j, n, group: g, gi })) : selScalar;
          const pr = prev ? (prev.data[j * (prev.comps ?? 1)] ?? neutral) : (prevVals?.[j] ?? neutral);
          v = pr + (v - pr) * s;
        }
        data[j] = v;
      }
      attr = { name: p.name, data, comps: 1 };
    } else {
      const data = new Float32Array(n);
      data.fill(scalar); // скаляр/не подключён — быстрая ветка T2-1 байт-в-байт
      attr = { name: p.name, data, comps: 1 };
    }
    const attrs: PointAttr[] = [...others, attr];
    const values = p.name === "pscale" ? Array.from(attr.data) : g.values;
    return { ...g, attrs, values };
  });
  return { kind: "setAttr", groups };
}

// Transform (конвертер PointSet->PointSet, T2-3): сдвиг/масштаб/поворот точек источника вокруг
// pivot (норм. 0..1 координаты кадра). values/attrs/links/chain/color сохраняются — меняются только
// координаты точек. Порядок: масштаб и поворот вокруг pivot, затем сдвиг (tx,ty).
// `sel` (T1-3 selection-вход, на точку 0..1): p_out = lerp(p, transformed(p), sel_j) — невыбранные
// (sel=0) на месте, дробный sel = «мягкое» смещение. undefined = все (прежний путь).
export function transformToField(
  source: PointField | null,
  p: { tx: number; ty: number; scale: number; rotate: number; pivotX: number; pivotY: number; sel?: number | FieldFn },
): PointField {
  if (!source) return { kind: "transform", groups: [] };
  const cos = Math.cos(p.rotate), sin = Math.sin(p.rotate);
  const selFn: FieldFn | null = typeof p.sel === "function" ? p.sel : null;
  const selScalar = typeof p.sel === "number" ? clamp01(p.sel) : 1;
  const hasSel = p.sel !== undefined;
  const groups = source.groups.map((g, gi) => {
    const n = g.points.length;
    return {
      ...g,
      points: g.points.map((pt, j) => {
        const dx = (pt.x - p.pivotX) * p.scale;
        const dy = (pt.y - p.pivotY) * p.scale;
        let x = p.pivotX + (dx * cos - dy * sin) + p.tx;
        let y = p.pivotY + (dx * sin + dy * cos) + p.ty;
        if (hasSel) {
          const s = selFn ? clamp01(selFn({ i: j, n, group: g, gi })) : selScalar;
          x = pt.x + (x - pt.x) * s;
          y = pt.y + (y - pt.y) * s;
        }
        const out: { x: number; y: number; z?: number } = { x, y };
        if (pt.z !== undefined) out.z = pt.z;
        return out;
      }),
    };
  });
  return { kind: "transform", groups };
}

// Merge (конвертер PointSet+PointSet->PointSet, T2-3): объединяет группы двух источников (A+B).
// B опционален (null = только A). Группы переносятся как есть (атрибуты/топология/цвет сохранены).
export function mergeToField(a: PointField | null, b: PointField | null): PointField {
  return { kind: "merge", groups: [...(a?.groups ?? []), ...(b?.groups ?? [])] };
}

// Sort (конвертер PointSet->PointSet, T2-3): переупорядочивает точки В КАЖДОЙ группе по ключу
// (pscale/value/x/y, asc|desc). chain идёт по новому порядку (путь линий меняется), links — индексные,
// поэтому РЕМАПЯТСЯ на новый порядок. values и attrs переставляются параллельно точкам.
export function sortToField(
  source: PointField | null,
  p: { attr: string; dir: string },
): PointField {
  if (!source) return { kind: "sort", groups: [] };
  const desc = p.dir === "desc";
  const groups = source.groups.map((g) => {
    const n = g.points.length;
    if (n < 2) return g;
    const keyOf = (i: number): number => {
      if (p.attr === "x") return g.points[i].x;
      if (p.attr === "y") return g.points[i].y;
      if (p.attr === "value") return g.values ? (g.values[i] ?? 0) : 0;
      const a = getPointAttr(g, p.attr); // pscale/любой атрибут (pscale -> values фолбэк в getPointAttr)
      return a ? Number(a[i] ?? 0) : (g.values ? (g.values[i] ?? 0) : 0);
    };
    const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => {
      const d = keyOf(i) - keyOf(j);
      return desc ? -d : d;
    });
    const inv = new Array<number>(n); // старый индекс -> новый (для ремапа links)
    for (let k = 0; k < n; k++) inv[order[k]] = k;
    const points = order.map((i) => g.points[i]);
    const values = g.values ? order.map((i) => g.values![i]) : undefined;
    const attrs = g.attrs?.map((at) => {
      const comps = at.comps ?? 1;
      const data = at.data instanceof Float32Array ? new Float32Array(n * comps) : new Uint16Array(n * comps);
      for (let k = 0; k < n; k++) {
        const srcBase = order[k] * comps;
        for (let c = 0; c < comps; c++) data[k * comps + c] = at.data[srcBase + c];
      }
      return { ...at, data };
    });
    const links = g.links?.map(([a2, b2]) => [inv[a2], inv[b2]] as [number, number]);
    const next: PointGroup = { ...g, points };
    if (values) next.values = values;
    if (attrs) next.attrs = attrs;
    if (links) next.links = links;
    return next;
  });
  return { kind: "sort", groups };
}

// Split (конвертер PointSet->PointSet, реализация Group/Split-по-полю, T1-3 selection): оставляет
// точки В КАЖДОЙ группе по per-element полю-критерию vs порог. keep "above" = поле≥порог, "below" =
// поле<порог. points/values/attrs фильтруются параллельно; links ремапятся (рёбра с выпавшим концом
// выбрасываются). `field` — скаляр (весь кадр, вырожденно: всё/ничего) ИЛИ FieldFn (на точку);
// undefined (нет провода) = оставить всё (прежний путь, как фолбэк setAttr).
export function splitToField(
  source: PointField | null,
  p: { field?: number | FieldFn; threshold: number; keep: string },
): PointField {
  if (!source) return { kind: "split", groups: [] };
  const thr = p.threshold;
  const below = p.keep === "below";
  const fieldFn: FieldFn | null = typeof p.field === "function" ? p.field : null;
  const fieldScalar = typeof p.field === "number" ? p.field : 1; // нет провода → 1 (above&thr≤1 = всё)
  const groups = source.groups.map((g, gi) => {
    const n = g.points.length;
    const keep = new Array<boolean>(n);
    let m = 0;
    for (let j = 0; j < n; j++) {
      const v = fieldFn ? fieldFn({ i: j, n, group: g, gi }) : fieldScalar;
      const pass = below ? v < thr : v >= thr;
      keep[j] = pass;
      if (pass) m++;
    }
    if (m === n) return g; // ничего не отфильтровано — байт-в-байт прежняя группа
    const newIdx = new Array<number>(n);
    const points: typeof g.points = [];
    for (let j = 0; j < n; j++) { if (keep[j]) { newIdx[j] = points.length; points.push(g.points[j]); } else newIdx[j] = -1; }
    const values = g.values ? g.values.filter((_, j) => keep[j]) : undefined;
    const attrs = g.attrs?.map((at) => {
      const comps = at.comps ?? 1;
      const data = at.data instanceof Float32Array ? new Float32Array(m * comps) : new Uint16Array(m * comps);
      let w = 0;
      for (let j = 0; j < n; j++) if (keep[j]) { for (let c = 0; c < comps; c++) data[w * comps + c] = at.data[j * comps + c]; w++; }
      return { ...at, data };
    });
    const links = g.links
      ? g.links
          .map(([a, b]) => (keep[a] && keep[b] ? ([newIdx[a], newIdx[b]] as [number, number]) : null))
          .filter((e): e is [number, number] => e !== null)
      : undefined;
    const next: PointGroup = { ...g, points };
    if (values) next.values = values;
    if (attrs) next.attrs = attrs;
    if (links) next.links = links;
    return next;
  });
  return { kind: "split", groups };
}

// Trail (конвертер PointSet->PointSet, STATEFUL): каждая точка источника оставляет хвост из своих
// позиций за прошлые кадры. Трекинг по атрибуту `id` (стабилен у hands/faceMesh/scatter); без id —
// фолбэк по индексу (gi*1e5+j, стабилен при постоянном порядке/числе точек). Выход — по ОДНОЙ
// группе-полилинии (chain) на отслеживаемую точку; pscale сужается к хвосту (новейшая=1, см. trailFade).
//
// СТЕЙТ: история живёт в модульной карте `trailState` (как `randomState`/lag в drivers.ts) — резолвер
// остаётся чистым, состояние шагается РАЗ В КАДР по frameTick-барьеру (ModifierOverlay инкрементит
// счётчик). Дозапись ТОЛЬКО когда tick > lastTick → дедуп и мульти-вызовов резолвера в кадре, и
// мульти-потребителей (statsRef/SplatMask зовут без tick → читают снапшот, не дописывают).
type TrailPos = { x: number; y: number; z?: number };
interface TrailNodeState { hist: Map<number, TrailPos[]>; lastTick: number; }
const trailState = new Map<string, TrailNodeState>();
let trailPruneTick = -1;

export function trailToField(
  source: PointField | null,
  p: { length: number; fade: number; instanceId: string; tick?: number },
): PointField {
  if (!source) return { kind: "trail", groups: [] };
  const len = Math.max(2, Math.min(60, Math.round(p.length)));
  const fade = clamp01(p.fade);
  let st = trailState.get(p.instanceId);
  if (!st) { st = { hist: new Map(), lastTick: -1 }; trailState.set(p.instanceId, st); }

  // текущие позиции по pid (id-атрибут, иначе индекс)
  const cur = new Map<number, TrailPos>();
  source.groups.forEach((g, gi) => {
    const ids = getPointAttr(g, "id");
    g.points.forEach((pt, j) => {
      const pid = ids ? Number(ids[j]) : gi * 100000 + j;
      cur.set(pid, pt.z !== undefined ? { x: pt.x, y: pt.y, z: pt.z } : { x: pt.x, y: pt.y });
    });
  });

  // Дозапись/усечение/эвикт МУТИРУЮТ общий st.hist — только во ВЛАДЕЛЬЦЕ кадра (tick продвинулся).
  // Снапшот-потребители (без tick / не продвинувшийся: SplatMask, statsRef) НЕ трогают st.hist —
  // иначе их (возможно stale) trailLength усёк бы хвост владельца (config-reviewer, порча общего стейта).
  const advance = p.tick !== undefined && p.tick > st.lastTick;
  if (advance) {
    for (const [pid, pos] of cur) {
      let h = st.hist.get(pid);
      if (!h) { h = []; st.hist.set(pid, h); }
      h.push(pos);
      if (h.length > len) h.splice(0, h.length - len);
    }
    for (const pid of st.hist.keys()) if (!cur.has(pid)) st.hist.delete(pid); // эвикт исчезнувших точек
    st.lastTick = p.tick!;
  }

  // выход: группа-полилиния на pid (>=2 позиции). НЕразрушающий срез последних len (если у этого
  // потребителя len меньше, чем накопил владелец) — без мутации общего st.hist.
  const groups: PointGroup[] = [];
  for (const [pid, h] of st.hist) {
    const view = h.length > len ? h.slice(h.length - len) : h;
    const n = view.length;
    if (n < 2) continue;
    const pscale = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1);            // 0 = хвост (старое), 1 = голова (новое)
      pscale[k] = 1 - fade * (1 - t);   // fade=0 → 1 везде; fade=1 → t (хвост к нулю)
    }
    groups.push({
      points: view.map((q) => ({ ...q })),
      chain: true,
      attrs: [
        { name: "pscale", data: pscale, comps: 1 },
        { name: "id", data: new Float32Array(n).fill(pid), comps: 1 },
      ],
    });
  }
  return { kind: "trail", groups };
}

// Сброс состояния шлейфов для нод, которых больше нет в графе (эвикт удалённых инстансов). Раз в
// продвинувшийся кадр. Без этого карта растёт при add/remove Trail-нод. Вызывается из case "trail".
function pruneTrailState(producers: ResolvedProducer[] | undefined, tick: number): void {
  if (tick === trailPruneTick) return;
  trailPruneTick = tick;
  for (const k of trailState.keys()) if (!producers?.some((x) => x.id === k)) trailState.delete(k);
}

// === «Силы (точки)» — CPU-солвер сил над PointSet (направление U: частицы = точки) ===
// ВТОРОЙ stateful-конвертер (шаблон Trail): состояние {p,v,age} на точку по стабильному id в
// МОДУЛЬНОЙ карте, шаг интеграции — раз в кадр по frameTick-барьеру (снапшот-потребители без tick
// читают, не мутируют). Секции сил В ПАРИТЕТЕ с GPU-Force (те же force*-параметры инстанса):
// гравитация / curl|turbulence (2D-fbm, конечные разности) / drag / границы bounce|wrap.
// Координаты — нормированные 0..1 кадра (как все CPU-точки); y растёт вниз → гравитация «вниз» = +y.
// Жизнь pfLife: 0 = бессмертно (точка дрейфует от своей исходной позиции), >0 = респавн на источник.
type PfState = { p: TrailPos; v: { x: number; y: number; z: number }; age: number };
interface PfNodeState { parts: Map<number, PfState>; lastTick: number; lastT: number }
const pfState = new Map<string, PfNodeState>();
let pfPruneTick = -1;
function prunePfState(producers: ResolvedProducer[] | undefined, tick: number): void {
  if (tick === pfPruneTick) return;
  pfPruneTick = tick;
  for (const k of pfState.keys()) if (!producers?.some((x) => x.id === k)) pfState.delete(k);
}

export function pointForceToField(
  source: PointField | null,
  p: {
    strength: number; life: number;
    gOn: boolean; gx: number; gy: number; gz: number; gStrength: number;
    nOn: boolean; nMode: string; nAmp: number; nScale: number; nSpeed: number;
    dragOn: boolean; drag: number; bounds: string;
    instanceId: string; tick?: number;
  },
): PointField {
  if (!source) return { kind: "pointForce", groups: [] };
  let st = pfState.get(p.instanceId);
  if (!st) { st = { parts: new Map(), lastTick: -1, lastT: 0 }; pfState.set(p.instanceId, st); }

  const now = clockSec();
  const advance = p.tick !== undefined && p.tick > st.lastTick;
  const dt = advance ? Math.min(1 / 20, st.lastT ? now - st.lastT : 1 / 60) : 0;
  if (advance) { st.lastTick = p.tick!; st.lastT = now; }

  // curl 2D от fbm-потенциала (div-free: v=(∂ψ/∂y, −∂ψ/∂x)); turbulence — сырой градиентный сдвиг.
  const t = now * p.nSpeed;
  const freq = Math.max(0.2, p.nScale) * 3;
  const EPS = 0.01;
  const psi = (x: number, y: number) => fbm(x * freq + t, y * freq - t * 0.6, 7, 3);
  const noiseAt = (x: number, y: number): [number, number] => {
    if (p.nMode === "turbulence") return [psi(x, y) - 0.5, psi(x + 13.7, y + 7.1) - 0.5];
    const dy = (psi(x, y + EPS) - psi(x, y - EPS)) / (2 * EPS);
    const dx = (psi(x + EPS, y) - psi(x - EPS, y)) / (2 * EPS);
    return [dy * 0.15, -dx * 0.15]; // нормировка градиента под |v|~1
  };

  const seen = new Set<number>();
  const groups = source.groups.map((g, gi) => {
    const ids = getPointAttr(g, "id");
    const points = g.points.map((pt, j) => {
      const pid = ids ? Number(ids[j]) : gi * 100000 + j;
      seen.add(pid);
      let s = st!.parts.get(pid);
      if (!s) {
        s = { p: pt.z !== undefined ? { x: pt.x, y: pt.y, z: pt.z } : { x: pt.x, y: pt.y }, v: { x: 0, y: 0, z: 0 }, age: 0 };
        st!.parts.set(pid, s);
      }
      if (advance && dt > 0) {
        let ax = 0, ay = 0, az = 0;
        if (p.gOn) { ax += p.gx * p.gStrength; ay += -p.gy * p.gStrength; az += p.gz * p.gStrength; } // y экрана вниз
        if (p.nOn && p.nAmp > 0) {
          const [nx2, ny2] = noiseAt(s.p.x, s.p.y);
          ax += nx2 * p.nAmp; ay += ny2 * p.nAmp;
        }
        if (p.dragOn) { ax += -s.v.x * p.drag * 8; ay += -s.v.y * p.drag * 8; az += -(s.v.z ?? 0) * p.drag * 8; }
        const k = p.strength;
        s.v.x += ax * dt * k; s.v.y += ay * dt * k; s.v.z += az * dt * k;
        s.p.x += s.v.x * dt; s.p.y += s.v.y * dt; s.p.z = (s.p.z ?? 0) + s.v.z * dt;
        s.age += dt;
        // границы кадра 0..1 (Z свободен): bounce = отражение, wrap = тор
        if (p.bounds === "bounce") {
          if (s.p.x < 0 || s.p.x > 1) { s.v.x *= -1; s.p.x = clamp01(s.p.x); }
          if (s.p.y < 0 || s.p.y > 1) { s.v.y *= -1; s.p.y = clamp01(s.p.y); }
        } else if (p.bounds === "wrap") {
          s.p.x = ((s.p.x % 1) + 1) % 1;
          s.p.y = ((s.p.y % 1) + 1) % 1;
        }
        // жизнь: респавн на ТЕКУЩУЮ позицию точки-источника (аналог over1/multiply1 из TD)
        if (p.life > 0 && s.age >= p.life * (0.75 + 0.5 * (pid % 17) / 17)) {
          s.p = pt.z !== undefined ? { x: pt.x, y: pt.y, z: pt.z } : { x: pt.x, y: pt.y };
          s.v = { x: 0, y: 0, z: 0 };
          s.age = 0;
        }
      }
      return s.p.z !== undefined ? { x: s.p.x, y: s.p.y, z: s.p.z } : { x: s.p.x, y: s.p.y };
    });
    return { ...g, points } as PointGroup; // топология/attrs/values едут с точками (id сохраняется)
  });
  if (advance) for (const pid of st.parts.keys()) if (!seen.has(pid)) st.parts.delete(pid); // эвикт
  return { kind: "pointForce", groups };
}

// Последние результаты продюсеров, доступные резолверу (DataBus-вход). T0c (instance-keyed):
// конвертерные параметры больше НЕ синглтоны — они в `producers` (инстансы по id, из resolveConfig).
export interface PointResultRefs {
  motion?: VisionResult;
  hands?: HandResult;
  faces?: FaceResult;
  people?: PeopleFrame | null;
  depth?: DepthFrame | null; // Map2D-вход для Scatter / Sample
  producers?: ResolvedProducer[];               // T0c: инстансы продюсеров/конвертеров (id+kind+params)
  // T1-3: скомпилированные field-входы конвертеров (layerId -> param -> скаляр | FieldFn).
  // Потребитель (ModifierOverlay/SplatMask/GraphView) компилирует через compileFieldFn ДО вызова —
  // резолвер по-прежнему не знает про drivers/ops. Скаляр = частный случай (прежний путь).
  layerFieldFns?: Record<string, Record<string, number | FieldFn>>;
  // Trail (stateful): монотонный счётчик кадра ВЛАДЕЛЬЦА рендера (ModifierOverlay инкрементит раз в
  // свой rAF). Резолвер шагает историю шлейфов только когда tick продвинулся → дедуп мульти-вызовов и
  // мульти-потребителей. Потребители без tick (statsRef/SplatMask) читают снапшот, не дописывают.
  frameTick?: number;
  // B-раунд-2: резолвнутые Map2D-карты конвертеров по id слоя (scatter.scatterMapSource → кадр-карта).
  // Потребитель резолвит через resolveProducerMaps (mapForRef) ДО вызова — резолвер не знает про mapSources.
  // Нет записи / потребитель без map-резолва → scatter падает на src.depth (back-compat video-источник).
  layerMaps?: Record<string, DepthFrame | null>;
}

// B-раунд-2: резолв Map2D-источников конвертеров (сейчас Scatter) в кадры-карты для PointResultRefs.
// Зеркало layerFieldFns: потребитель зовёт ПЕРЕД fieldForLayerId, резолвер читает готовое. mapForRef
// разворачивает цепочку (Видео.глубина / noise2d / mapCombine). scatterMapSource="video" → src.depth
// (дёшево, без генерации). Только реальная noise-цепочка платит за mapForRef.
export function resolveProducerMaps(
  producers: ResolvedProducer[] | undefined,
  refs: { depth?: DepthFrame | null; mapNodes?: ResolvedMapNode[]; time?: number },
): Record<string, DepthFrame | null> {
  const out: Record<string, DepthFrame | null> = {};
  for (const p of producers ?? []) {
    if (p.kind !== "scatter") continue;
    const ref = String(p.params.scatterMapSource ?? "video");
    out[p.id] = mapForRef(ref, refs);
  }
  return out;
}

// === U2 (направление U: частицы=точки) — Particles→Points: GPU-популяция → CPU-PointSet ===
// Модульный стор readback'а: ParticleFieldCanvas (GPU-владелец) пишет сюда downsample-результат на
// НИЗКОЙ частоте (~7Гц, ноль readback в кадре рендера), резолвер читает по хендлу Render-ноды
// (particlesSource). Модульный — чтобы не тянуть через PointResultRefs каждого потребителя
// (прецедент trailState/pfState; но пишется ИЗВНЕ, GPU-владельцем, а не самим резолвером).
const particleReadbackStore = new Map<string, PointField>();
// ref = id Render-ноды (= particlesSource конвертера). field=null → удалить запись.
export function setParticleReadback(ref: string, field: PointField | null): void {
  if (field && field.groups.length) particleReadbackStore.set(ref, field);
  else particleReadbackStore.delete(ref);
}
// Эвикт записей, чьи конвертеры больше не активны (мост передаёт актуальный набор ref'ов).
export function pruneParticleReadback(keep: Set<string>): void {
  for (const k of particleReadbackStore.keys()) if (!keep.has(k)) particleReadbackStore.delete(k);
}
// Построить PointField из плоского readback'а: [nx,ny,d]×k (страйд 3), ИЛИ [nx,ny,d, r,g,b]×k
// (страйд 6, withColor — U3: Cd сквозь границу → векторный атрибут Cd, красит Lines/constellation).
// Стабильный id = индекс слота k.
export function readbackToField(flat: Float32Array, withColor = false): PointField {
  const stride = withColor ? 6 : 3;
  const k = Math.floor(flat.length / stride);
  if (!k) return { kind: "particlesToPoints", groups: [] };
  const points = new Array<{ x: number; y: number; z: number }>(k);
  const ids = new Float32Array(k);
  const cd = withColor ? new Float32Array(k * 3) : null;
  for (let j = 0; j < k; j++) {
    const b = j * stride;
    points[j] = { x: flat[b], y: flat[b + 1], z: flat[b + 2] };
    ids[j] = j;
    if (cd) { cd[j * 3] = flat[b + 3]; cd[j * 3 + 1] = flat[b + 4]; cd[j * 3 + 2] = flat[b + 5]; }
  }
  const attrs: PointAttr[] = [{ name: "id", data: ids, comps: 1 as const }];
  if (cd) attrs.push({ name: "Cd", data: cd, comps: 3 as const });
  return { kind: "particlesToPoints", groups: [{ points, values: new Array(k).fill(1), attrs }] };
}

// Резолвер DataBus (T0c, instance-keyed): хендл = id СЛОЯ-инстанса (или вид — back-compat) -> PointField.
// findProd принимает id ЛИБО вид (старые конфиги/инспектор-SEL пишут вид → первый инстанс того вида).
// Конвертеры (scatter/sample/setAttr) считаются из params СВОЕГО инстанса; рекурсия по ref source.
export function fieldForLayerId(ref: string, src: PointResultRefs, seen: Set<string> = new Set()): PointField | null {
  if (!ref || seen.has(ref)) return null; // пусто / цикл-гард
  seen.add(ref);
  const p = src.producers?.find((x) => x.id === ref) ?? src.producers?.find((x) => x.kind === ref);
  if (!p) return null;
  const P = p.params;
  switch (p.kind) {
    case "hands": return src.hands ? handsToField(src.hands) : null;
    case "motion": return src.motion ? motionToField(src.motion) : null;
    case "faceMesh": return src.faces ? faceMeshToField(src.faces) : null;
    case "faceBoxes": return src.faces ? faceBoxesToField(src.faces) : null;
    case "peopleBox": return peopleBoxToField(src.people ?? null);
    case "grid": return gridToField({
      cols: Number(P.gridCols ?? 24), rows: Number(P.gridRows ?? 16),
      jitter: Number(P.gridJitter ?? 0), seed: Number(P.gridSeed ?? 1),
    });
    case "scatter": return scatterToField(src.layerMaps?.[p.id] ?? src.depth, {
      // B-раунд-2: карта Scatter — резолвнутая Map2D-цепочка (layerMaps[id], выставляет потребитель через
      // resolveProducerMaps) ИЛИ сырая глубина (back-compat / потребитель без map-резолва, scatterMapSource="video").
      density: Number(P.scatterDensity ?? 12), threshold: Number(P.scatterThreshold ?? 0.5),
      invert: !!P.scatterInvert, maxPoints: Number(P.scatterMaxPoints ?? 300),
      z3d: !!P.scatterZ, zScale: Number(P.scatterZScale ?? 1),
    });
    case "sample":
      return sampleToField(fieldForLayerId(String(P.sampleSource ?? ""), src, seen), src.depth, Number(P.sampleGain ?? 1));
    case "setAttr": {
      const sig = String(P.setAttrSignal ?? "none");
      const selSig = String(P.setAttrSelection ?? "none");
      // T1-3: подключённый сигнал -> скомпилированное поле (скаляр | FieldFn) из layerFieldFns;
      // фолбэк 1 (потребитель без компиляции, напр. statsRef) = прежнее поведение T2-1.
      return setAttrToField(fieldForLayerId(String(P.setAttrSource ?? ""), src, seen), {
        name: String(P.setAttrName ?? "pscale"),
        gain: Number(P.setAttrGain ?? 1), offset: Number(P.setAttrOffset ?? 0),
        field: (!!sig && sig !== "none") ? (src.layerFieldFns?.[p.id]?.setAttrSignal ?? 1) : undefined,
        sel: (!!selSig && selSig !== "none") ? (src.layerFieldFns?.[p.id]?.setAttrSelection ?? 1) : undefined,
        colorLo: P.setAttrColorLo as string, colorHi: P.setAttrColorHi as string,
      });
    }
    case "transform": {
      const selSig = String(P.transformSelection ?? "none");
      return transformToField(fieldForLayerId(String(P.transformSource ?? ""), src, seen), {
        tx: Number(P.transformTx ?? 0), ty: Number(P.transformTy ?? 0),
        scale: Number(P.transformScale ?? 1), rotate: Number(P.transformRotate ?? 0),
        pivotX: Number(P.transformPivotX ?? 0.5), pivotY: Number(P.transformPivotY ?? 0.5),
        sel: (!!selSig && selSig !== "none") ? (src.layerFieldFns?.[p.id]?.transformSelection ?? 1) : undefined,
      });
    }
    case "merge":
      // Раздельные seen-клоны на каждую ветку: разрешаем diamond-DAG (общий под-продюсер), цикл в ветке ловим.
      return mergeToField(
        fieldForLayerId(String(P.mergeSourceA ?? ""), src, new Set(seen)),
        fieldForLayerId(String(P.mergeSourceB ?? ""), src, new Set(seen)),
      );
    case "sort":
      return sortToField(fieldForLayerId(String(P.sortSource ?? ""), src, seen), {
        attr: String(P.sortAttr ?? "pscale"), dir: String(P.sortDir ?? "asc"),
      });
    case "trail": {
      if (src.frameTick !== undefined) pruneTrailState(src.producers, src.frameTick); // эвикт удалённых нод
      return trailToField(fieldForLayerId(String(P.trailSource ?? ""), src, seen), {
        length: Number(P.trailLength ?? 16), fade: Number(P.trailFade ?? 0.7),
        instanceId: p.id, tick: src.frameTick,
      });
    }
    case "split": {
      const fsig = String(P.splitField ?? "none");
      return splitToField(fieldForLayerId(String(P.splitSource ?? ""), src, seen), {
        field: (!!fsig && fsig !== "none") ? (src.layerFieldFns?.[p.id]?.splitField ?? 1) : undefined,
        threshold: Number(P.splitThreshold ?? 0.5), keep: String(P.splitKeep ?? "above"),
      });
    }
    // U2-b: "force" в CPU-ветке (вход points) = ТОТ ЖЕ pointForceToField, что pointForce (U0). force*-поля
    // и pfStrength/pfLife/pointForceSource у обоих видов одинаковы. GPU-режим (нет points-входа) →
    // источник null → пустой PointSet (безвреден; систему считает buildParticleSystems по particles-входу).
    case "pointForce":
    case "force": {
      if (src.frameTick !== undefined) prunePfState(src.producers, src.frameTick); // эвикт удалённых нод
      return pointForceToField(fieldForLayerId(String(P.pointForceSource ?? ""), src, seen), {
        strength: Number(P.pfStrength ?? 1), life: Number(P.pfLife ?? 0),
        gOn: !!P.forceGravityOn, gx: Number(P.forceGravityX ?? 0), gy: Number(P.forceGravityY ?? 0),
        gz: Number(P.forceGravityZ ?? 0), gStrength: Number(P.forceGravityStrength ?? 1),
        nOn: !!P.forceNoiseOn, nMode: String(P.forceNoiseMode ?? "curl"),
        nAmp: Number(P.forceNoiseAmp ?? 0), nScale: Number(P.forceNoiseScale ?? 1), nSpeed: Number(P.forceNoiseSpeed ?? 0.2),
        dragOn: !!P.forceDragOn, drag: Number(P.forceDrag ?? 0), bounds: String(P.forceBoundsMode ?? "none"),
        instanceId: p.id, tick: src.frameTick,
      });
    }
    case "particlesToPoints":
      // U2: данные положил ParticleFieldCanvas в модульный стор по id Render-ноды (particlesSource).
      // Нет провода/системы/ещё не считано → пусто (тихо, как scatter без глубины).
      return particleReadbackStore.get(String(P.particlesSource ?? "")) ?? { kind: "particlesToPoints", groups: [] };
    default: return null;
  }
}
