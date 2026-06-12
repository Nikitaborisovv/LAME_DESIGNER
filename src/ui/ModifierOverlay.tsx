// Оверлей top-level эффектов (Фаза 3 #2). Для каждого включённого эффекта берёт точки его
// источника (effect.source -> продюсер) из соответствующего рефа и рисует (пока «линии»).
// Координаты норм. 0..1 маппятся тем же фитом, что шейдер.
//
// Источник точек выбирается по effect.source (хендл продюсера): hands -> handsRef и т.д.
// Рендер: Canvas2D (ARCHITECTURE §0.2/§3 P1), размер через ResizeObserver — без SVG-reparse.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { EffectNode, HandResult, VisionResult, FaceResult, PeopleFrame, PointGroup, DriverKind, SceneConfig, OpNode } from "../core/types";
import type { DepthApi } from "../ml/useDepth";
import type { AudioBands } from "../ml/useAudio";
import { fieldForLayerId, resolveProducerMaps, type PointResultRefs } from "../core/pointSources";
import { LAYER_DEFS } from "../core/layerRegistry";
import { computeDrivers, drivenValue, shapeT, resolveSignal, compileFieldFn, type DriverValues } from "../core/drivers";
import { drawLines, toLineSettings, type LineSettings } from "./renderLines";
import { tintRgba } from "./constellationUtil";
import { perf } from "../core/perf";

// Trail: монотонный счётчик кадра НА УРОВНЕ МОДУЛЯ (не per-component ref) — переживает ремаунт
// ModifierOverlay (смена fit/active), чтобы tick не сбросился в 0 и не застрял барьер дозаписи
// против персистентного trailState в pointSources (config-reviewer). Владелец рендера инкрементит раз в кадр.
let trailFrameSeq = 0;

