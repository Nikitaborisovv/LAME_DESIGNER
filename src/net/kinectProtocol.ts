// Протокол хост-моста Kinect ⇄ веб (WebSocket, бинарные кадры). Мост — нативная
// программа на машине с Kinect (C#/.NET под Kinect SDK 1.8, ВНЕ репо, см. reference-
// док на Desktop). Мост открывает сенсор, на каждом кадре шлёт сюда RGB и/или depth.
// Веб — чистый потребитель: RGB → canvas.captureStream → VideoSource; depth → DepthFrame.
//
// Формат сообщений WebSocket:
//  - ТЕКСТ (JSON): { t: "hello", w, h, model, fps } — метаданные при коннекте.
//  - БИНАРЬ (ArrayBuffer): первый байт — тег кадра.
//      depth (tag 0x01):  [u8 tag][u8 pad][u16 w LE][u16 h LE][f64 ts ms LE][uint16 mm[w*h] LE]
//                         заголовок 14 байт (чётный), чтобы Uint16Array лёг без копий.
//      rgb   (tag 0x02):  [u8 tag][... encoded JPEG/PNG bytes]  → createImageBitmap(Blob)
//
// Глубина у Kinect — uint16 в МИЛЛИМЕТРАХ (не метрах!). Конвертируем в grayscale 0..255
// (ближе = ярче) под тот же контракт DepthFrame, что отдаёт нейро-воркер depthWorker.

import type { DepthFrame } from "../core/types";

export const KINECT_TAG_DEPTH = 0x01;
export const KINECT_TAG_RGB = 0x02;

// Заголовок depth-кадра: tag(1) + pad(1) + w(2) + h(2) + ts(8) = 14 байт.
export const KINECT_DEPTH_HEADER = 14;

// Диапазон дальности Kinect v1 (structured light): ~0.8–4.0 м. Вне диапазона / дыры (0мм) → 0.
export const KINECT_NEAR_MM = 500;
export const KINECT_FAR_MM = 4000;

// uint16 мм → Uint8 grayscale (ближе = ярче, как Depth Anything). Дыры (0 мм) → 0 (далеко/нет данных).
export function depthMmToGray(
  mm: Uint16Array,
  near = KINECT_NEAR_MM,
  far = KINECT_FAR_MM
): Uint8Array {
  const out = new Uint8Array(mm.length);
  const span = far - near || 1;
  for (let i = 0; i < mm.length; i++) {
    const d = mm[i];
    if (d <= 0) { out[i] = 0; continue; }
    const t = (far - d) / span; // near→1 (ярко), far→0 (темно)
    out[i] = t <= 0 ? 0 : t >= 1 ? 255 : ((t * 255 + 0.5) | 0);
  }
  return out;
}

export interface KinectDepthMsg {
  width: number;
  height: number;
  ts: number;
  mm: Uint16Array;
}

// Разобрать бинарный depth-кадр (tag 0x01). null — если тег не совпал/буфер мал.
export function parseDepthFrame(buf: ArrayBuffer): KinectDepthMsg | null {
  if (buf.byteLength < KINECT_DEPTH_HEADER) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== KINECT_TAG_DEPTH) return null;
  const width = dv.getUint16(2, true);
  const height = dv.getUint16(4, true);
  const ts = dv.getFloat64(6, true);
  const count = width * height;
  if (buf.byteLength < KINECT_DEPTH_HEADER + count * 2) return null;
  const mm = new Uint16Array(buf, KINECT_DEPTH_HEADER, count);
  return { width, height, ts, mm };
}

// Готовый DepthFrame (grayscale) из бинарного depth-кадра моста.
export function depthMsgToFrame(msg: KinectDepthMsg): DepthFrame {
  return { data: depthMmToGray(msg.mm), width: msg.width, height: msg.height };
}
