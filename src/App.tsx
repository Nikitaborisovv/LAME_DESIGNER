import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { type SceneConfig, type LayeredConfig, type LayerKind, type ModifierKind, type ParamBinding, type EffectNode, type OpNode, type OpKind } from "./core/types";
import {
  compileLayered, withEdge, withoutEdge, withoutNodeEdges, autoWireLayer, autoWireEffect,
  edgeForBinding, edgeForLayerParam, edgeKey,
} from "./core/graphDoc";
import { makeLayer, layerWiringParams, LAYER_DEFS } from "./core/layerRegistry";
import { makeEffect } from "./core/modifierRegistry";
import { isPointProducer, POINT_PRODUCERS, scatterToField, sampleToField, setAttrToField } from "./core/pointSources";
import { mapChainNeedsDepth } from "./core/mapSources";
import { RoundRobin, type SchedTask } from "./core/scheduler";
import { resolveSignal, compileFieldFn, OP_DEFS } from "./core/drivers";
import { VideoSource } from "./core/VideoSource";
import type * as THREE from "three";
import { Scene } from "./render/Scene";
import { ParticleCanvas } from "./render/ParticleCanvas";
import { ParticleFieldCanvas } from "./render/ParticleFieldCanvas";
import { MapScreenOverlay } from "./ui/MapScreenOverlay";
import type { ParticleBackend } from "./render/particles/ParticleSpike";
import { Controls } from "./ui/Controls";
import { ScenePanel } from "./ui/ScenePanel";
import { Overlay } from "./ui/Overlay";
import { HandsOverlay } from "./ui/HandsOverlay";
import { ModifierOverlay } from "./ui/ModifierOverlay";
import { SplatMask, type SplatState } from "./ui/SplatMask";
import { Constellation3D } from "./ui/Constellation3D";
import { PerfPanel } from "./ui/PerfPanel";
import { GraphView } from "./ui/GraphView";
import { useVision } from "./ml/useVision";
import { useCameraStream } from "./net/useCameraStream";
import { useKinect, type KinectDepthOpts } from "./net/useKinect";
import { useFaces } from "./ml/useFaces";
import { useHands } from "./ml/useHands";
import { useDepth } from "./ml/useDepth";
import { depthRouter, type DepthInput } from "./ml/depthRouter";
import { usePeople } from "./ml/usePeople";
import { useSegmentation } from "./ml/useSegmentation";
import { useFrameGrab } from "./ml/useFrameGrab";
import { useAudio } from "./ml/useAudio";
import * as Presets from "./core/presets";
import * as CacheStore from "./core/depthCacheStore";

// Удобный публичный тип API операций над слоями (для Controls).
export interface LayersApi {
  list: LayeredConfig["layers"];
  selectedId: string | null;
  select: (id: string | null) => void;
  add: (kind: LayerKind) => void;
  remove: (id: string) => void;
  toggle: (id: string) => void;
  setEnabled: (id: string, enabled: boolean) => void;
  rename: (id: string, name: string) => void;
  duplicate: (id: string) => void;
  setParams: (id: string, params: Partial<SceneConfig>) => void;
  reorder: (fromId: string, toId: string) => void;
  // top-level эффекты (Фаза 3 #2): ноды-потребители точек поверх продюсеров
  effects: EffectNode[];
  selectedEffectId: string | null;
  selectEffect: (id: string | null) => void;
  addEffect: (kind: ModifierKind, source: string) => void; // T0c: source = id слоя-продюсера
  removeEffect: (id: string) => void;
  toggleEffect: (id: string) => void;
  setEffectEnabled: (id: string, enabled: boolean) => void;
  setEffectParams: (id: string, params: Record<string, number | string | boolean>) => void;
  setEffectSource: (id: string, source: string) => void; // T0c: source = id слоя-продюсера (или вид — back-compat)
  setEffectBinding: (id: string, field: string, binding: ParamBinding | null) => void;
}

