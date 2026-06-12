import { useEffect, useRef } from "react";
import type { VisionResult } from "../core/types";
import type { SharedFrame } from "./useFrameGrab";
import { perf } from "../core/perf";

// Поднимает vision-воркер (движение + точки). submit(video) шлёт уменьшенный кадр.
// Результат кладётся в ref (без React-ререндера каждый кадр) — оверлей читает его на rAF.
const PROC_W = 192; // ширина обработки: мелко -> быстро, для боксов/точек хватает

// Параметры устойчивого frame-diff пайплайна (см. visionWorker / pipeline.md).
export interface MotionParams {
  sensitivity: number;
  gap: number;
  decay: number;
  heatThreshold: number;
  minArea: number;
  maxBoxes: number;
}

export function useVision(
  enabled: boolean,
  motion: MotionParams,
  featureCount: number
) {
  const workerRef = useRef<Worker | null>(null);
  const busyRef = useRef(false);
  const resultRef = useRef<VisionResult>({ boxes: [], features: [] });
  const canvasRef = useRef<OffscreenCanvas | null>(null);
  const submitTRef = useRef(0);
  const cfgRef = useRef({ motion, featureCount });
  cfgRef.current = { motion, featureCount };

  useEffect(() => {
    if (!enabled) {
      resultRef.current = { boxes: [], features: [] };
      return;
    }
    const worker = new Worker(new URL("./visionWorker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "vision") {
        resultRef.current = { boxes: m.boxes, features: m.features };
        perf.add("vision.worker", m.msVision);
        perf.add("vision.roundtrip", performance.now() - submitTRef.current);
        perf.tick("vision.fps");
        busyRef.current = false;
      } else if (m.type === "error") {
        console.error("[vision]", m.message);
        busyRef.current = false; // иначе busy зависает навсегда и воркер замолкает
      }
    };
    // Необработанное исключение в воркере тоже сбрасывает busy (иначе vision встанет).
    worker.onerror = (e) => { console.error("[vision] worker", e.message); busyRef.current = false; };
    worker.onmessageerror = () => { busyRef.current = false; };
    workerRef.current = worker;
    canvasRef.current = new OffscreenCanvas(PROC_W, Math.round(PROC_W * 9 / 16));
    busyRef.current = false;
    return () => {
      worker.terminate();
      workerRef.current = null;
      busyRef.current = false;
    };
  }, [enabled]);

  function submit(frame: SharedFrame) {
    const w = workerRef.current;
    const canvas = canvasRef.current;
    if (!w || !canvas || busyRef.current) return;
    busyRef.current = true;
    const ratio = frame.w / frame.h || 16 / 9;
    canvas.width = PROC_W;
    canvas.height = Math.max(2, Math.round(PROC_W / ratio));
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const endRb = perf.mark("vision.readback");
    ctx.drawImage(frame.source, 0, 0, canvas.width, canvas.height); // источник — общий грабер (мелкий)
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    endRb();
    submitTRef.current = performance.now();
    const { motion, featureCount } = cfgRef.current;
    w.postMessage(
      {
        type: "frame",
        data: img.data,
        width: canvas.width,
        height: canvas.height,
        sensitivity: motion.sensitivity,
        gap: motion.gap,
        decay: motion.decay,
        heatThreshold: motion.heatThreshold,
        minArea: motion.minArea,
        maxBoxes: motion.maxBoxes,
        featureCount,
      },
      [img.data.buffer]
    );
  }

  return { submit, resultRef };
}
