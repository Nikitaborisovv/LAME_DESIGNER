// Драйверы — непрерывные сигналы рук (0..1), которыми модулируются параметры
// модификаторов (толщина/цвет/количество связей). Считаются из HandResult на rAF.

import type { HandResult, VisionResult, FaceResult, PeopleFrame, DriverKind, LayerKind, OpNode, OpKind, PointGroup } from "./types";

export type DriverValues = Record<Exclude<DriverKind, "none">, number>;
export type Signal = Exclude<DriverKind, "none">;

// === T1-3 per-element поля: контекст ТОЧКИ, в котором вычисляется Field-цепочка. ===
// Поле = функция (ElementCtx) → 0..1 — вычисляется ПОТРЕБИТЕЛЕМ над ЕГО PointSet (lazy, без
// материализации буферов; материализация = setAttr/Capture). Скаляр — частный случай: цепочка
// без element-источников компилируется в одно число (см. compileFieldFn).
// gi — индекс группы у потребителя (опц.): randomPt подмешивает его в fallback-ключ, когда у группы
// НЕТ атрибута id — иначе локальные индексы параллельных групп (merge без id) коллизили бы.
export interface ElementCtx { i: number; n: number; group: PointGroup; gi?: number }
export type FieldFn = (ctx: ElementCtx) => number;

// FFT-полосы аудио-анализа (Reduce из WebAudio AnalyserNode -> Field).
// Экспортируется для хука useAudio и для тестирования computeAudioBands.
export interface AudioBands { low: number; mid: number; high: number; kick: number; }

// Источники сигналов-драйверов (последние результаты продюсеров). Структурно совпадает с
// PointResultRefs (pointSources) — тот же DataBus-вход, но для Reduce -> Field, не для точек.
export interface DriverSources {
  hands?: HandResult;
  motion?: VisionResult;
  faces?: FaceResult;
  people?: PeopleFrame | null;
  audio?: AudioBands;
}

const PEOPLE_MAX = 4; // нормировка count людей -> 0..1 (4 человека = «полно»)

// Список для UI-выпадашки привязки.
export const DRIVER_OPTIONS: [DriverKind, string][] = [
  ["none", "— нет —"],
  ["openness", "раскрытие (кулак↔ладонь)"],
  ["pinch", "щипок"],
  ["roll", "поворот ладони (roll)"],
  ["handsDist", "дистанция между руками"],
  ["motionEnergy", "энергия движения"],
  ["faceX", "лицо · X (центроид)"],
  ["faceY", "лицо · Y (центроид)"],
  ["peopleCount", "число людей"],
  ["audioLow", "аудио · бас"],
  ["audioMid", "аудио · середина"],
  ["audioHigh", "аудио · верх"],
  ["audioKick", "аудио · кик"],
];

// Сигналы-драйверы (Field-каналы) для нод-источников в графе: реальные выходы без "none".
export const DRIVER_SIGNALS: Signal[] = [
  "openness", "pinch", "roll", "handsDist", "motionEnergy", "faceX", "faceY", "peopleCount",
  "audioLow", "audioMid", "audioHigh", "audioKick",
];

// Короткие подписи выходов нод-сигналов (в графе место ограничено).
export const DRIVER_SHORT: Record<Signal, string> = {
  openness: "раскрытие", pinch: "щипок", roll: "поворот", handsDist: "дистанция рук",
  motionEnergy: "энергия", faceX: "X", faceY: "Y", peopleCount: "число",
  audioLow: "бас", audioMid: "середина", audioHigh: "верх", audioKick: "кик",
};