export default function App() {
  // T0e: merge(null) (а не сырой DEFAULT_LAYERED) — у конфига ВСЕГДА есть graph (рёбра+позиции).
  const [config, setConfig] = useState<LayeredConfig>(() => Presets.loadLast() ?? Presets.merge(null));
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  // Источник кадров: файл / живой поток с телефона (WebRTC) / Kinect (хост-мост).
  const [sourceMode, setSourceMode] = useState<DepthInput>("file");
  // Транспорт-настройки Kinect — ephemeral (НЕ в SceneConfig, чтобы IP не попадал в пресеты).
  const [kinectMock, setKinectMock] = useState(true);
  const [kinectHost, setKinectHost] = useState("localhost");
  const [kinectPort, setKinectPort] = useState(8090);
  // Обработка depth-сигнала Kinect (нормализация/сглаживание) — тоже ephemeral.
  const [kDepth, setKDepth] = useState<KinectDepthOpts>({ nearMm: 500, farMm: 4000, auto: true, smooth: 0.5, holeFill: true });
  // Галка: из Kinect брать ТОЛЬКО RGB, а глубину считать нейросетью по этому видео (как с файлом).
  const [kinectNeuralDepth, setKinectNeuralDepth] = useState(false);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [selectedEffectId, setSelectedEffectId] = useState<string | null>(null);

  // === Undo/redo (T0b граф-менеджмент) — история снимков LayeredConfig (они иммутабельны:
  // все мутации идут через spread-копию -> снимок безопасно держать по ссылке). Дебаунс коалесит
  // быстрые правки (драг слайдера) в ОДИН шаг. Всё через setConfig (без хаков localStorage).
  const histRef = useRef<{ past: LayeredConfig[]; future: LayeredConfig[] }>({ past: [], future: [] });
  const committedRef = useRef(config);      // последний снимок-baseline истории
  const applyingHistoryRef = useRef(false); // true пока применяем undo/redo (не записывать обратно)
  const undo = useCallback(() => {
    const h = histRef.current;
    if (!h.past.length) return;
    h.future.push(committedRef.current);
    const prev = h.past.pop() as LayeredConfig;
    committedRef.current = prev;
    applyingHistoryRef.current = true;
    setConfig(prev);
  }, []);
  const redo = useCallback(() => {
    const h = histRef.current;
    if (!h.future.length) return;
    h.past.push(committedRef.current);
    const next = h.future.pop() as LayeredConfig;
    committedRef.current = next;
    applyingHistoryRef.current = true;
    setConfig(next);
  }, []);
  // записываем предыдущий снимок при оседании изменения (дебаунс 400мс коалесит драги).
  useEffect(() => {
    if (applyingHistoryRef.current) { applyingHistoryRef.current = false; committedRef.current = config; return; }
    if (config === committedRef.current) return;
    const t = setTimeout(() => {
      if (config === committedRef.current) return;
      histRef.current.past.push(committedRef.current);
      if (histRef.current.past.length > 100) histRef.current.past.shift();
      histRef.current.future = [];
      committedRef.current = config;
    }, 400);
    return () => clearTimeout(t);
  }, [config]);
  // глобальные Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (игнор в текстовых полях).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [graphOpen, setGraphOpen] = useState(false); // нодовый редактор (прототип, Фаза 3)
  const [particleBackend, setParticleBackend] = useState<ParticleBackend | null>(null); // T5-спайк: активный бэкенд
  const [presetList, setPresetList] = useState<string[]>(() => Presets.presetNames());
  const [cacheList, setCacheList] = useState<string[]>([]);
  const sourceRef = useRef<VideoSource | null>(null);
  const scanRef = useRef(0); // позиция сканера, общая для облака и ASCII-оверлея
  const cameraRef = useRef<THREE.Camera | null>(null); // камера облака для проекции 3D-оверлеев

  // Автосохранение настроек (переживает перезагрузку).
  useEffect(() => { Presets.saveLast(config); }, [config]);

  // Приёмник потока с телефона (активен только в режиме "stream").
  const camera = useCameraStream(sourceMode === "stream");
  // Kinect как третий вход (активен только в режиме "kinect"): RGB → stream, depth → провайдер.
  const kinect = useKinect(sourceMode === "kinect", { mock: kinectMock, host: kinectHost, port: kinectPort, depth: kDepth });

  // T0e: компилятор графа (рёбра авторитетны, pull от Экрана) -> нормализованный конфиг
  // (его эффекты/оп-ноды читают оверлеи) + резолвнутый плоский SceneConfig для рендера.
  const compiled = useMemo(() => compileLayered(config), [config]);
  const resolved = compiled.resolved;
  const normalized = compiled.normalized;
  if (import.meta.env.DEV) {
    (window as unknown as { __resolved?: unknown }).__resolved = resolved;
    (window as unknown as { __scatter?: unknown }).__scatter = scatterToField; // тест Scatter (фаза C)
    (window as unknown as { __sample?: unknown }).__sample = sampleToField;     // тест Sample (фаза C)
    (window as unknown as { __setAttr?: unknown }).__setAttr = setAttrToField;  // тест SetAttr (T2-1)
    (window as unknown as { __resolveSignal?: unknown }).__resolveSignal = resolveSignal; // тест Math (фаза C)
    (window as unknown as { __compileFieldFn?: unknown }).__compileFieldFn = compileFieldFn; // тест per-element (T1-3)
  }

  // Splat-маска (конвертер PointSet->Map2D): SplatMask пишет CanvasTexture в этот реф, FlatView читает.
  const splatRef = useRef<SplatState | null>(null);
  const splatApi = useMemo(() => ({ ref: splatRef }), []);

  const flat = resolved.renderMode === "flat";
  const cloud = resolved.renderMode === "cloud";

  // Источник глубины: обычно следует за входом, НО для Kinect с галкой kinectNeuralDepth
  // считаем нейро по RGB Kinect (трактуем как "file"), а не берём железную глубину.
  const depthInput: DepthInput = (sourceMode === "kinect" && kinectNeuralDepth) ? "file" : sourceMode;
  // Нейро-глубина живёт на уровне App -> кеш не теряется при 2D<->3D. Для железного Kinect
  // нейро-воркер не нужен; для kinectNeuralDepth — нужен (depthInput="file").
  // T5 v2 A-часть-2/Phase B: particle-система с map-входом поднимает depth-инференс, ТОЛЬКО если цепочка
  // карт реально достигает Видео.глубины (не будим depth для чисто-шумовой карты — mapChainNeedsDepth).
  const particleMapNeedsDepth = resolved.particlesEnabled &&
    (resolved.particleSystems?.some((s) => mapChainNeedsDepth(s.emitters[0]?.mapRef ?? "none", resolved.mapNodes)) ?? false);
  // «Карта → Экран.видео» (полноэкранный просмотр Map2D) тоже будит depth, если цепочка карт
  // достигает Видео.глубины (тот же гейт, что у particle-map).
  const screenMapNeedsDepth = mapChainNeedsDepth(resolved.screenMapRef ?? "none", resolved.mapNodes);
  const depthActive = depthInput !== "kinect" && (
    (cloud && resolved.depthEnabled) ||
    (flat && (resolved.pixelateEnabled || resolved.scatterEnabled || resolved.sampleEnabled || (resolved.constellation2DEnabled && resolved.fakePerspective > 0))) ||
    particleMapNeedsDepth || screenMapNeedsDepth);
  const neural = useDepth(depthActive, resolved.depthResolution, {
    mode: resolved.depthSmoothMode,
    alpha: resolved.depthSmoothAlpha,
    motionBoost: resolved.depthMotionBoost,
    deadband: resolved.depthDeadband,
  });
  // Рендер читает единый DepthApi: файл/телефон/Kinect-нейро → нейро, железный Kinect → kinect.depth.
  const depth = depthRouter(depthInput, neural, kinect.depth);

  // Список сохранённых кешей (IndexedDB).
  useEffect(() => { CacheStore.listCaches().then(setCacheList); }, []);
  // 2D-слой активен в flat-режиме И в 3D-композите.
  const want2D = flat || resolved.composite;
  // constellation3D — только в 3D; motion/constellation2D — в 2D-слое.
  const visionOn =
    (cloud && resolved.constellationEnabled) ||
    ((resolved.motionEnabled || resolved.constellation2DEnabled) && want2D);
  const { submit: submitVision, resultRef } = useVision(
    visionOn,
    {
      sensitivity: resolved.motionSensitivity,
      gap: resolved.motionGap,
      decay: resolved.motionDecay,
      heatThreshold: resolved.motionHeatThreshold,
      minArea: resolved.motionMinArea,
      maxBoxes: resolved.motionMaxBoxes,
    },
    resolved.featureCount
  );

  const facesOn = want2D && (resolved.faceBoxesEnabled || resolved.faceMeshEnabled);
  const { submit: submitFaces, resultRef: facesRef } = useFaces(
    facesOn, resolved.faceBoxesEnabled, resolved.faceMeshEnabled, resolved.maxFaces
  );

  // Трекинг рук — самостоятельный слой поверх плоского видео (как лица, маппится "contain").
  const handsOn = want2D && resolved.handsEnabled;
  const { submit: submitHands, resultRef: handsRef } = useHands(
    handsOn, resolved.maxHands, resolved.handGestures, resolved.handSmooth, resolved.handMirror
  );

  // Маски людей (YOLOv8-seg).
  const peopleOn = want2D && resolved.peopleMasksEnabled;
  const people = usePeople(peopleOn, {
    input: resolved.peopleInput,
    conf: resolved.peopleConf,
    maskThreshold: resolved.peopleMaskThreshold,
    iou: resolved.peopleIou,
    smooth: resolved.peopleMaskSmooth,
  });
  const peopleFrame = useRef(0);
  // Планировщик тяжёлых синхронных детекторов (лица/руки) — круговая ротация вместо
  // бинарного «лицо ИЛИ руки», чтобы оба обновлялись и не крали кадр друг у друга.
  const schedRef = useRef(new RoundRobin());
  // Один грабер кадра: одна выемка <video> на кадр, общая для vision/seg/people (P3).
  const { frameRef: grabRef, grab } = useFrameGrab();

  // Аудио-анализ (T-Beauty): WebAudio FFT-полосы -> Field-драйверы audioLow/Mid/High/Kick.
  const audioRef = useAudio(resolved.audioEnabled, resolved.audioSource, resolved.audioGain, video);

  // Гладкая маска (MediaPipe Selfie) — независимый слой.
  const segOn = want2D && resolved.peopleSmoothEnabled;
  const seg = useSegmentation(segOn, { smooth: resolved.peopleSegSmooth, model: resolved.segModel });

  // 2D-оверлей (движение/лица/текст/constellation2D) — только в flat/композите.
  const overlay2DActive = resolved.motionEnabled || resolved.constellation2DEnabled ||
    resolved.faceBoxesEnabled || resolved.faceMeshEnabled || resolved.hudText.length > 0 ||
    (resolved.peopleBoxEnabled && resolved.peopleMasksEnabled);
  const overlayOn = want2D && overlay2DActive;
  const overlayFit: "cover" | "contain" = "contain";
  const constellation3D = cloud && resolved.constellationEnabled;

  // патч глобальных полей конфига (источник/темп/depth/камера/цвета людей)
  const patch = useCallback(
    (p: Partial<LayeredConfig>) => setConfig((c) => ({ ...c, ...p })),
    []
  );

  // --- операции над слоями ---
  const layers: LayersApi = useMemo(() => ({
    list: config.layers,
    selectedId: selectedLayerId,
    select: (id) => { setSelectedLayerId(id); if (id) setSelectedEffectId(null); },
    add: (kind) => {
      const l = makeLayer(kind);
      // T0e: новая нода сразу обвязана дефолтными рёбрами (детектор←Видео; FX — в хвост цепочки).
      // T5 v2: добавление particle-ноды авто-включает мастер-флаг (канвас — авто по графу; дальше
      // particlesEnabled — кнопка-рубильник OFF=force-off).
      setConfig((c) => {
        const next = autoWireLayer({ ...c, layers: [l, ...c.layers] }, l);
        // U2-b: "force" — двойной домен (particle+CPU-точки); CPU-режим НЕ должен будить мастер-флаг
        // (иначе lone CPU-Force → particlesEnabled=true + 0 систем → паразитный box-демо-оверлей).
        // GPU-цепочка и так включает флаг при add Emitter/Render.
        const wakesParticles = LAYER_DEFS[kind]?.domain === "particle" && kind !== "force";
        return wakesParticles ? { ...next, particlesEnabled: true } : next;
      });
      setSelectedLayerId(l.id);
      setSelectedEffectId(null);
    },
    remove: (id) => {
      // T0e: вместе со слоем уходят его рёбра и позиция в графе.
      setConfig((c) => withoutNodeEdges({ ...c, layers: c.layers.filter((l) => l.id !== id) }, id));
      setSelectedLayerId((s) => (s === id ? null : s));
    },
    toggle: (id) => setConfig((c) => ({
      ...c, layers: c.layers.map((l) => (l.id === id ? { ...l, enabled: !l.enabled } : l)),
    })),
    setEnabled: (id, enabled) => setConfig((c) => ({
      ...c, layers: c.layers.map((l) => (l.id === id ? { ...l, enabled } : l)),
    })),
    rename: (id, name) => setConfig((c) => ({
      ...c, layers: c.layers.map((l) => (l.id === id ? { ...l, name } : l)),
    })),
    duplicate: (id) => setConfig((c) => {
      const src = c.layers.find((l) => l.id === id);
      if (!src) return c;
      const copy = makeLayer(src.kind, src.params, src.enabled);
      copy.name = `${src.name} copy`;
      const i = c.layers.findIndex((l) => l.id === id);
      const next = c.layers.slice();
      next.splice(i, 0, copy);
      return { ...c, layers: next };
    }),
    setParams: (id, params) => setConfig((c) => {
      let next: LayeredConfig = {
        ...c, layers: c.layers.map((l) => (l.id === id ? { ...l, params: { ...l.params, ...params } } : l)),
      };
      // T0e-паритет: wiring-поля конвертера (источники точек + Field-сигнал), редактируемые из
      // инспектора, рисуют/снимают РЕБРО — иначе applyGraph затёр бы параметр без провода и погасил
      // ноду. T2-3: список data-driven по виду слоя (layerWiringParams: convertInputs + wiringFields).
      const lk = next.layers.find((l) => l.id === id)?.kind;
      for (const f of (lk ? layerWiringParams(lk) : [])) {
        if (!(f in params)) continue;
        const r = edgeForLayerParam(next, id, f, String((params as Record<string, unknown>)[f]));
        const old = (next.graph?.edges ?? []).find((e) => e.to.node === id && e.to.in === r.in);
        if (r.edge) next = withEdge(next, r.edge);
        else if (old) next = withoutEdge(next, edgeKey(old));
      }
      return next;
    }),
    reorder: (fromId, toId) => setConfig((c) => {
      if (fromId === toId) return c;
      const arr = c.layers.slice();
      const from = arr.findIndex((l) => l.id === fromId);
      const to = arr.findIndex((l) => l.id === toId);
      if (from < 0 || to < 0) return c;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return { ...c, layers: arr };
    }),
    effects: config.effects,
    selectedEffectId,
    selectEffect: (id) => { setSelectedEffectId(id); if (id) setSelectedLayerId(null); },
    addEffect: (kind, source) => setConfig((c) => {
      const e = makeEffect(kind, source);
      setSelectedEffectId(e.id);
      setSelectedLayerId(null);
      // T0e: сразу обвязываем (points от source-продюсера + out -> Экран.оверлеи).
      return autoWireEffect({ ...c, effects: [...c.effects, e] }, e);
    }),
    removeEffect: (id) => {
      setConfig((c) => withoutNodeEdges({ ...c, effects: c.effects.filter((e) => e.id !== id) }, id));
      setSelectedEffectId((s) => (s === id ? null : s));
    },
    toggleEffect: (id) => setConfig((c) => ({
      ...c, effects: c.effects.map((e) => e.id === id ? { ...e, enabled: !e.enabled } : e),
    })),
    setEffectEnabled: (id, enabled) => setConfig((c) => ({
      ...c, effects: c.effects.map((e) => e.id === id ? { ...e, enabled } : e),
    })),
    setEffectParams: (id, params) => setConfig((c) => ({
      ...c, effects: c.effects.map((e) => e.id === id ? { ...e, params: { ...e.params, ...params } } : e),
    })),
    setEffectSource: (id, source) => setConfig((c) => ({
      ...c, effects: c.effects.map((e) => e.id === id ? { ...e, source } : e),
    })),
    setEffectBinding: (id, field, binding) => setConfig((c) => {
      const base: LayeredConfig = {
        ...c, effects: c.effects.map((e) => {
          if (e.id !== id) return e;
          const next = { ...(e.bindings ?? {}) };
          if (binding) next[field] = binding; else delete next[field];
          return { ...e, bindings: next };
        }),
      };
      // T0e-паритет: правка биндинга в инспекторе рисует/снимает РЕБРО (граф честный).
      const oldEdge = (c.graph?.edges ?? []).find((e) => e.to.node === id && e.to.in === field);
      const newEdge = edgeForBinding(base, id, field, binding);
      if (newEdge) return withEdge(base, newEdge);
      if (oldEdge) return withoutEdge(base, edgeKey(oldEdge));
      return base;
    }),
  }), [config.layers, config.effects, selectedLayerId, selectedEffectId]);

  const loadFile = useCallback((file: File) => {
    setSourceMode("file");
    sourceRef.current?.dispose();
    const src = new VideoSource();
    sourceRef.current = src;
    const url = URL.createObjectURL(file);
    src.load(url);
    setVideo(src.el);
    setConfig((c) => ({ ...c, videoUrl: url }));
  }, []);

  // Стартовая авто-загрузка видео по СОХРАНЁННОМУ в конфиге URL — только реальные пути
  // (/videos/…, http(s)). Object-URL'ы (blob:) не переживают перезагрузку (живут в памяти вкладки),
  // поэтому их пропускаем. Позволяет открыть демо-видео по пути из конфига и восстанавливает
  // файловый источник между перезагрузками. Один раз на маунт.
  useEffect(() => {
    const url = config.videoUrl;
    if (!url || url.startsWith("blob:") || sourceMode !== "file") return;
    sourceRef.current?.dispose();
    const src = new VideoSource();
    sourceRef.current = src;
    src.load(url);
    setVideo(src.el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Переключение на поток с телефона: сбрасываем файл-источник, ждём MediaStream.
  const startStream = useCallback(() => {
    sourceRef.current?.dispose();
    sourceRef.current = null;
    setVideo(null);
    setSourceMode("stream");
  }, []);

  const stopStream = useCallback(() => {
    sourceRef.current?.dispose();
    sourceRef.current = null;
    setVideo(null);
    setSourceMode("file");
  }, []);

  // Переключение на Kinect: сбрасываем текущий источник, ждём MediaStream от моста/мока.
  const startKinect = useCallback(() => {
    sourceRef.current?.dispose();
    sourceRef.current = null;
    setVideo(null);
    setSourceMode("kinect");
  }, []);

  // Как только из WebRTC пришёл MediaStream — заворачиваем его в VideoSource.
  useEffect(() => {
    if (sourceMode !== "stream" || !camera.stream) return;
    sourceRef.current?.dispose();
    const src = new VideoSource();
    sourceRef.current = src;
    src.loadStream(camera.stream);
    setVideo(src.el);
  }, [sourceMode, camera.stream]);

  // RGB Kinect приходит как MediaStream (canvas.captureStream) — тот же путь, что телефон.
  useEffect(() => {
    if (sourceMode !== "kinect" || !kinect.stream) return;
    sourceRef.current?.dispose();
    const src = new VideoSource();
    sourceRef.current = src;
    src.loadStream(kinect.stream);
    setVideo(src.el);
  }, [sourceMode, kinect.stream]);

  const presets = {
    names: presetList,
    save: (name: string) => { if (!name) return; Presets.savePreset(name, config); setPresetList(Presets.presetNames()); },
    load: (name: string) => { const c = Presets.loadPreset(name); if (c) setConfig(c); },
    del: (name: string) => { Presets.deletePreset(name); setPresetList(Presets.presetNames()); },
    export: () => Presets.exportConfig(config),
    import: async (file: File) => { try { setConfig(await Presets.importConfig(file)); } catch { /* ignore */ } },
    reset: () => setConfig(Presets.merge(null)), // T0e: дефолт тоже с графом
  };

  const cache = {
    names: cacheList,
    bake: () => { const src = sourceRef.current; if (src) { neural.bake(src.el, resolved.cacheResolution, resolved.cacheFps); patch({ cacheEnabled: true }); } },
    save: async (name: string) => {
      if (!name) return;
      const c = neural.exportCache();
      if (!c) return;
      await CacheStore.saveCache(name, c);
      setCacheList(await CacheStore.listCaches());
    },
    load: async (name: string) => {
      const c = await CacheStore.loadCache(name);
      if (c) { neural.importCache(c); patch({ cacheEnabled: true }); }
    },
    del: async (name: string) => { await CacheStore.deleteCache(name); setCacheList(await CacheStore.listCaches()); },
  };

  // Покадрово кормим vision-воркер и детекторы (все троттлятся внутри себя).
  useEffect(() => {
    const src = sourceRef.current;
    if (!src || (!visionOn && !facesOn && !handsOn && !peopleOn && !segOn)) return;
    // Тяжёлые СИНХРОННЫЕ детекторы на главном потоке (лица/руки — MediaPipe) — в круговой
    // планировщик (см. core/scheduler): не больше одного на кадр, честная ротация. Каждый сам
    // троттлится (submit возвращает true, только если реально отработал). Список строится один
    // раз на запуск эффекта (не аллоцируется в кадре).
    const heavy: SchedTask[] = [];
    // faces/hands — MediaPipe грузит видео на GPU сам, CPU-грабер ему не нужен -> видео напрямую.
    if (facesOn) heavy.push({ key: "faces", run: (t) => submitFaces(src.el, t) });
    if (handsOn) heavy.push({ key: "hands", run: (t) => submitHands(src.el, t) });
    // seg (MediaPipe ImageSegmenter) — синхронный GPU-вызов на main; в ту же ротацию, чтобы
    // строго ≤1 MediaPipe-диспатча на кадр. Рисует из общего грабера (CPU-выемка кадра).
    if (segOn) heavy.push({ key: "seg", run: (t) => { const f = grabRef.current; return f ? seg.submit(f, t) : false; } });
    const sched = schedRef.current;
    const off = src.onFrame((now: number) => {
      grab(src.el); // ОДНА выемка кадра -> общий SharedFrame для всех CPU-детекторов (P3)
      const frame = grabRef.current;
      if (visionOn && frame) submitVision(frame);
      sched.tick(now, heavy, 1);
      // people — onnx-ВОРКЕР (не main-thread sync), поэтому вне планировщика.
      if (peopleOn && frame && (++peopleFrame.current % resolved.peopleEveryNthFrame === 0)) people.submit(frame);
    });
    return off;
  }, [video, visionOn, facesOn, handsOn, peopleOn, segOn, resolved.peopleEveryNthFrame, submitVision, submitFaces, submitHands, people, seg, grab, grabRef]);

  useEffect(() => () => sourceRef.current?.dispose(), []);

  return (
    <div className="app">
      <PerfPanel />
      <button
        className="mode"
        style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 15 }}
        onClick={() => setGraphOpen(true)}
        title="нодовый граф (прототип)"
      >
        граф ⬡
      </button>
      {leftOpen ? (
        <ScenePanel
          config={config}
          onChange={patch}
          onLoadFile={loadFile}
          device={depth.device}
          presets={presets}
          cache={cache}
          particleBackend={particleBackend}
          stream={{
            mode: sourceMode,
            status: camera.status,
            phoneUrl: camera.phoneUrl,
            error: camera.error,
            start: startStream,
            stop: stopStream,
          }}
          kinect={{
            status: kinect.status,
            error: kinect.error,
            mock: kinectMock,
            setMock: setKinectMock,
            host: kinectHost,
            setHost: setKinectHost,
            port: kinectPort,
            setPort: setKinectPort,
            start: startKinect,
            depth: kDepth,
            setDepth: (p) => setKDepth((d) => ({ ...d, ...p })),
            neuralDepth: kinectNeuralDepth,
            setNeuralDepth: setKinectNeuralDepth,
          }}
          onCollapse={() => setLeftOpen(false)}
        />
      ) : (
        <div className="spine left" title="развернуть" onClick={() => setLeftOpen(true)}>
          <span>сцена »</span>
        </div>
      )}
      <div className="stage">
        <Scene video={video} config={resolved} depth={depth} people={people} seg={seg} splat={splatApi} scanRef={scanRef} cameraRef={cameraRef}
          fxDrivers={{ handsRef, motionRef: resultRef, facesRef, peopleRef: people.latestRef, audioRef, opNodes: normalized.opNodes }} />
        {/* «Карта → Экран.видео»: полноэкранный ЧБ-просмотр Map2D-цепочки вместо видеотракта. */}
        {resolved.screenMapRef && (
          <MapScreenOverlay mapRef={resolved.screenMapRef} mapNodes={resolved.mapNodes} depth={depth} />
        )}
        {/* T5 v2: GPU-частицы отдельным WebGPU-канвасом-сиблингом поверх flat. Монтаж АВТО ПО ГРАФУ —
            есть цепочка Emitter→…→Render (resolved.particleSystems) → config-driven ParticleField.
            Back-compat: флаг ON + 0 цепочек → старый box-демо-спайк. particlesEnabled = мастер-рубильник. */}
        {resolved.particlesEnabled && (resolved.particleSystems?.length ?? 0) > 0 ? (
          <ParticleFieldCanvas
            systems={resolved.particleSystems ?? []}
            config={resolved}
            video={video}
            handsRef={handsRef}
            motionRef={resultRef}
            facesRef={facesRef}
            peopleRef={people.latestRef}
            audioRef={audioRef}
            depth={depth}
            opNodes={normalized.opNodes}
            zIndex={2}
            onBackend={setParticleBackend}
            cloudCameraRef={cameraRef}
          />
        ) : resolved.particlesEnabled ? (
          <ParticleCanvas zIndex={2} onBackend={setParticleBackend} />
        ) : null}
        {overlayOn && (
          <Overlay resultRef={resultRef} facesRef={facesRef} peopleRef={people.latestRef} config={resolved} video={video} fit={overlayFit} depth={depth} />
        )}
        {handsOn && (
          <HandsOverlay resultRef={handsRef} config={resolved} video={video} fit={overlayFit} />
        )}
        {want2D && (
          <ModifierOverlay effects={normalized.effects} handsRef={handsRef} motionRef={resultRef} facesRef={facesRef} peopleRef={people.latestRef} audioRef={audioRef} video={video} fit={overlayFit} depth={depth} config={resolved} opNodes={normalized.opNodes} cameraRef={cameraRef} />
        )}
        <SplatMask effects={normalized.effects} splatRef={splatRef} handsRef={handsRef} motionRef={resultRef} facesRef={facesRef} peopleRef={people.latestRef} audioRef={audioRef} video={video} config={resolved} depth={depth} opNodes={normalized.opNodes} />
        {constellation3D && (
          <Constellation3D resultRef={resultRef} depth={depth} video={video}
            config={resolved} cameraRef={cameraRef} />
        )}
        {!video && sourceMode === "file" && (
          <div className="hint">
            <p>загрузи видеофайл справа →</p>
            <small>2D-слои работают сразу; 3D-облако качает веса Depth Anything (~50 МБ)</small>
          </div>
        )}
        {!video && sourceMode === "stream" && (
          <div className="hint">
            <p>📱 ждём поток с телефона…</p>
            <small>открой ссылку/QR из панели на айфоне (один WiFi, разреши камеру)</small>
          </div>
        )}
        {!video && sourceMode === "kinect" && (
          <div className="hint">
            <p>🎮 ждём Kinect…</p>
            <small>мок генерит синтетику; для железа — запусти хост-мост и сними галочку «мок»</small>
          </div>
        )}
        {graphOpen && (
          <GraphView
            config={config}
            onSelectLayer={(id) => { layers.select(id); setRightOpen(true); }}
            onSelectEffect={(id) => { layers.selectEffect(id); setRightOpen(true); }}
            onSetEnabled={(effectId, enabled) => layers.setEffectEnabled(effectId, enabled)}
            handsRef={handsRef} motionRef={resultRef} facesRef={facesRef} peopleRef={people.latestRef} audioRef={audioRef}
            producers={resolved.producers} depth={depth} mapNodes={resolved.mapNodes}
            onAddEffect={(kind) => {
              // T0c: источник по умолчанию — id выбранного продюсер-слоя, иначе первого существующего
              // (резолвер примет и вид как фолбэк, но id точнее для мультиэкземпляра).
              const sel = config.layers.find((l) => l.id === selectedLayerId && isPointProducer(l.kind));
              const first = config.layers.find((l) => isPointProducer(l.kind));
              const source = sel?.id ?? first?.id ?? POINT_PRODUCERS[0];
              layers.addEffect(kind, source);
            }}
            onAddLayer={(kind) => layers.add(kind)}
            onSetLayerEnabled={(id, enabled) => layers.setEnabled(id, enabled)}
            onRemoveLayer={(id) => layers.remove(id)}
            onRemoveEffect={(effectId) => layers.removeEffect(effectId)}
            // T0e: РЁБРА АВТОРИТЕТНЫ. Провод в графе = ребро дока; все легаси-каналы
            // (source/bindings/op.input/setAttr*/shaderFxOrder) выводит компилятор (applyGraph),
            // зеркалирование для экспорта делает withEdge/withoutEdge (mirrorGraphToChannels).
            onAddEdge={(from, to) => setConfig((c) => withEdge(c, { from, to }))}
            onRemoveEdge={(key) => setConfig((c) => withoutEdge(c, key))}
            onSetNodePos={(id, p) => setConfig((c) => ({
              ...c,
              graph: { edges: c.graph?.edges ?? [], pos: { ...(c.graph?.pos ?? {}), [id]: p } },
            }))}
            onSetComposite={(p) => patch(p)} // T3 Composite: нода Композит пишет глобалы order/blend

            onAddOpNode={(kind: OpKind) => setConfig((c) => {
              const id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : "op_" + Date.now().toString(36);
              const op = { id, op: kind, input: "none", ...OP_DEFS[kind].defaults } as OpNode;
              return { ...c, opNodes: [...(c.opNodes ?? []), op] };
            })}
            onSetOpNodeParams={(opId, p) => setConfig((c) => ({
              ...c, opNodes: (c.opNodes ?? []).map((o) => (o.id === opId ? { ...o, ...p } : o)),
            }))}
            onRemoveOpNode={(opId) => setConfig((c) => withoutNodeEdges({
              ...c,
              opNodes: (c.opNodes ?? []).filter((o) => o.id !== opId),
              effects: c.effects.map((e) => {
                if (!e.bindings) return e;
                const next = { ...e.bindings };
                for (const [f, b] of Object.entries(next)) if (b.signal === "op:" + opId) delete next[f];
                return { ...e, bindings: next };
              }),
            }, opId))}
            // T0b граф-менеджмент: copy/paste/duplicate. Клонируем ТОЛЬКО мультиэкземплярные
            // сущности (effects/opNodes) с новым id; глубокая копия params/bindings (JSON-safe).
            // T0e: клонам также копируются ВХОДЯЩИЕ рёбра оригинала (+ out->Экран у эффектов) —
            // дубль сразу живой, как оригинал.
            onDuplicateNodes={(effectIds, opIds) => setConfig((c) => {
              const nid = () => (typeof crypto !== "undefined" && crypto.randomUUID)
                ? crypto.randomUUID() : "dup_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
              const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
              const pairs: [string, string][] = [];
              const newEffects = effectIds
                .map((id) => c.effects.find((e) => e.id === id))
                .filter((e): e is NonNullable<typeof e> => !!e)
                .map((e) => { const id = nid(); pairs.push([e.id, id]); return { ...clone(e), id }; });
              const newOps = opIds
                .map((id) => (c.opNodes ?? []).find((o) => o.id === id))
                .filter((o): o is NonNullable<typeof o> => !!o)
                .map((o) => { const id = nid(); pairs.push([o.id, id]); return { ...clone(o), id }; });
              if (!newEffects.length && !newOps.length) return c;
              const baseEdges = c.graph?.edges ?? [];
              const cloned = pairs.flatMap(([oldId, newId]) => baseEdges
                .filter((e) => e.to.node === oldId || (e.from.node === oldId && e.to.node === "screen"))
                .map((e) => ({
                  from: e.from.node === oldId ? { ...e.from, node: newId } : e.from,
                  to: e.to.node === oldId ? { ...e.to, node: newId } : e.to,
                })));
              return {
                ...c,
                effects: [...c.effects, ...newEffects],
                opNodes: [...(c.opNodes ?? []), ...newOps],
                graph: { edges: [...baseEdges, ...cloned], pos: c.graph?.pos ?? {} },
              };
            })}
            onUndo={undo} onRedo={redo}
            onClose={() => setGraphOpen(false)}
          />
        )}
      </div>
      {rightOpen ? (
        <Controls config={config} onChange={patch} layers={layers} onCollapse={() => setRightOpen(false)} />
      ) : (
        <div className="spine right" title="развернуть" onClick={() => setRightOpen(true)}>
          <span>« слои</span>
        </div>
      )}
    </div>
  );
}
