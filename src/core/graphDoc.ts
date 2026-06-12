// === T0e GraphDoc: явные рёбра + pull-компилятор (ARCHITECTURE §3.5.3, §3.6.9 T0e) ===
//
// Ребро — ОДНА сущность вместо четырёх ad-hoc каналов (effect.source / shaderFxOrder /
// bindings / setAttrSignal·sampleSource). Здесь:
//  - словарь нод/сокетов (id ноды = id сущности; спец "video"/"screen"; фолбэк "sig:<kind>");
//  - synthesizeGraph: старый конфиг без графа -> рёбра из легаси-каналов (back-compat пресетов);
//  - sanitizeGraph: валидация/ремап рёбер при загрузке;
//  - applyGraph: РЁБРА ПОБЕЖДАЮТ — нормализация конфига от рёбер + pull-активность
//    («считается достижимое от Экрана»): эффект жив только с подведёнными точками И путём до
//    Экрана; FX-цепочка = сегмент, реально доходящий до Экран.видео (висячие гаснут);
//    форс продюсеров — обратный обход field-рёбер СКВОЗЬ op-цепочки (закрывает баг
//    «Math-цепочка не будит детектор»); нет пути Видео→Экран = videoToScreen=false (чёрный кадр).
//    Pull-lite (задокументировано): детектор с проводом Видео→детект, но без потребителей,
//    ОСТАЁТСЯ жив — он рисует собственный оверлей (Overlay), это его «выход на экран» вне графа.
//  - compileLayered: главная точка входа App = applyGraph -> resolveConfig;
//  - mirrorEdgeAdd/Remove: зеркалирование правки ребра в легаси-каналы (читаемость экспорта,
//    обратная совместимость новых пресетов со старым кодом). Расхождение чинит applyGraph.

import {
  type LayeredConfig, type SceneConfig, type Layer, type LayerKind, type DriverKind,
  type EffectNode, type OpNode, type GraphDoc, type GraphEdge, type ParamBinding,
} from "./types";
import { LAYER_DEFS, layerBindable, layerWiringParams } from "./layerRegistry";
import { MODIFIER_DEFS } from "./modifierRegistry";
import { isPointProducer } from "./pointSources";
import { DRIVER_GROUPS, DRIVER_SIGNALS, driverProducer, type Signal } from "./drivers";
import { resolveConfig } from "./layerMigrate";

export const VIDEO_NODE = "video";
export const SCREEN_NODE = "screen";
// Фолбэк-нода сигналов: продюсер вида kind, чей СЛОЙ не добавлен (напр. «Аудио»). Стабильный id.
export const sigNodeId = (kind: LayerKind): string => "sig:" + kind;

// Канонический ключ ребра (идентичность; параллельных дублей не бывает).
export const edgeKey = (e: GraphEdge): string =>
  `${e.from.node}.${e.from.out}>${e.to.node}.${e.to.in}`;

// Мульти-вход: только Экран.оверлеи ("in") принимает много рёбер; всё остальное — одиночный вход.
export const isMultiInput = (node: string, inp: string): boolean =>
  node === SCREEN_NODE && inp === "in";

// Map-вход продюсера от ноды «Видео»: детекторы берут "video", scatter/sample — "depth".
// DATA-DRIVEN (баг-фикс): любой PointSet→PointSet конвертер (есть convertInputs: setAttr/transform/
// merge/sort/trail/split/…) и генератор (grid) — НИЧЕГО от Видео. Раньше тут был хардкод-список,
// и забытые в нём trail/split гейтились applyGraph по ФАНТОМНОМУ ребру Видео→.video, которого
// из UI нарисовать нельзя (сокета нет) — ноды молча оставались выключенными.
export function producerMapIn(kind: LayerKind): "video" | "depth" | null {
  if (kind === "scatter" || kind === "sample") return "depth";
  if (kind === "grid") return null; // генератор: входов нет
  if ((LAYER_DEFS[kind]?.convertInputs ?? []).length > 0) return null;
  return "video";
}

// Сигналы-выходы продюсера вида kind (группа DRIVER_GROUPS, чей driverProducer = kind).
export function signalsOfKind(kind: LayerKind): Signal[] {
  for (const g of DRIVER_GROUPS) if (driverProducer(g.signals[0]) === kind) return g.signals;
  return [];
}

const isShader = (k: LayerKind): boolean => LAYER_DEFS[k]?.domain === "shader";
// T5 v2: particle-нода (emitter/force/particleColor/particleRender) — GPU-домен, своя particles-цепочка.
export const isParticle = (k: LayerKind): boolean => LAYER_DEFS[k]?.domain === "particle";
// T5 v2 Phase B: Map2D-нода (noise2d/mapCombine) — CPU-карты, домен "map2d".
export const isMap2d = (k: LayerKind): boolean => LAYER_DEFS[k]?.domain === "map2d";

// Map2D-источник: хендл карты ("none"|"video"|id map2d-ноды) → конец ребра. Видео.глубина = out "depth";
// map2d-нода = out "map". (Зеркало handleSourceNode для field, но для Map2D-домена.)
function mapSourceEnd(c: LayeredConfig, ref: string): { node: string; out: string } | null {
  if (!ref || ref === "none") return null;
  if (ref === "video" || ref === "depth") return { node: VIDEO_NODE, out: "depth" };
  return c.layers.some((l) => l.id === ref && isMap2d(l.kind)) ? { node: ref, out: "map" } : null;
}
// Обратно: конец ребра (Map2D-выход) → хендл. Видео → "video"; map2d-нода → её id.
const mapHandleOfSource = (from: { node: string; out: string }): string =>
  from.node === VIDEO_NODE ? "video" : from.node;

