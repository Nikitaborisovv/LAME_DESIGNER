// T5 v2: менеджер particle-систем. ВЛАДЕЕТ единственным WebGPURenderer + canvas + scene +
// ортокамерой (frontLock на кадр, паттерн CloudCamera) + rAF. Держит Map<id,ParticleSystem>,
// диффит резолвнутые particleSystems[] (add/remove/restructure), гонит ОДИН renderer.render с N
// объектами Points. Адаптивный бюджет делит общий потолок населения между активными системами
// (4 эмиттера по 64k, не 4×256k — §3.6.12: 60fps приоритетнее суммы).
//
// Координаты: частицы в video-aligned пространстве (contain-фит, как все оверлеи). Камера — ортой
// фронтально на кадр (orbit-камера и map-вход — следующая часть Phase A, §3.6.12 defer).

import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments, OrthographicCamera, Quaternion, Scene, Vector3, WebGPURenderer } from "three/webgpu";
import { Fn, instanceIndex, instancedArray, atomicStore } from "three/tsl";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ResolvedParticleSystem } from "../../core/types";
import { ParticleSystem, type SharedShadowGrid } from "./ParticleSystem";

export type ParticleBackend = "webgpu" | "webgl2";

const GLOBAL_BUDGET = 1_400_000; // общий потолок населения, делится между системами (адаптив ужимает под FPS)
// ParticleLight: воксельная сетка плотности для САМОЗАТЕНЕНИЯ (Beer-рей-марч в материале). ОДНА на
// канвас (шарится всеми системами → кросс-системные тени даром): мир [-2,2]³ → 48³ ячеек-счётчиков
// (u32, ~442КБ). Каждый кадр: clear (атомики) → системы биннят свои частицы в update-compute →
// материалы с нодой Света рей-марчат к источнику. WebGPU-only (атомики; WebGL2 → свет без тени).
const SHADOW_GRID = 64;

// Поза внешней камеры (cloud) для follow-режима. Структурный тип — App отдаёт THREE.Camera
// из R3F-канваса облака, нам нужны только позиция/кватернион/zoom.
export interface ExtCamPose {
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
  zoom?: number;
}
// Cloud-камера смотрит на кадр с −Z (CloudCamera, frontLock-поза (0,0,−8)), частицы — с +Z.
// Миры зеркальны разворотом на 180° вокруг Y: pos' = (−x, y, −z), q' = Q_Y180 ⊗ q.
const Q_Y180 = new Quaternion(0, 1, 0, 0);

export class ParticleField {
  readonly canvas: HTMLCanvasElement;
  backend: ParticleBackend | null = null;
  initialized = false;
  private disposed = false;

  private renderer: WebGPURenderer;
  private scene: Scene;
  private camera: OrthographicCamera;
  private controls: OrbitControls | null = null;
  private frontLock = true; // фронт-замок на кадр (как cloud) vs свободная орбита
  private systems = new Map<string, ParticleSystem>();

  // самозатенение: общий voxel-грид (см. SHADOW_GRID) + clear-compute; atomics выясняются после init.
  // Типы TSL-узлов — any (граф строится на CPU, как в ParticleSystem).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private shadowGrid: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private clearGrid: any;
  private shadowShared: SharedShadowGrid;

  // гизмо света: маркер позиции + луч направления + 4 ребра конуса (8 сегментов = 16 вершин).
  private gizmo: LineSegments;
  private gizmoPos: Float32Array;

  private videoAspect = 16 / 9;
  private vw = 1;
  private vh = 1;
  private rectX = 1;
  private rectY = 1;
  private depthScale = 0.5;
  private time = 0;
  private pending: ResolvedParticleSystem[] | null = null;
  private extCam: ExtCamPose | null = null; // follow cloud-камеры (единое 3D-пространство)

