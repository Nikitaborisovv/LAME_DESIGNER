// Мост между моделью слоёв (LayeredConfig — то, что редактирует UI и хранят пресеты) и
// «резолвнутой» плоской формой (SceneConfig — то, что читает движок рендера).
//
//  - resolveConfig(layered): SceneConfig — развернуть слои в плоский конфиг (renderMode/
//    composite — производные от наличия включённых 2D/3D-слоёв).
//  - flatConfigToLayers(old): LayeredConfig — авто-миграция старого плоского конфига/пресета
//    в слои (создаём только АКТИВНЫЕ слои, чтобы список не засорялся выключенными).

import {
  DEFAULT_CONFIG, GLOBAL_FIELDS,
  type SceneConfig, type LayeredConfig, type Layer, type LayerKind, type GlobalKey,
  type EffectNode, type ModifierInstance, type DriverKind, type ParamBinding,
  type ResolvedParticleSystem,
} from "./types";
import { LAYER_DEFS, LAYER_ORDER, paramFields, makeLayer } from "./layerRegistry";
import { MODIFIER_DEFS } from "./modifierRegistry";
import { PRODUCER_ENABLE, isPointProducer } from "./pointSources";
import { driverProducer } from "./drivers";

function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = obj[k];
  return out;
}

function pickGlobals(c: SceneConfig): Pick<SceneConfig, GlobalKey> {
  return pick(c, GLOBAL_FIELDS);
}

// Был ли эффект «активен» в старом плоском конфиге (с учётом спец-случаев гейтинга).
function isActive(full: SceneConfig, kind: LayerKind): boolean {
  if (kind === "hud") return full.hudText.trim().length > 0;
  if (kind === "peopleBox") return full.peopleBoxEnabled && full.peopleMasksEnabled;
  const ef = LAYER_DEFS[kind].enabledField;
  return ef ? !!full[ef] : true;
}

