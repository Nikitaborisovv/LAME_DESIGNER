/// <reference lib="webworker" />
// Лёгкий vision-воркер на чистом JS (без OpenCV/нейронок).
// За один кадр считает:
//   1) детекцию движения через разницу кадров -> боксы движущихся объектов;
//   2) характерные точки (максимумы градиента) для constellation-эффекта.
// Работает на сильно уменьшенном кадре (см. useVision) -> десятки fps в потоке.

import type { MotionBox, FeaturePoint } from "../core/types";

let W = 0;
let H = 0;

let sensitivity = 0.12; // порог разницы (0..1), ниже = чувствительнее
let featureCount = 80;
// --- параметры устойчивого frame-diff пайплайна (см. pipeline.md) ---
let gap = 2; // сравнивать с кадром gap назад
let decay = 0.9; // затухание тепла
let heatThr = 0.35; // порог тепла для зажигания пикселя
let minArea = 24; // мин. площадь компоненты (px)
let maxBoxes = 8;

// --- персистентное состояние пайплайна (живёт между кадрами) ---
const HISTORY = 8; // глубина кольца кадров (>= max gap)
let heat: Float32Array | null = null; // накопитель «тепла» движения
let frames: Float32Array[] = []; // кольцо размытых кадров (oldest..newest)
let pool: Float32Array[] = []; // переиспользуемые буферы (без GC-мусора)
// рабочие буферы (переиспользуются):
let grayBuf: Float32Array | null = null;
let maskBuf: Uint8Array | null = null;
let binBuf: Uint8Array | null = null;
let tmpBuf: Uint8Array | null = null;

function resetState(n: number) {
  heat = new Float32Array(n);
  frames = [];
  pool = [];
  grayBuf = new Float32Array(n);
  maskBuf = new Uint8Array(n);
  binBuf = new Uint8Array(n);
  tmpBuf = new Uint8Array(n);
}

function toGray(data: Uint8ClampedArray, out: Float32Array, n: number) {
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    out[i] = (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) / 255;
  }
}

// Блюр 3×3 (усреднение) с зажимом по краям — гасит высокочастотный шум сенсора.
function boxBlur(src: Float32Array, dst: Float32Array) {
  for (let y = 0; y < H; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < H - 1 ? y + 1 : H - 1;
    for (let x = 0; x < W; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < W - 1 ? x + 1 : W - 1;
      let s = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const r = yy * W;
        s += src[r + x0] + src[r + x] + src[r + x1];
      }
      dst[y * W + x] = s / 9;
    }
  }
}

// Морфология 3×3: erode=true -> минимум окрестности (стереть точки),
// иначе -> максимум (вернуть размер). Классическое «открытие» = erode потом dilate.
function morph(src: Uint8Array, dst: Uint8Array, erode: boolean) {
  for (let y = 0; y < H; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < H - 1 ? y + 1 : H - 1;
    for (let x = 0; x < W; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < W - 1 ? x + 1 : W - 1;
      let v = erode ? 1 : 0;
      for (let yy = y0; yy <= y1 && (erode ? v : !v); yy++) {
        const r = yy * W;
        for (let xx = x0; xx <= x1; xx++) {
          const s = src[r + xx];
          if (erode) { if (!s) { v = 0; break; } }
          else if (s) { v = 1; break; }
        }
      }
      dst[y * W + x] = v;
    }
  }
}

