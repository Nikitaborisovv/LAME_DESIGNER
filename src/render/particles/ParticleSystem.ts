// T5 v2: ОДНА независимая particle-система (Режим 1). Обобщает спайк (ParticleSpike): SoA storage-
// буферы на атрибут, единый compute-pass-солвер (semi-implicit Euler + age-recycle, фикс. популяция),
// силы компилируются в update-Fn (структурно по forces[]), цвет — в colorNode (структурно по pcolorMode).
//
// ИНВАРИАНТЫ РЕАЛТАЙМА (§3.6.12): params = UNIFORMS (крутилка/тумблер секции не пересобирает шейдер);
// пересборка TSL только при смене СТРУКТУРЫ (число Force-нод / тип шума / режим цвета) — structureKey;
// ноль GPU→CPU readback. НЕ владеет рендерером (ParticleField даёт shared scene/renderer).
//
// Спавн (мост CPU→GPU): эмиттер рождает НА ТОМ, что воткнули. Источник-точки приходят НОРМИРОВАННЫМИ
// (0..1 кадра) в spawn-DataTexture (паттерн depth-текстуры PointCloud); GPU-респавн сэмплит случайный
// индекс + jitter и маппит в world по uniform'ам прямоугольника видео (uRectX/uRectY). Нет источника
// (uSpawnCount=0) → box-фолбэк. Цвет источника (Cd) тинтует частицу (наследование при рождении).

import {
  AdditiveBlending,
  NormalBlending,
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  RedFormat,
  UnsignedByteType,
  InstancedMesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  type BufferGeometry,
  type Scene,
} from "three/webgpu";
import {
  Fn, If, Loop, atomicAdd, atomicLoad, exp, float, hash, instancedArray, instanceIndex, mix, mx_noise_vec3, positionLocal, saturate, smoothstep, texture, uniform, vec2, vec3,
} from "three/tsl";
import type { ResolvedParticleSystem, DepthFrame } from "../../core/types";

// Граф TSL строится на CPU (флюент-узлы возвращают разные ShaderNodeObject — все несут .add/.mul/…).
// `any` тут осознанно (как в спайке): это построение графа, не runtime-значения.
type Node = any;
// Узел WebGPURenderer берём слабо — модуль не импортит сам класс (его держит ParticleField).
// getArrayBufferAsync — readback storage-буфера (U2 Particles→Points; GPU→CPU на низкой частоте).
type Renderer = {
  computeAsync: (n: Node) => Promise<void>;
  compute: (n: Node) => void;
  getArrayBufferAsync?: (attr: Node) => Promise<ArrayBuffer>;
};

const SPAWN_CAP = 4096; // макс. различных точек-источников спавна (продюсеры дают сотни–тысячи)
// Потолок АЛЛОКАЦИИ буферов на систему (≈общий бюджет ParticleField): emitterMaxParticles>этого
// клампится, чтобы N эмиттеров не аллоцировали N×1М VRAM (рисуемый count и так делит общий бюджет).
const MAX_SYSTEM_ALLOC = 1_500_000;
const MAP_TEX = 256; // фикс. размер map-текстуры (карта плотности эмиссии) — кадр глубины nearest-копится сюда
const VID_TEX = 128; // фикс. размер кадра видео (цвет частиц при map-эмиссии); мост заливает ~12Гц

// ParticleLight: общий voxel-грид плотности (владелец — ParticleField). Системы биннят частицы в
// update-compute (atomicAdd), а ОТДЕЛЬНЫЙ compute-проход тени (light-проход) рей-марчит грид
// (atomicLoad — валиден в compute) → per-particle litBuffer; материал лишь читает litBuffer (дёшево,
// не марчит на вершину). Мир грида ФИКСИРОВАН [-2,2]³ (recycle держит частицы в ±2·rect). atomics=false
// (WebGL2) → свет без тени.
export interface SharedShadowGrid { side: number; grid: Node; atomics: boolean }

const hexRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

interface ForceU {
  gx: Node; gy: Node; gz: Node; gStrength: Node; gOn: Node;
  nAmp: Node; nScale: Node; nSpeed: Node; nOn: Node;
  drag: Node; dragOn: Node;
}

// Структурная сигнатура: число Force-нод + тип шума каждой + режим границ + режим цвета + наличие Света.
// Смена → пересборка TSL.
export function structureKey(sys: ResolvedParticleSystem): string {
  const noises = sys.forces.map((f) => String(f.params.forceNoiseMode ?? "curl")).join(",");
  const bounds = sys.forces.map((f) => String(f.params.forceBoundsMode ?? "none")).join(",");
  const color = sys.color ? String(sys.color.params.pcolorMode ?? "byVelocity") : "byVelocity";
  return `${sys.forces.length}|${noises}|${bounds}|${color}|L${sys.light ? 1 : 0}`;
}

export class ParticleSystem {
  readonly id: string;
  readonly cap: number;
  count: number;                 // живая (рисуемая) популяция — адаптив + rate-фракция
  private structSig: string;

  private scene: Scene;
  private geometry: BufferGeometry;
  private material!: MeshBasicNodeMaterial;
  private mesh!: InstancedMesh; // квад-спрайт на частицу (THREE.Points в WebGPU не растеризует)

  // SoA storage-буферы (на cap). pos/vel/color vec3; data vec2(.x=age сек, .y=seed).
  private positionBuffer: Node;
  private velocityBuffer: Node;
  private dataBuffer: Node;
  private colorBuffer: Node; // наследованный Cd источника (белый по умолчанию = без тинта)

  // spawn-DataTexture (нормированные позиции/цвет источника), обновляются с CPU на низкой частоте.
  private spawnPosTex: DataTexture;
  private spawnColTex: DataTexture;
  private spawnPosData: Float32Array;
  private spawnColData: Float32Array;

  // map-источник эмиссии (Map2D — глубина): фикс 256×256 R8, кадр глубины nearest-копится сюда.
  private mapData: Uint8Array;
  private mapTex: DataTexture;
  private vidData: Uint8Array;
  private vidTex: DataTexture;

