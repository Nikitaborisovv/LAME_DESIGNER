// Kinect как ТРЕТИЙ ВХОД (файл / телефон / Kinect). Транспорт-хук по образцу
// useCameraStream: коннект к хост-мосту по WebSocket, приём RGB-кадров (→ canvas →
// captureStream → MediaStream, тот же путь, что VideoSource.loadStream) и depth-кадров
// (uint16 мм → grayscale DepthFrame). Глубина «следует за входом»: при kinect рендер
// берёт depth отсюда вместо нейро-useDepth (см. depthRouter).
//
// БЕЗ Kinect/моста тестируется на МОКЕ: синтетический RGB (двигающийся круг) + синтетическая
// depth (бугор по центру). Мок гоняет тот же mm→grayscale конверт, что и реальный мост.
//
// depth-объект структурно совместим с DepthApi (обёртка): рендер не отличает источник.
// cache/bake — заглушки (осмысленны только для нейро-источника).

import { useEffect, useRef, useState } from "react";
import type { DepthFrame } from "../core/types";
import type { DepthApi, DepthCache } from "../ml/useDepth";
import { perf } from "../core/perf";
import { KINECT_TAG_RGB, parseDepthFrame } from "./kinectProtocol";

export type KinectStatus = "idle" | "mock" | "connecting" | "waiting" | "connected" | "error";

// Обработка сырого depth-сигнала Kinect (uint16 мм) -> grayscale для рендера.
export interface KinectDepthOpts {
  nearMm: number;   // фиксированный ближний порог (мм), ярко
  farMm: number;    // фиксированный дальний порог (мм), темно
  auto: boolean;    // адаптивно растягивать фактический min/max сцены (вместо near/far)
  smooth: number;   // 0..0.95 — EMA-сглаживание + темпоральное заполнение дыр
  holeFill: boolean; // держать прошлое значение в пикселях-дырах (0 мм), иначе 0
}

export interface KinectOptions {
  mock: boolean;
  host: string;
  port: number;
  depth: KinectDepthOpts;
}

export interface KinectApi {
  stream: MediaStream | null; // RGB → VideoSource.loadStream
  depth: DepthApi; // depth-провайдер (обёртка под контракт DepthApi)
  status: KinectStatus;
  error: string | null;
}

const MOCK_RGB_W = 640;
const MOCK_RGB_H = 480;
const MOCK_DEPTH_W = 256;
const MOCK_DEPTH_H = 192;
const STREAM_FPS = 30;