// Нода-источник сигнала driver: слой её продюсера (первый по виду), иначе фолбэк "sig:<kind>".
function signalSourceNode(layers: Layer[], driver: Signal): { node: string; out: string } {
  const kind = driverProducer(driver);
  const l = layers.find((x) => x.kind === kind);
  return { node: l ? l.id : sigNodeId(kind), out: driver };
}

// Источник field-хендла ("op:"+id / имя драйвера) -> конец ребра.
function handleSourceNode(c: LayeredConfig, handle: string): { node: string; out: string } | null {
  if (!handle || handle === "none") return null;
  if (handle.startsWith("op:")) {
    const id = handle.slice(3);
    return (c.opNodes ?? []).some((o) => o.id === id) ? { node: id, out: "out" } : null;
  }
  return signalSourceNode(c.layers, handle as Signal);
}

// Обратно: конец ребра -> field-хендл ("op:"+id / имя сигнала).
function handleOfSource(c: LayeredConfig, from: { node: string; out: string }): string {
  if ((c.opNodes ?? []).some((o) => o.id === from.node)) return "op:" + from.node;
  return from.out; // сигнал: имя выхода = имя драйвера (на слое-продюсере или sig:-ноде)
}

// Разрешить ссылку на продюсера (id слоя ИЛИ вид — back-compat) в id слоя.
function producerRefToId(layers: Layer[], ref: string | undefined): string | null {
  if (!ref) return null;
  if (layers.some((l) => l.id === ref)) return ref;
  const byKind = layers.find((l) => l.kind === ref && isPointProducer(l.kind));
  return byKind ? byKind.id : null;
}

const push = (edges: GraphEdge[], seen: Set<string>, e: GraphEdge) => {
  const k = edgeKey(e);
  if (!seen.has(k)) { seen.add(k); edges.push(e); }
};