  // uniform'ы (обновляются из ParticleField каждый кадр).
  private uDt = uniform(0, "float");
  private uTime = uniform(0, "float");
  private uRectX = uniform(1, "float");
  private uRectY = uniform(1, "float");
  private uDepthScale = uniform(0.5, "float");
  private uJitter = uniform(0.01, "float");
  private uLife = uniform(4, "float");
  private uLifeVar = uniform(0.5, "float");
  private uInitSpeed = uniform(0, "float");
  private uVelSpread = uniform(0.3, "float");
  private uDamping = uniform(0, "float");
  private uSpawnCount = uniform(0, "float");
  private uHasMap = uniform(0, "float");
  private uHasVid = uniform(0, "float");
  private uMapThreshold = uniform(0.5, "float");
  private uColorA = uniform(vec3(0.25, 0.7, 1.0));
  private uColorB = uniform(vec3(1.0, 0.85, 0.4));
  private uOpacity = uniform(1, "float");
  private uSize = uniform(0.01, "float"); // полу-размер квада-спрайта в МИРОВЫХ единицах ([-1,1]-мир)
  private uSizeVar = uniform(0, "float"); // U3: per-particle разброс размера (по seed частицы; 0=одинаковый)
  // ParticleLight (прожектор + самозатенение): все ручки = uniforms (без пересборки TSL).
  private uLPos = uniform(vec3(0.9, 0.9, 1.4));
  private uLColor = uniform(vec3(1, 1, 1));
  private uLIntensity = uniform(1.6, "float");
  private uLCosOuter = uniform(Math.cos((40 * Math.PI) / 180), "float"); // внешний край конуса
  private uLCosInner = uniform(Math.cos((26 * Math.PI) / 180), "float"); // ядро (спред сужает/размывает)
  private uLRadius = uniform(1.6, "float"); // «размер»: радиус спада яркости по дистанции
  private uLShadow = uniform(0.7, "float"); // сила самозатенения (σ рей-марча)
  private uLSelf = uniform(0.12, "float");  // отступ старта марша: частица не тенит сама себя (мир-ед.)
  private uLAmbient = uniform(0.04, "float"); // заполняющий свет (0 = darkroom: вне луча чёрное)
  private uLSpread01 = uniform(0.35, "float"); // сырой спред 0..1 — мягкость тени (blur density-сэмпла)
  private forceU: ForceU[] = [];

  private computeInit: Node;
  private computeUpdate!: Node;
  private computeLight: Node | null = null; // light-проход: рей-марч грида → litBuffer (только при sys.light)
  private litBuffer: Node;                   // per-particle освещённость (vec3): color·int·cone·att·shadow
  private disposed = false;
  private cooldown = 0;
  emaMs = 16.7;
  // самозатенение: общий voxel-грид от ParticleField (null в юнит-контекстах без Field).
  private shadow: SharedShadowGrid | null;
  hasLight = false; // есть нода Света в цепочке (Field гейтит clear-грида)
  private lightGizmo = true; // показывать гизмо света (CPU-сторона, для ParticleField.updateGizmo)
  // биннинг включён Field'ом, когда есть хоть одна нода Света в ЛЮБОЙ системе (кросс-тени);
  // смена = пересборка update-compute (без света не платим 1 atomicAdd/частицу впустую).
  private binActive = false;

  constructor(scene: Scene, sys: ResolvedParticleSystem, shadow: SharedShadowGrid | null = null, binActive = false) {
    this.scene = scene;
    this.shadow = shadow;
    this.binActive = binActive;
    this.id = sys.id;
    this.cap = Math.max(1000, Math.min(MAX_SYSTEM_ALLOC, Math.round(sys.solver.maxParticles || 200000)));
    this.count = Math.min(this.cap, 200000);
    this.structSig = structureKey(sys);

    this.positionBuffer = instancedArray(this.cap, "vec3");
    this.velocityBuffer = instancedArray(this.cap, "vec3");
    this.dataBuffer = instancedArray(this.cap, "vec2");
    this.colorBuffer = instancedArray(this.cap, "vec3");
    this.litBuffer = instancedArray(this.cap, "vec3"); // ParticleLight: освещённость на частицу (light-проход)

    // spawn-текстуры (CAP×1, RGBA float, nearest — сэмплим точные тексели).
    this.spawnPosData = new Float32Array(SPAWN_CAP * 4);
    this.spawnColData = new Float32Array(SPAWN_CAP * 4).fill(1); // белый = без тинта
    this.spawnPosTex = this.makeSpawnTex(this.spawnPosData);
    this.spawnColTex = this.makeSpawnTex(this.spawnColData);

    this.mapData = new Uint8Array(MAP_TEX * MAP_TEX);
    this.mapTex = new DataTexture(this.mapData, MAP_TEX, MAP_TEX, RedFormat, UnsignedByteType);
    this.mapTex.minFilter = NearestFilter; this.mapTex.magFilter = NearestFilter; this.mapTex.needsUpdate = true;

    // Кадр видео (RGBA 128×128) — ЦВЕТ частицы при map-эмиссии (аналог attribfrommap→Cd из Houdini):
    // частица, рождённая по карте плотности, красится цветом кадра в точке рождения. CPU→GPU upload
    // на низкой частоте (мост ~12Гц), ноль readback. Без кадра (uHasVid=0) — белый, тонирует Color.
    this.vidData = new Uint8Array(VID_TEX * VID_TEX * 4).fill(255);
    this.vidTex = new DataTexture(this.vidData, VID_TEX, VID_TEX, RGBAFormat, UnsignedByteType);
    this.vidTex.minFilter = NearestFilter; this.vidTex.magFilter = NearestFilter; this.vidTex.needsUpdate = true;

    // init compute (структуро-независим) — засеять всю популяцию на CAP.
    this.computeInit = Fn(() => {
      const i = instanceIndex;
      // PCG-хеш three корректен от ЦЕЛОГО сида — instanceIndex идеален (см. h01 про дробные).
      const seed = hash(i.toFloat()).toVar();
      const sp = this.sampleSpawn(seed);
      this.positionBuffer.element(i).assign(sp.pos);
      this.velocityBuffer.element(i).assign(this.initVel(seed));
      this.colorBuffer.element(i).assign(sp.col);
      // стартовый age рандомен в [0,life) — респавны не пульсируют синхронно.
      const life = this.lifeOf(seed);
      this.dataBuffer.element(i).assign(vec2(this.h01(seed.add(0.999)).mul(life), seed));
    })().compute(this.cap);

    this.geometry = new PlaneGeometry(1, 1); // квад-спрайт; позиция/размер задаются positionNode на инстанс

    this.buildForces(sys);
    this.buildPipeline(sys);
    this.applyParams(sys);
  }