  constructor(canvas: HTMLCanvasElement, opts: { forceWebGL?: boolean } = {}) {
    this.canvas = canvas;
    this.scene = new Scene();
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    this.camera.position.set(0, 0, 10);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    this.renderer = new WebGPURenderer({ canvas, alpha: true, antialias: false, forceWebGL: opts.forceWebGL ?? false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // самозатенение: грид-счётчики + clear (atomicStore 0 на ячейку). atomics=false до init (WebGL2 — без тени).
    // Грид читается ТОЛЬКО в compute (light-проход, atomicLoad на read_write atomic — валидно) — НЕ в
    // материале (vertex-стадия read-only без atomic<> невалидна по WGSL-спеке). Поэтому второй plain-вью не нужен.
    this.shadowGrid = instancedArray(SHADOW_GRID ** 3, "uint").toAtomic();
    this.clearGrid = Fn(() => { atomicStore(this.shadowGrid.element(instanceIndex), 0); })().compute(SHADOW_GRID ** 3);
    this.shadowShared = { side: SHADOW_GRID, grid: this.shadowGrid, atomics: false };

    // гизмо света (LineSegments): позиции обновляются каждый кадр в updateGizmo. depthTest off →
    // всегда поверх (помогает понять, где источник). visible=false, пока нет ноды Света.
    this.gizmoPos = new Float32Array(16 * 3);
    const gg = new BufferGeometry();
    gg.setAttribute("position", new Float32BufferAttribute(this.gizmoPos, 3));
    const gm = new LineBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
    this.gizmo = new LineSegments(gg, gm);
    this.gizmo.frustumCulled = false;
    this.gizmo.visible = false;
    this.scene.add(this.gizmo);
  }

  // Гизмо света: маркер-крест в позиции + центральный луч (к началу координат = направление) + 4 ребра
  // конуса (полуугол = acos(cosOuter)). pose=null / on=false → скрыт. Перестраивает 16 вершин (дёшево).
  private _gv = { L: new Vector3(), dir: new Vector3(), right: new Vector3(), fwd: new Vector3(), up: new Vector3(), edge: new Vector3(), perp: new Vector3() };
  private updateGizmo(pose: ReturnType<ParticleSystem["getLightPose"]>): void {
    if (!pose || !pose.on) { this.gizmo.visible = false; return; }
    this.gizmo.visible = true;
    const g = this._gv;
    // ПИШЕМ В МАССИВ САМОГО АТРИБУТА (three/webgpu клонирует переданный буфер при создании — наш
    // this.gizmoPos НЕ тот же объект, sameRef=false; писать надо в attr.array, иначе аплоад нулей).
    const attr = this.gizmo.geometry.getAttribute("position") as Float32BufferAttribute;
    const P = attr.array as Float32Array;
    g.L.set(pose.x, pose.y, pose.z);
    const len = Math.max(0.05, g.L.length());
    g.dir.copy(g.L).multiplyScalar(-1 / len); // к началу координат (цель прожектора)
    g.up.set(Math.abs(g.dir.y) > 0.9 ? 1 : 0, Math.abs(g.dir.y) > 0.9 ? 0 : 1, 0);
    g.right.crossVectors(g.dir, g.up).normalize();
    g.fwd.crossVectors(g.right, g.dir).normalize();
    const half = Math.acos(Math.max(-1, Math.min(1, pose.cosOuter)));
    const ch = Math.cos(half), sh = Math.sin(half);
    let o = 0;
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
      P[o++] = ax; P[o++] = ay; P[o++] = az; P[o++] = bx; P[o++] = by; P[o++] = bz;
    };
    // центральный луч: позиция → начало координат
    seg(g.L.x, g.L.y, g.L.z, g.L.x + g.dir.x * len, g.L.y + g.dir.y * len, g.L.z + g.dir.z * len);
    // 4 ребра конуса
    for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      g.perp.copy(g.right).multiplyScalar(Math.cos(a)).addScaledVector(g.fwd, Math.sin(a));
      g.edge.copy(g.dir).multiplyScalar(ch).addScaledVector(g.perp, sh).normalize();
      seg(g.L.x, g.L.y, g.L.z, g.L.x + g.edge.x * len, g.L.y + g.edge.y * len, g.L.z + g.edge.z * len);
    }
    // маркер-крест в позиции света
    const s = 0.09;
    seg(g.L.x - s, g.L.y, g.L.z, g.L.x + s, g.L.y, g.L.z);
    seg(g.L.x, g.L.y - s, g.L.z, g.L.x, g.L.y + s, g.L.z);
    seg(g.L.x, g.L.y, g.L.z - s, g.L.x, g.L.y, g.L.z + s);
    attr.needsUpdate = true;
    (this.gizmo.material as LineBasicMaterial).color.setRGB(pose.color[0], pose.color[1], pose.color[2]);
  }

