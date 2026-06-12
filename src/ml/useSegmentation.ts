import { useEffect, useRef, useState } from "react";
import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import type { PeopleSegFrame, SegModel } from "../core/types";
import type { SharedFrame } from "./useFrameGrab";
import { perf } from "../core/perf";

// Гладкая сегментация людей через MediaPipe ImageSegmenter. Две модели на выбор:
//   - selfie: Selfie Segmentation (под селфи-портрет крупным планом) — confidence-маска 0..1.
//   - deeplab: DeepLabv3 (общий план, PASCAL VOC) — category-маска, берём класс person.
// Работает на основном потоке (GPU-delegate), НЕ из useFrame, с троттлингом — как useFaces.
// Видео letterbox'им в квадрат INPUT (маленький) -> дешёвый readback + чистый обратный
// letterbox в шейдере (mul/off, как у YOLO-масок). Темпоральная EMA гасит дрожь.
const INPUT = 256;
const MODELS: Record<SegModel, string> = {
  selfie: "/mediapipe/selfie_segmenter.tflite",
  deeplab: "/mediapipe/deeplab_v3.tflite",
};

export function useSegmentation(enabled: boolean, params: { smooth: number; model: SegModel }) {
  const latestRef = useRef<PeopleSegFrame | null>(null);
  const segRef = useRef<ImageSegmenter | null>(null);
  const readyRef = useRef(false);
  const lastTsRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const accRef = useRef<Float32Array | null>(null); // EMA-аккумулятор маски
  const isDeepRef = useRef(false); // текущая модель — deeplab (category) vs selfie (confidence)
  const personClassRef = useRef(15); // индекс класса person в category-маске (deeplab)
  const cfgRef = useRef(params);
  cfgRef.current = params;
  const [device, setDevice] = useState<string>("…");
  const model = params.model;

  useEffect(() => {
    if (!enabled) { latestRef.current = null; return; }
    let cancelled = false;
    let seg: ImageSegmenter | null = null;
    const isDeep = model === "deeplab";
    setDevice(`запуск ${model}…`);
    (async () => {
      const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      if (cancelled) return;
      seg = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODELS[model], delegate: "GPU" },
        runningMode: "VIDEO",
        outputConfidenceMasks: !isDeep,
        outputCategoryMask: isDeep,
      });
      if (cancelled) { seg.close(); return; }
      // ищем класс person в метках (deeplab); selfie — одноканальная, метки не нужны
      if (isDeep) {
        const labels = seg.getLabels?.() ?? [];
        const idx = labels.findIndex((l) => /person/i.test(l));
        personClassRef.current = idx >= 0 ? idx : 15;
      }
      isDeepRef.current = isDeep;
      accRef.current = null; // сброс EMA при смене модели
      segRef.current = seg;
      const c = document.createElement("canvas");
      c.width = INPUT; c.height = INPUT;
      canvasRef.current = c;
      readyRef.current = true;
      setDevice(`${model} · gpu`);
    })().catch((e) => { console.error("[seg] init", e); setDevice("ошибка ⚠"); });

    return () => {
      cancelled = true;
      readyRef.current = false;
      segRef.current?.close();
      segRef.current = null;
      latestRef.current = null;
      accRef.current = null;
    };
  }, [enabled, model]);

  // tsMs — монотонный таймстамп из покадрового колбэка (нужен MediaPipe). source — общий грабер.
  function submit(frame: SharedFrame, tsMs: number): boolean {
    const seg = segRef.current, canvas = canvasRef.current;
    if (!readyRef.current || !seg || !canvas) return false;
    if (tsMs - lastTsRef.current < 40) return false; // ~25 fps
    let ts = tsMs;
    if (ts <= lastTsRef.current) ts = lastTsRef.current + 1;
    lastTsRef.current = ts;

    const vw = frame.w || 1, vh = frame.h || 1;
    const scale = Math.min(INPUT / vw, INPUT / vh);
    const nw = vw * scale, nh = vh * scale;
    const padX = (INPUT - nw) / 2, padY = (INPUT - nh) / 2;

    const endSeg = perf.mark("seg.detect"); // GPU-delegate + readback маски, синхронно на main
    try {
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, INPUT, INPUT);
      ctx.drawImage(frame.source, padX, padY, nw, nh);
      const result = seg.segmentForVideo(canvas, ts);

      // источник покрытия: deeplab -> category (class==person ? 1 : 0); selfie -> confidence 0..1
      const isDeep = isDeepRef.current;
      const cm = isDeep ? result.categoryMask : result.confidenceMasks?.[0];
      if (cm) {
        const u8 = isDeep ? cm.getAsUint8Array() : null;
        const f32 = isDeep ? null : cm.getAsFloat32Array();
        const w = cm.width, h = cm.height, n = w * h;
        const person = personClassRef.current;
        let acc = accRef.current;
        if (!acc || acc.length !== n) {
          acc = new Float32Array(n);
          for (let i = 0; i < n; i++) acc[i] = f32 ? f32[i] : (u8![i] === person ? 1 : 0);
          accRef.current = acc;
        }
        const s = Math.max(0, Math.min(0.95, cfgRef.current.smooth));
        const buf = new Uint8Array(n); // свежий буфер -> FlatView ловит «новый кадр» по ссылке
        for (let i = 0; i < n; i++) {
          const cur = f32 ? f32[i] : (u8![i] === person ? 1 : 0);
          const v = acc[i] * s + cur * (1 - s);
          acc[i] = v;
          buf[i] = (v * 255) | 0;
        }
        const mul: [number, number] = [(vw * scale) / INPUT, (vh * scale) / INPUT];
        const off: [number, number] = [padX / INPUT, padY / INPUT];
        latestRef.current = { data: buf, width: w, height: h, mul, off };
      }
      result.close();
      perf.tick("seg.fps");
    } catch (e) {
      void e; // segmentForVideo иногда кидает на ресайзе/первом кадре
    }
    endSeg();
    return true;
  }

  return { submit, latestRef, device };
}

export type SegmentationApi = ReturnType<typeof useSegmentation>;
