// T5-СПАЙК: изолированный GPU-частичный прототип на three/webgpu + TSL.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ (не R3F, не часть FlatView):
//  - `WebGPURenderer` НЕ поддерживает `ShaderMaterial` → ядро рендера (flatShader/FBO-цепочка)
//    мигрировать нельзя; частицы живут СВОИМ канвасом-сиблингом поверх flat (см. ARCHITECTURE §3.6.6).
//  - Императивный класс (свой `<canvas>` + `WebGPURenderer` + свой rAF) — чтобы исключить риск
//    интеграции three/webgpu в R3F-дерево. React-обёртка (ParticleCanvas.tsx) только владеет
//    жизненным циклом: init() в useEffect, frame() в rAF, dispose() в cleanup.
//
// ПАРАДИГМА (TD POPs / Houdini POP, разведка §3.6.11): SoA storage-буферы на атрибут,
// ЕДИНЫЙ compute-pass-солвер (semi-implicit Euler + age-recycle с ФИКСИРОВАННОЙ популяцией —
// мёртвая частица респавнится на GPU без компакции/free-list), сила curl-noise (дивергентно-
// свободная). Только element-wise операции — без атомиков/shared memory → тот же TSL-код ложится
// и на WebGL2-фолбэк (там compute идёт через transform feedback).
//
// ВЕРИФИЦИРОВАНО против three@0.176 (node_modules/three/build/three.{webgpu,tsl}.js):
//  - instancedArray(count,'vec3') → StorageBufferNode; .element(i).assign(...); .toAttribute() для рендера.
//  - Fn(()=>{...})().compute(N) → ComputeNode; renderer.computeAsync(node) один раз, renderer.compute(node) в кадре.
//  - ComputeNode.count + updateDispatchCount() — адаптивный dispatch без реаллокации.
//  - PointsNodeMaterial.positionNode = posBuf.toAttribute(); draw-count = geometry position.count ∩ drawRange.
//  - renderer.backend.isWebGPUBackend — какой бэкенд реально активен после init().

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  PerspectiveCamera,
  Points,
  PointsNodeMaterial,
  Scene,
  WebGPURenderer,
} from "three/webgpu";
import {
  Fn,
  If,
  float,
  hash,
  instancedArray,
  instanceIndex,
  mix,
  mx_noise_vec3,
  saturate,
  uniform,
  vec2,
  vec3,
} from "three/tsl";

// Узел TSL в графовых хелперах не типизируем строго (флюент-API возвращает разные ShaderNodeObject<...>,
// все несут .add/.mul/.sub/... — прокся NodeElements). `any` тут осознанно: это построение графа на CPU,
// не runtime-значения. Класс снаружи типизирован строго.
type Node = any;

export interface ParticleSpikeOpts {
  cap?: number; // верхний потолок популяции (аллокация буферов — на нём, без реаллокации)
  start?: number; // стартовая популяция
  min?: number; // нижний предел адаптивного счётчика (iGPU)
  forceWebGL?: boolean; // диагностика: принудительно WebGL2-бэкенд (проверка фолбэка того же TSL-кода)
}

export type ParticleBackend = "webgpu" | "webgl2";

const DEFAULT_CAP = 524_288; // 512k
const DEFAULT_START = 262_144; // 256k
const DEFAULT_MIN = 100_000;

export class ParticleSpike {
  readonly canvas: HTMLCanvasElement;
  readonly cap: number;
  private minCount: number;
  count: number;
  backend: ParticleBackend | null = null;
  initialized = false;
  private disposed = false;
  emaMs = 16.7;

  private renderer: WebGPURenderer;
  private scene: Scene;
  private camera: PerspectiveCamera;
  private geometry: BufferGeometry;
  private material: PointsNodeMaterial;
  private points: Points;

  // SoA storage-буферы (instancedArray). pos/vel vec3, data vec2(.x=age сек, .y=seed).
  private positionBuffer: Node;
  private velocityBuffer: Node;
  private dataBuffer: Node;

