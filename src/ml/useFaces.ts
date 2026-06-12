import { useEffect, useRef } from "react";
import {
  FilesetResolver,
  FaceDetector,
  FaceLandmarker,
} from "@mediapipe/tasks-vision";
import type { FaceBox, FaceMesh, FaceResult } from "../core/types";
import { perf } from "../core/perf";

// Детекция лиц через MediaPipe (локальные wasm+модели из /public/mediapipe).
// Работает на основном потоке, но вызывается НЕ из useFrame, а из покадрового
// колбэка с троттлингом ~20 fps — тяжёлый рендер-шейдер не блокируется.
export function useFaces(
  enabled: boolean,
  wantBoxes: boolean,
  wantMesh: boolean,
  maxFaces: number
) {
  const resultRef = useRef<FaceResult>({ boxes: [], meshes: [] });
  const detectorRef = useRef<FaceDetector | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const edgesRef = useRef<number[]>([]);
  const readyRef = useRef(false);
  const lastTsRef = useRef(0);
  const turnRef = useRef(0); // чередование детектор/ландмаркер по кадрам (когда активны оба)

  useEffect(() => {
    if (!enabled || (!wantBoxes && !wantMesh)) {
      resultRef.current = { boxes: [], meshes: [] };
      return;
    }
    let cancelled = false;
    let detector: FaceDetector | null = null;
    let landmarker: FaceLandmarker | null = null;

    (async () => {
      const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      if (cancelled) return;

      if (wantBoxes) {
        detector = await FaceDetector.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: "/mediapipe/face_detector.tflite",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
        });
      }
      if (wantMesh) {
        landmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: "/mediapipe/face_landmarker.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numFaces: maxFaces,
        });
        // Плоский список рёбер из контуров (овал лица, глаза, брови, губы, радужки).
        const conn = (FaceLandmarker as unknown as {
          FACE_LANDMARKS_CONTOURS: { start: number; end: number }[];
        }).FACE_LANDMARKS_CONTOURS;
        const flat: number[] = [];
        for (const c of conn) flat.push(c.start, c.end);
        edgesRef.current = flat;
      }

      if (cancelled) {
        detector?.close();
        landmarker?.close();
        return;
      }
      detectorRef.current = detector;
      landmarkerRef.current = landmarker;
      readyRef.current = true;
    })().catch((e) => console.error("[faces] init", e));

    return () => {
      cancelled = true;
      readyRef.current = false;
      detectorRef.current?.close();
      landmarkerRef.current?.close();
      detectorRef.current = null;
      landmarkerRef.current = null;
      resultRef.current = { boxes: [], meshes: [] };
    };
  }, [enabled, wantBoxes, wantMesh, maxFaces]);

  // tsMs — DOMHighResTimeStamp из покадрового колбэка (нужен MediaPipe, монотонный).
  // Возвращает true, если детект реально отработал в этом кадре (съел main-thread время) —
  // вызывающий использует это для стаггеринга (не запускать другие тяжёлые операции тем же кадром).
  function submit(video: HTMLVideoElement, tsMs: number): boolean {
    if (!readyRef.current || video.readyState < 2) return false;
    if (tsMs - lastTsRef.current < 22) return false; // до ~45 fps — сетка должна успевать за лицом
    let ts = tsMs;
    if (ts <= lastTsRef.current) ts = lastTsRef.current + 1;
    lastTsRef.current = ts;

    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const det = detectorRef.current;
    const lm = landmarkerRef.current;

    // Профиль: faces.detect — крупнейший пожиратель main-thread, и при box+mesh это ДВА
    // синхронных detectForVideo за кадр (~2× цена). Чередуем: один тяжёлый вызов на кадр.
    // Результат другой ветки сохраняем с прошлого кадра — оверлей всё равно сглаживает.
    // Сетка (landmarker) — ПРИОРИТЕТ: бежит КАЖДЫЙ кадр, чтобы «прилипала» к лицу как в
    // снепчате (лаг убивает эффект). Боксы (detector) — реже (каждый 3-й вызов), они терпимы
    // к лагу. dev __noFacesAlt форсит оба каждый кадр (для A/B-замеров).
    const forceBoth = import.meta.env.DEV && (globalThis as any).__noFacesAlt;
    const runLm = !!lm;
    const runDet = !!det && (!lm || forceBoth || (turnRef.current % 3 === 0));
    turnRef.current++;

    let boxes = resultRef.current.boxes;
    let meshes = resultRef.current.meshes;

    const endDetect = perf.mark("faces.detect"); // GPU-delegate, но синхронный вызов на main-thread
    try {
      if (runDet) {
        boxes = [];
        const r = det!.detectForVideo(video, ts);
        for (const d of r.detections) {
          const bb = d.boundingBox;
          if (!bb) continue;
          boxes.push({
            x: bb.originX / vw,
            y: bb.originY / vh,
            w: bb.width / vw,
            h: bb.height / vh,
            score: d.categories?.[0]?.score ?? 0,
            keypoints: (d.keypoints ?? []).map((k) => ({ x: k.x, y: k.y })),
          });
        }
      }
      if (runLm) {
        meshes = [];
        const r = lm!.detectForVideo(video, ts);
        for (const face of r.faceLandmarks) {
          meshes.push({
            points: face.map((p) => ({ x: p.x, y: p.y })),
            edges: edgesRef.current,
          });
        }
      }
      resultRef.current = { boxes, meshes };
      perf.tick("faces.fps");
    } catch (e) {
      // detectForVideo иногда кидает на первом кадре/ресайзе — просто пропускаем кадр
      void e;
    }
    endDetect();
    return true;
  }

  return { submit, resultRef };
}