// Группировка сигналов по нодам-источникам в графе (= по продюсеру/семейству, TD CHOP-источник).
// Каждая группа = одна Field-нода с набором выходов-каналов.
export const DRIVER_GROUPS: { label: string; signals: Signal[] }[] = [
  { label: "Сигналы рук", signals: ["openness", "pinch", "roll", "handsDist"] },
  { label: "Движение · энергия", signals: ["motionEnergy"] },
  { label: "Лица · центроид", signals: ["faceX", "faceY"] },
  { label: "Люди · число", signals: ["peopleCount"] },
  { label: "Аудио", signals: ["audioLow", "audioMid", "audioHigh", "audioKick"] },
];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Reduce (PointSet -> Field, §2.4): энергия движения из боксов = площадь-взвешенная средняя
// активность. Площадь весит, чтобы крупное движение значило больше, чем дрожь маленького бокса.
// Нет боксов -> 0. (Темпоральное сглаживание делает binding.smooth ниже по потоку.)
export function motionEnergy(v: VisionResult | undefined): number {
  const boxes = v?.boxes;
  if (!boxes || !boxes.length) return 0;
  let num = 0, den = 0;
  for (const b of boxes) { const a = b.w * b.h; num += b.activity * a; den += a; }
  return den > 0 ? clamp01(num / den) : 0;
}

// Reduce (центроид): средний центр боксов лиц, норм. 0..1. Нет лиц -> центр кадра (0.5, 0.5).
export function faceCentroid(f: FaceResult | undefined): { x: number; y: number } {
  const boxes = f?.boxes;
  if (!boxes || !boxes.length) return { x: 0.5, y: 0.5 };
  let sx = 0, sy = 0;
  for (const b of boxes) { sx += b.x + b.w / 2; sy += b.y + b.h / 2; }
  return { x: clamp01(sx / boxes.length), y: clamp01(sy / boxes.length) };
}

// Reduce (count): число найденных людей -> 0..1 (нормировка PEOPLE_MAX). Нет данных -> 0.
export function peopleCountNorm(p: PeopleFrame | null | undefined): number {
  return clamp01((p?.count ?? 0) / PEOPLE_MAX);
}

// Считать все драйверы из текущих результатов продюсеров (DataBus-вход). Руки: первая для
// openness/pinch/roll, handsDist — между двумя ладонями. Остальное — Reduce'ы (энергия движения,
// центроид лиц, count людей), руки не нужны. Нет данных по источнику -> его сигналы нейтральны.
export function computeDrivers(s: DriverSources): DriverValues {
  const hands = s.hands?.hands ?? [];
  const h0 = hands[0];
  const openness = clamp01(h0?.pose.openness ?? 0);
  const pinch = clamp01(h0?.pose.pinch ?? 0);
  // roll в радианах: влево (−) -> 0, центр -> 0.5, вправо (+) -> 1
  const roll = h0 ? clamp01(0.5 + h0.pose.rotation.roll / Math.PI) : 0.5;
  let handsDist = 0;
  if (hands.length >= 2) {
    const a = hands[0].pose.palmCenter, b = hands[1].pose.palmCenter;
    handsDist = clamp01(Math.hypot(a.x - b.x, a.y - b.y) / 0.8); // ~0.8 норм. ширины = «далеко»
  }
  const fc = faceCentroid(s.faces);
  const ab = s.audio;
  return {
    openness, pinch, roll, handsDist,
    motionEnergy: motionEnergy(s.motion),
    faceX: fc.x, faceY: fc.y,
    peopleCount: peopleCountNorm(s.people),
    audioLow: ab ? clamp01(ab.low) : 0,
    audioMid: ab ? clamp01(ab.mid) : 0,
    audioHigh: ab ? clamp01(ab.high) : 0,
    audioKick: ab ? clamp01(ab.kick) : 0,
  };
}

// Какой продюсер должен «cook», чтобы сигнал-драйвер считался (для авто-активации зависимостей
// в resolveConfig). faceX/Y берут боксы лиц (faceBoxes); peopleCount — YOLO (через peopleBox).
export function driverProducer(d: Signal): LayerKind {
  switch (d) {
    case "openness": case "pinch": case "roll": case "handsDist": return "hands";
    case "motionEnergy": return "motion";
    case "faceX": case "faceY": return "faceBoxes";
    case "peopleCount": return "peopleBox";
    case "audioLow": case "audioMid": case "audioHigh": case "audioKick": return "audio";
  }
}

// Нелинейный отклик (Math/Remap на проводе): t (0..1) -> shaped (0..1) по кривой curve −1..1.
//  curve 0 = линейно; >0 = ease-in (экспонента 1..4, медленный старт); <0 = ease-out (1..1/4).
export function shapeT(t: number, curve?: number): number {
  const c = curve ?? 0;
  if (c === 0) return clamp01(t);
  const exp = Math.pow(2, c * 2); // c:1 -> 4 (ease-in), c:-1 -> 0.25 (ease-out)
  return Math.pow(clamp01(t), exp);
}