  // Uniform'ы, обновляемые из rAF-цикла (через .value).
  private uDt: Node;
  private uTime: Node;
  private uCurlFreq: Node;
  private uCurlAmp: Node;

  // Compute-ноды (построены один раз; update мутирует .count для адаптива).
  private computeInit: Node;
  private computeUpdate: Node;

  private cooldown = 0;

  constructor(canvas: HTMLCanvasElement, opts: ParticleSpikeOpts = {}) {
    this.canvas = canvas;
    this.cap = opts.cap ?? DEFAULT_CAP;
    this.count = Math.min(opts.start ?? DEFAULT_START, this.cap);
    this.minCount = opts.min ?? DEFAULT_MIN;

    // --- буферы (на CAP) ---
    this.positionBuffer = instancedArray(this.cap, "vec3");
    this.velocityBuffer = instancedArray(this.cap, "vec3");
    this.dataBuffer = instancedArray(this.cap, "vec2");

    // --- uniform'ы ---
    this.uDt = uniform(0, "float");
    this.uTime = uniform(0, "float");
    this.uCurlFreq = uniform(0.35, "float");
    this.uCurlAmp = uniform(2.5, "float");

    // --- graph-build хелперы (CPU, узлы) ---
    // Эмиттер для спайка — равномерный спавн в box-объёме по hash(seed). ЕДИНСТВЕННЫЙ шов для
    // будущего депт-эмиттера: заменить тело sampleEmitter на сэмпл depth-текстуры + unproject.
    const EMIT_MIN = vec3(-7, -7, -3);
    const EMIT_MAX = vec3(7, 7, 3);
    const LIFE_MIN = float(2.0);
    const LIFE_MAX = float(6.0);

    const sampleEmitter = (seed: Node): Node =>
      mix(EMIT_MIN, EMIT_MAX, vec3(hash(seed.add(0.123)), hash(seed.add(0.456)), hash(seed.add(0.789))));
    const sampleLife = (seed: Node): Node => mix(LIFE_MIN, LIFE_MAX, hash(seed.add(0.321)));
    const makeSeed = (idxF: Node, salt: Node): Node => hash(idxF.mul(0.6180339).add(salt));

    // Curl-noise: дивергентно-свободная сила через КОНЕЧНЫЕ РАЗНОСТИ векторного потенциала.
    // mx_noise_vec3 даёт дешёвый 1-октавный vec3-потенциал; curl(P) гарантированно div-free
    // (raw mx_fractal_noise_vec3 как поле скоростей НЕ div-free → клампит/взрывает).
    const EPS = float(0.1);
    const potential = (p: Node): Node => mx_noise_vec3(p.mul(this.uCurlFreq).add(vec3(this.uTime.mul(0.2))));
    const curlNoise = (p: Node): Node => {
      const dx = vec3(EPS, 0, 0);
      const dy = vec3(0, EPS, 0);
      const dz = vec3(0, 0, EPS);
      const px1 = potential(p.add(dx));
      const px0 = potential(p.sub(dx));
      const py1 = potential(p.add(dy));
      const py0 = potential(p.sub(dy));
      const pz1 = potential(p.add(dz));
      const pz0 = potential(p.sub(dz));
      const inv = EPS.mul(2).reciprocal();
      const dPdx = px1.sub(px0).mul(inv);
      const dPdy = py1.sub(py0).mul(inv);
      const dPdz = pz1.sub(pz0).mul(inv);
      return vec3(dPdy.z.sub(dPdz.y), dPdz.x.sub(dPdx.z), dPdx.y.sub(dPdy.x));
    };

    // --- init compute: засеять ВСЮ популяцию на CAP один раз ---
    this.computeInit = Fn(() => {
      const i = instanceIndex;
      const seed = makeSeed(i.toFloat(), float(7.0)).toVar();
      this.positionBuffer.element(i).assign(sampleEmitter(seed));
      this.velocityBuffer.element(i).assign(vec3(0));
      // стартовый age рандомен в [0,life) — чтобы респавны не пульсировали синхронно.
      const life = sampleLife(seed);
      const startAge = hash(seed.add(0.999)).mul(life);
      this.dataBuffer.element(i).assign(vec2(startAge, seed));
    })().compute(this.cap);

    // --- update compute: силы + semi-implicit Euler + age-recycle (per-frame) ---
    this.computeUpdate = Fn(() => {
      const i = instanceIndex;
      const posEl = this.positionBuffer.element(i);
      const velEl = this.velocityBuffer.element(i);
      const dataEl = this.dataBuffer.element(i);

      const p = posEl.toVar();
      const v = velEl.toVar();
      const age = dataEl.x.toVar();
      const seed = dataEl.y.toVar();
      const dt = this.uDt;

      // сила (curl). Гравитацию в спайке держим лёгкой, чтобы поле читалось.
      const accel = curlNoise(p).mul(this.uCurlAmp).add(vec3(0, -0.2, 0));

      // semi-implicit Euler
      v.addAssign(accel.mul(dt));
      p.addAssign(v.mul(dt));
      age.addAssign(dt);

      // recycle: age>=life → респавн на GPU (без free-list)
      const life = sampleLife(seed);
      If(age.greaterThanEqual(life), () => {
        const newSeed = makeSeed(i.toFloat(), this.uTime.add(seed));
        p.assign(sampleEmitter(newSeed));
        v.assign(vec3(0));
        age.assign(0);
        seed.assign(newSeed);
      });

      posEl.assign(p);
      velEl.assign(v);
      dataEl.assign(vec2(age, seed));
    })().compute(this.cap);

    // --- сцена / камера ---
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(60, 1, 0.1, 100);
    this.camera.position.set(0, 0, 14);
    this.camera.lookAt(0, 0, 0);

    // --- рендер: THREE.Points, позиции читаются из storage-буфера через positionNode ---
    // geometry несёт реальный position-атрибут на CAP (рендер берёт vertexCount = position.count),
    // но сами данные не читаются — positionNode их переопределяет. drawRange = текущая популяция.
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", new BufferAttribute(new Float32Array(this.cap * 3), 3));
    this.geometry.setDrawRange(0, this.count);

    this.material = new PointsNodeMaterial();
    // Позиции из storage-буфера в вершинный стейдж — идиоматичный путь three (как в compute-particle
    // примерах). ✅ WebGPU. ⚠ ВЫВОД СПАЙКА: на WebGL2-фолбэке рендер compute-output буфера как Points
    // НЕ выдаёт draw-call (compute через transform feedback работает, но storage-буфер не биндится как
    // render-input в WebGLBackend@0.176). Проверял и `.element(vertexIndex)` — тот же 0 draws. Это
    // лимит бэкенда three, не нашего кода; решение для прод-фолбэка (CPU-readback→attribute или не-node
    // WebGL2-путь) — на этапе полной обвязки T5. См. init() — предупреждение на webgl2.
    this.material.positionNode = this.positionBuffer.toAttribute();
    // цвет по скорости — ramp (голубой покой → тёплый быстрый). Яркость поднята: аддитив поверх
    // видео иначе теряется. Множитель 1.6 → заметное свечение.
    const speed = this.velocityBuffer.toAttribute().length();
    this.material.colorNode = mix(vec3(0.25, 0.7, 1.0), vec3(1.0, 0.85, 0.4), saturate(speed.mul(0.18))).mul(1.6);
    this.material.transparent = true;
    this.material.depthWrite = false;
    this.material.depthTest = true;
    this.material.blending = AdditiveBlending;
    (this.material as any).size = 3.5; // px (крупнее — чтобы облако читалось поверх видео)
    (this.material as any).sizeAttenuation = false; // постоянный пиксельный размер (HUD-look)

    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false; // позиции на GPU → CPU-bounding бессмыслен
    this.scene.add(this.points);

    this.renderer = new WebGPURenderer({ canvas, alpha: true, antialias: false, forceWebGL: opts.forceWebGL ?? false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  }

  async init(): Promise<void> {
    if (!navigator.gpu) {
      // WebGPURenderer сам уйдёт в WebGL2-фолбэк; логируем для диагностики.
      console.warn("[ParticleSpike] navigator.gpu отсутствует — ожидаем WebGL2-фолбэк");
    }
    await this.renderer.init();
    this.backend = (this.renderer as any).backend?.isWebGPUBackend ? "webgpu" : "webgl2";
    console.info(`[ParticleSpike] backend = ${this.backend}, start count = ${this.count}`);
    if (this.backend === "webgl2") {
      // Вывод спайка: на WebGL2 солвер (compute/transform-feedback) считает, но рендер Points из
      // storage-буфера не рисуется в three@0.176 — будет пусто. Не крэш, но и не видно.
      console.warn(
        "[ParticleSpike] WebGL2-фолбэк: compute работает, но рендер частиц из storage-буфера в этом " +
          "бэкенде three не выдаёт draw-call — на экране будет пусто. Полноценный фолбэк — на этапе T5.",
      );
    }
    // засеять буферы один раз
    await this.renderer.computeAsync(this.computeInit);
    this.initialized = true;
  }

  // Один кадр. dtMs — измеренная дельта в мс (clamp в секундах до 1/30 для устойчивости интегратора).
  frame(dtMs: number): void {
    if (!this.initialized) return;
    const dt = Math.min(dtMs / 1000, 1 / 30);
    this.uDt.value = dt;
    this.uTime.value += dt; // накапливаем КЛАМПНУТОЕ время — поле и интегратор согласованы при хитчах

    // адаптивный dispatch: считаем только живую популяцию
    if (this.computeUpdate.count !== this.count) {
      this.computeUpdate.count = this.count;
      this.computeUpdate.updateDispatchCount();
    }
    this.renderer.compute(this.computeUpdate);

    this.geometry.setDrawRange(0, this.count);
    this.renderer.render(this.scene, this.camera);

    this.adapt(dtMs);
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  setCount(n: number): void {
    this.count = Math.max(this.minCount, Math.min(Math.floor(n), this.cap));
  }

  // EMA(dtMs) + deadband + cooldown. Цель ~60fps; вниз агрессивнее (×0.85), вверх осторожнее (×1.10).
  private adapt(dtMs: number): void {
    this.emaMs = this.emaMs * 0.9 + dtMs * 0.1;
    if (this.cooldown > 0) {
      this.cooldown--;
      return;
    }
    const HI = 20.0; // ~50fps — ужимаемся
    const LO = 13.0; // ~77fps — есть запас, растём
    if (this.emaMs > HI && this.count > this.minCount) {
      this.setCount(this.count * 0.85);
      this.cooldown = 30;
    } else if (this.emaMs < LO && this.count < this.cap) {
      this.setCount(this.count * 1.1);
      this.cooldown = 30;
    }
  }

  // Освобождение GPU-ресурсов (ARCHITECTURE §7). Порядок: граф → geometry/material → буферы → renderer.
  // Идемпотентно. ВАЖНО: звать ТОЛЬКО после завершения init() — ParticleCanvas откладывает dispose
  // до резолва init-промиса, чтобы renderer.dispose() не гонился с await внутри init (config-reviewer).
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.initialized = false;
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
    // подлежащие StorageInstancedBufferAttribute несут .dispose()
    this.positionBuffer.value?.dispose?.();
    this.velocityBuffer.value?.dispose?.();
    this.dataBuffer.value?.dispose?.();
    this.renderer.dispose();
  }
}