  private makeSpawnTex(data: Float32Array): DataTexture {
    const t = new DataTexture(data, SPAWN_CAP, 1, RGBAFormat, FloatType);
    t.minFilter = NearestFilter;
    t.magFilter = NearestFilter;
    t.needsUpdate = true;
    return t;
  }

  // hash01 от ДРОБНОГО сида. БАГ-ФИКС: three.hash() = PCG от seed.toUint() — ЦЕЛОЙ части! —
  // поэтому дробные сиды (0..1) коллапсировали в 1-2 значения: частицы спавнились ровно из 2
  // текселей спавн-текстуры, жизни/скорости/джиттер были квантованы. Растягиваем дробь в целые
  // 0..2^22 (f32 представляет точно, сатурации f32→u32 в WGSL нет).
  private h01(x: Node): Node { return hash(x.fract().mul(4194304.0)); }

  // life частицы из seed: uLife·(1 + (hash-0.5)·2·lifeVar).
  private lifeOf(seed: Node): Node {
    return this.uLife.mul(float(1).add(this.h01(seed.add(0.321)).sub(0.5).mul(2).mul(this.uLifeVar))).max(0.1);
  }

  // стартовая скорость: случайное направление · uInitSpeed (разброс uVelSpread не используем в v1 строго —
  // направление полностью случайно, скорость = uInitSpeed). Нулевая по умолчанию.
  private initVel(seed: Node): Node {
    const dir = vec3(
      this.h01(seed.add(0.11)).sub(0.5), this.h01(seed.add(0.22)).sub(0.5), this.h01(seed.add(0.33)).sub(0.5),
    );
    return dir.mul(this.uInitSpeed).mul(this.uVelSpread.add(0.001));
  }

  // Нормированный кадр-UV (nx,ny ∈0..1) → world в видео-rect (y вниз) + z по глубине.
  private uvToWorld(nx: Node, ny: Node, d: Node): Node {
    return vec3(nx.mul(2).sub(1).mul(this.uRectX), ny.mul(2).sub(1).mul(this.uRectY).mul(-1), d.mul(this.uDepthScale));
  }

  // Спавн-позиция (world) + цвет. Приоритет: points-источник (uSpawnCount>0) → map-карта плотности
  // (uHasMap>0, эмит по глубине) → box-фолбэк. + jitter. Карта: 4-сэмпл max-density bias (importance-
  // приближение rejection-sampling без Loop) + порог-kill (ниже порога частица за far-плоскость).
  private sampleSpawn(seed: Node): { pos: Node; col: Node } {
    const useSrc = this.uSpawnCount.greaterThan(0).toFloat();
    // --- points-источник (spawn-текстура) ---
    const idx = this.h01(seed.add(0.7)).mul(this.uSpawnCount).floor();
    const u = idx.add(0.5).div(SPAWN_CAP);
    const uvSrc = vec2(u, 0.5);
    const s = texture(this.spawnPosTex).sample(uvSrc).xyz; // нормированные nx,ny,nz
    const worldSrc = this.uvToWorld(s.x, s.y, s.z);
    const colSrc = texture(this.spawnColTex).sample(uvSrc).xyz;
    // --- map-карта плотности: 4 кандидата, берём максимум значения карты ---
    // (сдвиги сабсидов ДРОБНО-различны: h01 работает от fract, целая часть отбрасывается)
    const uv1 = vec2(this.h01(seed.add(0.13)), this.h01(seed.add(0.71)));
    const uv2 = vec2(this.h01(seed.add(0.29)), this.h01(seed.add(0.83)));
    const uv3 = vec2(this.h01(seed.add(0.43)), this.h01(seed.add(0.97)));
    const uv4 = vec2(this.h01(seed.add(0.59)), this.h01(seed.add(0.37)));
    const d1 = texture(this.mapTex).sample(uv1).x;
    const d2 = texture(this.mapTex).sample(uv2).x;
    const d3 = texture(this.mapTex).sample(uv3).x;
    const d4 = texture(this.mapTex).sample(uv4).x;
    let bUV: Node = uv1; let bD: Node = d1.toVar();
    bUV = mix(bUV, uv2, d2.greaterThan(bD).toFloat()); bD = bD.max(d2);
    bUV = mix(bUV, uv3, d3.greaterThan(bD).toFloat()); bD = bD.max(d3);
    bUV = mix(bUV, uv4, d4.greaterThan(bD).toFloat()); bD = bD.max(d4);
    const worldMap = this.uvToWorld(bUV.x, bUV.y, bD);
    const useMap = this.uHasMap.greaterThan(0).toFloat().mul(float(1).sub(useSrc));
    const dead = bD.lessThan(this.uMapThreshold).toFloat().mul(useMap); // ниже порога → за far-плоскость
    // --- box-фолбэк (без source/map): демо-частицы по всей рамке видео ±uRect (мир теперь
    // video-aligned, камера contain-фитит видео-rect — литерал [-1,1] заполнял бы не весь кадр). ---
    const rnd = vec3(this.h01(seed.add(0.1)), this.h01(seed.add(0.2)), this.h01(seed.add(0.3)));
    const worldBox = mix(
      vec3(this.uRectX.negate(), this.uRectY.negate(), -0.3),
      vec3(this.uRectX, this.uRectY, 0.3), rnd);
    const jit = vec3(this.h01(seed.add(0.41)).sub(0.5), this.h01(seed.add(0.52)).sub(0.5), this.h01(seed.add(0.63)).sub(0.5))
      .mul(this.uJitter);
    // выбор: box → map → points (последний перекрывает)
    let pos: Node = mix(worldBox, worldMap, useMap);
    pos = mix(pos, worldSrc, useSrc).add(jit);
    pos = vec3(pos.x, pos.y, mix(pos.z, float(-1000), dead)); // kill ниже порога карты
    // цвет: map-рождение красится КАДРОМ ВИДЕО в точке рождения (uHasVid; иначе белый);
    // points-источник несёт свой цвет (Cd/видео — кладёт мост); box → белый (тинт решает Color).
    const colVid = texture(this.vidTex).sample(bUV).xyz;
    let col: Node = mix(vec3(1, 1, 1), colVid, useMap.mul(this.uHasVid));
    col = mix(col, colSrc, useSrc);
    return { pos, col };
  }

