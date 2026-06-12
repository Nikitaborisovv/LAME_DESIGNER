import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useFBO } from "@react-three/drei";
import * as THREE from "three";
import type { SceneConfig, ParamBinding, OpNode, HandResult, VisionResult, FaceResult, PeopleFrame } from "../core/types";
import type { DepthApi } from "../ml/useDepth";
import type { PeopleApi } from "../ml/usePeople";
import type { SegmentationApi } from "../ml/useSegmentation";
import type { SplatApi } from "../ui/SplatMask";
import type { AudioBands } from "../ml/useAudio";
import { computeDrivers, drivenValue, type DriverValues } from "../core/drivers";
import { flatVertex, flatFragment, emissiveFragment, blurFragment, thermalPassFragment, sobelPassFragment, pixelArtPassFragment, scanlinesPassFragment, pixelatePassFragment, lookupPassFragment, feedbackPassFragment, mirrorPassFragment, displacePassFragment, chromAbPassFragment, grainPassFragment } from "./flatShader";
import { perf } from "../core/perf";

// Driver-рефы для биндабельных params shader-FX (direction A): тот же DataBus-вход, что у
// ModifierOverlay/SplatMask. FlatView computeDrivers'ит из них в кадре и резолвит pass.bindings.
export interface FxDriverRefs {
  handsRef: React.MutableRefObject<HandResult>;
  motionRef: React.MutableRefObject<VisionResult>;
  facesRef: React.MutableRefObject<FaceResult>;
  peopleRef: React.MutableRefObject<PeopleFrame | null>;
  audioRef?: { current: AudioBands | null };
  opNodes?: OpNode[]; // Math-цепочки (binding.signal = "op:"+id)
}

interface Props {
  video: HTMLVideoElement | null;
  config: SceneConfig;
  fit?: "cover" | "contain";
  transparentVideo?: boolean; // верхний слой композита: видео скрыто, только эффекты
  depth?: DepthApi; // для пикселизации по глубине
  people?: PeopleApi; // маски людей (YOLOv8-seg)
  seg?: SegmentationApi; // гладкая маска людей (MediaPipe Selfie) — гибридная заливка
  splat?: SplatApi; // splat-маска (конвертер PointSet->Map2D) — композит форм в видео
  fxDrivers?: FxDriverRefs; // direction A: сигналы для биндабельных params shader-FX
}

// Наборы символов ASCII (слева = светлее, справа = плотнее) для атласа глифов.
const ASCII_MODES: Record<string, string> = {
  ramp: " .:-=+*#%@",
  retro: " .:-+xoO0#@",   // старый набор: кружочки (o/O/0) и полосочки (:/-/+)
  letters: " .,:iclvoxznykaeqOQ8B&@",
  digits: " 1234567890",
  blocks: " ░▒▓█",
  binary: " 01",
};

const EMPTY_DEPTH = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
const EMPTY_MASK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
const EMPTY_SELFIE = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
const EMPTY_SPLAT = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);

// direction A: наложить драйверы на числовые params shader-FX прохода. Возвращает params БЕЗ копии,
// если активных привязок нет (ноль аллокаций в кадре), иначе shallow-копию с заменёнными полями.
// EMA-сглаживание (тот же закон, что в ModifierOverlay): a = 1 - smooth^(dt·60), кадронезависимо.
function applyFxBindings(
  params: SceneConfig, bindings: Record<string, ParamBinding> | undefined,
  passId: string, d: DriverValues, sm: Map<string, number>, dt: number, ops?: OpNode[],
): SceneConfig {
  if (!bindings) return params;
  let out: SceneConfig | null = null;
  for (const field in bindings) {
    const b = bindings[field];
    if (!b || (b.driver === "none" && !b.signal)) continue;
    const target = drivenValue(b, d, ops);
    const k = passId + ":" + field;
    const prev = sm.get(k);
    let v: number;
    if (prev === undefined) v = target;
    else {
      const sc = Math.min(0.999, Math.max(0, b.smooth ?? 0));
      const a = sc <= 0 ? 1 : 1 - Math.pow(sc, dt * 60);
      v = prev + (target - prev) * a;
    }
    sm.set(k, v);
    if (!out) out = { ...params };
    (out as unknown as Record<string, number>)[field] = v;
  }
  return out ?? params;
}