// === Синтез графа из легаси-каналов (старые пресеты / автосейвы / DEFAULT_LAYERED) ===
// Ровно та проекция, что строил GraphView до T0e: ребро Видео→детект только у ВКЛЮЧЁННОГО слоя
// (A4b), цепочка FX по shaderFxOrder (+хвост), effect.source/bindings/op.input/setAttr* -> рёбра.
export function synthesizeGraph(c: LayeredConfig): GraphDoc {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  // Продюсеры/конвертеры: вход от Видео (включённые), points-источники конвертеров, setAttr.field.
  for (const l of c.layers) {
    if (!isPointProducer(l.kind)) continue;
    const mapIn = producerMapIn(l.kind);
    if (mapIn && l.enabled) {
      // B-раунд-2: Scatter — карта от scatterMapSource (Видео.глубина ИЛИ map2d-нода), не только Видео.
      // sample и пр. — по-прежнему Видео. mapSourceEnd("video")=Видео.depth → дефолт байт-в-байт.
      if (l.kind === "scatter") {
        const me = mapSourceEnd(c, String(l.params.scatterMapSource ?? "video"));
        if (me) push(edges, seen, { from: me, to: { node: l.id, in: mapIn } });
      } else {
        push(edges, seen, { from: { node: VIDEO_NODE, out: mapIn }, to: { node: l.id, in: mapIn } });
      }
    }
    // T2-3: points-источники конвертера — из convertInputs (data-driven; раньше хардкод sample/setAttr).
    for (const ci of LAYER_DEFS[l.kind]?.convertInputs ?? []) {
      const ref = (l.params as Record<string, unknown>)[ci.param];
      const srcId = producerRefToId(c.layers, typeof ref === "string" ? ref : undefined);
      if (srcId) push(edges, seen, { from: { node: srcId, out: ci.socket ?? "points" }, to: { node: l.id, in: ci.in } });
    }
    // T1-3: field-входы конвертера (сигнал setAttr / selection) — из fieldInputs (раньше хардкод setAttr).
    for (const fi of LAYER_DEFS[l.kind]?.fieldInputs ?? []) {
      const sig = (l.params as Record<string, unknown>)[fi.param];
      const src = handleSourceNode(c, typeof sig === "string" ? sig : "none");
      if (src) push(edges, seen, { from: src, to: { node: l.id, in: fi.in } });
    }
  }

  // T5 v2: эмиттер — points-источник из params (round-trip симметрия с applyGraph; эмиттер НЕ
  // isPointProducer, поэтому цикл продюсеров выше его не покрыл). particles-цепочка (Emitter→Force→
  // Render) — чистый edge-домен (нет legacy-канала), синтезу не подлежит: живёт только в graph.edges.
  for (const l of c.layers) {
    if (l.kind !== "emitter") continue;
    const ref = l.params.emitterSource;
    const srcId = producerRefToId(c.layers, typeof ref === "string" ? ref : undefined);
    if (srcId) push(edges, seen, { from: { node: srcId, out: "points" }, to: { node: l.id, in: "points" } });
    // map-вход эмиттера (Map2D-хендл): Видео.глубина / map2d-нода → Emitter.map.
    const me = mapSourceEnd(c, typeof l.params.emitterMapSource === "string" ? l.params.emitterMapSource : "none");
    if (me) push(edges, seen, { from: me, to: { node: l.id, in: "map" } });
  }

  // Phase B: Map2D-ноды — входы карт из params (round-trip симметрия с applyGraph).
  for (const l of c.layers) {
    if (!isMap2d(l.kind)) continue;
    for (const mi of LAYER_DEFS[l.kind]?.mapInputs ?? []) {
      const ref = (l.params as Record<string, unknown>)[mi.param];
      const me = mapSourceEnd(c, typeof ref === "string" ? ref : "none");
      if (me) push(edges, seen, { from: me, to: { node: l.id, in: mi.in } });
    }
  }

  // Цепочка 2D-FX: Видео.видео -> fx1 -> … -> Экран.видео (порядок shaderFxOrder, хвост — layers).
  const shaderLayers = c.layers.filter((l) => l.enabled && isShader(l.kind));
  const byId = new Map(shaderLayers.map((l) => [l.id, l] as const));
  const ordered: Layer[] = [];
  const used = new Set<string>();
  for (const id of c.shaderFxOrder ?? []) {
    const l = byId.get(id);
    if (l && !used.has(id)) { ordered.push(l); used.add(id); }
  }
  for (const l of shaderLayers) if (!used.has(l.id)) ordered.push(l);
  let prev: { node: string; out: string } = { node: VIDEO_NODE, out: "video" };
  for (const l of ordered) {
    push(edges, seen, { from: prev, to: { node: l.id, in: "in" } });
    prev = { node: l.id, out: "out" };
  }
  push(edges, seen, { from: prev, to: { node: SCREEN_NODE, in: "video" } });

  // direction A: field-рёбра shader-FX из layer.bindings (если биндинги осели на слое — back-compat).
  for (const l of c.layers) {
    if (!isShader(l.kind) || !l.bindings) continue;
    const bindable = layerBindable(l.kind);
    for (const [field, b] of Object.entries(l.bindings)) {
      if (!b || !bindable.includes(field)) continue;
      const src = handleSourceNode(c, b.signal ?? b.driver);
      if (src) push(edges, seen, { from: src, to: { node: l.id, in: field } });
    }
  }

  // Эффекты: поток точек + выход на Экран.оверлеи + ссылки-биндинги.
  for (const e of c.effects) {
    const srcId = producerRefToId(c.layers, e.source);
    if (srcId) push(edges, seen, { from: { node: srcId, out: "points" }, to: { node: e.id, in: "points" } });
    push(edges, seen, { from: { node: e.id, out: "out" }, to: { node: SCREEN_NODE, in: "in" } });
    const bindable = MODIFIER_DEFS[e.kind]?.bindable ?? [];
    for (const [field, b] of Object.entries(e.bindings ?? {})) {
      if (!b || !bindable.includes(field)) continue;
      const handle = b.signal ?? b.driver;
      const src = handleSourceNode(c, handle);
      if (src) push(edges, seen, { from: src, to: { node: e.id, in: field } });
    }
  }

  // Оп-ноды: input -> .in, input2 -> .b.
  for (const o of c.opNodes ?? []) {
    const a = handleSourceNode(c, o.input);
    if (a) push(edges, seen, { from: a, to: { node: o.id, in: "in" } });
    const b2 = o.input2 ? handleSourceNode(c, o.input2) : null;
    if (b2) push(edges, seen, { from: b2, to: { node: o.id, in: "b" } });
  }

  return { edges, pos: {} };
}

// === Санитайз графа при загрузке: ремап sig:->слой, выброс рёбер на отсутствующие ноды,
// дедуп, одиночные входы (последнее ребро побеждает). Идемпотентен. ===
export function sanitizeGraph(c: LayeredConfig): GraphDoc {
  const g = c.graph ?? synthesizeGraph(c);
  const ids = new Set<string>([VIDEO_NODE, SCREEN_NODE]);
  for (const l of c.layers) ids.add(l.id);
  for (const e of c.effects) ids.add(e.id);
  for (const o of c.opNodes ?? []) ids.add(o.id);
  // валидные sig:-ноды — по всем группам сигналов
  const sigKinds = new Set<string>();
  for (const grp of DRIVER_GROUPS) sigKinds.add(sigNodeId(driverProducer(grp.signals[0])));
  // ремап sig:<kind> -> первый слой этого вида (сигналы живут на ноде слоя, когда слой есть)
  const remap = (n: string): string => {
    if (!n.startsWith("sig:")) return n;
    const l = c.layers.find((x) => x.kind === (n.slice(4) as LayerKind));
    return l ? l.id : n;
  };
  const out: GraphEdge[] = [];
  const seen = new Set<string>();
  const byInput = new Map<string, number>(); // "node.in" -> index в out (одиночный вход: последний побеждает)
  for (const e of g.edges ?? []) {
    if (!e?.from?.node || !e?.to?.node) continue;
    const from = { node: remap(e.from.node), out: e.from.out };
    const to = { node: remap(e.to.node), in: e.to.in };
    const okFrom = ids.has(from.node) || sigKinds.has(from.node);
    const okTo = ids.has(to.node);
    if (!okFrom || !okTo) continue;
    const ed = { from, to };
    const k = edgeKey(ed);
    if (seen.has(k)) continue;
    if (!isMultiInput(to.node, to.in)) {
      const ik = `${to.node}.${to.in}`;
      const prev = byInput.get(ik);
      if (prev !== undefined) out[prev] = ed; // замещаем более ранний провод того же входа
      else { byInput.set(ik, out.length); out.push(ed); }
    } else out.push(ed);
    seen.add(k);
  }
  // pos: только существующих нод
  const pos: GraphDoc["pos"] = {};
  for (const [id, p] of Object.entries(g.pos ?? {})) {
    if ((ids.has(id) || sigKinds.has(id)) && p && isFinite(p.x) && isFinite(p.y)) pos[id] = { x: p.x, y: p.y };
  }
  return { edges: out, pos };
}