// Слои -> плоский SceneConfig для рендера.
// opts.forced (T0e): компилятор графа уже вычислил продюсеров, форсируемых field-рёбрами
// (обратный обход сквозь op-цепочки) — собственный обход биндингов тогда НЕ выполняется,
// а форс применяется только к видам БЕЗ слоя (слой = авторитет: его enabled уже решён рёбрами).
export function resolveConfig(c: LayeredConfig, opts?: { forced: LayerKind[] }): SceneConfig {
  const r: SceneConfig = { ...DEFAULT_CONFIG };

  // глобальные поля. Фолбэк на дефолт, если поля нет в c (частичный LayeredConfig мимо merge —
  // напр. промежуточный setConfig-стейт): иначе undefined перетёр бы дефолт и уехал в SceneConfig
  // (config-reviewer: compositeOrder=undefined → невалидный mixBlendMode в Scene).
  for (const f of GLOBAL_FIELDS) (r as any)[f] = (c as any)[f] ?? (DEFAULT_CONFIG as any)[f];

  // гасим все enabled-флаги и hud-текст — включаем только то, что есть в слоях
  for (const kind of Object.keys(LAYER_DEFS) as LayerKind[]) {
    const ef = LAYER_DEFS[kind].enabledField;
    if (ef) (r as any)[ef] = false;
  }
  r.hudText = "";

  // применяем включённые слои по порядку массива (поздний перекрывает по общим полям)
  for (const layer of c.layers) {
    if (!layer.enabled) continue;
    const def = LAYER_DEFS[layer.kind];
    if (!def) continue; // неизвестный/устаревший вид слоя — пропускаем
    Object.assign(r, layer.params);
    if (def.enabledField) (r as any)[def.enabledField] = true;
  }

  // Авто-активация зависимостей (TD-dependency: потребитель заставляет продюсера cook).
  // Включённый эффект поднимает свой продюсер точек (source) и продюсеров своих ссылок-драйверов
  // (bindings) — ЕСЛИ продюсер не выключен ЯВНО (A4b: рёбра/⏻ авторитетны). Так провод/ссылка
  // «оживляет» отсутствующий детектор, но НЕ перебивает явный выкл слоя (кнопка ⏻ / срез провода
  // Видео→детект реально гасит детектор). Продюсер с выключенным слоем -> остаётся off.
  const forceProducer = (kind: LayerKind) => {
    if (c.layers.some((l) => l.kind === kind && !l.enabled)) return; // явный выкл — не форсим
    for (const f of PRODUCER_ENABLE[kind] ?? []) (r as any)[f] = true;
  };
  // T0c: effect.source теперь id СЛОЯ (или вид — back-compat). Резолвим в вид для forceProducer.
  const kindOfRef = (ref: string): LayerKind | null => {
    const l = c.layers.find((x) => x.id === ref);
    if (l) return l.kind;
    return isPointProducer(ref as LayerKind) ? (ref as LayerKind) : null;
  };
  if (opts) {
    // T0e: форс от компилятора графа. Слой вида = авторитет (его enabled уже выведен рёбрами,
    // не перебиваем); форсим только лейерлесс-продюсеров (сигнал с sig:-ноды, напр. аудио).
    for (const k of opts.forced) {
      if (c.layers.some((l) => l.kind === k)) continue;
      for (const f of PRODUCER_ENABLE[k] ?? []) (r as any)[f] = true;
    }
    // source-продюсеры эффектов: applyGraph уже погасил эффекты без входа; здесь поднимаем
    // лейерлесс-source как раньше (вид как source — back-compat, слоя может не быть).
    for (const e of c.effects) {
      if (!e.enabled) continue;
      const k = kindOfRef(e.source);
      if (k && !c.layers.some((l) => l.kind === k)) forceProducer(k);
    }
  } else {
    // Форс продюсера сигнала от одной привязки: сырой драйвер ИЛИ обход Math-цепочки до её входов.
    const forceFromBinding = (b: ParamBinding | undefined) => {
      if (!b) return;
      if (b.driver !== "none") forceProducer(driverProducer(b.driver));
      if (b.signal?.startsWith("op:")) {
        const seenOps = new Set<string>();
        let queue = [b.signal];
        while (queue.length) {
          const h = queue.pop()!;
          if (!h.startsWith("op:")) { if (h !== "none") forceProducer(driverProducer(h as Exclude<DriverKind, "none">)); continue; }
          const op = (c.opNodes ?? []).find((o) => o.id === h.slice(3));
          if (!op || seenOps.has(op.id)) continue;
          seenOps.add(op.id);
          queue = queue.concat([op.input ?? "none", op.input2 ?? "none"]);
        }
      }
    };
    for (const e of c.effects) {
      if (!e.enabled) continue;
      const k = kindOfRef(e.source);
      if (k) forceProducer(k);
      for (const b of Object.values(e.bindings ?? {})) forceFromBinding(b);
    }
    // direction A: shader-FX биндинги тоже форсят продюсеров своих сигналов (легаси-путь без графа).
    for (const l of c.layers) {
      if (!l.enabled || LAYER_DEFS[l.kind]?.domain !== "shader" || !l.bindings) continue;
      for (const b of Object.values(l.bindings)) forceFromBinding(b);
    }
  }

  // T0c: продюсеры/конвертеры как массив ИНСТАНСОВ (по id) — для резолвера точек (fieldForLayerId).
  // Включаем ВКЛЮЧЁННЫЕ продюсер-слои (A4b: выключенный = off); их params слиты с дефолтами вида.
  r.producers = c.layers
    .filter((l) => l.enabled && isPointProducer(l.kind))
    .map((l) => ({
      id: l.id, kind: l.kind,
      params: pick({ ...DEFAULT_CONFIG, ...l.params }, paramFields(l.kind)) as Partial<SceneConfig>,
    }));

  // T0c: цепочка shader-FX как массив ИНСТАНСОВ (per-instance params) — снимает singleton.
  // Включённые shader-слои в порядке shaderFxOrder (по id), остальные включённые — в хвост (порядок
  // layers). Каждый pass.params = поля вида, слитые с дефолтами (FlatView читает uniform'ы отсюда).
  const shaderLayers = c.layers.filter((l) => l.enabled && LAYER_DEFS[l.kind]?.domain === "shader");
  const shaderById = new Map(shaderLayers.map((l) => [l.id, l] as const));
  const orderedFx: Layer[] = [];
  const usedFx = new Set<string>();
  for (const id of c.shaderFxOrder ?? []) {
    const l = shaderById.get(id);
    if (l && !usedFx.has(id)) { orderedFx.push(l); usedFx.add(id); }
  }
  for (const l of shaderLayers) if (!usedFx.has(l.id)) orderedFx.push(l);
  r.fxChain = orderedFx.map((l) => ({
    id: l.id, kind: l.kind,
    params: pick({ ...DEFAULT_CONFIG, ...l.params }, paramFields(l.kind)) as Partial<SceneConfig>,
    bindings: l.bindings, // direction A: привязки числовых params -> FlatView резолвит в кадре
  }));

  // T5 v2: particle-системы — обход particles-цепочки графа pull-от-Render (независимы от flat/cloud).
  r.particleSystems = buildParticleSystems(c);

  // T5 v2 Phase B: Map2D-ноды как массив ИНСТАНСОВ (по id) — для CPU-резолвера mapForRef. Включённые
  // map2d-слои; params слиты с дефолтами (входы-хендлы mapInputA/B уже в params, нормализованы applyGraph).
  r.mapNodes = c.layers
    .filter((l) => l.enabled && LAYER_DEFS[l.kind]?.domain === "map2d")
    .map((l) => ({
      id: l.id, kind: l.kind,
      params: pick({ ...DEFAULT_CONFIG, ...l.params }, paramFields(l.kind)) as Partial<SceneConfig>,
    }));

  // renderMode/composite — производные. 3D-сцена активна, если включено облако точек
  // (глобальный depthEnabled — секция «3D · облако» в левой панели) ИЛИ любой 3D-слой.
  // particle/map2d-слои (свой канвас / только данные) НЕ участвуют в any2D/any3D — иначе лоне-эмиттер/
  // карта флипали бы composite/renderMode.
  const nonVisual = (k: LayerKind) => LAYER_DEFS[k]?.domain === "particle" || LAYER_DEFS[k]?.domain === "map2d";
  const any3D = r.depthEnabled || c.layers.some((l) => l.enabled && LAYER_DEFS[l.kind]?.group === "3D");
  const any2D = c.layers.some((l) => l.enabled && LAYER_DEFS[l.kind]?.group === "2D" && !nonVisual(l.kind));
  r.renderMode = any3D ? "cloud" : "flat";
  r.composite = any3D && any2D;
  return r;
}

