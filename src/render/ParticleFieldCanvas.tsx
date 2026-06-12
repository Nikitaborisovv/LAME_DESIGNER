// T5 v2: React-обёртка жизненного цикла ParticleField (config-driven мульти-система частиц).
// Монтируется, когда в графе есть ≥1 цепочка Emitter→…→Render (pull, App решает по
// resolved.particleSystems) → свежий канвас на включение, полный dispose на выключении.
//
// МОСТ CPU→GPU (§3.6.12): emitter.sourceRef резолвится через тот же DataBus-вход, что ModifierOverlay
// (fieldForLayerId + PointResultRefs), на НИЗКОЙ частоте (throttle ~12Гц, НЕ каждый кадр — разделение
// частот). Точки нормированы 0..1 → spawn-буфер [nx,ny,nz, r,g,b]×N → ParticleField.setSpawn; GPU
// респавнит частицы из него. Cd точки (SetAttr(Cd)→Emitter) тинтует частицу при рождении.

import { useEffect, useRef } from "react";
import type { HandResult, VisionResult, FaceResult, PeopleFrame, SceneConfig, OpNode, ResolvedParticleSystem } from "../core/types";
import { getPointAttrVec } from "../core/types";
import type { DepthApi } from "../ml/useDepth";
import type { AudioBands } from "../ml/useAudio";
import { fieldForLayerId, setParticleReadback, pruneParticleReadback, readbackToField, resolveProducerMaps, type PointResultRefs } from "../core/pointSources";
import { mapForRef } from "../core/mapSources";
import { LAYER_DEFS } from "../core/layerRegistry";
import { computeDrivers, compileFieldFn } from "../core/drivers";
import { ParticleField, type ExtCamPose, type ParticleBackend } from "./particles/ParticleField";

const SPAWN_CAP = 4096; // паритет с ParticleSystem.SPAWN_CAP

interface Props {
  systems: ResolvedParticleSystem[];
  config: SceneConfig;
  video: HTMLVideoElement | null;
  handsRef: React.MutableRefObject<HandResult>;
  motionRef: React.MutableRefObject<VisionResult>;
  facesRef: React.MutableRefObject<FaceResult>;
  peopleRef: React.MutableRefObject<PeopleFrame | null>;
  audioRef?: { current: AudioBands | null };
  depth?: DepthApi;
  opNodes?: OpNode[];
  zIndex?: number;
  onBackend?: (b: ParticleBackend | null) => void;
  // Камера облака (App.cameraRef): при активном cloud частицы СЛЕДУЮТ за ней — единое
  // 3D-пространство (мышь крутит облако, частицы вращаются синхронно). readonly current —
  // ковариантность: App отдаёт ref c THREE.Camera, нам хватает позы (структурный ExtCamPose).
  cloudCameraRef?: { readonly current: ExtCamPose | null };
}

