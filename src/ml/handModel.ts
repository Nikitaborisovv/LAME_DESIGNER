// Чистые функции модели руки: сырые ландмарки -> поза + жест.
// Без состояния (дебаунс жеста живёт в useHands). Координаты:
//  - landmarks: норм. 0..1 кадра (для экранных величин: palmCenter, fingertips, pinch).
//  - world:     метрические относительно ладони (для углов/раскрытости — масштаб-инвариантно).

import type { HandLandmark, HandPose, HandGesture } from "../core/types";
import { FINGERTIPS, PALM_POINTS } from "./handTopology";

type V3 = { x: number; y: number; z: number };

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z) || 1e-6;
const norm = (a: V3): V3 => { const l = len(a); return { x: a.x / l, y: a.y / l, z: a.z / l }; };
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// Масштаб руки (мир): запястье -> основание среднего пальца. Делает величины
// независимыми от расстояния до камеры.
function handScale(world: HandLandmark[]): number {
  return len(sub(world[9], world[0]));
}

export function computePose(landmarks: HandLandmark[], world: HandLandmark[]): HandPose {
  // центр ладони (экранные норм. координаты) — среднее костяшек-оснований
  let px = 0, py = 0;
  for (const i of PALM_POINTS) { px += landmarks[i].x; py += landmarks[i].y; }
  const palmCenter = { x: px / PALM_POINTS.length, y: py / PALM_POINTS.length };

  // нормаль ладони (мир): cross двух векторов на ладони
  const v1 = sub(world[5], world[0]);
  const v2 = sub(world[17], world[0]);
  const palmNormal = norm(cross(v1, v2));

  // ориентация: roll — поворот руки в плоскости кадра (самое полезное для эффектов),
  // pitch/yaw — из нормали ладони.
  const up = sub(landmarks[9], landmarks[0]); // запястье -> средний MCP (экран)
  const rotation = {
    roll: Math.atan2(up.x, -up.y), // 0 = рука «вверх», по часовой +
    pitch: Math.asin(Math.max(-1, Math.min(1, -palmNormal.y))),
    yaw: Math.atan2(palmNormal.x, palmNormal.z),
  };

  // раскрытость: средняя дистанция кончиков от ладони (мир), нормировано к масштабу руки
  const scale = handScale(world);
  let palmWx = 0, palmWy = 0, palmWz = 0;
  for (const i of PALM_POINTS) { palmWx += world[i].x; palmWy += world[i].y; palmWz += world[i].z; }
  const palmW = { x: palmWx / PALM_POINTS.length, y: palmWy / PALM_POINTS.length, z: palmWz / PALM_POINTS.length };
  let tipSum = 0;
  for (const i of FINGERTIPS) tipSum += len(sub(world[i], palmW)) / scale;
  const tipAvg = tipSum / FINGERTIPS.length;
  const openness = clamp01((tipAvg - 0.8) / (2.1 - 0.8)); // кулак ~0.8, раскрытая ~2.1

  // щипок: дистанция большой(4)<->указательный(8), мир/масштаб; 1 = касание, 0 = далеко
  const pinchD = len(sub(world[4], world[8])) / scale;
  const pinch = clamp01(1 - pinchD / 0.6);

  // кончики в норм. координатах кадра
  const fingertips = FINGERTIPS.map((i) => ({ x: landmarks[i].x, y: landmarks[i].y }));

  return { palmCenter, palmNormal, rotation, openness, pinch, fingertips };
}

// Какие пальцы разогнуты [большой, указательный, средний, безымянный, мизинец].
// Палец 2..5: кончик дальше от запястья, чем PIP-сустав. Большой — отвод вбок (от мизинца).
export function extendedFingers(world: HandLandmark[]): boolean[] {
  const wrist = world[0];
  const d = (a: HandLandmark, b: HandLandmark) => len(sub(a, b));
  const thumb = d(world[4], world[17]) > d(world[2], world[17]) * 1.1;
  const tips = [8, 12, 16, 20], pips = [6, 10, 14, 18];
  const rest = tips.map((t, k) => d(world[t], wrist) > d(world[pips[k]], wrist) * 1.05);
  return [thumb, ...rest];
}

// Геометрическая классификация жеста (сырая, без дебаунса — он в useHands).
export function classifyGesture(world: HandLandmark[], pose: HandPose): HandGesture {
  if (pose.pinch > 0.7) return "pinch";
  const ext = extendedFingers(world);
  const [thumb, index, middle, ring, pinky] = ext;
  const count = ext.filter(Boolean).length;

  if (count === 0) return "fist";
  if (index && middle && !ring && !pinky) return "victory";
  if (index && !middle && !ring && !pinky) return "point";
  if (count >= 4 && index && middle && ring && pinky) return "open_palm";
  void thumb;
  return "none";
}