  // Создать uniform'ы на каждый Force-узел (число = структурно). Значения зальёт applyParams.
  private buildForces(sys: ResolvedParticleSystem): void {
    this.forceU = sys.forces.map(() => ({
      gx: uniform(0, "float"), gy: uniform(0, "float"), gz: uniform(0, "float"),
      gStrength: uniform(1, "float"), gOn: uniform(0, "float"),
      nAmp: uniform(0, "float"), nScale: uniform(0.35, "float"), nSpeed: uniform(0.2, "float"), nOn: uniform(0, "float"),
      drag: uniform(0, "float"), dragOn: uniform(0, "float"),
    }));
  }

  // Ячейка voxel-грида самозатенения для мировой точки: мир [-2,2]³ → side³, компонентный clamp держит
  // край (частицы за гридом прилипают к крайней ячейке — на тень почти не влияет). Биннинг — nearest.
  private gridIndex(p: Node): Node {
    const side = this.shadow!.side;
    const g = p.add(2).mul(side / 4).floor().clamp(0, side - 1);
    return g.z.mul(side * side).add(g.y.mul(side)).add(g.x).toInt();
  }

  // ТРИЛИНЕЙНЫЙ сэмпл плотности грида в мировой точке (8 atomicLoad + lerp) — гладкая тень без
  // «лесенки»/квадратов от voxel-сетки. `blur` (0..) сдвигает к центрам ячеек = мягче (мягкий свет).
  // Только в compute (atomicLoad на read_write atomic валиден).
  private sampleDensity(p: Node, blur: Node): Node {
    const side = this.shadow!.side;
    const gp = p.add(2).mul(side / 4).sub(0.5); // непрерывные координаты вокруг центров ячеек
    const b = gp.floor();
    // мягкость: тянем дробную часть к 0.5 (центр между ячейками = размытие) на blur
    const f0 = gp.sub(b);
    const f = mix(f0, vec3(0.5, 0.5, 0.5), blur.clamp(0, 1));
    const at = (ox: number, oy: number, oz: number): Node => {
      const c = b.add(vec3(ox, oy, oz)).clamp(0, side - 1);
      const idx = c.z.mul(side * side).add(c.y.mul(side)).add(c.x).toInt();
      return atomicLoad(this.shadow!.grid.element(idx)).toFloat();
    };
    const x00 = mix(at(0, 0, 0), at(1, 0, 0), f.x), x10 = mix(at(0, 1, 0), at(1, 1, 0), f.x);
    const x01 = mix(at(0, 0, 1), at(1, 0, 1), f.x), x11 = mix(at(0, 1, 1), at(1, 1, 1), f.x);
    return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
  }

  // Дивергентно-свободный curl-noise через конечные разности (из спайка). p в world.
  private curl(p: Node, u: ForceU): Node {
    const EPS = float(0.1);
    const pot = (q: Node): Node => mx_noise_vec3(q.mul(u.nScale).add(vec3(this.uTime.mul(u.nSpeed))));
    const dx = vec3(EPS, 0, 0), dy = vec3(0, EPS, 0), dz = vec3(0, 0, EPS);
    const inv = EPS.mul(2).reciprocal();
    const dPdx = pot(p.add(dx)).sub(pot(p.sub(dx))).mul(inv);
    const dPdy = pot(p.add(dy)).sub(pot(p.sub(dy))).mul(inv);
    const dPdz = pot(p.add(dz)).sub(pot(p.sub(dz))).mul(inv);
    return vec3(dPdy.z.sub(dPdz.y), dPdz.x.sub(dPdx.z), dPdx.y.sub(dPdy.x));
  }

  // Сырой turbulence (не div-free): прямое векторное поле шума.
  private turb(p: Node, u: ForceU): Node {
    return mx_noise_vec3(p.mul(u.nScale).add(vec3(this.uTime.mul(u.nSpeed))));
  }

  // Аккумуляция сил всех Force-узлов: gravity + noise + drag (коммутативно, порядок не важен).
  private accel(p: Node, v: Node, sys: ResolvedParticleSystem): Node {
    let a: Node = vec3(0, 0, 0);
    this.forceU.forEach((u, i) => {
      a = a.add(vec3(u.gx, u.gy, u.gz).mul(u.gStrength).mul(u.gOn));
      const mode = String(sys.forces[i]?.params.forceNoiseMode ?? "curl");
      const nf = mode === "turbulence" ? this.turb(p, u) : this.curl(p, u);
      a = a.add(nf.mul(u.nAmp).mul(u.nOn));
      a = a.add(v.mul(-1).mul(u.drag).mul(u.dragOn));
    });
    return a;
  }