// Конфиг гарантированно с графом (точка входа merge/presets).
export function ensureGraph(c: LayeredConfig): LayeredConfig {
  return { ...c, graph: sanitizeGraph(c) };
}

// === Обход FX-цепочки по рёбрам: Видео.видео -> (map-рёбра) -> shader-ноды -> Экран.видео ===
// Возвращает id слоёв сегмента, РЕАЛЬНО доходящего до Экрана, и сам факт достижения.
// Байпас (⏻ off) НЕ рвёт цепочку: нода остаётся в обходе (pass-through), из fxChain её
// выкидывает resolveConfig (enabled=false). Висячий хвост (не дошёл до Экрана) — НЕ рисуется.
export function walkFxChain(c: LayeredConfig, edges: GraphEdge[]): { order: string[]; reached: boolean } {
  const shaderIds = new Set(c.layers.filter((l) => isShader(l.kind)).map((l) => l.id));
  const order: string[] = [];
  const seen = new Set<string>();
  let cur = { node: VIDEO_NODE, out: "video" };
  for (let guard = 0; guard <= shaderIds.size + 1; guard++) {
    // Выход Видео.видео фан-аутится и на детекторы — для цепочки релевантны ТОЛЬКО рёбра
    // в shader-вход (продолжение) или в Экран.видео (финал). Продолжение приоритетнее финала
    // (вписанный в цепочку FX «забирает» поток; прямое ребро на экран при этом легаси-мусор).
    const cont = edges.find((x) => x.from.node === cur.node && x.from.out === cur.out &&
      shaderIds.has(x.to.node) && x.to.in === "in" && !seen.has(x.to.node));
    if (cont) {
      order.push(cont.to.node); seen.add(cont.to.node);
      cur = { node: cont.to.node, out: "out" };
      continue;
    }
    const fin = edges.find((x) => x.from.node === cur.node && x.from.out === cur.out &&
      x.to.node === SCREEN_NODE && x.to.in === "video");
    return { order, reached: !!fin };
  }
  return { order, reached: false };
}

// Дефолтный payload биндинга при появлении ребра (как создавал GraphView): диапазон из спеки
// контрола, smooth 0.6; цвет лерпится A->B (lo/hi 0..1).
export function defaultBinding(effKind: EffectNode["kind"], field: string, handle: string): ParamBinding {
  const spec = MODIFIER_DEFS[effKind]?.controls.find((s) => s.field === field);
  const isColor = field === "colorA";
  const fromOp = handle.startsWith("op:");
  return {
    driver: fromOp ? "none" : (handle as DriverKind),
    signal: fromOp ? handle : undefined,
    lo: isColor ? 0 : (spec?.min ?? 0),
    hi: isColor ? 1 : (spec?.max ?? 1),
    smooth: 0.6,
  };
}

// Дефолтный payload биндинга shader-FX слоя (direction A): диапазон lo/hi из min/max контрола
// поля (всё числовое — цветов среди bindable нет). smooth 0.6, как у эффектов.
export function defaultLayerBinding(kind: LayerKind, field: string, handle: string): ParamBinding {
  const spec = LAYER_DEFS[kind]?.controls.find((s) => s.field === field);
  const fromOp = handle.startsWith("op:");
  return {
    driver: fromOp ? "none" : (handle as DriverKind),
    signal: fromOp ? handle : undefined,
    lo: spec?.min ?? 0,
    hi: spec?.max ?? 1,
    smooth: 0.6,
  };
}

// Нормализация field-рёбер в bindings (общий код эффектов и shader-слоёв): по входящим рёбрам,
// чей `to.in` — биндабельное поле, строит Record<field, ParamBinding>; сохраняет прежний payload
// (lo/hi/smooth/curve), источник берёт из ребра. mkDefault — фабрика дефолта для новых полей.
function bindingsFromEdges(
  c: LayeredConfig, nodeId: string, bindable: readonly string[],
  prevBindings: Record<string, ParamBinding> | undefined,
  edgesInto: (node: string) => GraphEdge[],
  mkDefault: (field: string, handle: string) => ParamBinding,
): Record<string, ParamBinding> {
  const bindings: Record<string, ParamBinding> = {};
  for (const ed of edgesInto(nodeId)) {
    if (!bindable.includes(ed.to.in)) continue;
    const handle = handleOfSource(c, ed.from);
    const prev = prevBindings?.[ed.to.in];
    bindings[ed.to.in] = prev
      ? { ...prev, driver: handle.startsWith("op:") ? "none" : (handle as DriverKind), signal: handle.startsWith("op:") ? handle : undefined }
      : mkDefault(ed.to.in, handle);
  }
  return bindings;
}