// === T1 Field-алгебра: реестр оп-нод (вид -> метка, число входов, поля-крутилки, дефолты). ===
// Data-driven (как MODIFIER_DEFS): граф рисует ноду и контрол по этой спеке, App создаёт с defaults,
// resolveSignal считает по op.op. Новая Field-нода = запись здесь + case в evalOp (+ палитра).
export interface OpFieldSpec {
  field: string; label: string; type: "range" | "check" | "select" | "ramp";
  min?: number; max?: number; step?: number; options?: [string, string][];
}
// element (T1-3): нода — per-element ИСТОЧНИК (значение на точку, требует ElementCtx потребителя);
// цепочка с такой нодой компилируется в FieldFn, без неё — в скаляр (compileFieldFn).
export interface OpDef { kind: OpKind; label: string; inputs: 0 | 1 | 2; element?: boolean; fields: OpFieldSpec[]; defaults: Record<string, number | string | boolean>; }
const RG = (field: string, label: string, min: number, max: number, step: number): OpFieldSpec => ({ field, label, type: "range", min, max, step });
export const OP_DEFS: Record<OpKind, OpDef> = {
  math: {
    kind: "math", label: "Math", inputs: 1,
    fields: [RG("gain", "усиление", 0, 4, 0.05), RG("offset", "смещение", -1, 1, 0.05), RG("curve", "кривая", -1, 1, 0.1)],
    defaults: { gain: 1, offset: 0, curve: 0 },
  },
  const: {
    kind: "const", label: "Константа", inputs: 0,
    fields: [RG("value", "значение", 0, 1, 0.01)],
    defaults: { value: 0.5 },
  },
  mapRange: {
    kind: "mapRange", label: "MapRange", inputs: 1,
    fields: [
      RG("inLo", "вход: мин", 0, 1, 0.01), RG("inHi", "вход: макс", 0, 1, 0.01),
      RG("outLo", "выход: мин", 0, 1, 0.01), RG("outHi", "выход: макс", 0, 1, 0.01),
      RG("curve", "кривая", -1, 1, 0.1), { field: "clamp", label: "ограничить (clamp)", type: "check" },
    ],
    defaults: { inLo: 0, inHi: 1, outLo: 0, outHi: 1, curve: 0, clamp: true },
  },
  compare: {
    kind: "compare", label: "Compare", inputs: 1,
    fields: [RG("threshold", "порог", 0, 1, 0.01), RG("width", "мягкость", 0, 0.5, 0.01), { field: "invert", label: "инверсия", type: "check" }],
    defaults: { threshold: 0.5, width: 0.05, invert: false },
  },
  lfo: {
    kind: "lfo", label: "LFO (время)", inputs: 0,
    fields: [
      RG("rate", "частота (Гц)", 0, 4, 0.05),
      { field: "wave", label: "форма", type: "select", options: [["sine", "синус"], ["triangle", "треугольник"], ["saw", "пила"], ["square", "меандр"]] },
      RG("lo", "минимум", 0, 1, 0.01), RG("hi", "максимум", 0, 1, 0.01),
    ],
    defaults: { rate: 0.5, wave: "sine", lo: 0, hi: 1 },
  },
  // T1-2 новые ноды:
  random: {
    kind: "random", label: "Random", inputs: 0,
    fields: [RG("rate", "частота (Гц)", 0.1, 20, 0.1), RG("smooth", "сглаживание", 0, 1, 0.01)],
    defaults: { rate: 2, smooth: 0.3 },
  },
  mix: {
    kind: "mix", label: "Mix", inputs: 2,
    fields: [RG("t", "вес B  (0→A, 1→B)", 0, 1, 0.01)],
    defaults: { t: 0.5 },
  },
  noise: {
    kind: "noise", label: "Noise", inputs: 0,
    fields: [RG("freq", "частота (Гц)", 0.01, 10, 0.01), RG("octaves", "октавы", 1, 4, 1), RG("seed", "сид", 0, 99, 1)],
    defaults: { freq: 0.5, octaves: 2, seed: 0 },
  },
  ramp: {
    kind: "ramp", label: "Ramp", inputs: 1,
    fields: [],   // кривая рисуется отдельным RampEditor в OpControlComp
    defaults: {},
  },
  // T-Beauty: темпоральный фильтр с раздельными attack/release (TD Lag CHOP)
  lag: {
    kind: "lag", label: "Lag (attack/release)", inputs: 1,
    fields: [RG("attack", "атака (с)", 0, 2, 0.01), RG("release", "спад (с)", 0, 2, 0.01)],
    defaults: { attack: 0.05, release: 0.3 },
  },
  // === T1-3 per-element источники (element:true — значение НА ТОЧКУ; §3.6.3 Position/Index/
  // Named-Attribute/Random-by-ID). В скалярном контексте (без ElementCtx) дают фолбэк. ===
  position: {
    kind: "position", label: "Позиция (на точку)", inputs: 0, element: true,
    fields: [{ field: "axis", label: "ось", type: "select", options: [["x", "X"], ["y", "Y"], ["z", "Z (глубина)"]] }],
    defaults: { axis: "x" },
  },
  index: {
    kind: "index", label: "Индекс (на точку)", inputs: 0, element: true,
    fields: [],
    defaults: {},
  },
  readAttr: {
    kind: "readAttr", label: "Атрибут (на точку)", inputs: 0, element: true,
    fields: [
      { field: "attrName", label: "атрибут", type: "select", options: [["pscale", "pscale (размер)"], ["Cd", "Cd (цвет)"], ["id", "id"], ["v", "v (скорость)"], ["age", "age"], ["life", "life"]] },
      RG("comp", "компонента (вектор)", 0, 2, 1),
    ],
    defaults: { attrName: "pscale", comp: 0 },
  },
  randomPt: {
    kind: "randomPt", label: "Random (на точку)", inputs: 0, element: true,
    fields: [RG("seed", "сид", 0, 99, 1)],
    defaults: { seed: 0 },
  },
};