  // (Пере)сборка update-compute + материала (зависят от структуры: силы / режим цвета / наличие Света).
  private buildPipeline(sys: ResolvedParticleSystem): void {
    this.hasLight = !!sys.light; // Field гейтит clear voxel-грида по этому флагу
    this.computeUpdate = Fn(() => {
      const i = instanceIndex;
      const posEl = this.positionBuffer.element(i);
      const velEl = this.velocityBuffer.element(i);
      const dataEl = this.dataBuffer.element(i);
      const colEl = this.colorBuffer.element(i);

      const p = posEl.toVar();
      const v = velEl.toVar();
      const age = dataEl.x.toVar();
      const seed = dataEl.y.toVar();
      const dt = this.uDt;

      const a = this.accel(p, v, sys);
      v.addAssign(a.mul(dt));
      v.mulAssign(float(1).sub(this.uDamping.mul(dt).min(1))); // вязкость солвера
      p.addAssign(v.mul(dt));
      age.addAssign(dt);

      // Секция «Границы» Force-нод (аналог limit1 zigzag из TD): bounce/wrap у рамки видео по X/Y,
      // Z свободен (как chanmask=3). Структурно по forceBoundsMode (входит в structureKey);
      // функционально (step/clamp/mod), без If — bounce побеждает, если включён хоть в одной Force.
      const boundsModes = sys.forces.map((f) => String(f.params.forceBoundsMode ?? "none"));
      if (boundsModes.includes("bounce")) {
        const bx = this.uRectX, by = this.uRectY;
        // снаружи рамки И летим наружу → флип знака скорости; позиция прижимается к рамке
        const flip = (pc: Node, vc: Node, b: Node): Node =>
          float(1).sub(pc.abs().greaterThan(b).and(pc.mul(vc).greaterThan(0)).toFloat().mul(2));
        v.assign(vec3(v.x.mul(flip(p.x, v.x, bx)), v.y.mul(flip(p.y, v.y, by)), v.z));
        p.assign(vec3(p.x.clamp(bx.negate(), bx), p.y.clamp(by.negate(), by), p.z));
      } else if (boundsModes.includes("wrap")) {
        const wrap1 = (pc: Node, b: Node): Node => pc.add(b).mod(b.mul(2)).sub(b); // тор через край
        p.assign(vec3(wrap1(p.x, this.uRectX), wrap1(p.y, this.uRectY), p.z));
      }

      // recycle по возрасту ИЛИ при вылете за видимую зону — иначе curl уносит частицы за кадр и
      // экран пустеет. Порог покомпонентно от рамки видео (±2·uRect; мир теперь video-aligned,
      // rectX=аспект может быть >1 — старый |p|>1.8 рециклил частицы прямо у краёв кадра).
      const life = this.lifeOf(seed);
      const escaped = p.x.abs().greaterThan(this.uRectX.mul(2))
        .or(p.y.abs().greaterThan(this.uRectY.mul(2)))
        .or(p.z.abs().greaterThan(2));
      If(age.greaterThanEqual(life).or(escaped), () => {
        // newSeed: только ДРОБНЫЕ слагаемые (seed точки + дробь времени) → h01 не теряет точность
        // (большие суммы вида i·φ+time на f32 теряли дробь → респавн-рандом «ступенчатый»).
        const newSeed = this.h01(seed.add(this.uTime.fract().mul(0.7531)).add(0.017)).toVar();
        const sp = this.sampleSpawn(newSeed);
        p.assign(sp.pos);
        v.assign(this.initVel(newSeed));
        colEl.assign(sp.col);
        age.assign(0);
        seed.assign(newSeed);
      });

      posEl.assign(p);
      velEl.assign(v);
      dataEl.assign(vec2(age, seed));

      // ParticleLight: биннинг частицы в общий voxel-грид плотности (1 atomicAdd). У ВСЕХ систем, когда
      // есть хоть одна нода Света (binActive от Field) — кросс-системные тени (крупные частицы соседней
      // системы затеняют эту, даже без своей ноды Света). Мёртвые (за far) — мимо.
      if (this.shadow?.atomics && this.binActive) {
        If(p.z.greaterThan(-100), () => {
          atomicAdd(this.shadow!.grid.element(this.gridIndex(p)), 1);
        });
      }
    })().compute(this.cap);

    // Рендер: InstancedMesh квадов. На инстанс: центр = positionBuffer.element(i), вершина квада =
    // positionLocal·uSize (камера фронт-орто → биллборд не нужен). Атрибуты — .element(instanceIndex),
    // НЕ .toAttribute() (то для per-vertex Points). Это РАСТЕРИЗУЕТСЯ в WebGPU (Points — нет).
    const mode = sys.color ? String(sys.color.params.pcolorMode ?? "byVelocity") : "byVelocity";
    const speed = this.velocityBuffer.element(instanceIndex).length();
    const age = this.dataBuffer.element(instanceIndex).x;
    let base: Node;
    if (mode === "constant") base = this.uColorA;
    else if (mode === "byAge") base = mix(this.uColorA, this.uColorB, saturate(age.div(this.uLife)));
    else base = mix(this.uColorA, this.uColorB, saturate(speed.mul(0.18))); // byVelocity
    const center = this.positionBuffer.element(instanceIndex);
    // ParticleLight (darkroom-модель): цвет = АЛЬБЕДО × освещённость. litBuffer считает light-проход
    // (компьют, рей-марч тени) на частицу; материал лишь читает (дёшево). uLAmbient — заполнение (0 =
    // вне луча ЧЁРНОЕ). Без ноды Света — прежний ×1.6-буст (back-compat байт-в-байт).
    const albedo = base.mul(this.colorBuffer.element(instanceIndex));
    const colorNode = sys.light
      ? albedo.mul(this.litBuffer.element(instanceIndex).add(this.uLAmbient))
      : albedo.mul(1.6);
    // ParticleLight: light-проход — освещённость на частицу (color·int·cone·att·shadow) в КОМПЬЮТЕ
    // (раз на частицу, не на вершину). Рей-марч тени трилинейно сэмплит грид. Строим только при sys.light.
    this.computeLight = null;
    if (sys.light) this.buildLightPass();
    // U3: per-particle размер из seed частицы (dataBuffer.y). uSizeVar=0 → factor=1 (одинаковый, back-compat).
    const seedR = this.dataBuffer.element(instanceIndex).y;
    const sizeF = float(1).add(this.h01(seedR).sub(0.5).mul(2).mul(this.uSizeVar)).max(0.05);

    const oldMat = this.material;
    const mat = new MeshBasicNodeMaterial();
    mat.positionNode = center.add(positionLocal.mul(this.uSize.mul(sizeF))); // квад вокруг центра, размер ×per-particle factor
    mat.colorNode = colorNode;
    (mat as Node).opacityNode = this.uOpacity;
    mat.transparent = true;
    // НАСТОЯЩЕЕ 3D-перекрытие: depth-тест+write (общий depth-буфер сортирует ВСЕ системы по реальному z —
    // ближние частицы перекрывают дальние, даже из разных систем). applyParams переключает по
    // prenderDepthWrite (false = старый HUD-glow: depthTest off, аддитив всегда поверх).
    mat.depthWrite = true;
    mat.depthTest = true;
    mat.blending = AdditiveBlending; // applyParams выставит по prenderBlend
    this.material = mat;

    if (this.mesh) {
      this.mesh.material = mat;
    } else {
      this.mesh = new InstancedMesh(this.geometry, mat, this.cap);
      this.mesh.frustumCulled = false; // позиции на GPU → CPU-bounding бессмыслен
      this.mesh.count = this.count;
      this.scene.add(this.mesh);
    }
    oldMat?.dispose();
  }