// === applyGraph: РЁБРА ПОБЕЖДАЮТ. Чистая нормализация (вход не мутируется): выводит легаси-
// каналы из рёбер + pull-активность. Возвращает нормализованную копию + форс-лист продюсеров
// (для resolveConfig) + videoToScreen. ===
export function applyGraph(c: LayeredConfig): {
  config: LayeredConfig; forced: LayerKind[]; videoToScreen: boolean;
} {
  const edges = c.graph?.edges ?? [];
  const intoNode = (node: string, inp: string): GraphEdge | undefined =>
    edges.find((e) => e.to.node === node && e.to.in === inp);
  const edgesInto = (node: string): GraphEdge[] => edges.filter((e) => e.to.node === node);

  // FX-цепочка (pull: только сегмент до Экрана) + видим ли кадр вообще.
  const { order: fxOrder, reached: videoToScreen } = walkFxChain(c, edges);
  const fxInChain = new Set(fxOrder);

  const opIds = new Set((c.opNodes ?? []).map((o) => o.id));

  // Оп-ноды: входы строго из рёбер.
  const opNodes: OpNode[] = (c.opNodes ?? []).map((o) => {
    const a = intoNode(o.id, "in");
    const b = intoNode(o.id, "b");
    return {
      ...o,
      input: a ? handleOfSource(c, a.from) : "none",
      input2: b ? handleOfSource(c, b.from) : (o.input2 !== undefined ? "none" : undefined),
    };
  });

  // Эффекты: source/активность/биндинги из рёбер.
  const effects: EffectNode[] = c.effects.map((e) => {
    const pts = intoNode(e.id, "points");
    const toScreen = edges.some((x) => x.from.node === e.id && x.to.node === SCREEN_NODE && x.to.in === "in");
    const bindings = bindingsFromEdges(c, e.id, MODIFIER_DEFS[e.kind]?.bindable ?? [], e.bindings, edgesInto,
      (field, handle) => defaultBinding(e.kind, field, handle));
    return {
      ...e,
      source: pts ? pts.from.node : e.source,
      enabled: e.enabled && !!pts && toScreen, // pull: нет входа ИЛИ нет пути на Экран -> спит
      bindings,
    };
  });

  // Слои: продюсеры — вход(ы) обязаны быть подведены; shader-FX — только сегмент цепочки.
  const layers: Layer[] = c.layers.map((l) => {
    if (isShader(l.kind)) {
      // direction A: field-рёбра -> layer.bindings (паритет с эффектами). Сами биндинги резолвит
      // FlatView в кадре — здесь только нормализуем источник из рёбер. Активность — сегмент цепочки.
      const bindings = bindingsFromEdges(c, l.id, layerBindable(l.kind), l.bindings, edgesInto,
        (field, handle) => defaultLayerBinding(l.kind, field, handle));
      const base = fxInChain.has(l.id) ? l : { ...l, enabled: false };
      return { ...base, bindings };
    }
    if (isParticle(l.kind)) {
      // T5 v2: particle-ноды — wiring-каналы эмиттера (emitterSource/emitterMapSource) из рёбер
      // (паритет с продюсерами для экспорта/round-trip). Активность НЕ гейтим здесь — pull-активность
      // системы считает buildParticleSystems от Render-терминала; particles-чейн-рёбра авторитетны.
      const params = { ...l.params } as Record<string, unknown>;
      for (const ci of LAYER_DEFS[l.kind]?.convertInputs ?? []) {
        const e = intoNode(l.id, ci.in);
        params[ci.param] = e ? e.from.node : "none";
      }
      if (l.kind === "emitter") {
        const m = intoNode(l.id, "map");
        params.emitterMapSource = m ? mapHandleOfSource(m.from) : "none";
      }
      return { ...l, params: params as Layer["params"] };
    }
    if (isMap2d(l.kind)) {
      // Phase B: Map2D-ноды — входы карт (mapInputA/B) из рёбер (паритет с convertInputs). Активность
      // НЕ гейтим (нет входа = identity по моде у combine; генератор самодостаточен).
      const params = { ...l.params } as Record<string, unknown>;
      for (const mi of LAYER_DEFS[l.kind]?.mapInputs ?? []) {
        const e = intoNode(l.id, mi.in);
        params[mi.param] = e ? mapHandleOfSource(e.from) : "none";
      }
      return { ...l, params: params as Layer["params"] };
    }
    if (!isPointProducer(l.kind)) return l; // оверлеи/3D/аудио — вне графовой топологии
    const params = { ...l.params } as Record<string, unknown>;
    let on = l.enabled;
    const mapIn = producerMapIn(l.kind);
    if (mapIn) on = on && !!intoNode(l.id, mapIn);
    // B-раунд-2: Scatter записывает source карты из ребра "depth" (Видео.глубина → "video" / map2d → id).
    // Нет ребра → "video" (дефолт; on уже false выше — нода всё равно выключена). Зеркалится через wiringFields.
    if (l.kind === "scatter") {
      const e = intoNode(l.id, "depth");
      params.scatterMapSource = e ? mapHandleOfSource(e.from) : "video";
    }
    // T2-3: points-источники конвертера из рёбер (data-driven по convertInputs; раньше хардкод
    // sample/setAttr). Обязательный вход без провода гасит ноду; optional (Merge.B) — нет.
    for (const ci of LAYER_DEFS[l.kind]?.convertInputs ?? []) {
      const pts = intoNode(l.id, ci.in);
      params[ci.param] = pts ? pts.from.node : "none";
      if (!ci.optional) on = on && !!pts;
    }
    // T1-3: field-входы (сигнал/selection) из рёбер — data-driven по fieldInputs; активность НЕ гейтят
    // (нет провода = дефолт: константа / «все выбраны»).
    for (const fi of LAYER_DEFS[l.kind]?.fieldInputs ?? []) {
      const f = intoNode(l.id, fi.in);
      params[fi.param] = f ? handleOfSource(c, f.from) : "none";
    }
    return { ...l, enabled: on, params: params as Layer["params"] };
  });

  // Форс продюсеров сигналов: обратный обход field-рёбер от АКТИВНЫХ потребителей сквозь op-ноды.
  const forced = new Set<LayerKind>();
  const visitedOps = new Set<string>();
  const traceField = (from: { node: string; out: string }) => {
    if (opIds.has(from.node)) {
      if (visitedOps.has(from.node)) return;
      visitedOps.add(from.node);
      for (const ed of edgesInto(from.node)) traceField(ed.from); // входы op (in/b)
      return;
    }
    // сигнал: имя выхода -> вид продюсера. Явный гард (corrupt-ребро points/out в field-вход
    // не должно класть undefined в форс-сет; driverProducer на не-сигнале НЕ бросает).
    if (DRIVER_SIGNALS.includes(from.out as Signal)) forced.add(driverProducer(from.out as Signal));
  };
  const activeEffects = new Set(effects.filter((e) => e.enabled).map((e) => e.id));
  // T1-3: field-входы ЛЮБОГО активного конвертера (сигнал setAttr, selection setAttr/transform) будят
  // детектор-источник сигнала — data-driven по fieldInputs (раньше хардкод setAttr."field").
  const activeFieldIns = new Map(layers
    .filter((l) => l.enabled && (LAYER_DEFS[l.kind]?.fieldInputs?.length ?? 0) > 0)
    .map((l) => [l.id, (LAYER_DEFS[l.kind].fieldInputs ?? []).map((fi) => fi.in)] as const));
  // direction A: активные shader-FX в цепочке -> их биндабельные field-входы тоже будят детектор.
  const activeShaderFx = new Map(layers.filter((l) => l.enabled && isShader(l.kind)).map((l) => [l.id, l.kind] as const));
  for (const ed of edges) {
    const bindableHit = activeEffects.has(ed.to.node) &&
      (MODIFIER_DEFS[effects.find((e) => e.id === ed.to.node)!.kind]?.bindable ?? []).includes(ed.to.in);
    const fieldHit = activeFieldIns.get(ed.to.node)?.includes(ed.to.in) ?? false;
    const shaderHit = activeShaderFx.has(ed.to.node) && layerBindable(activeShaderFx.get(ed.to.node)!).includes(ed.to.in);
    if (bindableHit || fieldHit || shaderHit) traceField(ed.from);
  }

  const cfg: LayeredConfig = { ...c, layers, effects, opNodes, shaderFxOrder: fxOrder };
  return { config: cfg, forced: [...forced], videoToScreen };
}