export function useKinect(active: boolean, opts: KinectOptions): KinectApi {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<KinectStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<string>("…");

  // depth-рефы живут весь lifetime хука (переживают реконнект/смену мок↔реал).
  const latestRef = useRef<DepthFrame | null>(null);
  const smoothedRef = useRef<DepthFrame | null>(null);

  // Состояние обработки глубины (персистентно между кадрами): EMA-аккумулятор в мм
  // и сглаженные границы нормализации (чтобы авто-стрейч не «пампил» яркость).
  const accRef = useRef<Float32Array | null>(null);
  const accSizeRef = useRef("0x0");
  const normLoRef = useRef(500);
  const normHiRef = useRef(4000);

  // Живые объекты транспорта — в ref, чистим в teardown.
  const wsRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  const bakingRef = useRef(false); // всегда false — у Kinect нет запекания (для контракта DepthApi)

  // Свежие настройки без переподписки эффекта (host/port/mock читаются на старте).
  const optsRef = useRef(opts);
  optsRef.current = opts;

  function setDepth(frame: DepthFrame) {
    latestRef.current = frame;
    smoothedRef.current = frame;
    perf.tick("depth.fps");
  }

  // Сырой Kinect-depth (uint16 мм) -> grayscale DepthFrame с обработкой:
  //  1) EMA-сглаживание + темпоральное заполнение дыр (пиксель 0 мм держит прошлое значение);
  //  2) нормализация: либо фиксированный near/far, либо адаптивный растяг min/max сцены (ближе=ярче).
  function processDepth(mm: Uint16Array, w: number, h: number) {
    const d = optsRef.current.depth;
    const n = w * h;
    const key = `${w}x${h}`;
    if (accSizeRef.current !== key || !accRef.current || accRef.current.length !== n) {
      accRef.current = Float32Array.from(mm);
      accSizeRef.current = key;
      normLoRef.current = d.nearMm;
      normHiRef.current = d.farMm;
    }
    const acc = accRef.current;
    const s = Math.max(0, Math.min(0.95, d.smooth));
    for (let i = 0; i < n; i++) {
      const v = mm[i];
      if (v > 0) acc[i] = s > 0 && acc[i] > 0 ? acc[i] * s + v * (1 - s) : v;
      else if (!d.holeFill) acc[i] = 0; // дыру не держим
      // holeFill && v===0 -> оставляем acc[i] (темпоральное заполнение)
    }

    let lo: number, hi: number;
    if (d.auto) {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < n; i++) { const a = acc[i]; if (a > 0) { if (a < mn) mn = a; if (a > mx) mx = a; } }
      if (mn === Infinity) { mn = d.nearMm; mx = d.farMm; }
      if (mx - mn < 1) mx = mn + 1;
      normLoRef.current = normLoRef.current * 0.9 + mn * 0.1; // сглаживаем границы
      normHiRef.current = normHiRef.current * 0.9 + mx * 0.1;
      lo = normLoRef.current; hi = normHiRef.current;
    } else {
      lo = d.nearMm; hi = d.farMm;
    }

    const span = (hi - lo) || 1;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const a = acc[i];
      if (a <= 0) { out[i] = 0; continue; }
      const t = (hi - a) / span; // ближе=ярче
      out[i] = t <= 0 ? 0 : t >= 1 ? 255 : ((t * 255 + 0.5) | 0);
    }
    setDepth({ data: out, width: w, height: h });
  }

  useEffect(() => {
    if (!active) {
      setStatus("idle");
      setDevice("…");
      return;
    }
    const o = optsRef.current;
    let closed = false;
    setError(null);

    // RGB-холст + поток: общий для мока и реального моста.
    const canvas = document.createElement("canvas");
    canvas.width = MOCK_RGB_W;
    canvas.height = MOCK_RGB_H;
    canvasRef.current = canvas;
    const ctx = canvas.getContext("2d")!;
    const capture = (canvas as HTMLCanvasElement).captureStream(STREAM_FPS);
    setStream(capture);

    if (o.mock) {
      // ---- МОК: рисуем синтетический RGB и синтетическую глубину на rAF ----
      setStatus("mock");
      setDevice("kinect: мок");
      let t = 0;
      const mm = new Uint16Array(MOCK_DEPTH_W * MOCK_DEPTH_H);
      const loop = () => {
        if (closed) return;
        t += 0.016;
        // RGB: градиент-фон + двигающийся круг + подпись.
        const cx = (0.5 + 0.35 * Math.sin(t)) * MOCK_RGB_W;
        const cy = (0.5 + 0.25 * Math.cos(t * 0.8)) * MOCK_RGB_H;
        const g = ctx.createLinearGradient(0, 0, 0, MOCK_RGB_H);
        g.addColorStop(0, "#0a1026");
        g.addColorStop(1, "#04263a");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, MOCK_RGB_W, MOCK_RGB_H);
        const grd = ctx.createRadialGradient(cx, cy, 8, cx, cy, 120);
        grd.addColorStop(0, "#ffd23c");
        grd.addColorStop(1, "rgba(255,210,60,0)");
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(cx, cy, 120, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#39ff8b";
        ctx.font = "bold 28px monospace";
        ctx.fillText("KINECT MOCK", 18, 40);

        // depth: фон 3000мм, бугор (ближе, до ~700мм) под кругом — даёт 3D-выступ в облаке.
        const dcx = (cx / MOCK_RGB_W) * MOCK_DEPTH_W;
        const dcy = (cy / MOCK_RGB_H) * MOCK_DEPTH_H;
        const r = 48;
        for (let y = 0; y < MOCK_DEPTH_H; y++) {
          for (let x = 0; x < MOCK_DEPTH_W; x++) {
            const dx = x - dcx, dy = y - dcy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const bump = dist < r ? Math.cos((dist / r) * (Math.PI / 2)) : 0; // 1 в центре → 0 к краю
            mm[y * MOCK_DEPTH_W + x] = Math.round(3000 - bump * 2300); // 3000мм фон, 700мм пик
          }
        }
        processDepth(mm, MOCK_DEPTH_W, MOCK_DEPTH_H);
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);

      return () => {
        closed = true;
        cancelAnimationFrame(rafRef.current);
        capture.getTracks().forEach((tr) => tr.stop());
        canvasRef.current = null;
        setStream(null);
        setStatus("idle");
      };
    }

    // ---- РЕАЛЬНЫЙ МОСТ: WebSocket к ws://host:port ----
    setStatus("connecting");
    setDevice("kinect: коннект…");
    const url = `ws://${o.host}:${o.port}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setStatus("error");
      setError("не удалось открыть " + url + ": " + String(e));
      return () => {
        capture.getTracks().forEach((tr) => tr.stop());
        setStream(null);
      };
    }
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => { if (!closed) { setStatus("waiting"); setDevice("kinect: ждём кадры…"); } };
    ws.onerror = () => { if (!closed) { setStatus("error"); setError("мост недоступен: " + url); } };
    ws.onclose = () => { if (!closed) { setStatus("idle"); setDevice("kinect: отключён"); } };

    ws.onmessage = async (ev) => {
      if (closed) return;
      // ТЕКСТ → JSON-meta (hello). БИНАРЬ → кадр (depth/rgb).
      if (typeof ev.data === "string") {
        try {
          const m = JSON.parse(ev.data);
          if (m.t === "hello") { setStatus("connected"); setDevice(`kinect: ${m.model ?? "v1"} ${m.w}×${m.h}`); }
        } catch { /* не JSON — игнор */ }
        return;
      }
      const buf = ev.data as ArrayBuffer;
      const tag = new DataView(buf).getUint8(0);
      if (tag === KINECT_TAG_RGB) {
        try {
          const bmp = await createImageBitmap(new Blob([new Uint8Array(buf, 1)]));
          if (closed) { bmp.close(); return; }
          ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
          bmp.close();
          if (status !== "connected") setStatus("connected");
        } catch { /* битый кадр — пропускаем */ }
      } else {
        const msg = parseDepthFrame(buf);
        if (msg) {
          processDepth(msg.mm, msg.width, msg.height);
          if (status !== "connected") setStatus("connected");
        }
      }
    };

    return () => {
      closed = true;
      cancelAnimationFrame(rafRef.current);
      try { ws.close(); } catch { /* ignore */ }
      wsRef.current = null;
      capture.getTracks().forEach((tr) => tr.stop());
      canvasRef.current = null;
      setStream(null);
      setStatus("idle");
    };
  }, [active, opts.mock, opts.host, opts.port]);

  // depth-объект в форме DepthApi (обёртка). Заглушки cache/bake — у аппаратной глубины нет запекания.
  const depth: DepthApi = {
    submit: () => { /* аппаратная глубина приходит из сети, инференс не нужен */ },
    latestRef,
    smoothedRef,
    device,
    bake: async () => 0,
    getCached: () => null,
    exportCache: (): DepthCache | null => null,
    importCache: () => { /* нет кеша у Kinect */ },
    hasCache: () => false,
    cacheCount: () => 0,
    bakingRef,
  };

  return { stream, depth, status, error };
}