  // ParticleLight: compute-проход освещённости. Для каждой частицы — конус прожектора + спад по дистанции
  // + Beer-рей-марч тени (трилинейный сэмпл грида, отступ uLSelf от себя, мягкость по спреду) → litBuffer
  // (color·int·cone·att·shadow). Дохлые (z за far) → 0. Запускается ПОСЛЕ биннинга всех систем.
  private buildLightPass(): void {
    const STEPS = 12;
    this.computeLight = Fn(() => {
      const i = instanceIndex;
      const p = this.positionBuffer.element(i);
      const alive = p.z.greaterThan(-100).toFloat();
      const toL = this.uLPos.sub(p);
      const dist = toL.length().max(1e-4);
      const ldir = toL.div(dist);
      // ось прожектора: свет → центр сцены (0,0,0). normalize вручную (свет в нуле → NaN иначе).
      const axis = this.uLPos.div(this.uLPos.length().max(1e-4)).negate();
      const cone = smoothstep(this.uLCosOuter, this.uLCosInner, ldir.negate().dot(axis));
      const att = float(1).div(float(1).add(dist.div(this.uLRadius).pow(2)));
      // Beer-рей-марч к свету: трилинейный сэмпл (гладко, без «лесенки»), старт с отступом uLSelf
      // (частица не тенит сама себя → есть форма), мягкость blur = спред (мягкий свет → размытая тень).
      const sum = float(0).toVar();
      const marchLen = dist.sub(this.uLSelf).clamp(0.05, 2.6);
      const stepLen = marchLen.div(STEPS);
      const blur = this.uLSpread01.mul(0.6);
      Loop(STEPS, ({ i: s }: { i: Node }) => {
        const t = this.uLSelf.add(stepLen.mul(s.toFloat().add(0.5)));
        sum.addAssign(this.sampleDensity(p.add(ldir.mul(t)), blur));
      });
      const shadow = exp(sum.mul(stepLen).mul(this.uLShadow).mul(-0.12)).clamp(0, 1);
      const lit = this.uLColor.mul(this.uLIntensity).mul(cone).mul(att).mul(shadow).mul(alive);
      this.litBuffer.element(i).assign(lit);
    })().compute(this.cap);
  }

  // Поза света для гизмо (ParticleField рисует маркер+луч+конус). null = нет Света / гизмо выкл.
  getLightPose(): { x: number; y: number; z: number; color: [number, number, number]; cosOuter: number; on: boolean } | null {
    if (!this.hasLight) return null;
    const p = this.uLPos.value as unknown as { x: number; y: number; z: number };
    const c = this.uLColor.value as unknown as { x: number; y: number; z: number };
    return { x: p.x, y: p.y, z: p.z, color: [c.x, c.y, c.z], cosOuter: this.uLCosOuter.value as unknown as number, on: this.lightGizmo };
  }

  // Запуск light-прохода (ParticleField зовёт после биннинга, перед render). Только при наличии Света.
  lightPass(renderer: Renderer): void {
    if (this.disposed || !this.computeLight) return;
    if ((this.computeLight as Node).count !== this.count) {
      (this.computeLight as Node).count = this.count;
      (this.computeLight as Node).updateDispatchCount();
    }
    renderer.compute(this.computeLight);
  }

  // Засеять буферы один раз (после init() рендерера). Идемпотентно по вызывающему.
  async seed(renderer: Renderer): Promise<void> {
    await renderer.computeAsync(this.computeInit);
  }

  // Структура сменилась? Пересобрать TSL (силы/цвет/Свет/биннинг) — редко, не на крутилке параметра.
  // binActive — поле-уровневый флаг биннинга (Свет появился/ушёл В ЛЮБОЙ системе → ребилд compute).
  needsRestructure(sys: ResolvedParticleSystem, binActive = this.binActive): boolean {
    return structureKey(sys) !== this.structSig || binActive !== this.binActive;
  }

  async restructure(renderer: Renderer, sys: ResolvedParticleSystem, binActive = this.binActive): Promise<void> {
    this.structSig = structureKey(sys);
    this.binActive = binActive;
    this.buildForces(sys);
    this.buildPipeline(sys);
    this.applyParams(sys);
    await renderer.computeAsync(this.computeUpdate); // прекомпиляция нового шейдера без фриза рендера
  }