// === Главная точка входа App: рёбра -> нормализованный конфиг -> резолв. ===
// Без графа (легаси-вызовы) поведение прежнее байт-в-байт (+videoToScreen=true).
export function compileLayered(c: LayeredConfig): { normalized: LayeredConfig; resolved: SceneConfig } {
  if (!c.graph) {
    const resolved = resolveConfig(c);
    resolved.videoToScreen = true;
    return { normalized: c, resolved };
  }
  const { config: normalized, forced, videoToScreen } = applyGraph(c);
  const resolved = resolveConfig(normalized, { forced });
  resolved.videoToScreen = videoToScreen;
  // «Карта → Экран.видео»: Map2D-выход, воткнутый во вход Экрана (вместо GPU-видеотракта), —
  // полноэкранный ЧБ-просмотр карты. Раньше такой провод молча давал ЧЁРНЫЙ кадр (вход одиночный,
  // путь Видео→Экран снят, а CPU-карты видеотракт не умеет) — теперь рисует MapScreenOverlay.
  const scrEdge = (c.graph?.edges ?? []).find((e) => e.to.node === SCREEN_NODE && e.to.in === "video");
  if (scrEdge) {
    if (scrEdge.from.node === VIDEO_NODE && scrEdge.from.out === "depth") resolved.screenMapRef = "video";
    else if (c.layers.some((l) => l.id === scrEdge.from.node && isMap2d(l.kind))) resolved.screenMapRef = scrEdge.from.node;
  }
  return { normalized, resolved };
}

// === Хелперы правки графа для App (все чистые; после правки рёбер зеркалят каналы) ===

// Вставить ребро: дедуп по ключу + одиночный вход (прежний провод того же входа снимается).
export function withEdge(c: LayeredConfig, edge: GraphEdge): LayeredConfig {
  const g = c.graph ?? { edges: [], pos: {} };
  const k = edgeKey(edge);
  const edges = g.edges.filter((e) =>
    edgeKey(e) !== k &&
    (isMultiInput(edge.to.node, edge.to.in) || !(e.to.node === edge.to.node && e.to.in === edge.to.in)));
  edges.push(edge);
  return mirrorGraphToChannels({ ...c, graph: { ...g, edges } });
}

// Снять ребро по каноническому ключу.
export function withoutEdge(c: LayeredConfig, key: string): LayeredConfig {
  const g = c.graph ?? { edges: [], pos: {} };
  return mirrorGraphToChannels({ ...c, graph: { ...g, edges: g.edges.filter((e) => edgeKey(e) !== key) } });
}

