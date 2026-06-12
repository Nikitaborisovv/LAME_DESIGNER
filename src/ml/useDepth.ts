import { useEffect, useRef, useState } from "react";
import type { DepthFrame, DepthSmoothMode } from "../core/types";
import { perf } from "../core/perf";

export interface DepthCache {
  fps: number;
  frames: DepthFrame[];
}

export interface DepthSmoothing {
  mode: DepthSmoothMode;
  alpha: number;
  motionBoost: number;
  deadband: number; // доля 0..0.1
}

export type DepthApi = ReturnType<typeof useDepth>;

// Хук поднимает depth-воркер и даёт:
//  - submit(video): live-инференс текущего кадра (если воркер не занят)
//  - latestRef: последний live-результат
//  - device: живой статус
//  - bake(...): прогнать всё видео и сложить карты глубины в кеш (макс. качество)
//  - getCached(time): взять карту из кеша по времени видео (без инференса)
//  - hasCache / cacheCount
export function useDepth(
  enabled: boolean,
  resolution: number,
  smoothing: DepthSmoothing
) {
  const workerRef = useRef<Worker | null>(null);
  const busyRef = useRef(false);
  const bakingRef = useRef(false);
  const latestRef = useRef<DepthFrame | null>(null); // сырой live-результат
  const smoothedRef = useRef<DepthFrame | null>(null); // сглаженный — его читают потребители
  const liveCanvasRef = useRef<OffscreenCanvas | null>(null);
  const bakeCanvasRef = useRef<OffscreenCanvas | null>(null);
  const cacheRef = useRef<DepthCache | null>(null);
  const pendingRef = useRef<((f: DepthFrame) => void) | null>(null);
  const resRef = useRef(resolution);
  resRef.current = resolution;
  const submitTRef = useRef(0); // время отправки live-кадра (для roundtrip)
  const smRef = useRef(smoothing); // живые параметры сглаживания (без переподписки)
  smRef.current = smoothing;
  // состояние темпорального сглаживания (персистентно между кадрами глубины)
  const accRef = useRef<Float32Array | null>(null); // EMA-аккумулятор
  const accSizeRef = useRef("0x0");
  const medianHistRef = useRef<Uint8Array[]>([]); // последние сырые карты для медианы
  const [device, setDevice] = useState<string>("…");

  // Темпоральное сглаживание live-карты на частоте обновления глубины (дёшево).
  // EMA — motion-adaptive (alpha растёт там, где кадр реально изменился) + deadband.
  // median — поэлементная медиана последних 3 карт. Сброс при смене разрешения.
  function smoothFrame(latest: DepthFrame): DepthFrame {
    const p = smRef.current;
    if (p.mode === "off") { accRef.current = null; medianHistRef.current = []; return latest; }
    const key = `${latest.width}x${latest.height}`;
    if (accSizeRef.current !== key) {
      accRef.current = Float32Array.from(latest.data);
      accSizeRef.current = key;
      medianHistRef.current = [];
    }
    const n = latest.data.length;
    const src = latest.data;

    if (p.mode === "median") {
      const hist = medianHistRef.current;
      hist.push(src);
      if (hist.length > 3) hist.shift();
      if (hist.length < 3) return latest; // ещё мало кадров
      const [a, b, c] = hist;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const x = a[i], y = b[i], z = c[i];
        // медиана трёх без сортировки
        out[i] = Math.max(Math.min(x, y), Math.min(Math.max(x, y), z));
      }
      return { data: out, width: latest.width, height: latest.height };
    }

    // mode === "ema"
    const acc = accRef.current!;
    const base = p.alpha, boost = p.motionBoost, dead = p.deadband * 255;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const d = src[i];
      const delta = Math.abs(d - acc[i]);
      if (delta > dead) {
        const a = Math.min(1, base + (delta / 255) * boost);
        acc[i] = acc[i] * (1 - a) + d * a;
      }
      out[i] = (acc[i] + 0.5) | 0;
    }
    return { data: out, width: latest.width, height: latest.height };
  }

  useEffect(() => {
    if (!enabled) return;
    setDevice("запуск воркера…");
    const worker = new Worker(new URL("./depthWorker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "ready") setDevice(m.device);
      else if (m.type === "status") { if (!bakingRef.current) setDevice(m.text); }
      else if (m.type === "depth") {
        const frame: DepthFrame = { data: m.data, width: m.width, height: m.height };
        // во время запекания ответы идут в pending-резолвер, иначе — в latest
        if (pendingRef.current) {
          const r = pendingRef.current;
          pendingRef.current = null;
          r(frame);
        } else {
          latestRef.current = frame;
          perf.add("depth.infer", m.infMs);
          perf.add("depth.roundtrip", performance.now() - submitTRef.current);
          const endSm = perf.mark("depth.smooth");
          smoothedRef.current = smoothFrame(frame); // централизованное сглаживание
          endSm();
          perf.tick("depth.fps");
          busyRef.current = false;
        }
      } else if (m.type === "error") {
        console.error("[depth]", m.message);
        if (pendingRef.current) { const r = pendingRef.current; pendingRef.current = null; r({ data: new Uint8Array(1), width: 1, height: 1 }); }
        else { setDevice("ошибка ⚠"); busyRef.current = false; }
      }
    };
    worker.postMessage({ type: "init" });
    workerRef.current = worker;
    liveCanvasRef.current = new OffscreenCanvas(2, 2);
    bakeCanvasRef.current = new OffscreenCanvas(2, 2);
    return () => {
      worker.terminate();
      workerRef.current = null;
      busyRef.current = false;
      bakingRef.current = false;
      pendingRef.current = null;
      // сброс сглаживания — чтобы при перезапуске не тянуть старый аккумулятор
      accRef.current = null;
      accSizeRef.current = "0x0";
      medianHistRef.current = [];
      latestRef.current = null;
      smoothedRef.current = null;
    };
  }, [enabled]);

  function frameDims(video: HTMLVideoElement, long: number) {
    const ratio = video.videoWidth / video.videoHeight || 1;
    const tw = ratio >= 1 ? long : Math.round(long * ratio);
    const th = ratio >= 1 ? Math.round(long / ratio) : long;
    return [tw, th] as const;
  }

  // Live-инференс: даунскейл -> RGBA -> воркер (троттлинг по busy).
  function submit(video: HTMLVideoElement) {
    const w = workerRef.current;
    const canvas = liveCanvasRef.current;
    if (!w || !canvas || busyRef.current || bakingRef.current || video.readyState < 2) return;
    busyRef.current = true;
    try {
      const [tw, th] = frameDims(video, resRef.current);
      canvas.width = tw; canvas.height = th;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const endRb = perf.mark("depth.readback");
      ctx.drawImage(video, 0, 0, tw, th);
      const img = ctx.getImageData(0, 0, tw, th);
      endRb();
      submitTRef.current = performance.now();
      w.postMessage({ type: "frame", data: img.data, width: tw, height: th }, [img.data.buffer]);
    } catch {
      busyRef.current = false;
    }
  }

  // Один инференс с ожиданием результата (для запекания, последовательно).
  function inferOnce(img: ImageData): Promise<DepthFrame> {
    return new Promise((resolve) => {
      const w = workerRef.current;
      if (!w) return resolve({ data: new Uint8Array(1), width: 1, height: 1 });
      pendingRef.current = resolve;
      w.postMessage({ type: "frame", data: img.data, width: img.width, height: img.height }, [img.data.buffer]);
    });
  }

  function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
    return new Promise((res) => {
      if (Math.abs(video.currentTime - t) < 1e-3) return res();
      let done = false;
      const finish = () => { if (done) return; done = true; video.removeEventListener("seeked", finish); res(); };
      video.addEventListener("seeked", finish);
      video.currentTime = t;
      // фолбэк, если seeked не стрельнул
      setTimeout(finish, 1500);
    });
  }

  // Запечь глубину всего видео в кеш. resolution — «максимальный размер».
  async function bake(
    video: HTMLVideoElement,
    cacheRes: number,
    cacheFps: number
  ): Promise<number> {
    const w = workerRef.current;
    if (!w || bakingRef.current) return 0;
    const dur = video.duration;
    if (!isFinite(dur) || dur <= 0) return 0;

    bakingRef.current = true;
    const wasPlaying = !video.paused;
    video.pause();

    const [tw, th] = frameDims(video, cacheRes);
    const canvas = bakeCanvasRef.current!;
    canvas.width = tw; canvas.height = th;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    const n = Math.max(1, Math.floor(dur * cacheFps));
    const frames: DepthFrame[] = [];
    for (let i = 0; i < n; i++) {
      const t = Math.min((i + 0.5) / cacheFps, dur - 1e-3);
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, tw, th);
      const img = ctx.getImageData(0, 0, tw, th);
      const frame = await inferOnce(img);
      frames.push(frame);
      setDevice(`запекание ${Math.round(((i + 1) / n) * 100)}%`);
    }

    cacheRef.current = { fps: cacheFps, frames };
    bakingRef.current = false;
    if (wasPlaying) video.play().catch(() => {});
    setDevice(`кеш готов: ${frames.length} кадров`);
    return frames.length;
  }

  // Экспорт/импорт кеша (для сохранения в IndexedDB и восстановления).
  function exportCache(): DepthCache | null {
    return cacheRef.current;
  }
  function importCache(cache: DepthCache): void {
    cacheRef.current = cache;
    setDevice(`кеш загружен: ${cache.frames.length} кадров`);
  }

  function getCached(time: number): DepthFrame | null {
    const c = cacheRef.current;
    if (!c || !c.frames.length) return null;
    let i = Math.round(time * c.fps);
    i = Math.max(0, Math.min(c.frames.length - 1, i));
    return c.frames[i] ?? null;
  }

  return {
    submit,
    latestRef,
    smoothedRef,
    device,
    bake,
    getCached,
    exportCache,
    importCache,
    hasCache: () => !!cacheRef.current,
    cacheCount: () => cacheRef.current?.frames.length ?? 0,
    bakingRef,
  };
}