  // params → uniforms (каждый кадр; НЕ пересобирает шейдер).
  applyParams(sys: ResolvedParticleSystem): void {
    const e = sys.emitters[0]?.params ?? {};
    this.uLife.value = Number(e.emitterLife ?? 4);
    this.uLifeVar.value = Number(e.emitterLifeVar ?? 0.5);
    this.uJitter.value = Number(e.emitterJitterPos ?? 0.01);
    this.uInitSpeed.value = Number(e.emitterInitSpeed ?? 0);
    this.uVelSpread.value = Number(e.emitterVelSpread ?? 0.3);
    this.uDamping.value = Number(sys.solver.damping ?? 0);
    this.uMapThreshold.value = Number(e.emitterMapThreshold ?? 0.5);

    sys.forces.forEach((f, i) => {
      const u = this.forceU[i]; if (!u) return;
      const p = f.params;
      u.gx.value = Number(p.forceGravityX ?? 0); u.gy.value = Number(p.forceGravityY ?? 0); u.gz.value = Number(p.forceGravityZ ?? 0);
      u.gStrength.value = Number(p.forceGravityStrength ?? 1); u.gOn.value = p.forceGravityOn ? 1 : 0;
      u.nAmp.value = Number(p.forceNoiseAmp ?? 0); u.nScale.value = Number(p.forceNoiseScale ?? 0.35);
      u.nSpeed.value = Number(p.forceNoiseSpeed ?? 0.2); u.nOn.value = p.forceNoiseOn ? 1 : 0;
      u.drag.value = Number(p.forceDrag ?? 0); u.dragOn.value = p.forceDragOn ? 1 : 0;
    });

    const c = sys.color?.params ?? {};
    const a = hexRgb(String(c.pcolorA ?? "#40b3ff"));
    const b = hexRgb(String(c.pcolorB ?? "#ffd966"));
    (this.uColorA.value as Node).set?.(a[0], a[1], a[2]);
    (this.uColorB.value as Node).set?.(b[0], b[1], b[2]);

    // ParticleLight: все ручки света — uniforms (живая крутилка без пересборки TSL).
    const li = sys.light?.params;
    if (li) {
      (this.uLPos.value as Node).set?.(Number(li.plightX ?? 0.9), Number(li.plightY ?? 0.9), Number(li.plightZ ?? 1.4));
      const lc = hexRgb(String(li.plightColor ?? "#ffffff"));
      (this.uLColor.value as Node).set?.(lc[0], lc[1], lc[2]);
      this.uLIntensity.value = Number(li.plightIntensity ?? 1.6);
      const ang = (Math.max(1, Math.min(90, Number(li.plightAngle ?? 40))) * Math.PI) / 180;
      const spread = Math.max(0, Math.min(1, Number(li.plightSpread ?? 0.35)));
      this.uLCosOuter.value = Math.cos(ang);
      this.uLCosInner.value = Math.cos(ang * Math.max(0.05, 1 - spread)); // спред: шире ядро ↔ мягче край
      this.uLRadius.value = Math.max(0.1, Number(li.plightSize ?? 1.6));
      this.uLShadow.value = Math.max(0, Math.min(1, Number(li.plightShadow ?? 0.7)));
      this.uLAmbient.value = Math.max(0, Math.min(0.5, Number(li.plightAmbient ?? 0.04)));
      this.uLSpread01.value = spread; // мягкость тени = тот же спред, что у конуса
      this.lightGizmo = li.plightGizmo !== false;
    }

    const r = sys.render?.params ?? {};
    this.uSize.value = Math.max(0.002, Number(r.prenderSize ?? 3) * 0.004); // px → мировой полу-размер квада
    this.uSizeVar.value = Math.max(0, Math.min(1, Number(r.prenderSizeVar ?? 0))); // U3: per-particle разброс
    this.uOpacity.value = Number(r.prenderOpacity ?? 1);
    const blend = String(r.prenderBlend ?? "additive") === "normal" ? NormalBlending : AdditiveBlending;
    if (this.material.blending !== blend) { this.material.blending = blend; this.material.needsUpdate = true; }
    // 3D-перекрытие vs HUD-glow: depthTest+write = реальная глубина (системы перекрывают друг друга по z);
    // false = аддитив всегда поверх. depthTest следует тому же флагу (выключен → glow всегда видно).
    const dw = r.prenderDepthWrite !== false; // default true (настоящее 3D)
    if (this.material.depthWrite !== dw) { this.material.depthWrite = dw; this.material.depthTest = dw; this.material.needsUpdate = true; }

    // rate как фракция населения (0..1 значимо; >1 = полное). Адаптив ужимает дальше под нагрузкой.
    const rate = Math.max(0, Math.min(1, Number(e.emitterRate ?? 1)));
    this.targetMax = Math.max(0, Math.floor(this.cap * rate));
  }
  private targetMax = 0;

  // Камера-маппинг + время (общие на кадр, из ParticleField).
  setFrame(dtSec: number, time: number, rectX: number, rectY: number, depthScale: number): void {
    this.uDt.value = dtSec;
    this.uTime.value = time;
    this.uRectX.value = rectX;
    this.uRectY.value = rectY;
    this.uDepthScale.value = depthScale;
  }

  // Обновить spawn-буфер источника (нормированные [nx,ny,nz, r,g,b]×n). Низкая частота.
  setSpawn(flat: Float32Array, n: number): void {
    const count = Math.max(0, Math.min(SPAWN_CAP, n));
    for (let i = 0; i < count; i++) {
      this.spawnPosData[i * 4] = flat[i * 6]; this.spawnPosData[i * 4 + 1] = flat[i * 6 + 1];
      this.spawnPosData[i * 4 + 2] = flat[i * 6 + 2]; this.spawnPosData[i * 4 + 3] = 1;
      this.spawnColData[i * 4] = flat[i * 6 + 3]; this.spawnColData[i * 4 + 1] = flat[i * 6 + 4];
      this.spawnColData[i * 4 + 2] = flat[i * 6 + 5]; this.spawnColData[i * 4 + 3] = 1;
    }
    this.spawnPosTex.needsUpdate = true;
    this.spawnColTex.needsUpdate = true;
    this.uSpawnCount.value = count;
  }

  // Обновить map-источник эмиссии (кадр глубины). Nearest-копит в фикс 256×256 (размер кадра может
  // меняться — текстура-объект стабилен, ноду не пересобираем). null/нет кадра → uHasMap=0.
  setMap(frame: DepthFrame | null | undefined): void {
    if (!frame || frame.width < 2 || frame.height < 2) { this.uHasMap.value = 0; return; }
    const { data, width, height } = frame;
    for (let y = 0; y < MAP_TEX; y++) {
      const sy = Math.min(height - 1, (y * height / MAP_TEX) | 0);
      const row = sy * width, drow = y * MAP_TEX;
      for (let x = 0; x < MAP_TEX; x++) {
        this.mapData[drow + x] = data[row + Math.min(width - 1, (x * width / MAP_TEX) | 0)];
      }
    }
    this.mapTex.needsUpdate = true;
    this.uHasMap.value = 1;
  }