// Полноэкранный quad с видео-текстурой и 2D-эффектами (flat-режим / верхний слой 3D).
export function FlatView({ video, config, fit = "cover", transparentVideo = false, depth, people, seg, splat, fxDrivers }: Props) {
  const { size, gl } = useThree();
  const depthTex = useRef(EMPTY_DEPTH);
  const maskTex = useRef(EMPTY_MASK);
  const selfieTex = useRef(EMPTY_SELFIE);
  const frameCount = useRef(0);
  // direction A: рефы сигналов для биндабельных params + EMA-сглаживание привязок (ключ `${passId}:${field}`).
  const fxDriversRef = useRef(fxDrivers);
  fxDriversRef.current = fxDrivers;
  const fxSmooth = useRef<Map<string, number>>(new Map());

  // Хранилище пар RT для feedback-инстансов (ключ = pass.id).
  // Каждому инстансу — СВОЯ пара read/write (ping-pong внутри инстанса).
  const feedbackHistory = useRef<Map<string, { read: THREE.WebGLRenderTarget; write: THREE.WebGLRenderTarget }>>(new Map());
  // Переиспользуемый scratch-Set для свипа сирот (правило 2: без аллокаций в кадре).
  const feedbackActiveIds = useRef<Set<string>>(new Set());

  // T0e pull: videoToScreen=false (нет пути Видео→Экран в графе) = кадр не рисуем вовсе —
  // тот же путь, что «видео не загружено» (чёрный фон, оверлеи поверх живут).
  const colorTex = useMemo(() => {
    if (!video || config.videoToScreen === false) return null;
    const t = new THREE.VideoTexture(video);
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    return t;
  }, [video, config.videoToScreen]);

  // Атлас глифов ASCII: один ряд символов выбранного режима (canvas -> текстура).
  const ascii = useMemo(() => {
    const chars = ASCII_MODES[config.pixelArtAsciiMode] ?? ASCII_MODES.ramp;
    const cell = 24, w = chars.length * cell, h = cell;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.round(cell * 0.92)}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < chars.length; i++) ctx.fillText(chars[i], i * cell + cell / 2, cell / 2 + 1);
    const t = new THREE.CanvasTexture(cv);
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return { tex: t, count: chars.length };
  }, [config.pixelArtAsciiMode]);

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: flatVertex,
      fragmentShader: flatFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTex: { value: colorTex },
        uTexel: { value: new THREE.Vector2(1 / 640, 1 / 360) },
        uVideoAspect: { value: 16 / 9 },
        uViewAspect: { value: 16 / 9 },
        uFit: { value: 0 },
        uTransparentVideo: { value: 0 },
        uHideVideo: { value: 0 },
        uPixelArt: { value: 0 },
        uPixelArtSize: { value: 8 },
        uPixelArtAscii: { value: 0 },
        uPixelArtMono: { value: 0 },
        uPixelArtLevels: { value: 4 },
        uPalette: { value: Array.from({ length: 16 }, () => new THREE.Color("#000000")) },
        uPAAsciiTint: { value: 0 },
        uPAAsciiColor: { value: new THREE.Color("#ff2d8e") },
        uAsciiAtlas: { value: null as THREE.Texture | null },
        uAsciiCount: { value: 10 },
        uGlowMask: { value: new Array(16).fill(0) as number[] },
        uGlowSize: { value: 1.5 },
        uGlowIntensity: { value: 1.2 },
        uBloom: { value: null as THREE.Texture | null },
        uBloomOn: { value: 0 },
        uTime: { value: 0 },
        uThermal: { value: 0 },
        uThermalCold: { value: new THREE.Color("#05011a") },
        uThermalHot: { value: new THREE.Color("#fff3c0") },
        uSobel: { value: 0 },
        uSobelOnly: { value: 0 },
        uSobelColor: { value: new THREE.Color("#33ffaa") },
        uSobelThickness: { value: 1 },
        uSobelTolerance: { value: 0 },
        uSobelPixelate: { value: 0 },
        uScanlines: { value: 0 },
        uDepthMap: { value: EMPTY_DEPTH },
        uHasDepth: { value: 0 },
        uPixNear: { value: 2 },
        uPixFar: { value: 24 },
        uRampNear: { value: 1 },
        uRampFar: { value: 0 },
        uPixGrid: { value: 1 },
        uPixBlur: { value: 0 },
        uMask: { value: EMPTY_MASK },
        uMaskOn: { value: 0 },
        uMaskMul: { value: new THREE.Vector2(1, 1) },
        uMaskOff: { value: new THREE.Vector2(0, 0) },
        uMaskTexel: { value: new THREE.Vector2(1, 1) },
        uMaskFill: { value: 1 },
        uMaskOutline: { value: 1 },
        uMaskFillOpacity: { value: 0.45 },
        uMaskFillOpacity2: { value: 0.45 },
        uSplat: { value: EMPTY_SPLAT },
        uSplatOn: { value: 0 },
        uSplatMode: { value: 0 },
        uSelfie: { value: EMPTY_SELFIE },
        uSelfieOn: { value: 0 },
        uSelfieMul: { value: new THREE.Vector2(1, 1) },
        uSelfieOff: { value: new THREE.Vector2(0, 0) },
        uSelfieFeather: { value: 0.08 },
        uSelfieThreshold: { value: 0.62 },
        uSelfieTexel: { value: new THREE.Vector2(1 / 256, 1 / 256) },
        uPeopleColor: { value: new THREE.Color("#36e6ff") },
        uPeopleColor2: { value: new THREE.Color("#ff36a0") },
        uPeopleFillGradient: { value: 1 },
        uOutlineColor: { value: new THREE.Color("#39ff8b") },
        uOutlineColor2: { value: new THREE.Color("#36e6ff") },
        uPeopleOutlineGradient: { value: 1 },
        uGradByInstance: { value: 0 },
      },
    });
  }, [colorTex]);

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), []);

  // --- bloom-проход для свечения: эмиссия -> сепарабельный гаусс в FBO (низкое разрешение) ---
  const BW = 640, BH = 360;
  const rtE = useFBO(BW, BH, { depthBuffer: false });
  const rtA = useFBO(BW, BH, { depthBuffer: false });
  const rtB = useFBO(BW, BH, { depthBuffer: false });
  const bloom = useMemo(() => {
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    scene.add(quad);
    const emat = new THREE.ShaderMaterial({
      vertexShader: flatVertex, fragmentShader: emissiveFragment, depthTest: false, depthWrite: false,
      uniforms: {
        uTex: { value: null }, uTexel: { value: new THREE.Vector2(1 / 640, 1 / 360) },
        uVideoAspect: { value: 16 / 9 }, uViewAspect: { value: 16 / 9 }, uFit: { value: 1 },
        uOn: { value: 0 }, uLevels: { value: 4 },
        uPalette: { value: Array.from({ length: 16 }, () => new THREE.Color("#000000")) },
        uGlowMask: { value: new Array(16).fill(0) as number[] },
      },
    });
    const bmat = new THREE.ShaderMaterial({
      vertexShader: flatVertex, fragmentShader: blurFragment, depthTest: false, depthWrite: false,
      uniforms: { uTex: { value: null as THREE.Texture | null }, uDir: { value: new THREE.Vector2() } },
    });
    return { scene, cam, quad, emat, bmat };
  }, []);

  // --- Фаза B: движок цепочки map→map FBO-проходов (ping-pong, 2 RT) ---
  // Каждый извлечённый 2D-эффект — отдельный полноэкранный проход; выходы чейнятся (ping-pong
  // между fxRTA/fxRTB), финал подаётся мега-шейдеру как `uTex` вместо сырого видео. Так FX —
  // настоящие map→map узлы (TD-стиль), мега-шейдер дотягивает композит. Извлечены: Тепловизор (B1),
  // Sobel (B2). Порядок проходов фиксирован (thermal→sobel); порядок-по-рёбрам придёт в B5.
  const mkRT = () => {
    const rt = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: false, stencilBuffer: false });
    rt.texture.colorSpace = THREE.SRGBColorSpace; // зеркалим colorTex — round-trip без сдвига цвета
    rt.texture.minFilter = THREE.LinearFilter;
    rt.texture.magFilter = THREE.LinearFilter;
    return rt;
  };
  const fxRTA = useMemo(mkRT, []);
  const fxRTB = useMemo(mkRT, []);
  const fxChain = useMemo(() => {
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    scene.add(quad);
    const thermalMat = new THREE.ShaderMaterial({
      vertexShader: flatVertex, fragmentShader: thermalPassFragment, depthTest: false, depthWrite: false,
      uniforms: {
        uTex: { value: null as THREE.Texture | null }, uThermal: { value: 0 },
        uThermalCold: { value: new THREE.Color("#05011a") }, uThermalHot: { value: new THREE.Color("#fff3c0") },
      },
    });
    const sobelMat = new THREE.ShaderMaterial({
      vertexShader: flatVertex, fragmentShader: sobelPassFragment, depthTest: false, depthWrite: false,
      uniforms: {
        uTex: { value: null as THREE.Texture | null }, uTexel: { value: new THREE.Vector2(1 / 640, 1 / 360) },
        uSobel: { value: 1 }, uSobelOnly: { value: 0 }, uSobelColor: { value: new THREE.Color("#33ffaa") },
        uSobelThickness: { value: 1 }, uSobelTolerance: { value: 0 }, uSobelPixelate: { value: 0 },
      },
    });
    const pixelArtMat = new THREE.ShaderMaterial({
      vertexShader: flatVertex, fragmentShader: pixelArtPassFragment, depthTest: false, depthWrite: false,
      uniforms: {
        uTex: { value: null as THREE.Texture | null }, uTexel: { value: new THREE.Vector2(1 / 640, 1 / 360) },
        uPixelArtSize: { value: 8 }, uPixelArtAscii: { value: 0 }, uPixelArtMono: { value: 0 }, uPixelArtLevels: { value: 4 },
        uPalette: { value: Array.from({ length: 16 }, () => new THREE.Color("#000000")) },
        uPAAsciiTint: { value: 0 }, uPAAsciiColor: { value: new THREE.Color("#ff2d8e") },
        uAsciiAtlas: { value: null as THREE.Texture | null }, uAsciiCount: { value: 10 },
      },
    });
    const scanlinesMat = new THREE.ShaderMaterial({
      vertexShader: flatVertex, fragmentShader: scanlinesPassFragment, depthTest: false, depthWrite: false,
      uniforms: { uTex: { value: null as THREE.Texture | null }, uScanlines: { value: 0 } },
    });
    const pixelateMat = new THREE.ShaderMaterial({
      vertexShader: flatVertex, fragmentShader: pixelatePassFragment, depthTest: false, depthWrite: false,
      uniforms: {
        uTex: { value: null as THREE.Texture | null }, uTexel: { value: new THREE.Vector2(1 / 640, 1 / 360) },
        uDepthMap: { value: EMPTY_DEPTH }, uHasDepth: { value: 0 },
        uPixNear: { value: 2 }, uPixFar: { value: 24 }, uRampNear: { value: 1 }, uRampFar: { value: 0 },
        uPixGrid: { value: 1 }, uPixBlur: { value: 0 },
      },
    });
    const lookupMat = new THREE.ShaderMaterial({
      vertexShader: flatVertex, fragmentShader: lookupPassFragment, depthTest: false, depthWrite: false,
      uniforms: {
        uTex: { value: null as THREE.Texture | null },
        uLookup: { value: Array.from({ length: 16 }, () => new THREE.Color("#000000")) },
        uLookupStops: { value: 4 },
        uLookupMix: { value: 1 },
      },
    });
    const feedbackMat = new THREE.ShaderMaterial({
      vertexShader: flatVertex, fragmentShader: feedbackPassFragment, depthTest: false, depthWrite: false,
      uniforms: {
        uTex: { value: null as THREE.Texture | null },
        uHistory: { value: null as THREE.Texture | null },
        uDecay: { value: 0.92 },
        uFbZoom: { value: 1.01 },
        uFbRotate: { value: 0.0 },
        uFbOffX: { value: 0.0 },
        uFbOffY: { value: 0.0 },
        uFbMode: { value: 0 },
      },
    });
    const mirrorMat = new THREE.ShaderMaterial({
      vertexShader: flatVertex, fragmentShader: mirrorPassFragment, depthTest: false, depthWrite: false,
      uniforms: {
        uTex: { value: null as THREE.Texture | null },
        uSectors: { value: 6 },
        uAngle: { value: 0 },
      },
    });
    const displaceMat = new THREE.ShaderMaterial({
      vertexShader: flatVertex, fragmentShader: displacePassFragment, depthTest: false, depthWrite: false,
      uniforms: {
        uTex: { value: null as THREE.Texture | null },
        uDisplaceAmount: { value: 0.03 },
        uDisplaceScale: { value: 8 },
        uDisplaceSpeed: { value: 1.0 },
        uTime: { value: 0 },
        uDisplaceMode: { value: 0 },
      },
    });
    const chromAbMat = new THREE.ShaderMaterial({
      vertexShader: flatVertex, fragmentShader: chromAbPassFragment, depthTest: false, depthWrite: false,
      uniforms: {
        uTex: { value: null as THREE.Texture | null },
        uChromAbAmount: { value: 0.008 },
        uChromAbAngle: { value: 0 },
        uChromAbMode: { value: 0 },
      },
    });
    const grainMat = new THREE.ShaderMaterial({
      vertexShader: flatVertex, fragmentShader: grainPassFragment, depthTest: false, depthWrite: false,
      uniforms: {
        uTex: { value: null as THREE.Texture | null },
        uGrainAmount: { value: 0.25 },
        uGrainSize: { value: 1 },
        uGrainColored: { value: 0 },
        uTime: { value: 0 },
      },
    });
    return { scene, cam, quad, thermalMat, sobelMat, pixelArtMat, scanlinesMat, pixelateMat, lookupMat, feedbackMat, mirrorMat, displaceMat, chromAbMat, grainMat };
  }, []);

  // Освобождение GPU-ресурсов: каждый useMemo диспозит СВОЁ предыдущее значение при смене
  // зависимости и при размонтировании (иначе утечка на каждом flat<->cloud переключении).
  // useFBO (rtE/rtA/rtB) drei диспозит сам на анмаунте. EMPTY_* — модульные синглтоны, не трогаем.
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => { colorTex?.dispose(); }, [colorTex]);
  useEffect(() => () => { ascii.tex.dispose(); }, [ascii]);
  useEffect(() => () => {
    bloom.quad.geometry.dispose();
    bloom.emat.dispose();
    bloom.bmat.dispose();
  }, [bloom]);
  useEffect(() => () => { fxRTA.dispose(); }, [fxRTA]);
  useEffect(() => () => { fxRTB.dispose(); }, [fxRTB]);
  useEffect(() => () => {
    fxChain.quad.geometry.dispose();
    fxChain.thermalMat.dispose();
    fxChain.sobelMat.dispose();
    fxChain.pixelArtMat.dispose();
    fxChain.scanlinesMat.dispose();
    fxChain.pixelateMat.dispose();
    fxChain.lookupMat.dispose();
    fxChain.feedbackMat.dispose();
    fxChain.mirrorMat.dispose();
    fxChain.displaceMat.dispose();
    fxChain.chromAbMat.dispose();
    fxChain.grainMat.dispose();
  }, [fxChain]);
  // Dispose всех feedback history RT на анмаунте (правило 5).
  useEffect(() => () => {
    feedbackHistory.current.forEach((e) => { e.read.dispose(); e.write.dispose(); });
    feedbackHistory.current.clear();
  }, []);
  // Текстуры масок/глубины живут в ref'ах (обновляются в useFrame) — чистим на анмаунте.
  useEffect(() => () => {
    if (depthTex.current !== EMPTY_DEPTH) depthTex.current.dispose();
    if (maskTex.current !== EMPTY_MASK) maskTex.current.dispose();
    if (selfieTex.current !== EMPTY_SELFIE) selfieTex.current.dispose();
  }, []);

  useFrame((_, delta) => {
    if (!video || video.readyState < 2) return;
    perf.tick("render.fps");
    const endJs = perf.mark("render.js"); // JS-часть кадра (обновление uniform'ов/текстур, без GPU)
    const u = material.uniforms;
    u.uTime.value += delta;
    frameCount.current++;

    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    u.uVideoAspect.value = vw / vh;
    u.uViewAspect.value = size.width / size.height;
    u.uFit.value = fit === "contain" ? 1 : 0;
    u.uTransparentVideo.value = transparentVideo ? 1 : 0;
    u.uHideVideo.value = config.hideVideo ? 1 : 0;

    // Пиксель-арт извлечён в map→map проход (B3): мега uPixelArt=0 (ставится в финале цепочки),
    // его render-uniform'ы (size/ascii/mono/levels/palette/atlas) — на pixelArtMat. Здесь — только
    // сила свечения для добавки bloom в мега-композите (сам bloom считается отдельным pre-pass'ом ниже).
    u.uGlowIntensity.value = config.pixelArtGlowIntensity;

    // --- bloom-проход: эмиссия светящихся цветов -> размытие в FBO -> uBloom ---
    const wantGlow = config.pixelArtEnabled && config.pixelArtMono &&
      config.pixelArtGlowIntensity > 0.001 && config.pixelArtGlowSize > 0.001 &&
      !!config.pixelArtGlowMask?.some(Boolean);
    if (wantGlow && colorTex) {
      const e = bloom.emat.uniforms;
      e.uTex.value = colorTex;
      (e.uTexel.value as THREE.Vector2).set(1 / vw, 1 / vh);
      e.uVideoAspect.value = vw / vh;
      e.uViewAspect.value = size.width / size.height;
      e.uFit.value = fit === "contain" ? 1 : 0;
      e.uOn.value = 1;
      e.uLevels.value = config.pixelArtLevels;
      { const pal = e.uPalette.value as THREE.Color[]; const sp = config.pixelArtPalette; for (let i = 0; i < 16; i++) pal[i].set(sp[i] ?? "#000000"); }
      { const gm = e.uGlowMask.value as number[]; const sp = config.pixelArtGlowMask; for (let i = 0; i < 16; i++) gm[i] = sp && sp[i] ? 1 : 0; }

      const prev = gl.getRenderTarget();
      bloom.quad.material = bloom.emat;
      gl.setRenderTarget(rtE);
      gl.render(bloom.scene, bloom.cam);
      const stepx = config.pixelArtGlowSize / BW, stepy = config.pixelArtGlowSize / BH;
      const blur = (s: THREE.WebGLRenderTarget, d: THREE.WebGLRenderTarget, dx: number, dy: number) => {
        bloom.quad.material = bloom.bmat;
        bloom.bmat.uniforms.uTex.value = s.texture;
        (bloom.bmat.uniforms.uDir.value as THREE.Vector2).set(dx, dy);
        gl.setRenderTarget(d);
        gl.render(bloom.scene, bloom.cam);
      };
      blur(rtE, rtA, stepx, 0); blur(rtA, rtB, 0, stepy);
      blur(rtB, rtA, stepx, 0); blur(rtA, rtB, 0, stepy);
      gl.setRenderTarget(prev);
      u.uBloom.value = rtB.texture;
      u.uBloomOn.value = 1;
    } else {
      u.uBloomOn.value = 0;
    }
    // Глубина для прохода «Пикселизация» (B4): тянем карту ДО цепочки, чтобы проход её сэмплил.
    let hasDepth = false;
    // T0c: глубину для пикселизации тянем, если в цепочке fxChain есть хоть один pixelate-инстанс.
    const wantPixelate = (config.fxChain ?? []).some((p) => p.kind === "pixelate");
    if (wantPixelate && depth) {
      if (frameCount.current % config.depthEveryNthFrame === 0) depth.submit(video);
      const frame = config.cacheEnabled && depth.hasCache()
        ? depth.getCached(video.currentTime)
        : (depth.smoothedRef.current ?? depth.latestRef.current);
      if (frame && (frame.width !== depthTex.current.image.width ||
          frame.height !== depthTex.current.image.height ||
          depthTex.current.image.data !== frame.data)) {
        const tex = new THREE.DataTexture(frame.data, frame.width, frame.height, THREE.RedFormat, THREE.UnsignedByteType);
        tex.needsUpdate = true;
        if (depthTex.current !== EMPTY_DEPTH) depthTex.current.dispose();
        depthTex.current = tex;
      }
      hasDepth = depthTex.current.image.width > 1;
    }

    // --- Цепочка map→map FBO-проходов (Фаза B): извлечённые FX обрабатывают видео ДО мега-шейдера,
    // ping-pong между fxRTA/fxRTB; финал → мега uTex. uTexel каждого прохода = 1/размер ЕГО входа.
    // Извлечены ВСЕ 2D-FX: Тепловизор/Sobel/Сканлайны/Пикселизация/Пиксель-арт (B1–B4). Мега
    // uThermal/uSobel/uScanlines/uHasDepth/uPixelArt=0 (всё сделано здесь). Порядок фикс. = SHADER_FX_KINDS
    // (граф-рёбра B5 структурны; edge-authoritative — позже). Мега теперь только композит.
    let srcTex: THREE.Texture | null = colorTex;
    let inW = vw, inH = vh;
    // T0c (instance-keyed): цепочка FX = резолвнутый config.fxChain — массив ИНСТАНСОВ shader-слоёв
    // в порядке цепочки, каждый со своими params. Снимает singleton: две thermal-ноды с разными
    // настройками = два прохода. Uniform'ы выставляем per-pass из pass.params (не из плоского config).
    const passes = config.fxChain ?? [];
    if (passes.length > 0 && colorTex) {
      const maxDim = 1600; // потолок размера FBO (4K-видео -> не плодим гигантский RT)
      const scale = Math.min(1, maxDim / Math.max(vw, vh));
      const cw = Math.max(1, Math.round(vw * scale));
      const ch = Math.max(1, Math.round(vh * scale));
      if (fxRTA.width !== cw || fxRTA.height !== ch) fxRTA.setSize(cw, ch);
      if (fxRTB.width !== cw || fxRTB.height !== ch) fxRTB.setSize(cw, ch);
      const rts = [fxRTA, fxRTB];
      const prev = gl.getRenderTarget();
      // uTime анимированных проходов тикается ОДИН раз за кадр (не в ветке: два инстанса
      // displace/grain в цепочке иначе гнали бы время в 2×).
      fxChain.displaceMat.uniforms.uTime.value += delta;
      fxChain.grainMat.uniforms.uTime.value += delta;
      // direction A: драйверы для биндабельных params — считаем ОДИН раз за кадр (общие на цепочку),
      // только если есть хоть один pass с непустыми bindings (иначе ноль работы). Тот же Reduce, что у
      // ModifierOverlay/SplatMask. drivers=null -> applyFxBindings возвращает params как есть.
      const fd = fxDriversRef.current;
      const anyBind = fd && passes.some((p) => p.bindings && Object.keys(p.bindings).length > 0);
      const drivers: DriverValues | null = anyBind
        ? computeDrivers({
            hands: fd!.handsRef.current, motion: fd!.motionRef.current,
            faces: fd!.facesRef.current, people: fd!.peopleRef.current,
            audio: fd!.audioRef?.current ?? undefined,
          })
        : null;
      const fxOps = fd?.opNodes;
      // dt для EMA клампим (паритет с ModifierOverlay): защита от телепорта после фоновой вкладки.
      const fxDt = Math.min(0.1, delta);
      for (let i = 0; i < passes.length; i++) {
        const dst = rts[i % 2]; // ping-pong: вход и выход — разные RT (i и i-1 чётность различна)
        // полный набор полей вида (resolveConfig слил с дефолтами) + наложенные драйверы (direction A).
        const pp = drivers
          ? applyFxBindings(passes[i].params as SceneConfig, passes[i].bindings, passes[i].id, drivers, fxSmooth.current, fxDt, fxOps)
          : (passes[i].params as SceneConfig);
        let mat: THREE.ShaderMaterial;
        if (passes[i].kind === "thermal") {
          mat = fxChain.thermalMat;
          const m = mat.uniforms;
          m.uTex.value = srcTex;
          m.uThermal.value = pp.thermalMix;
          (m.uThermalCold.value as THREE.Color).set(pp.thermalColdColor);
          (m.uThermalHot.value as THREE.Color).set(pp.thermalHotColor);
        } else if (passes[i].kind === "sobel") {
          mat = fxChain.sobelMat;
          const m = mat.uniforms;
          m.uTex.value = srcTex;
          (m.uTexel.value as THREE.Vector2).set(1 / inW, 1 / inH);
          m.uSobel.value = pp.sobelStrength;
          m.uSobelOnly.value = pp.sobelOnly ? 1 : 0;
          (m.uSobelColor.value as THREE.Color).set(pp.sobelColor);
          m.uSobelThickness.value = pp.sobelThickness;
          m.uSobelTolerance.value = pp.sobelTolerance;
          m.uSobelPixelate.value = pp.sobelPixelate;
        } else if (passes[i].kind === "scanlines") {
          mat = fxChain.scanlinesMat;
          mat.uniforms.uTex.value = srcTex;
          mat.uniforms.uScanlines.value = pp.scanlineIntensity;
        } else if (passes[i].kind === "pixelate") {
          mat = fxChain.pixelateMat;
          const m = mat.uniforms;
          m.uTex.value = srcTex;
          (m.uTexel.value as THREE.Vector2).set(1 / inW, 1 / inH);
          m.uDepthMap.value = depthTex.current;
          m.uHasDepth.value = hasDepth ? 1 : 0;
          m.uPixNear.value = pp.pixelateNear;
          m.uPixFar.value = pp.pixelateFar;
          m.uRampNear.value = pp.pixelateRampNear;
          m.uRampFar.value = pp.pixelateRampFar;
          m.uPixGrid.value = pp.pixelateGrid ? 1 : 0;
          m.uPixBlur.value = pp.pixelateBlur;
        } else if (passes[i].kind === "lookup") {
          mat = fxChain.lookupMat;
          const m = mat.uniforms;
          m.uTex.value = srcTex;
          {
            const lut = m.uLookup.value as THREE.Color[];
            const sp = pp.lookupColors;
            for (let k = 0; k < 16; k++) lut[k].set(sp[k] ?? sp[sp.length - 1] ?? "#000000");
          }
          m.uLookupStops.value = pp.lookupStops;
          m.uLookupMix.value = pp.lookupMix;
        } else if (passes[i].kind === "feedback") {
          // Feedback: рендерим в собственный write-RT инстанса (НЕ в общий ping-pong dst).
          // Ленивое создание и ресайз пары RT; очистка обеих при создании/ресайзе (правило 4).
          const passId = passes[i].id;
          let entry = feedbackHistory.current.get(passId);
          if (!entry) {
            const rA = mkRT(); rA.setSize(cw, ch);
            const rB = mkRT(); rB.setSize(cw, ch); // сразу нужный размер -> ресайз-ветка не пересоздаёт зря
            // Очистить обе новые RT (правило 4: иначе write покажет мусор).
            const prevRt = gl.getRenderTarget();
            gl.setRenderTarget(rA); gl.clear();
            gl.setRenderTarget(rB); gl.clear();
            gl.setRenderTarget(prevRt);
            entry = { read: rA, write: rB };
            feedbackHistory.current.set(passId, entry);
          }
          if (entry.read.width !== cw || entry.read.height !== ch) {
            // Ресайз: пересоздать оба RT и очистить (правило 4).
            entry.read.dispose(); entry.write.dispose();
            const rA = mkRT(); rA.setSize(cw, ch);
            const rB = mkRT(); rB.setSize(cw, ch);
            const prevRt = gl.getRenderTarget();
            gl.setRenderTarget(rA); gl.clear();
            gl.setRenderTarget(rB); gl.clear();
            gl.setRenderTarget(prevRt);
            entry.read = rA; entry.write = rB;
          }
          mat = fxChain.feedbackMat;
          const m = mat.uniforms;
          m.uTex.value = srcTex;
          m.uHistory.value = entry.read.texture;
          m.uDecay.value = pp.feedbackDecay;
          m.uFbZoom.value = pp.feedbackZoom;
          m.uFbRotate.value = pp.feedbackRotate;
          m.uFbOffX.value = pp.feedbackOffsetX;
          m.uFbOffY.value = pp.feedbackOffsetY;
          m.uFbMode.value = pp.feedbackMode === "add" ? 1 : 0;
          fxChain.quad.material = mat;
          gl.setRenderTarget(entry.write);
          gl.render(fxChain.scene, fxChain.cam);
          // Своп read/write (без new-объектов — меняем ссылки внутри entry).
          const tmp = entry.read; entry.read = entry.write; entry.write = tmp;
          srcTex = entry.read.texture;
          inW = cw; inH = ch;
          continue; // не пишем в общий dst — переходим к следующему проходу
        } else if (passes[i].kind === "mirror") {
          mat = fxChain.mirrorMat;
          const m = mat.uniforms;
          m.uTex.value = srcTex;
          m.uSectors.value = pp.mirrorSectors;
          m.uAngle.value = pp.mirrorAngle;
        } else if (passes[i].kind === "displace") {
          mat = fxChain.displaceMat;
          const m = mat.uniforms;
          m.uTex.value = srcTex;
          m.uDisplaceAmount.value = pp.displaceAmount;
          m.uDisplaceScale.value = pp.displaceScale;
          m.uDisplaceSpeed.value = pp.displaceSpeed;
          m.uDisplaceMode.value = pp.displaceMode === "self" ? 1 : 0;
        } else if (passes[i].kind === "chromAb") {
          mat = fxChain.chromAbMat;
          const m = mat.uniforms;
          m.uTex.value = srcTex;
          m.uChromAbAmount.value = pp.chromAbAmount;
          m.uChromAbAngle.value = pp.chromAbAngle;
          m.uChromAbMode.value = pp.chromAbMode === "linear" ? 1 : 0;
        } else if (passes[i].kind === "grain") {
          mat = fxChain.grainMat;
          const m = mat.uniforms;
          m.uTex.value = srcTex;
          m.uGrainAmount.value = pp.grainAmount;
          m.uGrainSize.value = pp.grainSize;
          m.uGrainColored.value = pp.grainColored ? 1 : 0;
        } else {
          mat = fxChain.pixelArtMat;
          const m = mat.uniforms;
          m.uTex.value = srcTex;
          (m.uTexel.value as THREE.Vector2).set(1 / inW, 1 / inH);
          m.uPixelArtSize.value = pp.pixelArtSize;
          m.uPixelArtAscii.value = pp.pixelArtAscii ? 1 : 0;
          m.uPixelArtMono.value = pp.pixelArtMono ? 1 : 0;
          m.uPixelArtLevels.value = pp.pixelArtLevels;
          {
            const pal = m.uPalette.value as THREE.Color[];
            const sp = pp.pixelArtPalette;
            for (let k = 0; k < 16; k++) pal[k].set(sp[k] ?? sp[sp.length - 1] ?? "#000000");
          }
          m.uPAAsciiTint.value = pp.pixelArtAsciiTint ? 1 : 0;
          (m.uPAAsciiColor.value as THREE.Color).set(pp.pixelArtAsciiColor);
          m.uAsciiAtlas.value = ascii.tex; // ASCII-атлас пока общий (из плоского pixelArtAsciiMode) — лимит мультиэкземпляра
          m.uAsciiCount.value = ascii.count;
        }
        fxChain.quad.material = mat;
        gl.setRenderTarget(dst);
        gl.render(fxChain.scene, fxChain.cam);
        srcTex = dst.texture;
        inW = cw; inH = ch;
      }
      gl.setRenderTarget(prev);
    }
    // Свип осиротевших feedback-инстансов (правило 1): выполняется БЕЗУСЛОВНО каждый кадр,
    // ПОСЛЕ if-блока — чтобы при удалении ПОСЛЕДНЕГО feedback (passes пуст → if пропущен)
    // история освобождалась, а не текла до анмаунта.
    if (feedbackHistory.current.size > 0) {
      const activeIds = feedbackActiveIds.current;
      activeIds.clear();
      for (let i = 0; i < passes.length; i++) {
        if (passes[i].kind === "feedback") activeIds.add(passes[i].id);
      }
      feedbackHistory.current.forEach((e, id) => {
        if (!activeIds.has(id)) {
          e.read.dispose(); e.write.dispose();
          feedbackHistory.current.delete(id);
        }
      });
    }
    // direction A: свип осиротевших EMA-ключей fxSmooth (ключ = `${passId}:${field}`) — при
    // удалении FX-ноды её id уходит из passes; иначе Map копит мёртвые ключи до анмаунта.
    if (fxSmooth.current.size > 0) {
      const liveIds = new Set<string>();
      for (let i = 0; i < passes.length; i++) liveIds.add(passes[i].id);
      fxSmooth.current.forEach((_v, k) => {
        if (!liveIds.has(k.slice(0, k.lastIndexOf(":")))) fxSmooth.current.delete(k);
      });
    }
    u.uTex.value = srcTex;
    (u.uTexel.value as THREE.Vector2).set(1 / inW, 1 / inH);
    // Все 2D-FX извлечены в проходы (B1–B4) -> мега-ветки FX выключены (no-op); мега = только композит.
    u.uThermal.value = 0;
    u.uSobel.value = 0;
    u.uScanlines.value = 0;
    u.uHasDepth.value = 0;  // пикселизация по глубине теперь проход
    u.uPixelArt.value = 0;

    // --- маски людей (YOLOv8-seg): композитинг в шейдере ---
    if (config.peopleMasksEnabled && people) {
      const frame = people.latestRef.current;
      if (frame) {
        if (frame.width !== maskTex.current.image.width ||
            frame.height !== maskTex.current.image.height ||
            maskTex.current.image.data !== frame.data) {
          const tex = new THREE.DataTexture(frame.data, frame.width, frame.height, THREE.RGBAFormat, THREE.UnsignedByteType);
          // Nearest (дефолт DataTexture) -> пиксельная маска (так нравится). Сглаживание —
          // только темпоральное (EMA движения в usePeople), края остаются блочными.
          tex.needsUpdate = true;
          if (maskTex.current !== EMPTY_MASK) maskTex.current.dispose();
          maskTex.current = tex;
          u.uMask.value = tex;
        }
        (u.uMaskMul.value as THREE.Vector2).set(frame.mul[0], frame.mul[1]);
        (u.uMaskOff.value as THREE.Vector2).set(frame.off[0], frame.off[1]);
        (u.uMaskTexel.value as THREE.Vector2).set(1 / frame.width, 1 / frame.height);
        u.uMaskOn.value = 1;
      } else {
        u.uMaskOn.value = 0;
      }
    } else {
      u.uMaskOn.value = 0;
    }

    // --- гладкая маска (MediaPipe Selfie): независимый слой ---
    if (config.peopleSmoothEnabled && seg) {
      const f = seg.latestRef.current;
      if (f) {
        if (f.width !== selfieTex.current.image.width ||
            f.height !== selfieTex.current.image.height ||
            selfieTex.current.image.data !== f.data) {
          const tex = new THREE.DataTexture(f.data, f.width, f.height, THREE.RedFormat, THREE.UnsignedByteType);
          tex.minFilter = THREE.LinearFilter; // линейная -> мягкий край заливки
          tex.magFilter = THREE.LinearFilter;
          tex.needsUpdate = true;
          if (selfieTex.current !== EMPTY_SELFIE) selfieTex.current.dispose();
          selfieTex.current = tex;
          u.uSelfie.value = tex;
        }
        (u.uSelfieMul.value as THREE.Vector2).set(f.mul[0], f.mul[1]);
        (u.uSelfieOff.value as THREE.Vector2).set(f.off[0], f.off[1]);
        (u.uSelfieTexel.value as THREE.Vector2).set(1 / f.width, 1 / f.height);
        u.uSelfieOn.value = 1;
      } else {
        u.uSelfieOn.value = 0;
      }
      u.uSelfieFeather.value = config.peopleFeather;
      u.uSelfieThreshold.value = config.peopleSegThreshold;
    } else {
      u.uSelfieOn.value = 0;
    }

    // --- splat-маска (конвертер PointSet->Map2D): продюсер пишет CanvasTexture в splat.ref ---
    {
      const sp = splat?.ref.current;
      if (sp && sp.on) {
        u.uSplat.value = sp.tex;
        u.uSplatOn.value = 1;
        u.uSplatMode.value = sp.mode;
      } else {
        u.uSplatOn.value = 0;
      }
    }

    // --- заливка/контур/цвета/градиенты (общие для YOLO и гладкой маски) ---
    u.uMaskFill.value = config.peopleFill ? 1 : 0;
    u.uMaskOutline.value = config.peopleOutline ? 1 : 0;
    u.uMaskFillOpacity.value = config.peopleFillOpacity;
    u.uMaskFillOpacity2.value = config.peopleFillOpacity2;
    (u.uPeopleColor.value as THREE.Color).set(config.peopleColor);
    (u.uPeopleColor2.value as THREE.Color).set(config.peopleColor2);
    u.uPeopleFillGradient.value = config.peopleFillGradient ? 1 : 0;
    (u.uOutlineColor.value as THREE.Color).set(config.peopleOutlineColor);
    (u.uOutlineColor2.value as THREE.Color).set(config.peopleOutlineColor2);
    u.uPeopleOutlineGradient.value = config.peopleOutlineGradient ? 1 : 0;
    u.uGradByInstance.value = config.peopleGradientByInstance ? 1 : 0;
    endJs();
  });

  if (!video) return null;
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}