export function ModifierOverlay({
  effects, handsRef, motionRef, facesRef, peopleRef, audioRef, video, fit = "contain", depth, config, opNodes, cameraRef,
}: {
  effects: EffectNode[];
  handsRef: React.MutableRefObject<HandResult>;
  motionRef: React.MutableRefObject<VisionResult>;
  facesRef: React.MutableRefObject<FaceResult>;
  peopleRef: React.MutableRefObject<PeopleFrame | null>;
  audioRef?: { current: AudioBands | null };  // аудио-сигналы (T-Beauty)
  video: HTMLVideoElement | null;
  fit?: "cover" | "contain";
  depth?: DepthApi;             // Map2D-вход для Scatter (фаза C)
  config: SceneConfig;          // параметры scatter (density/threshold/…)
  opNodes?: OpNode[];           // Math-оп-ноды (фаза C): Field→Field на привязках
  // U1: камера облака (App.cameraRef, прецедент Constellation3D). 3D-точки (z задан) проецируются через
  // неё, когда облако активно — линии живут в одном мире с облаком; иначе fakePerspective-параллакс.
  cameraRef?: React.MutableRefObject<THREE.Camera | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const effectsRef = useRef(effects);
  effectsRef.current = effects;
  const videoRef = useRef(video);
  videoRef.current = video;
  const depthRef = useRef(depth);
  depthRef.current = depth;
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const opsRef = useRef(opNodes);
  opsRef.current = opNodes;
  const audioRefRef = useRef(audioRef);
  audioRefRef.current = audioRef;
  const camRefRef = useRef(cameraRef);
  camRefRef.current = cameraRef;
  const projVec = useRef(new THREE.Vector3()).current; // переиспользуемый вектор проекции (без аллокаций в кадре)
  // сглаженные значения драйв-привязок между кадрами (ключ = `${effectId}:${field}`)
  const smoothRef = useRef<Map<string, number>>(new Map());
  const lastTRef = useRef(0); // время прошлого кадра для dt (кадронезависимое сглаживание)

  // активен, если есть хоть один включённый эффект
  const active = effects.some((e) => e.enabled);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    // B-раунд-2: кеш резолва Map2D-источников Scatter — троттл ~10Гц (noise2d-цепочка генерит 128² карту;
    // на 60Гц это впустую). video-источник дёшев (= src.depth), но троттлим единообразно. Карты-снапшоты
    // иммутабельны → scatterToField читает их каждый кадр без проблем.
    let mapCacheT = 0;
    let mapCache: NonNullable<PointResultRefs["layerMaps"]> = {};

    // Размер кешируем через ResizeObserver, НЕ читаем clientWidth в кадре (избегаем reflow).
    const size = { cw: 0, ch: 0, dpr: 1 };
    const applySize = (cw: number, ch: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      size.cw = cw; size.ch = ch; size.dpr = dpr;
      const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    };
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      applySize(cr.width, cr.height);
    });
    ro.observe(canvas);
    applySize(canvas.clientWidth, canvas.clientHeight);

    const dims = (cw: number, ch: number) => {
      const v = videoRef.current;
      const va = (v ? v.videoWidth / v.videoHeight : 0) || 16 / 9;
      const ca = cw / ch;
      let dw: number, dh: number;
      if (fit === "cover") {
        if (va > ca) { dh = ch; dw = ch * va; } else { dw = cw; dh = cw / va; }
      } else {
        if (va > ca) { dw = cw; dh = cw / va; } else { dh = ch; dw = ch * va; }
      }
      return { dw, dh };
    };

    const draw = () => {
      const { cw, ch, dpr } = size;
      // БАГ-ФИКС: НЕ гейтим по наличию видео — процедурные продюсеры (Grid) живут без источника
      // кадров, dims() фолбэчит аспект 16:9. Раньше весь оверлей был мёртв, пока не загрузят видео.
      if (!cw || !ch) { raf = requestAnimationFrame(draw); return; }
      const endDraw = perf.mark("modifiers.draw");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      const { dw, dh } = dims(cw, ch);
      // U1: проекция координат. z===undefined → плоский contain-фит (байт-в-байт прежнее поведение
      // для 2D-продюсеров). z задан (3D-точки Scatter/pointForce) → камера облака, когда она активна
      // (линии в одном мире с облаком/Constellation3D), иначе fakePerspective-параллакс от центра.
      const v = videoRef.current;
      const aspect = (v ? v.videoWidth / v.videoHeight : 0) || 16 / 9;
      const depthScale = Number(cfgRef.current.depthScale) || 0.5;
      const cam = camRefRef.current?.current ?? null;
      const FAKE_PERSP = 0.8; // сила параллакса fakePerspective (нет камеры): ближе → дальше от центра
      const map = (nx: number, ny: number, z?: number) => {
        const bx = (cw - dw) / 2 + nx * dw, by = (ch - dh) / 2 + ny * dh;
        if (z === undefined) return [bx, by] as const; // 2D-продюсер — плоский путь без изменений
        const wz = z * depthScale; // выраженность 3D — тот же depthScale, что облако/частицы
        if (cam) {
          // мир как у Constellation3D/облака: x=(1-2nx)·aspect, y=1-2ny, z=-(depth·scale)·depthScale
          projVec.set((1 - 2 * nx) * aspect, 1 - 2 * ny, -wz).project(cam);
          return [(projVec.x * 0.5 + 0.5) * cw, (-projVec.y * 0.5 + 0.5) * ch] as const;
        }
        const f = 1 + wz * FAKE_PERSP; // спред от центра канваса (ближе крупнее → дальше от центра)
        return [cw / 2 + (bx - cw / 2) * f, ch / 2 + (by - ch / 2) * f] as const;
      };

      // dt для кадронезависимого сглаживания привязок (защита от скачков при свёрнутой вкладке)
      const now = performance.now();
      const dt = Math.min(0.1, lastTRef.current ? (now - lastTRef.current) / 1000 : 1 / 60);
      lastTRef.current = now;

      // DataBus-вход: последние результаты всех продюсеров точек (общий для точек и драйверов).
      // + Scatter (фаза C): карта глубины (Map2D) и его параметры из конфига -> «точки из глубины».
      const cfg = cfgRef.current;
      const dApi = depthRef.current;
      // T0c: продюсеры/конвертеры — инстансы из резолвнутого конфига (cfg.producers). Резолвер
      // адресует effect.source по id. Глубину тянем, если есть scatter/sample-инстанс.
      const producers = cfg.producers ?? [];
      const needDepth = producers.some((p) => p.kind === "scatter" || p.kind === "sample");
      const sources: PointResultRefs = {
        motion: motionRef.current, hands: handsRef.current,
        faces: facesRef.current, people: peopleRef.current,
        depth: needDepth ? (dApi?.smoothedRef.current ?? dApi?.latestRef.current ?? null) : null,
        producers,
        frameTick: ++trailFrameSeq, // Trail: владелец рендера шагает историю шлейфов раз в кадр
      };
      // драйверы (руки + Reduce'ы: энергия движения, центроид лиц, число людей + аудио) — общие на кадр,
      // модулируют параметры по привязкам. Те же источники, что и точки.
      const drivers = computeDrivers({ ...sources, audio: audioRefRef.current?.current ?? undefined });

      // Field-входы конвертеров (T1-3): сигнал setAttr / selection — КОМПИЛИРУЮТСЯ здесь (доступны
      // драйверы + Math): скалярная цепочка -> число (прежний путь байт-в-байт), element-цепочка ->
      // FieldFn (конвертер вычислит на точку). data-driven по LAYER_DEFS[kind].fieldInputs.
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
      // B-раунд-2: резолв Map2D-источников Scatter (глубина×нойз-цепочка) → кадры-карты, троттл ~10Гц.
      // scatterMapSource="video" → src.depth (дёшево); реальная noise-цепочка → mapForRef (128²).
      if (now - mapCacheT > 100) {
        mapCacheT = now;
        mapCache = resolveProducerMaps(producers, { depth: sources.depth, mapNodes: cfg.mapNodes, time: now / 1000 });
      }
      sources.layerMaps = mapCache;

      for (const e of effectsRef.current) {
        if (!e.enabled || e.kind !== "lines") continue;
        // источник точек: продюсер по хендлу effect.source (DataBus, id-инстанс или вид).
        const field = fieldForLayerId(e.source, sources);
        if (!field || !field.groups.length) continue;
        const s = toLineSettings(e.params);
        applyBindings(s, e.bindings, drivers, smoothRef.current, e.id, dt, opsRef.current);
        // "по близости": связи по ОБЪЕДИНЁННЫМ точкам всех групп; native/chain — по группам.
        if (s.topology === "nearest" && field.groups.length > 1) {
          const merged: PointGroup = { points: [], values: [] };
          for (const g of field.groups) {
            for (const p of g.points) merged.points.push(p);
            const vals = g.values ?? g.points.map(() => 1);
            for (const v of vals) merged.values!.push(v);
          }
          drawLines(ctx, merged, map, s);
        } else {
          for (const g of field.groups) drawLines(ctx, g, map, s);
        }
      }

      endDraw();
      perf.tick("modifiers.fps");
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [active, handsRef, motionRef, fit]);

  if (!active) return null;
  return (
    <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 7 }} />
  );
}