  // Обновить кадр видео для цвета map-эмиссии (RGBA VID_TEX×VID_TEX, из ImageData моста).
  // null → uHasVid=0 (белый). Низкая частота, как setMap.
  setVideoFrame(rgba: Uint8ClampedArray | null): void {
    if (!rgba || rgba.length < VID_TEX * VID_TEX * 4) { this.uHasVid.value = 0; return; }
    this.vidData.set(rgba.subarray(0, VID_TEX * VID_TEX * 4));
    this.vidTex.needsUpdate = true;
    this.uHasVid.value = 1;
  }

  // Один шаг симуляции (compute). Рендер делает ParticleField (общий renderer.render).
  step(renderer: Renderer): void {
    if (this.disposed) return;
    if ((this.computeUpdate as Node).count !== this.count) {
      (this.computeUpdate as Node).count = this.count;
      (this.computeUpdate as Node).updateDispatchCount();
    }
    renderer.compute(this.computeUpdate);
    this.mesh.count = this.count; // InstancedMesh: число рисуемых инстансов = живая популяция
  }

  // Адаптивное население (EMA dtMs + deadband), уважает targetMax (rate-фракцию). budget — общий
  // потолок от ParticleField (делит бюджет между системами).
  // БАГ-ФИКС гистерезиса: (1) рост требовал emaMs<13 — на 60Гц-vsync кадр всегда ~16.7мс, т.е.
  // ужавшееся население НИКОГДА не росло обратно (рейт вверх «не работал»); пороги теперь вокруг
  // vsync (<18 рост, >22 шринк). (2) проезд рейта через 0 ронял count в 0 навсегда — мгновенный
  // минимум 2000 при ненулевом hardMax, дальше адаптив растит.
  adapt(dtMs: number, budget: number): void {
    this.emaMs = this.emaMs * 0.9 + dtMs * 0.1;
    const hardMax = Math.min(this.cap, this.targetMax, budget);
    const floorN = Math.min(50000, hardMax);
    if (hardMax > 0 && this.count < Math.min(2000, hardMax)) this.count = Math.min(2000, hardMax);
    if (this.cooldown > 0) { this.cooldown--; this.count = Math.min(this.count, hardMax); return; }
    if (this.emaMs > 22 && this.count > floorN) { this.count = Math.max(floorN, Math.floor(this.count * 0.85)); this.cooldown = 30; }
    else if (this.emaMs < 18 && this.count < hardMax) { this.count = Math.min(hardMax, Math.floor(this.count * 1.1) + 1000); this.cooldown = 30; }
    else this.count = Math.min(this.count, hardMax);
  }

  // U2 (направление U: частицы = точки): readback живой популяции в CPU-PointSet. GPU→CPU через
  // getArrayBufferAsync(positionBuffer) — ЛЕГАЛЬНО на НИЗКОЙ частоте (как кадр глубины, не в кадре).
  // Downsample ≤maxPoints (страйд по live count), world→нормированный кадр-UV (инверсия uvToWorld:
  // nx=(wx/rectX+1)/2, ny=(1−wy/rectY)/2, d=wz/depthScale), мёртвые (z за far ≈−1000) отброшены.
  // Возврат — плоский [nx,ny,d]×k, ИЛИ [nx,ny,d, r,g,b]×k при withColor (U3: Cd сквозь границу —
  // наследованный colorBuffer частицы → Cd точки; ещё один getArrayBufferAsync, по флагу = дешевле
  // базовый случай). disposed/нет API → пусто.
  async readback(renderer: Renderer, maxPoints: number, withColor = false): Promise<Float32Array> {
    const cap = Math.max(1, Math.round(maxPoints));
    if (this.disposed || !renderer.getArrayBufferAsync || this.count <= 0) return new Float32Array(0);
    const attr = (this.positionBuffer as Node).value;
    if (!attr) return new Float32Array(0);
    const ab = await renderer.getArrayBufferAsync(attr);
    if (this.disposed) return new Float32Array(0);
    const floats = new Float32Array(ab);
    const fpi = Math.max(3, Math.round(floats.length / this.cap)); // 3 или 4 (vec3 padding до 16б)
    // U3: цвет (Cd) — второй readback colorBuffer (тот же страйд). withColor=false → не платим.
    let cfloats: Float32Array | null = null, cfpi = 4;
    if (withColor) {
      const cattr = (this.colorBuffer as Node).value;
      // lockstep: withColor ОБЯЗАН дать страйд-6 (readbackToField парсит 6). Нет colorBuffer →
      // пусто (как position-гард), а не молчаливый страйд-3 vs страйд-6 рассинхрон у потребителя.
      if (!cattr) return new Float32Array(0);
      const cab = await renderer.getArrayBufferAsync(cattr);
      if (this.disposed) return new Float32Array(0);
      cfloats = new Float32Array(cab);
      cfpi = Math.max(3, Math.round(cfloats.length / this.cap));
    }
    const live = Math.min(this.count, this.cap);
    const step = Math.max(1, Math.ceil(live / cap));
    const rectX = this.uRectX.value || 1, rectY = this.uRectY.value || 1;
    const ds = this.uDepthScale.value || 0.5;
    const out: number[] = [];
    for (let i = 0; i < live; i += step) {
      const b = i * fpi;
      const wx = floats[b], wy = floats[b + 1], wz = floats[b + 2];
      if (wz < -100) continue; // killed (за far-плоскостью)
      out.push((wx / rectX + 1) * 0.5, (1 - wy / rectY) * 0.5, wz / ds);
      if (cfloats) { const cb = i * cfpi; out.push(cfloats[cb], cfloats[cb + 1], cfloats[cb + 2]); }
    }
    return Float32Array.from(out);
  }

  // Освобождение GPU-ресурсов (§7). Идемпотентно. Порядок: сцена → geometry/material → буферы → текстуры.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.mesh) this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material?.dispose();
    this.positionBuffer.value?.dispose?.();
    this.velocityBuffer.value?.dispose?.();
    this.dataBuffer.value?.dispose?.();
    this.colorBuffer.value?.dispose?.();
    this.litBuffer.value?.dispose?.();
    this.spawnPosTex.dispose();
    this.spawnColTex.dispose();
    this.mapTex.dispose();
    this.vidTex.dispose();
  }
}