// Удаление сущности: убрать все её рёбра и позицию (вызывать ПОСЛЕ удаления из layers/effects/opNodes).
export function withoutNodeEdges(c: LayeredConfig, nodeId: string): LayeredConfig {
  const g = c.graph ?? { edges: [], pos: {} };
  const pos = { ...g.pos };
  delete pos[nodeId];
  return mirrorGraphToChannels({
    ...c,
    graph: { edges: g.edges.filter((e) => e.from.node !== nodeId && e.to.node !== nodeId), pos },
  });
}

// Авто-обвязка нового слоя (UX-паритет: добавленная нода сразу живая, как раньше):
// детектор/scatter/sample — провод от Видео; shader-FX — вписывается в ХВОСТ цепочки перед
// Экраном (X→Экран.видео => X→fx.in + fx.out→Экран.видео); setAttr/прочие — без проводов.
export function autoWireLayer(c: LayeredConfig, l: Layer): LayeredConfig {
  if (isShader(l.kind)) {
    const g = c.graph ?? { edges: [], pos: {} };
    const tail = g.edges.find((e) => e.to.node === SCREEN_NODE && e.to.in === "video");
    if (!tail) return c; // экран отрезан — оставляем висячей, пользователь подключит сам
    let next = withoutEdge(c, edgeKey(tail));
    next = withEdge(next, { from: tail.from, to: { node: l.id, in: "in" } });
    return withEdge(next, { from: { node: l.id, out: "out" }, to: { node: SCREEN_NODE, in: "video" } });
  }
  // T5 v2: авто-обвязка particle-нод (UX-паритет «добавил — сразу в цепочке»).
  if (isParticle(l.kind)) return autoWireParticle(c, l);
  const mapIn = isPointProducer(l.kind) ? producerMapIn(l.kind) : null;
  if (mapIn) return withEdge(c, { from: { node: VIDEO_NODE, out: mapIn }, to: { node: l.id, in: mapIn } });
  return c;
}

// Авто-обвязка particle-ноды. Emitter — points от первого points-продюсера (если есть). Force/
// ParticleColor — вставка в ХВОСТ перед Render (как shader перед Экраном); нет Render — вход от
// последнего висячего particle-выхода. Render — вход от последнего висячего particle-выхода.
function autoWireParticle(c: LayeredConfig, l: Layer): LayeredConfig {
  const g = c.graph ?? { edges: [], pos: {} };
  const layerKind = (id: string): LayerKind | undefined => c.layers.find((x) => x.id === id)?.kind;
  // particle-нода, чей выход `particles` ещё никуда не подключён (хвост висячей цепочки).
  const danglingParticleOut = (): string | null => {
    const cands = c.layers.filter((x) => x.id !== l.id && isParticle(x.kind) && x.kind !== "particleRender");
    for (let i = cands.length - 1; i >= 0; i--) {
      const id = cands[i].id;
      if (!g.edges.some((e) => e.from.node === id && e.from.out === "particles")) return id;
    }
    return null;
  };
  if (l.kind === "emitter") {
    // предпочитаем сырой ДЕТЕКТОР (точки сразу есть) конвертеру (scatter ждёт глубину, transform/setAttr
    // могут висеть без своего источника → 0 точек, box-фолбэк) — UX «добавил эмиттер, частицы есть».
    const detectors: LayerKind[] = ["motion", "hands", "faceMesh", "faceBoxes", "peopleBox"];
    const srcId = c.layers.find((x) => detectors.includes(x.kind))?.id
      ?? c.layers.find((x) => isPointProducer(x.kind))?.id;
    return srcId ? withEdge(c, { from: { node: srcId, out: "points" }, to: { node: l.id, in: "points" } }) : c;
  }
  if (l.kind === "force" || l.kind === "particleColor" || l.kind === "particleLight") {
    // вставка перед Render: ребро X→Render.particles становится X→new.particles + new.out→Render
    const tail = g.edges.find((e) => e.to.in === "particles" && layerKind(e.to.node) === "particleRender");
    if (tail) {
      let next = withoutEdge(c, edgeKey(tail));
      next = withEdge(next, { from: tail.from, to: { node: l.id, in: "particles" } });
      return withEdge(next, { from: { node: l.id, out: "particles" }, to: tail.to });
    }
    const src = danglingParticleOut();
    return src ? withEdge(c, { from: { node: src, out: "particles" }, to: { node: l.id, in: "particles" } }) : c;
  }
  if (l.kind === "particleRender") {
    const src = danglingParticleOut();
    return src ? withEdge(c, { from: { node: src, out: "particles" }, to: { node: l.id, in: "particles" } }) : c;
  }
  return c;
}

// Авто-обвязка нового эффекта: поток точек от source-продюсера + выход на Экран.оверлеи.
export function autoWireEffect(c: LayeredConfig, e: EffectNode): LayeredConfig {
  let next = c;
  const srcId = producerRefToId(c.layers, e.source);
  if (srcId) next = withEdge(next, { from: { node: srcId, out: "points" }, to: { node: e.id, in: "points" } });
  return withEdge(next, { from: { node: e.id, out: "out" }, to: { node: SCREEN_NODE, in: "in" } });
}

