import { useEffect, useRef } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { Hand, HandGesture, HandLandmark, HandResult } from "../core/types";
import { computePose, classifyGesture } from "./handModel";
import { newEuroState, oneEuro, type EuroState, type OneEuroParams } from "../ui/oneEuro";
import { perf } from "../core/perf";

// Трекинг рук через MediaPipe HandLandmarker (локальные wasm+модель из /public/mediapipe).
// Самостоятельный слой: работает на основном потоке, но вызывается НЕ из useFrame, а из
// покадрового колбэка с троттлингом — тяжёлый рендер-шейдер не блокируется. Сглаживание
// One Euro по handedness (личность руки стабильна, рук максимум две). Поза/жест считаются
// чистыми функциями из handModel; дебаунс жеста — здесь (требует состояния между кадрами).
//
// ПРИМЕЧАНИЕ: попытка вынести в Web Worker (handsWorker) упёрлась в несовместимость
// MediaPipe + Vite-dev: в ES-воркере FilesetResolver динамически import()'ит wasm-загрузчик,
// Vite отдаёт его как `...vision_wasm_internal.js?import` (ES-модуль) и fetch падает
// (issue #5292). Классический воркер не подходит — он не может top-level import пакета.
// Поэтому MediaPipe-детекторы пока на главном потоке; их не-блокировку решает планировщик
// (core/scheduler) + троттлинг. См. ARCHITECTURE.md §4.

// Дебаунс жеста: сырая классификация дрожит на границах поз. Кандидат должен
// продержаться N кадров подряд, прежде чем станет «зафиксированным».
const GESTURE_DEBOUNCE = 3;

// Состояние одной руки между кадрами: фильтры на каждый канал (21×3 норм. + 21×3 world)
// и дебаунс жеста. Ключ — handedness ("Left"/"Right").
interface HandState {
  norm: EuroState[]; // 63 канала: x,y,z по 21 точке (экранные норм.)
  world: EuroState[]; // 63 канала: x,y,z по 21 точке (метрические)
  gCand: HandGesture; // текущий кандидат жеста
  gCount: number; // сколько кадров кандидат держится
  gCommit: HandGesture; // зафиксированный (выдаваемый) жест
}

const newHandState = (): HandState => ({
  norm: Array.from({ length: 63 }, newEuroState),
  world: Array.from({ length: 63 }, newEuroState),
  gCand: "none",
  gCount: 0,
  gCommit: "none",
});

// smooth 0..1 -> параметры One Euro. На 0 фильтр почти прозрачен (высокий minCutoff),
// на 1 — сильно гасит дрожь (низкий minCutoff). beta держим небольшой, чтобы быстрые
// движения не лагали.
function smoothParams(smooth: number): OneEuroParams {
  const s = smooth < 0 ? 0 : smooth > 1 ? 1 : smooth;
  return { minCutoff: 3.0 - 2.7 * s, beta: 0.007, dCutoff: 1 };
}

// Сгладить массив 21 точки in-place через набор EuroState (3 канала на точку).
function smoothPoints(pts: HandLandmark[], st: EuroState[], dt: number, p: OneEuroParams): HandLandmark[] {
  const out: HandLandmark[] = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const b = i * 3;
    out[i] = {
      x: oneEuro(st[b], pts[i].x, dt, p),
      y: oneEuro(st[b + 1], pts[i].y, dt, p),
      z: oneEuro(st[b + 2], pts[i].z, dt, p),
    };
  }
  return out;
}