// === T5 v2: сборка particle-систем обходом particles-цепочки графа (pull-от-Render) ===
// Для каждого ВКЛЮЧЁННОГО particleRender идём НАЗАД по particles-рёбрам (out "particles" → in
// "particles"), собирая ParticleColor/Force до эмиттера. Рисуется только цепочка, дотянутая до
// Render-терминала («выход в аут»); висячий эмиттер без Render → нет системы. Дизейбл-Force/Color
// проходятся как pass-through (исключаются из набора), дизейбл-эмиттер/Render → нет системы.
// Без графа (легаси) → []. Прецедент — walkFxChain (pull-сегмент FX-цепочки до Экрана).
function buildParticleSystems(c: LayeredConfig): ResolvedParticleSystem[] {
  const edges = c.graph?.edges ?? [];
  if (!edges.length) return [];
  const layerById = new Map(c.layers.map((l) => [l.id, l] as const));
  const isParticle = (k: LayerKind | undefined): boolean => !!k && LAYER_DEFS[k]?.domain === "particle";
  const fullParams = (l: Layer): Partial<SceneConfig> =>
    pick({ ...DEFAULT_CONFIG, ...l.params }, paramFields(l.kind)) as Partial<SceneConfig>;
  // ребро, питающее particles-вход ноды (одиночный вход → одно ребро).
  const incoming = (nodeId: string) =>
    edges.find((e) => e.to.node === nodeId && e.to.in === "particles" && e.from.out === "particles");

  const systems: ResolvedParticleSystem[] = [];
  const usedEmitters = new Set<string>(); // дедуп: две Render-ноды на один эмиттер → одна система
  for (const rnode of c.layers) {
    if (rnode.kind !== "particleRender" || !rnode.enabled) continue;
    const forcesRev: { params: Partial<SceneConfig> }[] = [];
    let color: { params: Partial<SceneConfig> } | null = null;
    let light: { params: Partial<SceneConfig> } | null = null;
    let emitter: Layer | null = null;
    const walked = new Set<string>([rnode.id]);
    let cur = incoming(rnode.id);
    for (let guard = 0; cur && guard <= c.layers.length; guard++) {
      const node = layerById.get(cur.from.node);
      if (!node || !isParticle(node.kind) || walked.has(node.id)) break;
      walked.add(node.id);
      if (node.kind === "emitter") { emitter = node; break; }
      if (node.enabled) {
        if (node.kind === "force") forcesRev.push({ params: fullParams(node) });
        else if (node.kind === "particleColor" && !color) color = { params: fullParams(node) };
        else if (node.kind === "particleLight" && !light) light = { params: fullParams(node) };
      }
      cur = incoming(node.id);
    }
    if (!emitter || !emitter.enabled || usedEmitters.has(emitter.id)) continue; // pull: нет/занят эмиттер
    usedEmitters.add(emitter.id);
    const pts = edges.find((e) => e.to.node === emitter!.id && e.to.in === "points");
    const mp = edges.find((e) => e.to.node === emitter!.id && e.to.in === "map");
    const ep = fullParams(emitter);
    systems.push({
      id: emitter.id,
      renderId: rnode.id, // U2: терминал-Render, на который ссылается конвертер Particles→Points
      emitters: [{ params: ep, sourceRef: pts ? pts.from.node : null, mapRef: mp ? mp.from.node : null }],
      solver: {
        maxParticles: Number(ep.emitterMaxParticles ?? 200000),
        timeScale: Number(ep.emitterTimeScale ?? 1),
        damping: Number(ep.emitterDamping ?? 0),
      },
      forces: forcesRev.reverse(), // порядок цепочки: эмиттер → Render
      color,
      light,
      render: { params: fullParams(rnode) },
    });
  }
  return systems;
}