export function ParticleFieldCanvas(props: Props) {
  const { systems, zIndex = 2, onBackend } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fieldRef = useRef<ParticleField | null>(null);
  // живые пропы для rAF-цикла (без переподписки эффекта-маунта).
  const pr = useRef(props);
  pr.current = props;

  // Маунт: один ParticleField на жизнь канваса (init/rAF/dispose).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true;
    let raf = 0;
    let last = 0;
    let lastSpawn = 0;
    let lastReadback = 0;       // U2: таймстамп прошлого GPU→CPU readback (Particles→Points)
    let readbackBusy = false;   // гард: не накладывать async-readback'и (getArrayBufferAsync) друг на друга
    const field = new ParticleField(canvas);
    fieldRef.current = field;
    const spawnScratch = new Float32Array(SPAWN_CAP * 6);
    // Кадр видео для ЦВЕТА частиц (map-эмиссия — GPU-сэмпл; points без Cd — CPU-сэмпл здесь же).
    // Off-DOM канвас 128×128 (= VID_TEX системы), выгребается на том же ~12Гц-троттле моста.
    const VID = 128;
    const vidCanvas = document.createElement("canvas");
    vidCanvas.width = VID; vidCanvas.height = VID;
    const vidCtx = vidCanvas.getContext("2d", { willReadFrequently: true });

    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) field.resize(r.width, r.height);
    });
    ro.observe(canvas);

    // Резолв spawn-буферов всех систем из DataBus (throttle). Снапшот-потребитель (frameTick не шлём —
    // не мутируем trail-стейт владельца, [[procedural-node-system-v2]] Trail).
    const resolveSpawns = () => {
      const p = pr.current;
      const v = p.video;
      const va = (v && v.videoWidth / v.videoHeight) || 16 / 9;
      field.setVideoAspect(va);
      field.setDepthScale(Number(p.config.depthScale) || 0.5); // выраженность 3D-экструзии — из конфига
      // кадр видео → цвет частиц (uv-aligned: кадр растянут в VID×VID, как карта глубины)
      let vidPixels: Uint8ClampedArray | null = null;
      if (v && v.readyState >= 2 && v.videoWidth > 0 && vidCtx) {
        try {
          vidCtx.drawImage(v, 0, 0, VID, VID);
          vidPixels = vidCtx.getImageData(0, 0, VID, VID).data;
        } catch { vidPixels = null; } // кадр недоступен (декодер/секьюрити) — белый
      }
      const dApi = p.depth;
      const producers = p.config.producers ?? [];
      const depthFrame = dApi?.smoothedRef.current ?? dApi?.latestRef.current ?? null;
      const needDepth = producers.some((x) => x.kind === "scatter" || x.kind === "sample");
      const sources: PointResultRefs = {
        motion: p.motionRef.current, hands: p.handsRef.current,
        faces: p.facesRef.current, people: p.peopleRef.current,
        depth: needDepth ? depthFrame : null,
        producers,
      };
      // field-входы конвертеров (setAttr-сигнал/selection) — компилируем (как ModifierOverlay).
      const drivers = computeDrivers({ ...sources, audio: p.audioRef?.current ?? undefined });
      const layerFieldFns: NonNullable<PointResultRefs["layerFieldFns"]> = {};
      for (const prod of producers) {
        for (const fi of LAYER_DEFS[prod.kind]?.fieldInputs ?? []) {
          const sig = prod.params[fi.param];
          if (!sig || sig === "none") continue;
          const cf = compileFieldFn(sig as string, drivers, p.opNodes);
          (layerFieldFns[prod.id] ??= {})[fi.param] = cf.perElement ? cf.fn! : cf.value;
        }
      }
      sources.layerFieldFns = layerFieldFns;
      const mapTime = performance.now() / 1000;
      // B-раунд-2: Map2D-источники Scatter (если scatter→Emitter.points) → кадры-карты (паритет).
      sources.layerMaps = resolveProducerMaps(producers, { depth: depthFrame, mapNodes: p.config.mapNodes, time: mapTime });
      for (const sys of pr.current.systems) {
        // map-вход (Map2D): резолвим цепочку карт (Phase B: Видео.глубина / noise2d / mapCombine →
        // глубина×нойз) в кадр через CPU-резолвер, грузим в систему. mapRef пуст → выключаем map-ветку.
        const mref = sys.emitters[0]?.mapRef;
        field.setMap(sys.id, mref ? mapForRef(mref, { depth: depthFrame, mapNodes: p.config.mapNodes, time: mapTime }) : null);
        field.setVideoFrame(sys.id, mref ? vidPixels : null); // цвет map-эмиссии = кадр видео
        const ref = sys.emitters[0]?.sourceRef;
        if (!ref || ref === "none") { field.setSpawn(sys.id, spawnScratch, 0); continue; }
        const pf = fieldForLayerId(ref, sources);
        if (!pf || !pf.groups.length) { field.setSpawn(sys.id, spawnScratch, 0); continue; }
        let k = 0;
        for (const g of pf.groups) {
          for (let j = 0; j < g.points.length && k < SPAWN_CAP; j++) {
            const pt = g.points[j];
            const cd = getPointAttrVec(g, "Cd", j); // наследованный цвет (или undefined)
            spawnScratch[k * 6] = pt.x; spawnScratch[k * 6 + 1] = pt.y; spawnScratch[k * 6 + 2] = pt.z ?? 0;
            if (cd) {
              spawnScratch[k * 6 + 3] = cd[0]; spawnScratch[k * 6 + 4] = cd[1]; spawnScratch[k * 6 + 5] = cd[2];
            } else if (vidPixels) {
              // без Cd — цвет КАДРА ВИДЕО под точкой (attribfrommap→Cd; CPU-сэмпл дёшев на ≤4096 точек)
              const px = (Math.min(VID - 1, (pt.y * VID) | 0) * VID + Math.min(VID - 1, (pt.x * VID) | 0)) * 4;
              spawnScratch[k * 6 + 3] = vidPixels[px] / 255;
              spawnScratch[k * 6 + 4] = vidPixels[px + 1] / 255;
              spawnScratch[k * 6 + 5] = vidPixels[px + 2] / 255;
            } else {
              spawnScratch[k * 6 + 3] = 1; spawnScratch[k * 6 + 4] = 1; spawnScratch[k * 6 + 5] = 1;
            }
            k++;
          }
          if (k >= SPAWN_CAP) break;
        }
        field.setSpawn(sys.id, spawnScratch, k);
      }
    };

    // U2 (направление U): Particles→Points. На НИЗКОЙ частоте (~7Гц) читаем популяцию систем,
    // на которые ссылаются конвертеры particlesToPoints, в CPU-PointSet (модульный стор pointSources).
    // GPU→CPU readback легален вне кадра рендера; гард readbackBusy не накладывает async-вызовы.
    const doReadback = async () => {
      readbackBusy = true;
      try {
        const cfg = pr.current.config;
        const convs = (cfg.producers ?? []).filter((p) => p.kind === "particlesToPoints");
        const keep = new Set<string>();
        if (convs.length) {
          // renderId → sysId (системы несут renderId-терминал; конвертер ссылается на Render-ноду).
          // ГОЧА (L1): buildParticleSystems дедуплит по эмиттеру — ОДНА система на эмиттер, renderId =
          // ПЕРВЫЙ Render. Конвертер на ВТОРОЙ Render той же цепочки → sysByRender промах → пусто (мягко).
          const sysByRender = new Map<string, string>();
          for (const s of pr.current.systems) if (s.renderId) sysByRender.set(s.renderId, s.id);
          for (const c of convs) {
            const renderId = String(c.params.particlesSource ?? "");
            if (!renderId || renderId === "none") continue;
            keep.add(renderId);
            const sysId = sysByRender.get(renderId);
            if (!sysId) { setParticleReadback(renderId, null); continue; }
            const withColor = !!c.params.p2pColor; // U3: Cd сквозь границу (второй readback по флагу)
            const flat = await field.readback(sysId, Number(c.params.p2pMaxPoints ?? 1500), withColor);
            if (!alive) return;
            setParticleReadback(renderId, readbackToField(flat, withColor));
          }
        }
        pruneParticleReadback(keep); // эвикт записей снятых/удалённых конвертеров
      } finally {
        readbackBusy = false;
      }
    };

    const initP = field.init().then(async () => {
      if (!alive) return;
      onBackend?.(field.backend);
      if (import.meta.env.DEV) (window as unknown as { __particleField?: unknown }).__particleField = field;
      const r = canvas.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) field.resize(r.width, r.height);
      await field.update(pr.current.systems);
      if (!alive) return;
      last = performance.now();
      const loop = (t: number) => {
        if (!alive) return;
        const dt = t - last;
        last = t;
        if (t - lastSpawn > 80) { lastSpawn = t; resolveSpawns(); } // ~12Гц мост точек
        if (!readbackBusy && t - lastReadback > 140) { lastReadback = t; void doReadback(); } // ~7Гц Particles→Points
        // единое пространство: при активном cloud и снятом фронт-замке следуем cloud-камере
        const pc = pr.current;
        const follow = pc.config.renderMode === "cloud" && !pc.config.frontLock
          ? (pc.cloudCameraRef?.current ?? null) : null;
        field.setExternalCamera(follow);
        field.frame(dt);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }).catch((e) => console.error("[ParticleFieldCanvas] init failed", e));

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      pruneParticleReadback(new Set()); // U2: канвас частиц ушёл — чистим стор readback'а (нет GPU-источника)
      initP.finally(() => field.dispose()); // dispose только после резолва init (как спайк)
      fieldRef.current = null;
      onBackend?.(null);
      if (import.meta.env.DEV) delete (window as unknown as { __particleField?: unknown }).__particleField;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Дифф систем (add/remove/restructure/params) — при смене particleSystems (config), НЕ каждый кадр.
  useEffect(() => {
    fieldRef.current?.update(systems);
  }, [systems]);

  // Камера: frontLock (фронт-вид на кадр) ↔ свободная орбита (как cloud). При unlock канвас частиц
  // включает pointerEvents (ловит мышь для OrbitControls) — НО только когда cloud НЕ активен:
  // при активном облаке мышь принадлежит cloud-канвасу (частицы follow'ят его камеру), иначе
  // канвас частиц перехватывал бы ввод и «облако не вращается».
  useEffect(() => {
    const lock = props.config.frontLock;
    const cloudActive = props.config.renderMode === "cloud";
    fieldRef.current?.setFrontLock(lock);
    const cv = canvasRef.current;
    if (cv) cv.style.pointerEvents = lock || cloudActive ? "none" : "auto";
  }, [props.config.frontLock, props.config.renderMode]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex, pointerEvents: "none" }}
    />
  );
}