  async init(): Promise<void> {
    if (!navigator.gpu) console.warn("[ParticleField] navigator.gpu отсутствует — ожидаем WebGL2-фолбэк");
    await this.renderer.init();
    this.backend = (this.renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend?.isWebGPUBackend ? "webgpu" : "webgl2";
    if (this.backend === "webgl2") {
      console.warn("[ParticleField] WebGL2-фолбэк: рендер частиц из storage-буфера в three@0.176 пустой (лимит бэкенда).");
    }
    this.shadowShared.atomics = this.backend === "webgpu"; // тени = атомики = WebGPU-only
    this.initialized = true;
    if (this.pending) { const p = this.pending; this.pending = null; await this.update(p); }
  }

  setVideoAspect(a: number): void {
    if (a && isFinite(a) && a > 0 && a !== this.videoAspect) {
      this.videoAspect = a;
      this.updateCamera(); // фит зависит от аспекта — без апдейта камера живёт со старым
    }
  }

  // Выраженность 3D-экструзии по глубине (z = d·depthScale) — ведётся config.depthScale.
  setDepthScale(s: number): void {
    if (isFinite(s) && s > 0) this.depthScale = s;
  }

  // Follow-режим: камера частиц каждый кадр повторяет позу cloud-камеры (зеркало Y180) —
  // единое 3D-пространство «облако глубины + частицы» при активном cloud (мышь у облака,
  // канвас частиц pointerEvents:none). null → своя орбита/фронт-замок как прежде.
  setExternalCamera(cam: ExtCamPose | null): void {
    this.extCam = cam;
  }

  // Переключение фронт-замок ↔ свободная орбита (как cloud). frontLock=true: фиксируем фронт-вид
  // на кадр, орбита выключена. false: OrbitControls на канвасе частиц (канвас включает pointerEvents
  // на стороне React-обёртки). Идемпотентно.
  setFrontLock(lock: boolean): void {
    if (lock === this.frontLock && (lock || this.controls)) return;
    this.frontLock = lock;
    if (lock) {
      this.controls?.dispose();
      this.controls = null;
      this.camera.position.set(0, 0, 10);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(0, 0, 0);
      this.camera.zoom = 1;
      this.camera.updateProjectionMatrix();
    } else if (!this.controls) {
      const ctl = new OrbitControls(this.camera as unknown as ConstructorParameters<typeof OrbitControls>[0], this.canvas);
      ctl.enableDamping = true; ctl.dampingFactor = 0.08; ctl.target.set(0, 0, 0); ctl.update();
      this.controls = ctl;
    }
  }

  // Дифф резолвнутых систем: добавить новые, убрать исчезнувшие, пересобрать структурно-изменившиеся,
  // params → uniforms у всех. Вызывается из React при смене particleSystems (НЕ каждый кадр).
  async update(list: ResolvedParticleSystem[]): Promise<void> {
    if (this.disposed) return;
    if (!this.initialized) { this.pending = list; return; }
    const ids = new Set(list.map((s) => s.id));
    for (const [id, sys] of this.systems) {
      if (!ids.has(id)) { sys.dispose(); this.systems.delete(id); }
    }
    // биннинг в voxel-грид активен у ВСЕХ систем, когда есть хоть одна нода Света (кросс-системные
    // тени); смена флага = пересборка update-compute (needsRestructure учитывает binActive).
    const binActive = this.shadowShared.atomics && list.some((s) => !!s.light);
    for (const s of list) {
      let sys = this.systems.get(s.id);
      if (!sys) {
        sys = new ParticleSystem(this.scene, s, this.shadowShared, binActive);
        this.systems.set(s.id, sys);
        await sys.seed(this.renderer);
        if (this.disposed) { sys.dispose(); this.systems.delete(s.id); return; }
      } else if (sys.needsRestructure(s, binActive)) {
        await sys.restructure(this.renderer, s, binActive);
        if (this.disposed) return;
      } else {
        sys.applyParams(s);
      }
    }
  }

  setSpawn(id: string, flat: Float32Array, n: number): void {
    this.systems.get(id)?.setSpawn(flat, n);
  }

  // U2: readback живой популяции системы id → нормированные [nx,ny,d]×k (≤maxPoints). GPU→CPU на
  // низкой частоте (мост вызывает ~7Гц). Нет системы / не инициализирован → пусто.
  async readback(id: string, maxPoints: number, withColor = false): Promise<Float32Array> {
    if (this.disposed || !this.initialized) return new Float32Array(0);
    const sys = this.systems.get(id);
    return sys ? sys.readback(this.renderer, maxPoints, withColor) : new Float32Array(0);
  }

  setMap(id: string, frame: Parameters<ParticleSystem["setMap"]>[0]): void {
    this.systems.get(id)?.setMap(frame);
  }

  setVideoFrame(id: string, rgba: Uint8ClampedArray | null): void {
    this.systems.get(id)?.setVideoFrame(rgba);
  }

  resize(w: number, h: number): void {
    this.vw = Math.max(1, w); this.vh = Math.max(1, h);
    this.renderer.setSize(w, h, false);
    this.updateCamera();
  }

  // Ортокамера: фронтально на кадр. БАГ-ФИКС фита: видео-rect частиц обязан совпадать с
  // оверлеями — ТОТ ЖЕ contain-фит видео на ВЕСЬ канвас (конвенция проекта). Мир видео фиксирован:
  // полуширина rectX=va, полувысота rectY=1; frustum подгоняется так, чтобы этот rect contain-фитился
  // (W/H = аспект канваса → px/world одинаков по осям, без искажения). Раньше камера контейнила
  // юнит-квадрат [-1,1]² → видео-rect частиц был МЕНЬШЕ оверлейного и по-другому реагировал на
  // изменение размера stage (открытие панелей «скейлило только частицы»).
  private updateCamera(): void {
    const ca = this.vw / this.vh;
    const va = this.videoAspect;
    this.rectX = va; this.rectY = 1; // мир видео фиксирован, от канваса не зависит
    const W = va > ca ? va : ca;     // contain: видео шире канваса → впритык по X, иначе по Y
    const H = W / ca;
    this.camera.left = -W; this.camera.right = W;
    this.camera.top = H; this.camera.bottom = -H;
    this.camera.updateProjectionMatrix();
  }

  // Один кадр: sim каждой системы (compute) + ОДИН render всех Points. dtMs — измеренная дельта.
  frame(dtMs: number): void {
    if (!this.initialized || this.disposed) return;
    const dt = Math.min(dtMs / 1000, 1 / 30);
    this.time += dt;
    const n = Math.max(1, this.systems.size);
    const budget = Math.floor(GLOBAL_BUDGET / n);
    // самозатенение: грид чистится ДО шагов систем (биннинг в update-compute), материалы читают в render.
    // Гейт: есть хоть одна нода Света (иначе грид никто не читает — clear не нужен).
    let anyLight = false;
    for (const sys of this.systems.values()) if (sys.hasLight) { anyLight = true; break; }
    const shadowOn = anyLight && this.shadowShared.atomics;
    if (shadowOn) this.renderer.compute(this.clearGrid);
    for (const sys of this.systems.values()) {
      sys.setFrame(dt, this.time, this.rectX, this.rectY, this.depthScale);
      sys.step(this.renderer); // двигает частицы + биннит в общий грид (если binActive)
    }
    // ParticleLight: ПОСЛЕ полного биннинга всех систем — отдельный compute-проход тени на частицу
    // (рей-марч грида → per-particle litBuffer). Раз на частицу, не на вершину (340k частиц).
    if (shadowOn) for (const sys of this.systems.values()) sys.lightPass(this.renderer);
    // гизмо света: поза первой системы с нодой Света (null → скрыт).
    let pose: ReturnType<ParticleSystem["getLightPose"]> = null;
    for (const sys of this.systems.values()) { const p = sys.getLightPose(); if (p) { pose = p; break; } }
    this.updateGizmo(pose);
    if (this.extCam) {
      // единое пространство: повторяем позу cloud-камеры (зеркало Y180), свои контролы спят
      const { position: p, quaternion: q, zoom } = this.extCam;
      this.camera.position.set(-p.x, p.y, -p.z);
      this.camera.quaternion.set(q.x, q.y, q.z, q.w).premultiply(Q_Y180);
      const z = zoom ?? 1;
      if (this.camera.zoom !== z) { this.camera.zoom = z; this.camera.updateProjectionMatrix(); }
    } else if (this.controls) this.controls.update(); // орбита: демпинг/инерция
    this.renderer.render(this.scene, this.camera);
    for (const sys of this.systems.values()) sys.adapt(dtMs, budget);
  }

  // Освобождение (§7). Идемпотентно. Все системы + буферы + рендерер.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.initialized = false;
    this.controls?.dispose();
    this.controls = null;
    for (const sys of this.systems.values()) sys.dispose();
    this.systems.clear();
    this.scene.remove(this.gizmo);
    this.gizmo.geometry.dispose();
    (this.gizmo.material as LineBasicMaterial).dispose();
    this.shadowGrid.value?.dispose?.(); // voxel-грид самозатенения (владелец — Field)
    this.renderer.dispose();
  }
}