// T0c-миграция: shaderFxOrder из ВИДОВ (старый LayerKind[]) -> id СЛОЁВ. Запись, уже являющаяся
// id существующего слоя, сохраняется; вид-слой (старый формат) маппится в id первого shader-слоя
// того вида; неизвестное — отбрасывается. Дедуп. Если order — уже ids, функция идемпотентна.
export function migrateShaderFxOrder(order: string[] | undefined, layers: Layer[]): string[] {
  const ids = new Set(layers.map((l) => l.id));
  const shaderByKind = new Map<string, string>();
  for (const l of layers) {
    if (LAYER_DEFS[l.kind]?.domain === "shader" && !shaderByKind.has(l.kind)) shaderByKind.set(l.kind, l.id);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of order ?? []) {
    const id = ids.has(e) ? e : shaderByKind.get(e);
    if (id && !seen.has(id)) { out.push(id); seen.add(id); }
  }
  return out;
}

// Старый плоский конфиг/пресет -> слои. Создаём только активные слои (чистый список).
export function flatConfigToLayers(old: Partial<SceneConfig>): LayeredConfig {
  const full: SceneConfig = { ...DEFAULT_CONFIG, ...old };
  const wasCloud = full.renderMode === "cloud";
  const wasComposite = full.composite;
  const layers: Layer[] = [];

  for (const kind of LAYER_ORDER) {
    const def = LAYER_DEFS[kind];
    if (!def) continue;
    const is3D = def.group === "3D";
    // 3D-эффекты были видны только в cloud; 2D — во flat ИЛИ в cloud+composite
    const visible = is3D ? wasCloud : (!wasCloud || wasComposite);
    if (!(visible && isActive(full, kind))) continue;
    layers.push(makeLayer(kind, pick(full, paramFields(kind)), true));
  }

  // T0c: shaderFxOrder из старых ВИДОВ (или дефолтный) -> id свежесозданных shader-слоёв.
  return { ...pickGlobals(full), layers, effects: [], shaderFxOrder: migrateShaderFxOrder(full.shaderFxOrder, layers) };
}

// === Миграция Фазы 3 #2: вложенные layer.modifiers[] -> top-level effects[] ===
// Backward-compat: старые пресеты держали эффекты ВНУТРИ слоёв-продюсеров. Разворачиваем
// каждый модификатор в EffectNode: source = его прежний params.source (или вид слоя-хозяина,
// если был "self"); поле source убираем из params (теперь это top-level хендл/провод).
// Слои очищаем от legacy-поля modifiers. existing — уже мигрированные effects (если есть).
export function drainModifiers(
  layers: Layer[],
  existing: EffectNode[] = [],
): { layers: Layer[]; effects: EffectNode[] } {
  const effects: EffectNode[] = [...existing];
  const cleaned = layers.map((l) => {
    const legacy = (l as Layer & { modifiers?: ModifierInstance[] }).modifiers;
    if (!legacy?.length) return l;
    for (const m of legacy) {
      const raw = (typeof m.params.source === "string" ? m.params.source : "self") as string;
      const source = (raw === "self" ? l.kind : raw) as LayerKind;
      const { source: _s, ...params } = m.params as Record<string, number | string | boolean>;
      void _s;
      effects.push({ id: m.id, kind: m.kind, enabled: m.enabled, source, params, bindings: m.bindings });
    }
    const { modifiers: _m, ...rest } = l as Layer & { modifiers?: ModifierInstance[] };
    void _m;
    return rest;
  });
  return { layers: cleaned, effects };
}

// Дополнить эффекты дефолтными параметрами (forward-compat новых полей модификатора) и
// убрать осевший в params source (страховка для уже-мигрированных, но «грязных» данных).
export function sanitizeEffects(effects: EffectNode[]): EffectNode[] {
  return (effects ?? [])
    .filter((e) => e && (MODIFIER_DEFS as Record<string, unknown>)[e.kind])
    .map((e) => {
      const { source: _s, ...params } = (e.params ?? {}) as Record<string, number | string | boolean>;
      void _s;
      return { ...e, params: { ...MODIFIER_DEFS[e.kind].defaults, ...params } };
    });
}

// Дефолтный документ-конфиг (слои) — из текущего DEFAULT_CONFIG (резолвнутого).
export const DEFAULT_LAYERED: LayeredConfig = flatConfigToLayers(DEFAULT_CONFIG);