const num = (x: number | undefined, def: number) => (typeof x === "number" && isFinite(x) ? x : def);
const smoothstep = (e0: number, e1: number, x: number) => {
  if (e0 === e1) return x >= e1 ? 1 : 0;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const clockSec = () => (typeof performance !== "undefined" ? performance.now() : 0) / 1000;

// Random: детерминированный хэш (step + op.id) -> 0..1
const hash01 = (step: number, id: string): number => {
  let h = (step * 1664525 + 1013904223) >>> 0;
  for (let i = 0; i < Math.min(id.length, 8); i++) h = (h ^ (id.charCodeAt(i) * 1664525)) >>> 0;
  // Финализатор-лавина (murmur3 fmix32). БАГ-ФИКС: без него соседние step (id точек 0,1,2…)
  // давали соседние значения — randomPt был «градиентом», а не случайностью (Split 95/5 не резал),
  // нода Random ползла вместо прыжков.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
};
// EMA-состояние нод Random: value (текущий), target (куда идём), lastStep
const randomState = new Map<string, { value: number; target: number; lastStep: number }>();
// Состояние нод Lag: value (отфильтрованное), lastT (время последнего кадра в сек)
const lagState = new Map<string, { value: number; lastT: number }>();

// Noise: дробная часть (для value-noise)
const frac = (x: number) => x - Math.floor(x);

// Вычислить значение оп-ноды по её виду (вход(ы) — рекурсивный resolveSignal). Все выходы clamp01.
// T1-3: ctx (контекст точки) и ucache (кеш uniform-подграфов) — опциональны; без них путь
// байт-в-байт прежний (скалярные потребители drivenValue/applyFxBindings не тронуты).
function evalOp(op: OpNode, d: DriverValues, ops: OpNode[], depth: number, ctx?: ElementCtx, ucache?: Map<string, number>): number {
  const inA = () => resolveSignal(op.input ?? "none", d, ops, depth + 1, ctx, ucache);
  switch (op.op) {
    case "const": return clamp01(num(op.value, 0.5));
    case "math": return clamp01(num(op.gain, 1) * shapeT(inA(), op.curve) + num(op.offset, 0));
    case "mapRange": {
      const a = inA(), inLo = num(op.inLo, 0), inHi = num(op.inHi, 1);
      let t = inHi === inLo ? 0 : (a - inLo) / (inHi - inLo);
      if (op.clamp !== false) t = clamp01(t);
      t = shapeT(t, op.curve);
      return clamp01(num(op.outLo, 0) + (num(op.outHi, 1) - num(op.outLo, 0)) * t);
    }
    case "compare": {
      const a = inA(), th = num(op.threshold, 0.5), w = num(op.width, 0.05);
      const o = w <= 0 ? (a >= th ? 1 : 0) : smoothstep(th - w, th + w, a);
      return op.invert ? 1 - o : o;
    }
    case "lfo": {
      const ph = (() => { const t = clockSec() * num(op.rate, 0.5); return t - Math.floor(t); })();
      let w: number;
      switch (op.wave) {
        case "saw": w = ph; break;
        case "triangle": w = 1 - Math.abs(2 * ph - 1); break;
        case "square": w = ph < 0.5 ? 1 : 0; break;
        default: w = 0.5 - 0.5 * Math.cos(2 * Math.PI * ph); // sine
      }
      return clamp01(num(op.lo, 0) + (num(op.hi, 1) - num(op.lo, 0)) * w);
    }
    case "random": {
      // Детерминированный rng (hash(id, step)) + EMA-сглаживание по времени.
      const step = Math.floor(clockSec() * Math.max(0.001, num(op.rate, 2)));
      let st = randomState.get(op.id);
      if (!st) {
        const raw = hash01(step, op.id);
        st = { value: raw, target: raw, lastStep: step };
        randomState.set(op.id, st);
      } else if (step !== st.lastStep) {
        st.target = hash01(step, op.id);
        st.lastStep = step;
      }
      // EMA: smooth=0 -> мгновенный прыжок; smooth=1 -> не меняется.
      st.value += (1 - num(op.smooth, 0.3)) * (st.target - st.value);
      return clamp01(st.value);
    }
    case "mix": {
      const a = inA();
      const b = (op.input2 && op.input2 !== "none")
        ? resolveSignal(op.input2, d, ops, depth + 1, ctx, ucache)
        : a; // B не подключён → сквозной (pass-through на вес t не влияет)
      return clamp01(a + (b - a) * num(op.t, 0.5));
    }
    case "noise": {
      // FBM value-noise: smoothstep-интерполяция хэшей смежных целых + октавы.
      const freq = num(op.freq, 0.5), seed = num(op.seed, 0);
      const octaves = Math.max(1, Math.min(4, Math.round(num(op.octaves, 2))));
      let v = 0, amp = 0.5, f = 1;
      for (let o = 0; o < octaves; o++) {
        const x = clockSec() * freq * f + seed * 17.31;
        const i = Math.floor(x), fr = x - i, u = fr * fr * (3 - 2 * fr);
        const ha = frac(Math.sin(i * 127.1 + seed * 311.7) * 43758.5453);
        const hb = frac(Math.sin((i + 1) * 127.1 + seed * 311.7) * 43758.5453);
        v += (ha + (hb - ha) * u) * amp;
        amp *= 0.5; f *= 2;
      }
      return clamp01(v);
    }
    case "ramp": {
      // Кусочно-линейный lookup по stops[]: вход x -> выход y (lerp между ближайшими stops).
      const x = inA();
      const stops = (op.stops && op.stops.length >= 2)
        ? [...op.stops].sort((a, b) => a.x - b.x)
        : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
      if (x <= stops[0].x) return clamp01(stops[0].y);
      if (x >= stops[stops.length - 1].x) return clamp01(stops[stops.length - 1].y);
      for (let i = 1; i < stops.length; i++) {
        if (x <= stops[i].x) {
          const dx = stops[i].x - stops[i - 1].x;
          const t = dx === 0 ? 0 : (x - stops[i - 1].x) / dx;
          return clamp01(stops[i - 1].y + (stops[i].y - stops[i - 1].y) * t);
        }
      }
      return clamp01(stops[stops.length - 1].y);
    }
    case "lag": {
      // TD Lag CHOP: экспоненциальный фильтр с раздельными attack (вверх) / release (вниз).
      // Состояние — мутируемый объект в lagState, без аллокаций после первого кадра.
      const inp = inA();
      const now = clockSec();
      let st = lagState.get(op.id);
      if (!st) {
        // Первый вызов: инициализируем состояние значением входа.
        st = { value: inp, lastT: now };
        lagState.set(op.id, st);
        return clamp01(inp);
      }
      // Гард: ограничиваем dt сверху (пауза / фоновая вкладка), снизу — не нужно (всегда >= 0).
      const dt = Math.min(now - st.lastT, 0.25);
      st.lastT = now;
      const tau = inp > st.value ? num(op.attack, 0.05) : num(op.release, 0.3);
      if (tau <= 0) {
        // Мгновенный переход (tau = 0 → прямое присвоение без exp).
        st.value = inp;
      } else {
        st.value += (1 - Math.exp(-dt / tau)) * (inp - st.value);
      }
      return clamp01(st.value);
    }
    // === T1-3 element-источники: значение на ТОЧКУ из ElementCtx. Без ctx (скалярный
    // потребитель — биндинг shader-FX/эффекта) — детерминированный фолбэк. ===
    case "position": {
      if (!ctx) return 0.5; // центр кадра — нейтральный фолбэк
      const p = ctx.group.points[ctx.i];
      if (!p) return 0.5;
      // z (MediaPipe landmark) центрирован около 0 и бывает отрицательным — ремап 0.5+z/2,
      // иначе clamp01 схлопнул бы почти все z в 0 (мёртвая ось). x/y нормированы 0..1 как есть.
      const v = op.axis === "y" ? p.y : op.axis === "z" ? 0.5 + (p.z ?? 0) * 0.5 : p.x;
      return clamp01(v);
    }
    case "index":
      return ctx ? (ctx.n <= 1 ? 0 : clamp01(ctx.i / (ctx.n - 1))) : 0;
    case "readAttr": {
      if (!ctx) return 0;
      const name = (op.attrName as string) || "pscale";
      const g = ctx.group;
      const a = g.attrs?.find((x) => x.name === name);
      if (a) {
        const comps = a.comps ?? 1;
        const c = Math.max(0, Math.min(comps - 1, Math.round(num(op.comp, 0))));
        return clamp01(a.data[ctx.i * comps + c] ?? 0);
      }
      if (name === "pscale" && g.values) return clamp01(g.values[ctx.i] ?? 0); // legacy alias
      return 0;
    }
    case "randomPt": {
      // Стабильный случайный на точку: hash(id-атрибут ?? индекс, seed). С id переживает
      // sort/мерцание scatter (значение «едет» вместе с точкой); без id — по индексу+группе
      // (gi в ключе, иначе параллельные точки разных групп после merge делили бы значение).
      const seed = Math.round(num(op.seed, 0));
      if (!ctx) return hash01(seed, "pt"); // скалярный фолбэк: константа от seed
      const idAttr = ctx.group.attrs?.find((x) => x.name === "id");
      const key = idAttr ? Math.round(idAttr.data[ctx.i] ?? ctx.i) : ctx.i;
      return hash01(key, "pt" + seed + (idAttr ? "" : ":" + (ctx.gi ?? 0)));
    }
  }
  return 0;
}

// Резолв сигнала по хендлу (T1): сырой драйвер (Signal) ИЛИ оп-нода ("op:"+id) -> цепочка Field-нод
// (evalOp по виду op). Глубина-гард от циклов. Сырой драйвер -> d[handle] (без шейпа) — drivenValue
// без оп-нод байт-в-байт прежний. Math с gain/offset/curve = идентичен прежней реализации.
// T1-3: ctx/ucache опциональны (per-element путь compileFieldFn); ucache-попадание возвращает
// заранее вычисленный uniform-подграф (стейт-ноды продвигаются ровно один раз на компиляцию).
export function resolveSignal(handle: string, d: DriverValues, ops?: OpNode[], depth = 0, ctx?: ElementCtx, ucache?: Map<string, number>): number {
  if (handle.startsWith("op:")) {
    if (depth > 16 || !ops) return 0; // цикл/переполнение -> нейтрально
    const id = handle.slice(3);
    const cached = ucache?.get(id);
    if (cached !== undefined) return cached;
    const op = ops.find((o) => o.id === id);
    if (!op) return 0;
    return evalOp(op, d, ops, depth, ctx, ucache);
  }
  if (handle === "none") return 0;
  return d[handle as Signal] ?? 0;
}

// === T1-3: компиляция field-хендла. Скаляр — частный случай. ===
// Стейт-ноды (lag/random) — uniform-БАРЬЕРЫ: всегда вычисляются один раз скалярным путём
// (стейт на точку без стабильного id невозможен; lag(element-вход) деградирует к uniform —
// element-источники в скалярном контексте дают фолбэк). Honest-ограничение, см. ARCHITECTURE §3.6.9.
const STATE_KINDS = new Set<OpKind>(["random", "lag"]);

// Цепочка handle транзитивно содержит element-источник? (с учётом стейт-барьеров и цикл-гарда)
export function isElementDependent(handle: string, ops?: OpNode[], seen: Set<string> = new Set()): boolean {
  if (!handle?.startsWith("op:") || !ops) return false;
  const id = handle.slice(3);
  if (seen.has(id)) return false;
  seen.add(id);
  const op = ops.find((o) => o.id === id);
  if (!op) return false;
  if (OP_DEFS[op.op]?.element) return true;
  if (STATE_KINDS.has(op.op)) return false; // стейт-нода — uniform-барьер (вход считается скалярно)
  return isElementDependent(op.input ?? "none", ops, seen) ||
    (op.input2 ? isElementDependent(op.input2, ops, seen) : false);
}

// Prepass: обойти element-зависимую цепочку и вычислить все uniform-ПОДГРАФЫ один раз в кеш
// (включая стейт-ноды — ровно одно продвижение фильтра на компиляцию = на потребителя на кадр).
function fillUniformCache(handle: string, d: DriverValues, ops: OpNode[], cache: Map<string, number>, seen: Set<string> = new Set()): void {
  if (!handle?.startsWith("op:")) return;
  const id = handle.slice(3);
  if (seen.has(id)) return;
  seen.add(id);
  const op = ops.find((o) => o.id === id);
  if (!op) return;
  if (!isElementDependent(handle, ops)) {
    cache.set(id, resolveSignal(handle, d, ops)); // uniform-подграф целиком, скалярный путь
    return;
  }
  fillUniformCache(op.input ?? "none", d, ops, cache, seen);
  if (op.input2) fillUniformCache(op.input2, d, ops, cache, seen);
}

// Результат компиляции: либо скаляр (perElement=false, value — прежний resolveSignal байт-в-байт,
// потребитель идёт быстрой веткой data.fill), либо FieldFn (вычислять на точку через ElementCtx).
export interface CompiledField { perElement: boolean; value: number; fn?: FieldFn }
export function compileFieldFn(handle: string, d: DriverValues, ops?: OpNode[]): CompiledField {
  if (!handle || handle === "none") return { perElement: false, value: 0 };
  if (!isElementDependent(handle, ops)) return { perElement: false, value: resolveSignal(handle, d, ops) };
  const cache = new Map<string, number>();
  fillUniformCache(handle, d, ops!, cache);
  return { perElement: true, value: 0, fn: (ctx) => resolveSignal(handle, d, ops, 0, ctx, cache) };
}

// Значение параметра, продиктованное привязкой (с нелинейным откликом curve). `signal` (Math-цепочка)
// переопределяет сырой `driver`, если задан. Без signal/ops — идентично прежнему поведению.
export function drivenValue(
  binding: { driver: DriverKind; signal?: string; lo: number; hi: number; curve?: number },
  d: DriverValues,
  ops?: OpNode[],
): number {
  const handle = binding.signal ?? binding.driver;
  if (handle === "none") return binding.lo;
  const t = shapeT(resolveSignal(handle, d, ops), binding.curve);
  return binding.lo + (binding.hi - binding.lo) * t;
}