// Устойчивая детекция движения: блюр -> разница с кадром gap назад -> накопитель
// тепла с затуханием -> бинаризация -> открытие (erode+dilate) -> связные компоненты.
function motionBoxes(): MotionBox[] {
  const n = W * H;
  if (!heat || heat.length !== n) return [];
  const blur = grayBuf!; // grayBuf уже содержит серый кадр; блюрим в буфер из пула
  const buf = pool.pop() ?? new Float32Array(n);
  boxBlur(blur, buf);

  // кольцо кадров: добавляем текущий размытый, опорный — gap позиций назад
  frames.push(buf);
  if (frames.length > HISTORY) pool.push(frames.shift()!);
  const refIdx = frames.length - 1 - gap;

  const mask = maskBuf!;
  if (refIdx >= 0) {
    const ref = frames[refIdx];
    for (let i = 0; i < n; i++) mask[i] = Math.abs(buf[i] - ref[i]) > sensitivity ? 1 : 0;
  } else {
    mask.fill(0); // истории ещё мало — движения нет, но тепло копим дальше
  }

  // накопитель тепла: heat = max(heat·decay, mask)
  for (let i = 0; i < n; i++) {
    const h = heat[i] * decay;
    heat[i] = mask[i] > h ? mask[i] : h;
  }

  // бинаризация по порогу тепла -> открытие (erode -> dilate)
  const bin = binBuf!, tmp = tmpBuf!;
  for (let i = 0; i < n; i++) bin[i] = heat[i] >= heatThr ? 1 : 0;
  morph(bin, tmp, true); // erode
  morph(tmp, bin, false); // dilate

  // связные компоненты (4-соседство) методом заливки -> bbox + площадь
  const labels = new Int32Array(n).fill(-1);
  const boxes: MotionBox[] = [];
  const stack: number[] = [];
  for (let i0 = 0; i0 < n; i0++) {
    if (!bin[i0] || labels[i0] !== -1) continue;
    let minX = W, minY = H, maxX = 0, maxY = 0, heatSum = 0, count = 0;
    stack.length = 0;
    stack.push(i0);
    labels[i0] = boxes.length;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % W;
      const y = (i - x) / W;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      heatSum += heat[i];
      count++;
      if (x > 0 && bin[i - 1] && labels[i - 1] === -1) { labels[i - 1] = labels[i0]; stack.push(i - 1); }
      if (x < W - 1 && bin[i + 1] && labels[i + 1] === -1) { labels[i + 1] = labels[i0]; stack.push(i + 1); }
      if (y > 0 && bin[i - W] && labels[i - W] === -1) { labels[i - W] = labels[i0]; stack.push(i - W); }
      if (y < H - 1 && bin[i + W] && labels[i + W] === -1) { labels[i + W] = labels[i0]; stack.push(i + W); }
    }
    if (count < minArea) continue; // фильтр по площади — мелкий мусор прочь
    boxes.push({
      x: minX / W,
      y: minY / H,
      w: (maxX - minX + 1) / W,
      h: (maxY - minY + 1) / H,
      activity: Math.min(1, heatSum / count),
    });
  }

  // самые крупные сверху, ограничим количество
  boxes.sort((a, b) => b.w * b.h - a.w * a.h);
  return boxes.slice(0, maxBoxes);
}

// --- Характерные точки: РОВНО по одной на ячейку сетки (фиксированная длина). ---
// Стабильный порядок ячеек -> стабильные индексы между кадрами -> можно сглаживать
// и линии constellation не прыгают. Слабая ячейка отдаёт strength=0 (точка «спит»
// в своём центре) — главный поток держит её замороженной и гасит по альфе.
function features(gray: Float32Array): FeaturePoint[] {
  const aspect = W / H;
  const cols = Math.max(2, Math.round(Math.sqrt(featureCount * aspect)));
  const rows = Math.max(2, Math.round(featureCount / cols));
  const cw = W / cols;
  const ch = H / rows;
  const pts: FeaturePoint[] = [];

  const gradAt = (x: number, y: number) => {
    if (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1) return 0;
    const i = y * W + x;
    const gx = gray[i + 1] - gray[i - 1];
    const gy = gray[i + W] - gray[i - W];
    return Math.sqrt(gx * gx + gy * gy);
  };

  const minGrad = 0.06; // порог «есть фича»
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let bx = -1, by = -1, best = minGrad;
      const x0 = Math.floor(cx * cw), x1 = Math.floor((cx + 1) * cw);
      const y0 = Math.floor(cy * ch), y1 = Math.floor((cy + 1) * ch);
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const g = gradAt(x, y);
          if (g > best) { best = g; bx = x; by = y; }
        }
      }
      if (bx >= 0) {
        pts.push({ x: bx / W, y: by / H, strength: Math.min(1, best * 2) });
      } else {
        // «спящая» точка в центре ячейки
        pts.push({ x: (cx + 0.5) / cols, y: (cy + 0.5) / rows, strength: 0 });
      }
    }
  }
  return pts;
}

function applyParams(m: any) {
  if (typeof m.sensitivity === "number") sensitivity = m.sensitivity;
  if (typeof m.featureCount === "number") featureCount = m.featureCount;
  if (typeof m.gap === "number") gap = Math.max(1, Math.min(HISTORY - 1, m.gap | 0));
  if (typeof m.decay === "number") decay = m.decay;
  if (typeof m.heatThreshold === "number") heatThr = m.heatThreshold;
  if (typeof m.minArea === "number") minArea = m.minArea;
  if (typeof m.maxBoxes === "number") maxBoxes = m.maxBoxes | 0;
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "config") {
    applyParams(m);
    return;
  }
  if (m.type !== "frame") return;

  const { data, width, height } = m as {
    data: Uint8ClampedArray; width: number; height: number;
  };
  applyParams(m);

  const n = width * height;
  if (W !== width || H !== height || !heat || heat.length !== n) {
    W = width; H = height;
    resetState(n); // смена разрешения -> сброс истории/тепла, иначе мусор
  }

  const t0 = performance.now();
  toGray(data, grayBuf!, n);
  const boxes = motionBoxes(); // читает grayBuf, обновляет heat/frames
  const feats = features(grayBuf!);

  postMessage({ type: "vision", boxes, features: feats, msVision: performance.now() - t0 });
};
