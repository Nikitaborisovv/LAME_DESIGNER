// Реестр модификаторов (аналог LAYER_DEFS, но для вложенных в слой эффектов поверх
// точек-данных). Каждый ModifierDef = label + крутилки (data-driven) + дефолты.
// Добавить новый эффект пула = добавить запись сюда + рендер-функцию (renderLines и т.п.).

import type { ModifierKind, LayerKind, EffectNode } from "./types";

// Спека крутилки модификатора: как ControlSpec слоёв, но field — произвольная строка
// (ключ в ModifierInstance.params, не поле SceneConfig).
export interface ModControlSpec {
  field: string;
  type: "range" | "check" | "color" | "select" | "text";
  label: string;
  min?: number;
  max?: number;
  step?: number;
  options?: [string, string][];
}

export interface ModifierDef {
  kind: ModifierKind;
  label: string;
  desc?: string;
  controls: ModControlSpec[];
  defaults: Record<string, number | string | boolean>;
  // Параметры, которые можно привязать к драйверу-сигналу (ссылка в графе + BindingRow).
  // Единый источник правды: читают и инспектор (LayerInspector), и нод-редактор (GraphView).
  bindable: string[];
}

const R = (field: string, label: string, min: number, max: number, step: number): ModControlSpec =>
  ({ field, type: "range", label, min, max, step });
const C = (field: string, label: string): ModControlSpec => ({ field, type: "check", label });
const COL = (field: string, label: string): ModControlSpec => ({ field, type: "color", label });
const SEL = (field: string, label: string, options: [string, string][]): ModControlSpec =>
  ({ field, type: "select", label, options });

export const MODIFIER_DEFS: Record<ModifierKind, ModifierDef> = {
  lines: {
    kind: "lines",
    label: "Линии",
    desc: "соединяет точки источника линиями (как constellation)",
    controls: [
      // источник точек теперь — top-level поле EffectNode.source (провод в графе), не param.
      SEL("topology", "соединять", [["native", "родные рёбра/цепь"], ["chain", "цепь по порядку"], ["nearest", "по близости"]]),
      R("nearestDist", "дистанция связи", 0.02, 100, 0.5),
      R("maxLinks", "связей на точку (0 = все)", 0, 8, 1),
      C("gradient", "градиент линии"),
      COL("colorA", "цвет A"),
      COL("colorB", "цвет B"),
      R("width", "толщина", 0.3, 6, 0.1),
      R("widthRandom", "рандом толщины", 0, 1, 0.05),
      R("curve", "кривизна", 0, 1, 0.05),
      SEL("axis", "ось касательной", [["auto", "по оси A→B"], ["x", "горизонталь"], ["y", "вертикаль"]]),
      C("showNodes", "узлы (точки)"),
      R("nodeScaleMin", "узел: мин", 0.2, 8, 0.1),
      R("nodeScaleMax", "узел: макс", 0.5, 12, 0.1),
      R("labelChance", "доля со значениями", 0, 1, 0.05),
    ],
    defaults: {
      topology: "native",
      nearestDist: 0.18,
      maxLinks: 3,
      gradient: true,
      colorA: "#3cffaa",
      colorB: "#36e6ff",
      width: 1.6,
      widthRandom: 0.4,
      curve: 0.35,
      axis: "auto",
      showNodes: true,
      nodeScaleMin: 1.2,
      nodeScaleMax: 4,
      labelChance: 0,
    },
    bindable: ["width", "maxLinks", "colorA", "curve"],
  },
  // Splat/Rasterize (конвертер PointSet -> Map2D, §2.4): растеризует форму на каждой точке в
  // маску, которую видео-шейдер композитит (overlay-цвет или alpha-cutout «формы как альфа видео»).
  splat: {
    kind: "splat",
    label: "Splat",
    desc: "форма на каждой точке -> маска в видео-шейдере (overlay / альфа видео)",
    controls: [
      SEL("shape", "форма", [["square", "квадрат"], ["disc", "диск"]]),
      SEL("mode", "композит", [["overlay", "цвет поверх видео"], ["alpha", "альфа видео (вырез)"]]),
      R("size", "размер (доля кадра)", 0.005, 0.25, 0.005),
      R("sizeByValue", "размер ∝ значению", 0, 1, 0.05),
      COL("colorA", "цвет"),
      R("opacity", "непрозрачность", 0, 1, 0.05),
      R("feather", "мягкость края", 0, 1, 0.05),
    ],
    defaults: {
      shape: "square",
      mode: "overlay",
      size: 0.04,
      sizeByValue: 0.5,
      colorA: "#ffffff",
      opacity: 1,
      feather: 0,
    },
    bindable: ["size", "opacity"],
  },
};

let _seq = 0;
function newId(): string {
  try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); }
  catch { /* ignore */ }
  return `mod_${Date.now().toString(36)}_${(_seq++).toString(36)}`;
}

// Top-level эффект-нода (Фаза 3 #2): source — хендл продюсера точек (T0c: id слоя-инстанса или вид).
export function makeEffect(kind: ModifierKind, source: string): EffectNode {
  return {
    id: newId(),
    kind,
    enabled: true,
    source,
    params: { ...MODIFIER_DEFS[kind].defaults },
  };
}
