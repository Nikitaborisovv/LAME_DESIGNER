// Продюсер splat-маски (конвертер PointSet -> Map2D, §2.4). Для каждого включённого splat-эффекта
// берёт точки его источника (DataBus) и растеризует формы в offscreen-Canvas2D (в video-нормированном
// пространстве: канвас = кадр, без letterbox). Канвас обёрнут THREE.CanvasTexture и публикуется через
// общий SplatApi-реф; видео-шейдер (FlatView/flatShader uSplat) композитит его (overlay / альфа видео).
//
// Не в DOM (offscreen) — отрисовка не видна как оверлей; результат уходит в GPU как маска (§0.2:
// один аплоад текстуры/кадр, малый N точек). Композит-режим берётся из ПЕРВОГО splat-эффекта.

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { EffectNode, HandResult, VisionResult, FaceResult, PeopleFrame, SceneConfig, OpNode } from "../core/types";
import type { DepthApi } from "../ml/useDepth";
import type { AudioBands } from "../ml/useAudio";
import { fieldForLayerId, resolveProducerMaps, type PointResultRefs } from "../core/pointSources";
import { LAYER_DEFS } from "../core/layerRegistry";
import { computeDrivers, drivenValue, compileFieldFn } from "../core/drivers";
import { drawSplats, toSplatSettings, type SplatSettings } from "./renderSplat";

export interface SplatState { tex: THREE.Texture; on: boolean; mode: number; } // mode: 0 overlay, 1 alpha
export interface SplatApi { ref: React.MutableRefObject<SplatState | null>; }

// Привязки size/opacity к драйверам (без темпорального сглаживания — слайс; smooth — на будущее).
function applyBindings(s: SplatSettings, e: EffectNode, drivers: ReturnType<typeof computeDrivers>) {
  const b = e.bindings;
  if (!b) return;
  if (b.size && b.size.driver !== "none") s.size = drivenValue(b.size, drivers);
  if (b.opacity && b.opacity.driver !== "none") s.opacity = drivenValue(b.opacity, drivers);
}

export function SplatMask({
  effects, splatRef, handsRef, motionRef, facesRef, peopleRef, audioRef, video, config, depth, opNodes,
}: {
  effects: EffectNode[];
  splatRef: React.MutableRefObject<SplatState | null>;
  handsRef: React.MutableRefObject<HandResult>;
  motionRef: React.MutableRefObject<VisionResult>;
  facesRef: React.MutableRefObject<FaceResult>;
  peopleRef: React.MutableRefObject<PeopleFrame | null>;
  audioRef?: { current: AudioBands | null };  // аудио-сигналы (T-Beauty)
  video: HTMLVideoElement | null;
  config: SceneConfig;          // T0c: резолвнутые продюсеры (config.producers) для адресации source
  depth?: DepthApi;             // Map2D-вход для scatter/sample-источников splat
  opNodes?: OpNode[];           // Math-цепочки для setAttr-сигналов источников
}) {
  const effectsRef = useRef(effects);
  effectsRef.current = effects;
  const videoRef = useRef(video);
  videoRef.current = video;
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const depthRef = useRef(depth);
  depthRef.current = depth;
  const opsRef = useRef(opNodes);
  opsRef.current = opNodes;
  const audioRefRef = useRef(audioRef);
  audioRefRef.current = audioRef;

  const splats = effects.filter((e) => e.kind === "splat");
  const active = splats.some((e) => e.enabled);

  // Offscreen-канвас + CanvasTexture живут весь срок монтирования (пересоздаём при потере контекста нет).
  const cv = useMemo(() => document.createElement("canvas"), []);
  const tex = useMemo(() => {
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    return t;
  }, [cv]);

  useEffect(() => () => { tex.dispose(); }, [tex]);

  useEffect(() => {
    if (!active) { splatRef.current = null; return; }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let raf = 0;

    const draw = () => {
      const v = videoRef.current;
      if (!v || !v.videoWidth) { raf = requestAnimationFrame(draw); return; }
      // канвас = кадр в video-нормированном пространстве (max сторона 640, по аспекту видео)
      const aspect = v.videoWidth / v.videoHeight;
      const W = aspect >= 1 ? 640 : Math.round(640 * aspect);
      const H = aspect >= 1 ? Math.round(640 / aspect) : 640;
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      ctx.clearRect(0, 0, W, H);
      const map = (nx: number, ny: number) => [nx * W, ny * H] as const;

      // T0c: продюсеры-инстансы из резолвнутого конфига; адресация source по id (или вид — back-compat).
      const producers = cfgRef.current.producers ?? [];
      const needDepth = producers.some((p) => p.kind === "scatter" || p.kind === "sample");
      const dApi = depthRef.current;
      const sources: PointResultRefs = {
        motion: motionRef.current, hands: handsRef.current,
        faces: facesRef.current, people: peopleRef.current,
        depth: needDepth ? (dApi?.smoothedRef.current ?? dApi?.latestRef.current ?? null) : null,
        producers,
      };
      const drivers = computeDrivers({ ...sources, audio: audioRefRef.current?.current ?? undefined });
      // Field-входы конвертеров (T1-3): сигнал/selection — компиляция (скаляр | FieldFn), data-driven
      // по LAYER_DEFS[kind].fieldInputs (паритет с ModifierOverlay).
      const layerFieldFns: NonNullable<PointResultRefs["layerFieldFns"]> = {};
      for (const p of producers) {
        for (const fi of LAYER_DEFS[p.kind]?.fieldInputs ?? []) {
          const sig = p.params[fi.param];
          if (!sig || sig === "none") continue;
          const cf = compileFieldFn(sig as string, drivers, opsRef.current);
          (layerFieldFns[p.id] ??= {})[fi.param] = cf.perElement ? cf.fn! : cf.value;
        }
      }
      sources.layerFieldFns = layerFieldFns;
      // B-раунд-2: Map2D-источники Scatter → кадры-карты (паритет с ModifierOverlay).
      sources.layerMaps = resolveProducerMaps(producers, { depth: sources.depth, mapNodes: cfgRef.current.mapNodes, time: performance.now() / 1000 });

      let mode = 0;
      let drew = false;
      const list = effectsRef.current.filter((e) => e.enabled && e.kind === "splat");
      for (let k = 0; k < list.length; k++) {
        const e = list[k];
        const field = fieldForLayerId(e.source, sources);
        if (!field || !field.groups.length) continue;
        const s = toSplatSettings(e.params);
        applyBindings(s, e, drivers);
        if (k === 0) mode = s.mode === "alpha" ? 1 : 0; // композит — по первому splat-эффекту
        for (const g of field.groups) drawSplats(ctx, g, map, s, H);
        drew = true;
      }
      tex.needsUpdate = true;
      splatRef.current = drew ? { tex, on: true, mode } : { tex, on: false, mode };
      if (import.meta.env.DEV) (window as unknown as { __splat?: unknown }).__splat = { cv, state: splatRef.current };
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); splatRef.current = null; };
  }, [active, cv, tex, splatRef, handsRef, motionRef, facesRef, peopleRef]);

  return null; // off-DOM: ничего не рендерим в дерево, только публикуем текстуру через splatRef
}
