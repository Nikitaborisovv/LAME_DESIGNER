import { useRef, useCallback } from "react";
import { perf } from "../core/perf";

// Один грабер кадра (ARCHITECTURE §0.2/§3 P3). Раньше каждый CPU-детектор (vision/people/seg)
// сам делал дорогой `drawImage(<video>)` с полноразмерного (1080p/4K) кадра — 3 выемки/кадр.
// Теперь ОДИН drawImage(<video> → общий канвас) на кадр; детекторы рисуют уже из него
// (маленький источник -> дёшево). Не добавляет GPU-работы (обычный 2D drawImage), поэтому не
// конкурирует с MediaPipe (в отличие от createImageBitmap-ресайза, см. P3).
//
// faces/hands НЕ используют грабер: MediaPipe грузит видео на GPU сам, CPU-выемка ему не нужна.

export interface SharedFrame {
  source: CanvasImageSource; // общий канвас с текущим кадром (downscale, аспект сохранён)
  w: number; // размеры источника (для аспект-математики детекторов: letterbox scale/mul/off)
  h: number;
}

const LONG = 640; // длинная сторона — хватает самому крупному потребителю (people input 640)

export function useFrameGrab() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<SharedFrame | null>(null);
  if (!canvasRef.current && typeof document !== "undefined") {
    canvasRef.current = document.createElement("canvas");
  }

  // Вызывать ОДИН раз в начале покадрового колбэка. После — детекторы берут frameRef.current.
  // Стабильна (useCallback) — чтобы не дёргать effect-deps потребителей каждый рендер.
  const grab = useCallback((video: HTMLVideoElement) => {
    const canvas = canvasRef.current;
    if (!canvas || video.readyState < 2) { frameRef.current = null; return; }
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { frameRef.current = null; return; }
    const scale = Math.min(1, LONG / Math.max(vw, vh));
    const w = Math.max(2, Math.round(vw * scale)), h = Math.max(2, Math.round(vh * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    // CPU-backed (willReadFrequently): дорогая выемка video→CPU происходит ЗДЕСЬ один раз;
    // детекторы потом копируют CPU→CPU (мелко, дёшево). Если грабер GPU-backed — каждый
    // детектор-CPU-канвас форсирует свой GPU→CPU ридбэк 640-кадра и всё клинит (проверено).
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const end = perf.mark("frame.grab"); // единственная дорогая выемка video→CPU на кадр
    ctx.drawImage(video, 0, 0, w, h);
    end();
    frameRef.current = { source: canvas, w, h };
  }, []);

  return { frameRef, grab };
}
