import { useEffect, useRef, useState } from "react";
import type { PeopleFrame } from "../core/types";
import type { SharedFrame } from "./useFrameGrab";
import { perf } from "../core/perf";

export interface PeopleParams {
  input: number;
  conf: number;
  maskThreshold: number;
  iou: number;
  smooth: number; // 0..0.9 темпоральная EMA маски (гасит «ступеньки» между кадрами инференса)
}

export type PeopleApi = ReturnType<typeof usePeople>;

// Мост к воркеру сегментации людей. submit(video) делает letterbox в квадрат INPUT×INPUT
// на основном потоке (canvas) и шлёт RGBA в воркер; busy-троттлинг как у глубины.
// latestRef хранит последнюю маску + линейный маппинг для обратного letterbox в шейдере.
export function usePeople(enabled: boolean, params: PeopleParams) {
  const workerRef = useRef<Worker | null>(null);
  const busyRef = useRef(false);
  const latestRef = useRef<PeopleFrame | null>(null);
  const canvasRef = useRef<OffscreenCanvas | null>(null);
  const cfgRef = useRef(params);
  cfgRef.current = params;
  // если модель ждёт фиксированный вход (≠ ползунка) — воркер подскажет, и мы переопределим
  const overrideInputRef = useRef<number | null>(null);
  // параметры letterbox последнего отправленного кадра (для маппинга результата)
  const pendRef = useRef<{ scale: number; padX: number; padY: number; vw: number; vh: number; input: number } | null>(null);
  const submitTRef = useRef(0); // время отправки кадра (для roundtrip)
  const accRef = useRef<Float32Array | null>(null); // EMA-аккумулятор RGBA-маски (темпоральная стабилизация)
  const [device, setDevice] = useState<string>("…");

  useEffect(() => {
    if (!enabled) {
      latestRef.current = null;
      return;
    }
    setDevice("запуск воркера…");
    let readyDevice = "…"; // имя EP — чтобы вернуть статус после самолечения входа
    let transient = false; // показан временный статус (ошибка/подбор) — снять при первом успехе
    const worker = new Worker(new URL("./peopleWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "ready") { readyDevice = m.device; setDevice(m.device); transient = false; }
      else if (m.type === "status") setDevice(m.text);
      else if (m.type === "people") {
        const p = pendRef.current;
        if (p) {
          // mul/off: video_uv (y-down) -> mask_uv. denom = INPUT (=maskScale*protoW)
          const mul: [number, number] = [(p.vw * p.scale) / p.input, (p.vh * p.scale) / p.input];
          const off: [number, number] = [p.padX / p.input, p.padY / p.input];
          // темпоральная EMA: гасит «ступеньки» маски между редкими кадрами инференса
          const s = Math.max(0, Math.min(0.9, cfgRef.current.smooth || 0));
          let data: Uint8Array = m.data;
          if (s > 0) {
            const n = m.data.length;
            let acc = accRef.current;
            if (!acc || acc.length !== n) { acc = Float32Array.from(m.data); accRef.current = acc; }
            const out = new Uint8Array(n);
            for (let i = 0; i < n; i++) { const v = acc[i] * s + m.data[i] * (1 - s); acc[i] = v; out[i] = v | 0; }
            data = out;
          }
          // боксы: INPUT-координаты -> нормированные видео (обратный letterbox)
          const nw = p.vw * p.scale, nh = p.vh * p.scale;
          const boxes = ((m.boxes ?? []) as { x1: number; y1: number; x2: number; y2: number; score: number }[]).map((b) => ({
            x: (b.x1 - p.padX) / nw,
            y: (b.y1 - p.padY) / nh,
            w: (b.x2 - b.x1) / nw,
            h: (b.y2 - b.y1) / nh,
            score: b.score,
          }));
          latestRef.current = { data, width: m.width, height: m.height, mul, off, count: m.count, boxes };
        }
        perf.add("people.run", m.runMs);
        perf.add("people.post", m.postMs);
        perf.add("people.roundtrip", performance.now() - submitTRef.current);
        perf.tick("people.fps");
        if (transient) { transient = false; setDevice(readyDevice); } // успех -> снять временный статус
        busyRef.current = false;
      } else if (m.type === "inputHint") {
        overrideInputRef.current = m.input; // модель ждёт именно этот размер входа
        transient = true;
        setDevice(`подбираю вход ${m.input}…`);
      } else if (m.type === "error") {
        console.error("[people]", m.message);
        // если уже есть подсказка по входу — это переходная ошибка самолечения, не пугаем «ошибкой»
        if (!overrideInputRef.current) { transient = true; setDevice("ошибка ⚠"); }
        busyRef.current = false;
      }
    };
    worker.postMessage({ type: "init" });
    workerRef.current = worker;
    canvasRef.current = new OffscreenCanvas(2, 2);
    busyRef.current = false;
    return () => {
      worker.terminate();
      workerRef.current = null;
      busyRef.current = false;
      pendRef.current = null;
      latestRef.current = null;
      overrideInputRef.current = null;
      accRef.current = null;
    };
  }, [enabled]);

  function submit(frame: SharedFrame) {
    const w = workerRef.current;
    const canvas = canvasRef.current;
    if (!w || !canvas || busyRef.current) return;
    const vw = frame.w, vh = frame.h;
    if (!vw || !vh) return;
    busyRef.current = true;
    try {
      const { conf, maskThreshold, iou } = cfgRef.current;
      const input = overrideInputRef.current ?? cfgRef.current.input;
      // letterbox: вписать кадр в квадрат INPUT с паддингами на чёрном фоне
      const scale = Math.min(input / vw, input / vh);
      const nw = vw * scale, nh = vh * scale;
      const padX = (input - nw) / 2, padY = (input - nh) / 2;
      canvas.width = input; canvas.height = input;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const endRb = perf.mark("people.readback");
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, input, input);
      ctx.drawImage(frame.source, padX, padY, nw, nh);
      const img = ctx.getImageData(0, 0, input, input);
      endRb();
      submitTRef.current = performance.now();
      pendRef.current = { scale, padX, padY, vw, vh, input };
      w.postMessage(
        { type: "frame", data: img.data, input, conf, maskThreshold, iouThr: iou },
        [img.data.buffer]
      );
    } catch {
      busyRef.current = false;
    }
  }

  return { submit, latestRef, device };
}
