// T5 v2 Phase B: CPU-резолвер Map2D-нод (зеркало pointSources.fieldForLayerId, но для Map2D-домена).
// Карты — это кадры {data:Uint8Array(R 0..255), width, height} (= форма DepthFrame). Потребители —
// CPU, низкая частота (particle Emitter.map, scatter): резолвер рекурсивно разворачивает цепочку
// `noise2d`/`mapCombine` в один кадр. НЕ трогает GPU-шейдерный путь (тот — отдельная FBO-цепочка).
//
// `Видео.глубина` адресуется хендлом "video"/"depth" (возвращается кадр глубины как есть). Map2D-ноды —
// по id (как продюсеры точек). Анимация шума — по refs.time. Рабочий размер генераторов — WORK×WORK.

import type { DepthFrame, ResolvedMapNode, LayerKind } from "./types";

export type MapFrame = DepthFrame; // {data:Uint8Array, width, height} (R 0..255)
const WORK = 128; // размер генерируемых карт (дёшево; combine ресэмплит входы сюда)

// Виды map2d-нод (для гейтинга/проверок). Держим тут, чтобы не тянуть LAYER_DEFS в горячий путь.
export const MAP_PRODUCERS: LayerKind[] = ["noise2d", "mapCombine"];
export function isMap2dKind(kind: LayerKind): boolean {
  return MAP_PRODUCERS.includes(kind);
}

export interface MapResolveRefs {
  depth?: DepthFrame | null;       // Видео.глубина (кадр инференса)
  mapNodes?: ResolvedMapNode[];    // резолвнутые map2d-ноды (resolveConfig.mapNodes)
  time?: number;                   // секунды — анимация поля шума
}

// --- value-noise 2D + FBM (CPU, дёшево; аналог noise-OpNode из drivers.ts, но пространственный) ---
function hash2(x: number, y: number, seed: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 982451653;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h >>> 0) / 4294967295;
}
function vnoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const n00 = hash2(x0, y0, seed), n10 = hash2(x0 + 1, y0, seed);
  const n01 = hash2(x0, y0 + 1, seed), n11 = hash2(x0 + 1, y0 + 1, seed);
  const nx0 = n00 + (n10 - n00) * sx, nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}
export function fbm(x: number, y: number, seed: number, octaves: number): number {
  let amp = 0.5, sum = 0, norm = 0, f = 1;
  const oct = Math.max(1, Math.min(6, Math.round(octaves)));
  for (let o = 0; o < oct; o++) { sum += amp * vnoise(x * f, y * f, seed + o * 17); norm += amp; amp *= 0.5; f *= 2; }
  return sum / Math.max(1e-5, norm);
}

export function noise2dToMap(
  p: { freq: number; octaves: number; seed: number; speed: number; contrast: number },
  time: number,
): MapFrame {
  const data = new Uint8Array(WORK * WORK);
  const freq = Math.max(1, p.freq);
  const t = time * p.speed;
  const gamma = Math.max(0.05, p.contrast);
  for (let y = 0; y < WORK; y++) {
    for (let x = 0; x < WORK; x++) {
      // анимация по ОБЕИМ осям (разные рейты — диагональный дрейф, не одно-осевой скролл).
      let v = fbm((x / WORK) * freq + t, (y / WORK) * freq - t * 0.6, p.seed, p.octaves);
      v = Math.pow(v < 0 ? 0 : v > 1 ? 1 : v, gamma);
      data[y * WORK + x] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
  return { data, width: WORK, height: WORK };
}

// Сэмпл кадра в координатах WORK (nearest; кадр может быть любого размера — глубина натив).
function sampleAt(f: MapFrame, x: number, y: number): number {
  const sx = Math.min(f.width - 1, ((x * f.width / WORK) | 0));
  const sy = Math.min(f.height - 1, ((y * f.height / WORK) | 0));
  return f.data[sy * f.width + sx] / 255;
}
// Identity-операнд для отсутствующего входа (combine с одним проводом = pass-through).
function identityFor(mode: string): number {
  return mode === "multiply" || mode === "min" ? 1 : 0;
}

export function combineToMap(a: MapFrame | null, b: MapFrame | null, mode: string): MapFrame | null {
  if (!a && !b) return null;
  const idA = identityFor(mode), idB = identityFor(mode);
  const data = new Uint8Array(WORK * WORK);
  for (let y = 0; y < WORK; y++) {
    for (let x = 0; x < WORK; x++) {
      const va = a ? sampleAt(a, x, y) : idA;
      const vb = b ? sampleAt(b, x, y) : idB;
      let v: number;
      switch (mode) {
        case "add": v = va + vb; break;
        case "screen": v = 1 - (1 - va) * (1 - vb); break;
        case "min": v = Math.min(va, vb); break;
        case "max": v = Math.max(va, vb); break;
        default: v = va * vb; // multiply
      }
      data[y * WORK + x] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
  return { data, width: WORK, height: WORK };
}

// Резолв Map2D-хендла в кадр. ref: "none"→null; "video"/"depth"→кадр глубины; id map2d-ноды→цепочка.
// Cycle-гард — как fieldForLayerId (раздельные seen-клоны на ветки combine для diamond-DAG).
export function mapForRef(ref: string, refs: MapResolveRefs, seen: Set<string> = new Set()): MapFrame | null {
  if (!ref || ref === "none" || seen.has(ref)) return null;
  if (ref === "video" || ref === "depth") return refs.depth ?? null;
  seen.add(ref);
  const n = refs.mapNodes?.find((x) => x.id === ref);
  if (!n) return null;
  const P = n.params;
  switch (n.kind) {
    case "noise2d":
      return noise2dToMap({
        freq: Number(P.noiseFreq ?? 6), octaves: Number(P.noiseOctaves ?? 3),
        seed: Number(P.noiseSeed ?? 1), speed: Number(P.noiseSpeed ?? 0.2), contrast: Number(P.noiseContrast ?? 1),
      }, refs.time ?? 0);
    case "mapCombine":
      return combineToMap(
        mapForRef(String(P.mapInputA ?? "none"), refs, new Set(seen)),
        mapForRef(String(P.mapInputB ?? "none"), refs, new Set(seen)),
        String(P.combineMode ?? "multiply"),
      );
    default:
      return null;
  }
}

// Достигает ли цепочка карты `Видео.глубину`? (для App.depthActive — не будить depth для чисто-шумовой
// карты). Обходит mapNodes от ref. Прямой "video"/"depth" ИЛИ любой вход в цепочке = "video".
export function mapChainNeedsDepth(ref: string, mapNodes: ResolvedMapNode[] | undefined, seen: Set<string> = new Set()): boolean {
  if (!ref || ref === "none" || seen.has(ref)) return false;
  if (ref === "video" || ref === "depth") return true;
  seen.add(ref);
  const n = mapNodes?.find((x) => x.id === ref);
  if (!n || n.kind !== "mapCombine") return false;
  return mapChainNeedsDepth(String(n.params.mapInputA ?? "none"), mapNodes, seen)
    || mapChainNeedsDepth(String(n.params.mapInputB ?? "none"), mapNodes, seen);
}