export function useHands(
  enabled: boolean,
  maxHands: number,
  gesturesEnabled: boolean,
  smooth: number,
  mirror: boolean
) {
  const resultRef = useRef<HandResult>({ hands: [] });
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const readyRef = useRef(false);
  const lastTsRef = useRef(0);
  const statesRef = useRef<Map<string, HandState>>(new Map());

  // живые значения для submit без пересоздания замыкания
  const cfgRef = useRef({ gesturesEnabled, smooth, mirror });
  cfgRef.current = { gesturesEnabled, smooth, mirror };

  useEffect(() => {
    if (!enabled) {
      resultRef.current = { hands: [] };
      statesRef.current.clear();
      return;
    }
    let cancelled = false;
    let landmarker: HandLandmarker | null = null;

    (async () => {
      const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      if (cancelled) return;
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: "/mediapipe/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: maxHands,
      });
      if (cancelled) {
        landmarker.close();
        return;
      }
      landmarkerRef.current = landmarker;
      readyRef.current = true;
    })().catch((e) => console.error("[hands] init", e));

    return () => {
      cancelled = true;
      readyRef.current = false;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
      resultRef.current = { hands: [] };
      statesRef.current.clear();
    };
  }, [enabled, maxHands]);

  // tsMs — DOMHighResTimeStamp из покадрового колбэка (монотонный, нужен MediaPipe).
  // Возвращает true, если инференс реально отработал в этом кадре (для стаггеринга с лицами).
  function submit(video: HTMLVideoElement, tsMs: number): boolean {
    const lm = landmarkerRef.current;
    if (!readyRef.current || !lm || video.readyState < 2) return false;
    if (tsMs - lastTsRef.current < 22) return false; // до ~45 fps
    const prev = lastTsRef.current;
    let ts = tsMs;
    if (ts <= prev) ts = prev + 1;
    const dt = prev > 0 ? (ts - prev) / 1000 : 1 / 30;
    lastTsRef.current = ts;

    const { gesturesEnabled: wantG, smooth: sm, mirror: mir } = cfgRef.current;
    const p = smoothParams(sm);

    const endDetect = perf.mark("hands.detect");
    try {
      const r = lm.detectForVideo(video, ts);
      const hands: Hand[] = [];
      const seen = new Set<string>();

      const n = r.landmarks?.length ?? 0;
      for (let h = 0; h < n; h++) {
        const norm = r.landmarks[h];
        const world = r.worldLandmarks?.[h] ?? norm;
        // MediaPipe отдаёт handedness по картинке (не зеркалёной); в селфи-режиме
        // лейбл инвертируем, чтобы совпадал с тем, что видит пользователь.
        const cat = r.handedness?.[h]?.[0];
        const rawLabel: "Left" | "Right" = cat?.categoryName === "Left" ? "Left" : "Right";
        const label: "Left" | "Right" = mir ? (rawLabel === "Left" ? "Right" : "Left") : rawLabel;
        const score = cat?.score ?? 0;

        // зеркалирование экранных координат (world не трогаем — углы остаются физичными)
        let nPts: HandLandmark[] = norm.map((pt) => ({
          x: mir ? 1 - pt.x : pt.x,
          y: pt.y,
          z: pt.z,
        }));
        let wPts: HandLandmark[] = world.map((pt) => ({ x: pt.x, y: pt.y, z: pt.z }));

        // сглаживание по личности руки
        let state = statesRef.current.get(label);
        if (!state) {
          state = newHandState();
          statesRef.current.set(label, state);
        }
        seen.add(label);
        nPts = smoothPoints(nPts, state.norm, dt, p);
        wPts = smoothPoints(wPts, state.world, dt, p);

        const pose = computePose(nPts, wPts);
        let gesture: HandGesture = "none";
        if (wantG) {
          const raw = classifyGesture(wPts, pose);
          if (raw === state.gCand) {
            state.gCount++;
          } else {
            state.gCand = raw;
            state.gCount = 1;
          }
          if (state.gCount >= GESTURE_DEBOUNCE) state.gCommit = state.gCand;
          gesture = state.gCommit;
        } else {
          state.gCommit = "none";
        }

        hands.push({ handedness: label, score, landmarks: nPts, worldLandmarks: wPts, pose, gesture });
      }

      // забыть состояние исчезнувших рук (иначе при возврате прилетит лаг от старого фильтра)
      for (const key of statesRef.current.keys()) {
        if (!seen.has(key)) statesRef.current.delete(key);
      }

      resultRef.current = { hands };
      perf.tick("hands.fps");
    } catch (e) {
      void e; // detectForVideo иногда кидает на первом кадре/ресайзе — пропускаем
    }
    endDetect();
    return true;
  }

  return { submit, resultRef };
}