// Модуляция настроек линий драйверами (привязки параметров к сигналам рук).
// sm — карта сглаженных значений между кадрами; key — id модификатора (для уникальности ключей).
// EMA подтягивает значение к цели плавно (smooth: 0 = мгновенно, ~0.95 = очень медленно).
function applyBindings(
  s: LineSettings,
  bindings: Record<string, { driver: DriverKind; signal?: string; lo: number; hi: number; smooth?: number; curve?: number }> | undefined,
  d: DriverValues,
  sm: Map<string, number>,
  key: string,
  dt: number,
  ops?: OpNode[],
) {
  if (!bindings) return;
  // привязка активна, если задан сырой драйвер ИЛИ Math-цепочка (signal).
  const on = (b?: { driver: DriverKind; signal?: string }) => !!b && (b.driver !== "none" || !!b.signal);
  // EMA, нормированная на 60fps: a = 1 - smooth^(dt*60). Реальная скорость не зависит от FPS
  // (smooth трактуется как «доля остатка за 1/60 c»).
  const ease = (field: string, target: number, smooth?: number): number => {
    const k = key + ":" + field;
    const prev = sm.get(k);
    if (prev === undefined) { sm.set(k, target); return target; }
    const sc = Math.min(0.999, Math.max(0, smooth ?? 0));
    const a = sc <= 0 ? 1 : 1 - Math.pow(sc, dt * 60);
    const next = prev + (target - prev) * a;
    sm.set(k, next);
    return next;
  };
  const bw = bindings.width;
  if (on(bw)) s.width = ease("width", drivenValue(bw, d, ops), bw.smooth);
  const bl = bindings.maxLinks;
  if (on(bl)) s.maxLinks = Math.round(ease("maxLinks", drivenValue(bl, d, ops), bl.smooth));
  const bcv = bindings.curve;
  if (on(bcv)) s.curve = ease("curve", drivenValue(bcv, d, ops), bcv.smooth);
  const bc = bindings.colorA;
  if (on(bc)) {
    const t0 = shapeT(resolveSignal(bc.signal ?? bc.driver, d, ops), bc.curve);
    const t = Math.max(0, Math.min(1, ease("colorA", t0, bc.smooth)));
    s.colorA = tintRgba(s.colorA, s.colorB, t, 1); // цвет лерпится A->B по сглаженному драйверу
    s.gradient = false;
  }
}