// Ребро для wiring-параметра КОНВЕРТЕРА из ИНСПЕКТОРА (паритет SEL-контролов sample/setAttr:
// выпадашка источника/сигнала рисует провод — иначе applyGraph затёр бы параметр без ребра).
// Возвращает { in, edge|null }: edge=null = провод входа `in` снять (значение "none"/невалидно).
export function edgeForLayerParam(
  c: LayeredConfig, layerId: string, field: string, value: string,
): { in: string; edge: GraphEdge | null } {
  const layer = c.layers.find((l) => l.id === layerId);
  // field-wiring (Field-сигнал/selection): вход из fieldInputs по полю-параметру (T1-3 data-driven;
  // раньше хардкод setAttrSignal -> "field").
  const fi = layer ? (LAYER_DEFS[layer.kind]?.fieldInputs ?? []).find((x) => x.param === field) : undefined;
  if (fi) {
    const src = handleSourceNode(c, value);
    return { in: fi.in, edge: src ? { from: src, to: { node: layerId, in: fi.in } } : null };
  }
  // Phase B: Map2D-вход (mapInputA/B / emitterMapSource / scatterMapSource) — источник = Видео.глубина /
  // map2d-нода. B-раунд-2: scatterMapSource входит в "depth"-сокет (а не "map") — иначе App.setParams (если
  // когда-нибудь появится SEL-контрол источника) уронил бы значение в points-ветку и создал кривое ребро.
  const mi = layer ? (LAYER_DEFS[layer.kind]?.mapInputs ?? []).find((x) => x.param === field) : undefined;
  const mapField = mi || field === "emitterMapSource" || field === "scatterMapSource";
  if (mapField) {
    const inSock = field === "scatterMapSource" ? "depth" : (mi?.in ?? "map");
    const me = mapSourceEnd(c, value);
    return { in: inSock, edge: me ? { from: me, to: { node: layerId, in: inSock } } : null };
  }
  // points-источник конвертера: вход берётся из convertInputs по полю-параметру (data-driven;
  // раньше всегда "points"). Дефолт "points" — back-compat для старых вызовов.
  const ci = layer ? (LAYER_DEFS[layer.kind]?.convertInputs ?? []).find((x) => x.param === field) : undefined;
  const inSock = ci?.in ?? "points";
  const srcId = producerRefToId(c.layers, value);
  return { in: inSock, edge: srcId ? { from: { node: srcId, out: ci?.socket ?? "points" }, to: { node: layerId, in: inSock } } : null };
}

// Ребро для биндинга из ИНСПЕКТОРА (паритет BindingRow: выпадашка тоже рисует провод).
// null = биндинг снят (ребро поля убрать).
export function edgeForBinding(
  c: LayeredConfig, effectId: string, field: string,
  binding: { driver: DriverKind; signal?: string } | null,
): GraphEdge | null {
  if (!binding) return null;
  const handle = binding.signal ?? binding.driver;
  if (!handle || handle === "none") return null;
  const src = handleSourceNode(c, handle);
  return src ? { from: src, to: { node: effectId, in: field } } : null;
}

// === Зеркалирование правки ребра в легаси-каналы (вызывает App при add/remove). Рёбра уже
// обновлены в next.graph; здесь — синхронизация effect.source/bindings/op.input/setAttr*/
// shaderFxOrder/enabled-детектора, чтобы экспортированный пресет читался и старым кодом.
// Расхождения не страшны: applyGraph при компиляции всё равно берёт рёбра. ===
export function mirrorGraphToChannels(c: LayeredConfig): LayeredConfig {
  if (!c.graph) return c;
  const { config } = applyGraph(c);
  // ВАЖНО: activity-выводы (enabled=false у висячих) НЕ зеркалим в хранимый конфиг — это
  // дериват кадра, а не намерение пользователя. Зеркалим только КАНАЛЫ источников.
  return {
    ...c,
    shaderFxOrder: config.shaderFxOrder,
    effects: c.effects.map((e) => {
      const n = config.effects.find((x) => x.id === e.id);
      return n ? { ...e, source: n.source, bindings: n.bindings } : e;
    }),
    opNodes: (c.opNodes ?? []).map((o) => {
      const n = (config.opNodes ?? []).find((x) => x.id === o.id);
      return n ? { ...o, input: n.input, input2: n.input2 } : o;
    }),
    layers: c.layers.map((l) => {
      const n = config.layers.find((x) => x.id === l.id);
      if (!n) return l;
      // direction A: источник биндингов shader-FX — рёбра; зеркалим их на слой (как source/bindings эффекта).
      // Пусто -> undefined (не плодим bindings:{} в каждом слое; чистим при снятии последнего провода).
      if (isShader(l.kind)) {
        const b = n.bindings && Object.keys(n.bindings).length ? n.bindings : undefined;
        if (b === undefined && l.bindings === undefined) return l;
        return { ...l, bindings: b };
      }
      // T2-3: зеркалим wiring-каналы конвертера (источники точек + Field-сигнал) — data-driven по
      // convertInputs+wiringFields (раньше хардкод sample/setAttr). Иначе провод transform/merge/sort
      // живёт в рёбрах, но layer.params остаётся "none" — срыв fallback-инварианта при пересинтезе графа.
      const wiring = layerWiringParams(l.kind);
      if (!wiring.length) return l;
      const keep: Record<string, unknown> = { ...l.params };
      for (const f of wiring)
        if (f in (n.params as Record<string, unknown>)) keep[f] = (n.params as Record<string, unknown>)[f];
      return { ...l, params: keep as Layer["params"] };
    }),
  };
}
