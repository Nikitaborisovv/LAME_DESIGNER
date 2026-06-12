// Реестр эффектов-слоёв: единый источник правды о том, какие бывают слои, как они
// называются, в какую группу (2D/3D) и домен рендера попадают, каким булевым полем
// SceneConfig гейтятся и какими крутилками настраиваются. Инспектор слоя рендерится
// data-driven по `controls`, а миграция/resolveConfig — по полям из `controls`.
//
// ВАЖНО: имена `field` 1:1 совпадают с полями SceneConfig (резолвнутой формы) — поэтому
// движок рендера не меняется: resolveConfig просто раскладывает params обратно в плоский конфиг.

import { DEFAULT_CONFIG, type SceneConfig, type Layer, type LayerKind } from "./types";

export interface ControlSpec {
  field: keyof SceneConfig;
  type: "range" | "check" | "color" | "select" | "text" | "palette";
  label: string;
  min?: number;
  max?: number;
  step?: number;
  options?: [string, string][];
}

// Пресеты палитр для монохромного пиксель-арта (заполняют первые N свотчей + ставят levels=N).
export const PIXEL_PALETTES: { name: string; colors: string[] }[] = [
  { name: "ч/б", colors: ["#0a0a0b", "#5a5a5e", "#a8a8ad", "#ffffff"] },
  { name: "gameboy", colors: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"] },
  { name: "огонь", colors: ["#100208", "#5c0a14", "#c8410f", "#ff8a1e", "#ffe24a"] },
  { name: "лёд", colors: ["#04121f", "#0f3b57", "#1d6e8c", "#4fc3dd", "#dffaff"] },
  { name: "неон", colors: ["#0a0a0b", "#3a1d5d", "#ff2d8e", "#36e6ff"] },
  { name: "матрица", colors: ["#001b00", "#0a5a14", "#19ff5a", "#aaffba"] },
  { name: "закат", colors: ["#1a1033", "#5e2a6e", "#c8417b", "#ff8a5b", "#ffd23c"] },
  { name: "сепия", colors: ["#1c120a", "#5a3a22", "#a87a4a", "#e8c89a", "#fff3e0"] },
];

export interface LayerDef {
  kind: LayerKind;
  label: string;
  group: "2D" | "3D";
  domain: "shader" | "overlay" | "mask" | "three" | "convert" | "particle" | "map2d";
  enabledField?: keyof SceneConfig; // булево поле SceneConfig, которое включает эффект (hud — без него)
  controls: ControlSpec[];
  // Глобальные поля (общие для нескольких слоёв: цвета людей, общие лица), которые
  // ВДОБАВОК показываются в инспекторе этого слоя — чтобы всё связанное было в одном месте.
  // Редактируются как глобалы (а не layer.params).
  globalControls?: ControlSpec[];
  // Wiring-поля: пишутся в layer.params ПРОВОДОМ графа, контрола в инспекторе нет
  // (пример: setAttrSignal). Должны попадать в paramFields(), иначе resolveConfig
  // выкинет их из producers[].params и провод будет молча игнорироваться рендером.
  wiringFields?: (keyof SceneConfig)[];
  // Convert-входы PointSet (T2-3): каждый points-вход конвертера + поле params, где хранится
  // хендл источника. data-driven (граф рисует/резолвит рёбра по этому списку — graphDoc/App/GraphView
  // обходят его вместо хардкода sample/setAttr). `optional` — вход не обязателен для активности (Merge.B).
  // Новая convert-нода PointSet→PointSet = LAYER_DEFS-запись с convertInputs (+ *ToField в pointSources).
  // `socket` (U2): тип входного сокета источника (дефолт "points"). "particles" — вход GPU-популяции
  // (конвертер Particles→Points): ребро тянется от particle-ноды (out "particles"), а не точечного
  // продюсера. graphDoc использует ci.socket вместо хардкода "points" на from.out.
  convertInputs?: { in: string; param: keyof SceneConfig; optional?: boolean; socket?: "points" | "particles" }[];
  // Field-входы конвертера (T1-3, паритет с convertInputs): жёлтый Field-вход ноды + поле params с
  // хендлом сигнала ("none" | драйвер | "op:"+id). НЕ гейтят активность (нет провода = дефолт:
  // setAttr пишет константу, selection «все выбраны»). graphDoc/GraphView/потребители (compileFieldFn)
  // обходят список data-driven. **Новый field-вход = запись здесь + чтение param в *ToField —
  // без правок graphDoc/GraphView.**
  fieldInputs?: { in: string; param: keyof SceneConfig; label?: string }[];
  // Map2D-входы ноды (T5 v2 Phase B, паритет с convertInputs): розовый Map2D-вход + поле params с
  // хендлом источника ("none"|"video"|id map2d-ноды). data-driven (graphDoc резолвит рёбра по списку).
  // `optional` — вход не обязателен (mapCombine: недостающий = identity по моде). **Новая Map2D-нода
  // с входами = mapInputs здесь + ветка в mapSources.mapForRef.**
  mapInputs?: { in: string; param: keyof SceneConfig; optional?: boolean }[];
  // Биндабельные ЧИСЛОВЫЕ params (direction A): поля, которые можно драйвить Field-сигналом
  // проводом графа (field-вход на shader-ноде). Только range-контролы (lo/hi из их min/max).
  // Паритет с MODIFIER_DEFS[kind].bindable, но для shader-слоёв. Цвета/селекты/чеки не биндим.
  bindable?: (keyof SceneConfig)[];
  singleton: boolean; // этап 1: все singleton (фикс-порядок мега-шейдера / однозначный resolve)
  desc?: string;
}

const R = (field: keyof SceneConfig, label: string, min: number, max: number, step: number): ControlSpec =>
  ({ field, type: "range", label, min, max, step });
const C = (field: keyof SceneConfig, label: string): ControlSpec => ({ field, type: "check", label });
const COL = (field: keyof SceneConfig, label: string): ControlSpec => ({ field, type: "color", label });
const T = (field: keyof SceneConfig, label: string): ControlSpec => ({ field, type: "text", label });
const SEL = (field: keyof SceneConfig, label: string, options: [string, string][]): ControlSpec =>
  ({ field, type: "select", label, options });

// Общие (глобальные) крутилки цветов/градиентов людей — показываем в инспекторе и
// YOLO-масок, и гладкой маски (чтобы всё «по людям» было в одном месте).
const PEOPLE_COLORS: ControlSpec[] = [
  C("peopleFillGradient", "градиент заливки"),
  COL("peopleColor", "заливка A / цвет"),
  COL("peopleColor2", "заливка B"),
  R("peopleFillOpacity", "опасити: верх (A)", 0, 1, 0.05),
  R("peopleFillOpacity2", "опасити: низ (B)", 0, 1, 0.05),
  C("peopleOutlineGradient", "градиент контура"),
  COL("peopleOutlineColor", "контур A"),
  COL("peopleOutlineColor2", "контур B"),
  C("peopleGradientByInstance", "тинт по инстансу (hue)"),
];
// Общие крутилки лиц — показываем в инспекторе и боксов, и сетки.
const FACE_SHARED: ControlSpec[] = [
  R("maxFaces", "макс. лиц", 1, 5, 1),
  R("faceSmooth", "сглаживание", 0, 1, 0.05),
];

export const LAYER_DEFS: Record<LayerKind, LayerDef> = {
  // ===== 2D — экранные шейдер-эффекты =====
  thermal: {
    kind: "thermal", label: "Тепловизор / ИК", group: "2D", domain: "shader",
    enabledField: "thermalEnabled", singleton: false, // T0c: мультиэкземпляр (две термалки в цепочке)
    bindable: ["thermalMix"],
    controls: [R("thermalMix", "сила", 0, 1, 0.05), COL("thermalColdColor", "цвет: холод"), COL("thermalHotColor", "цвет: жар")],
  },
  sobel: {
    kind: "sobel", label: "Обводка (Sobel)", group: "2D", domain: "shader",
    enabledField: "sobelEnabled", singleton: false, // T0c: мультиэкземпляр
    bindable: ["sobelStrength", "sobelThickness"],
    controls: [
      C("sobelOnly", "только контуры"), COL("sobelColor", "цвет"),
      R("sobelStrength", "сила", 0.2, 4, 0.1), R("sobelThickness", "толщина", 0.5, 5, 0.1),
      R("sobelTolerance", "толеранс", 0, 1, 0.02), R("sobelPixelate", "пиксели", 0, 16, 1),
    ],
  },
  scanlines: {
    kind: "scanlines", label: "Сканлайны", group: "2D", domain: "shader",
    enabledField: "scanlinesEnabled", singleton: false, // T0c: мультиэкземпляр
    bindable: ["scanlineIntensity"],
    controls: [R("scanlineIntensity", "интенсивность", 0, 1, 0.05)],
  },
  pixelate: {
    kind: "pixelate", label: "Пикселизация по глубине", group: "2D", domain: "shader",
    enabledField: "pixelateEnabled", singleton: false, desc: "нужна глубина (depth-ресурс)", // T0c: мультиэкземпляр
    bindable: ["pixelateNear", "pixelateFar"],
    controls: [
      C("pixelateGrid", "ровная сетка (степени 2)"),
      R("pixelateNear", "блок вблизи (px)", 1, 32, 1), R("pixelateFar", "блок вдали (px)", 1, 80, 1),
      R("pixelateRampNear", "рампа: вблизи (d)", 0, 1, 0.02), R("pixelateRampFar", "рампа: вдали (d)", 0, 1, 0.02),
      R("pixelateBlur", "разблюр под пиксели", 0, 1, 0.05),
    ],
  },
  lookup: {
    kind: "lookup", label: "Lookup (колоризация)", group: "2D", domain: "shader",
    enabledField: "lookupEnabled", singleton: false,
    bindable: ["lookupMix"],
    desc: "люма → плавный градиент-рампа (N стопов); mix с оригиналом",
    controls: [
      R("lookupMix", "сила", 0, 1, 0.05),
      R("lookupStops", "кол-во стопов", 2, 5, 1),
      { field: "lookupColors", type: "palette", label: "градиент" } as ControlSpec,
    ],
  },
  mirror: {
    kind: "mirror", label: "Kaleidoscope (зеркала)", group: "2D", domain: "shader",
    enabledField: "mirrorEnabled", singleton: false,
    bindable: ["mirrorSectors", "mirrorAngle"],
    desc: "складывает кадр в N секторов вокруг центра с зеркалом внутри клина → мандала",
    controls: [
      R("mirrorSectors", "секторы", 2, 16, 1),
      R("mirrorAngle", "угол", 0, 6.283, 0.01),
    ],
  },
  displace: {
    kind: "displace", label: "Displace (глитч / жидкость)", group: "2D", domain: "shader",
    enabledField: "displaceEnabled", singleton: false,
    bindable: ["displaceAmount", "displaceScale", "displaceSpeed"],
    desc: "UV-смещение кадра: noise — процедурный шум; self — кадр как карта смещения",
    controls: [
      SEL("displaceMode", "режим", [["noise", "процедурный нойз"], ["self", "self (кадр как карта)"]]),
      R("displaceAmount", "амплитуда", 0, 0.2, 0.002),
      R("displaceScale", "масштаб нойза", 1, 50, 0.5),
      R("displaceSpeed", "скорость", 0, 5, 0.1),
    ],
  },
  chromAb: {
    kind: "chromAb", label: "Chromatic Aberration", group: "2D", domain: "shader",
    enabledField: "chromAbEnabled", singleton: false,
    bindable: ["chromAbAmount", "chromAbAngle"],
    desc: "раздельный сдвиг R/G/B каналов; radial — от центра; linear — по углу",
    controls: [
      SEL("chromAbMode", "режим", [["radial", "radial (от центра)"], ["linear", "linear (по углу)"]]),
      R("chromAbAmount", "сила", 0, 0.05, 0.001),
      R("chromAbAngle", "угол (linear)", 0, 6.283, 0.01),
    ],
  },
  grain: {
    kind: "grain", label: "Grain (зерно)", group: "2D", domain: "shader",
    enabledField: "grainEnabled", singleton: false,
    bindable: ["grainAmount", "grainSize"],
    desc: "плёночное зерно, анимируется по времени; amount=0 → без изменений",
    controls: [
      R("grainAmount", "сила зерна", 0, 1, 0.02),
      R("grainSize", "размер зерна", 1, 8, 1),
      C("grainColored", "цветной шум"),
    ],
  },
  feedback: {
    kind: "feedback", label: "Feedback (шлейф)", group: "2D", domain: "shader",
    enabledField: "feedbackEnabled", singleton: false,
    bindable: ["feedbackDecay", "feedbackZoom", "feedbackRotate"],
    desc: "петля с памятью кадра: затухающий шлейф + микротрансформ истории",
    controls: [
      R("feedbackDecay", "затухание", 0.5, 0.99, 0.01),
      R("feedbackZoom", "zoom", 0.95, 1.05, 0.001),
      R("feedbackRotate", "поворот", -0.1, 0.1, 0.002),
      R("feedbackOffsetX", "сдвиг X", -0.05, 0.05, 0.001),
      R("feedbackOffsetY", "сдвиг Y", -0.05, 0.05, 0.001),
      SEL("feedbackMode", "режим", [["over", "over"], ["add", "add"]]),
    ],
  },
  pixelArt: {
    kind: "pixelArt", label: "Пиксели / ASCII", group: "2D", domain: "shader",
    enabledField: "pixelArtEnabled", singleton: false, desc: "блочные пиксели или ASCII-символы", // T0c: мультиэкземпляр
    bindable: ["pixelArtSize", "pixelArtGlowIntensity"],
    controls: [
      R("pixelArtSize", "размер пикселя (px)", 2, 40, 1),
      C("pixelArtAscii", "ASCII-символы"),
      C("pixelArtMono", "монохром (иначе цвет видео)"),
      R("pixelArtLevels", "кол-во цветов (моно)", 2, 16, 1),
      { field: "pixelArtPalette", type: "palette", label: "палитра" },
      SEL("pixelArtAsciiMode", "режим ASCII", [["ramp", "символы"], ["retro", "ретро ○ (кружки/полосы)"], ["letters", "буквы"], ["digits", "цифры"], ["blocks", "блоки"], ["binary", "0/1"]]),
      C("pixelArtAsciiTint", "красить ASCII"),
      COL("pixelArtAsciiColor", "цвет ASCII"),
      R("pixelArtGlowSize", "свечение: размер", 0, 10, 0.1),
      R("pixelArtGlowIntensity", "свечение: сила", 0, 3, 0.05),
    ],
  },

  // ===== 2D — маски людей (композитинг в шейдере) =====
  peopleMask: {
    kind: "peopleMask", label: "Обводка YOLO (инстансы)", group: "2D", domain: "mask",
    enabledField: "peopleMasksEnabled", singleton: true, desc: "yolov8n-seg, webgpu",
    controls: [
      C("peopleFill", "заливка силуэта"), C("peopleOutline", "контур по краю"),
      R("peopleInput", "вход (= imgsz)", 320, 640, 32), R("peopleConf", "порог детекции", 0.1, 0.9, 0.05),
      R("peopleMaskThreshold", "порог маски", 0.1, 0.9, 0.05), R("peopleIou", "порог NMS", 0.1, 0.9, 0.05),
      R("peopleEveryNthFrame", "каждый N-й кадр", 1, 8, 1), R("peopleMaskSmooth", "сглаживание движения", 0, 0.9, 0.05),
    ],
    globalControls: PEOPLE_COLORS,
  },
  selfie: {
    kind: "selfie", label: "Гладкая маска (Selfie)", group: "2D", domain: "mask",
    enabledField: "peopleSmoothEnabled", singleton: true, desc: "mediapipe selfie/deeplab",
    controls: [
      SEL("segModel", "модель", [["deeplab", "deeplab (общий план)"], ["selfie", "selfie (портрет)"]]),
      R("peopleSegThreshold", "порог (срезает фон)", 0.3, 0.9, 0.02), R("peopleFeather", "мягкость края", 0, 0.4, 0.01),
      R("peopleSegSmooth", "стабилизация", 0, 0.9, 0.05), R("peopleSegEveryNthFrame", "N-й кадр", 1, 6, 1),
    ],
    globalControls: PEOPLE_COLORS,
  },

  // ===== 2D — оверлеи (SVG) =====
  motion: {
    kind: "motion", label: "Детекция движения", group: "2D", domain: "overlay",
    enabledField: "motionEnabled", singleton: true,
    controls: [
      R("motionSensitivity", "чувствит-ть", 0.03, 0.4, 0.01), R("motionGap", "кадр назад (gap)", 1, 5, 1),
      R("motionDecay", "затухание тепла", 0.5, 0.97, 0.01), R("motionHeatThreshold", "порог тепла", 0.1, 0.9, 0.05),
      R("motionMinArea", "мин. площадь", 4, 200, 2), R("motionMaxBoxes", "макс. боксов", 1, 16, 1),
      R("motionSmooth", "сглаживание", 0, 1, 0.05), COL("motionColor", "цвет"), COL("motionColor2", "цвет: градиент"),
      R("motionThickness", "толщина", 0.5, 5, 0.1), T("motionLabel", "подпись"), R("motionLabelSize", "размер текста", 6, 28, 1),
      C("motionAscii", "ascii-частицы"), R("motionAsciiDensity", "плотность", 0, 1, 0.05),
      // цепь-линия между боксами теперь — отдельная нода «Линии» (source=motion) в графе.
    ],
  },
  constellation2D: {
    kind: "constellation2D", label: "Constellation (2D)", group: "2D", domain: "overlay",
    enabledField: "constellation2DEnabled", singleton: true, desc: "точки на видео + глубина-кью",
    controls: [
      R("featureCount", "кол-во точек", 20, 200, 10), R("linkDistance", "дистанция связи", 0.04, 0.3, 0.01),
      R("constellationSmooth", "сглаживание", 0, 1, 0.05), COL("constellationColor", "цвет A"), COL("constellationColor2", "цвет B"),
      R("lineWidth", "толщина линий", 0.3, 4, 0.1), R("lineWidthRandom", "рандом толщины", 0, 1, 0.05),
      R("constellationCurve", "кривизна", 0, 1, 0.05), R("constellationLabelChance", "доля со значениями", 0, 1, 0.05),
      R("constellationScaleMin", "скейл: дальние", 0.2, 6, 0.1), R("constellationScaleMax", "скейл: ближние", 0.5, 10, 0.1),
      SEL("constellationLineAxis", "ось касательной", [["x", "горизонталь"], ["y", "вертикаль"], ["auto", "по оси A→B"]]),
      R("fakePerspective", "фейк-перспектива (по глубине)", 0, 1, 0.02),
    ],
  },
  faceBoxes: {
    kind: "faceBoxes", label: "Лица — боксы", group: "2D", domain: "overlay",
    enabledField: "faceBoxesEnabled", singleton: true, desc: "mediapipe",
    controls: [
      COL("faceBoxColor", "цвет бокса"), R("faceBoxThickness", "толщина бокса", 0.5, 5, 0.1),
      T("faceLabel", "подпись"), R("faceLabelSize", "размер текста", 6, 28, 1), COL("faceLabelColor", "цвет текста"),
    ],
    globalControls: FACE_SHARED,
  },
  faceMesh: {
    kind: "faceMesh", label: "Лица — сетка (468)", group: "2D", domain: "overlay",
    enabledField: "faceMeshEnabled", singleton: true,
    controls: [
      COL("faceMeshColor", "цвет сетки"), R("faceMeshDensity", "кол-во точек", 0.1, 1, 0.05),
      R("faceMeshPointSize", "размер точек", 0.5, 6, 0.1), R("faceMeshColorRandom", "цветовой рандом", 0, 1, 0.05),
      R("facePointScaleRandom", "рандом точек", 0, 1, 0.05), R("faceSquareChance", "доля квадратиков", 0, 1, 0.05),
    ],
    globalControls: FACE_SHARED,
  },
  hands: {
    kind: "hands", label: "Руки (MediaPipe)", group: "2D", domain: "overlay",
    enabledField: "handsEnabled", singleton: true, desc: "mediapipe hand landmarker, 21 точка",
    controls: [
      R("maxHands", "сколько рук", 1, 2, 1), C("handMirror", "зеркало (селфи)"),
      C("handSkeleton", "скелет (кости)"), C("handPoints", "точки + кончики"),
      C("handGestures", "жесты"), C("handHud", "HUD-текст позы/жеста"),
      R("handSmooth", "сглаживание", 0, 1, 0.05), R("handLineWidth", "толщина костей", 1, 8, 0.5),
      R("handTipDotSize", "размер точек", 1, 12, 0.5), R("handTipSquareSize", "квадрат кончика", 4, 24, 1),
      COL("handColorLeft", "цвет левой"), COL("handColorRight", "цвет правой"),
    ],
  },
  peopleBox: {
    kind: "peopleBox", label: "Bounding box людей", group: "2D", domain: "overlay",
    enabledField: "peopleBoxEnabled", singleton: true, desc: "по YOLO-детекции",
    controls: [
      R("peopleBoxThickness", "толщина рамки", 0.5, 6, 0.5), C("peopleBoxGradient", "градиент рамки"),
      COL("peopleBoxColor", "рамка A"), COL("peopleBoxColor2", "рамка B"),
    ],
  },
  // ===== Генераторы PointSet (0 входов) =====
  grid: {
    kind: "grid", label: "Grid (сетка точек)", group: "2D", domain: "convert",
    enabledField: "gridEnabled", singleton: false,
    desc: "процедурная сетка точек (генератор, без входов) — стартовые позиции для частиц/линий",
    controls: [
      R("gridCols", "колонок", 2, 64, 1),
      R("gridRows", "рядов", 2, 64, 1),
      R("gridJitter", "джиттер (доля ячейки)", 0, 0.5, 0.01),
      R("gridSeed", "зерно", 0, 100, 1),
    ],
  },
  // ===== Конвертеры (оп-ноды, фаза C): Map2D -> PointSet =====
  scatter: {
    kind: "scatter", label: "Scatter (карта→точки)", group: "2D", domain: "convert",
    enabledField: "scatterEnabled", singleton: false, desc: "прорежённые точки по карте (глубина ИЛИ Map2D-цепочка глубина×нойз) → в Линии", // T0c: мультиэкземпляр
    // B-раунд-2: scatterMapSource ведётся проводом графа (вход "depth" — Видео.глубина / map2d-нода).
    wiringFields: ["scatterMapSource"],
    controls: [
      R("scatterDensity", "шаг сетки (px)", 6, 48, 1),
      R("scatterThreshold", "порог глубины", 0, 1, 0.02),
      C("scatterInvert", "инверсия (дальние области)"),
      R("scatterMaxPoints", "макс. точек", 50, 600, 10),
      C("scatterZ", "3D: z из глубины (U1)"),
      R("scatterZScale", "масштаб z", 0, 2, 0.05),
    ],
  },
  sample: {
    kind: "sample", label: "Sample (точки×карта)", group: "2D", domain: "convert",
    enabledField: "sampleEnabled", singleton: false, desc: "сэмплит глубину в значение точек источника (Z/размер-метка)", // T0c: мультиэкземпляр
    convertInputs: [{ in: "points", param: "sampleSource" }],
    controls: [
      SEL("sampleSource", "источник точек", [
        ["motion", "движение"], ["hands", "руки"], ["faceMesh", "лица — сетка"],
        ["faceBoxes", "лица — боксы"], ["peopleBox", "люди — боксы"], ["scatter", "scatter"],
      ]),
      R("sampleGain", "усиление значения", 0, 2, 0.05),
    ],
  },
  // SetAttr (T2-1): PointSet × Field -> PointSet. Присваивает точкам источника атрибут из сигнала.
  // Источник точек — провод в графе (setAttrSource), Field-сигнал — провод setAttr.поле (setAttrSignal).
  setAttr: {
    kind: "setAttr", label: "SetAttr (атрибут)", group: "2D", domain: "convert",
    enabledField: "setAttrEnabled", singleton: false, desc: "присваивает точкам атрибут (pscale/Cd/…) из Field-сигнала", // T0c: мультиэкземпляр
    // T1-3: setAttrSignal переехал из wiringFields в fieldInputs (вход "field" — паритет байт-в-байт);
    // sel — selection-маска (на точку, 0..1): пишет атрибут только «выбранным» (lerp с прежним значением).
    fieldInputs: [{ in: "field", param: "setAttrSignal", label: "поле" }, { in: "sel", param: "setAttrSelection", label: "sel" }],
    convertInputs: [{ in: "points", param: "setAttrSource" }],
    controls: [
      SEL("setAttrSource", "источник точек", [
        ["motion", "движение"], ["hands", "руки"], ["faceMesh", "лица — сетка"],
        ["faceBoxes", "лица — боксы"], ["peopleBox", "люди — боксы"], ["scatter", "scatter"], ["sample", "sample"],
      ]),
      SEL("setAttrName", "атрибут", [
        ["pscale", "размер (pscale)"], ["Cd", "цвет (Cd)"], ["v", "скорость (v)"],
        ["age", "возраст (age)"], ["life", "жизнь (life)"],
      ]),
      R("setAttrGain", "усиление", 0, 4, 0.05),
      R("setAttrOffset", "смещение", -1, 1, 0.05),
      // только для атрибута Cd (векторный, comps=3): цвет = lerp(lo,hi) по сигналу. Для
      // скалярных атрибутов эти поля игнорируются конвертером (controlField без условий — всегда видны).
      COL("setAttrColorLo", "Cd · цвет (мин)"),
      COL("setAttrColorHi", "Cd · цвет (макс)"),
    ],
  },
  // ===== PointSet -> PointSet конвертеры (T2-3): Transform / Merge / Sort =====
  // Источники точек ведутся ПРОВОДОМ графа (wiringFields, без инспектор-SEL) — graphDoc резолвит
  // их из рёбер по convertInputs. Новая PointSet→PointSet нода = запись здесь + *ToField в pointSources.
  transform: {
    kind: "transform", label: "Transform (точки)", group: "2D", domain: "convert",
    enabledField: "transformEnabled", singleton: false, desc: "сдвиг/масштаб/поворот точек вокруг pivot",
    // T1-3 selection: sel (на точку, 0..1) — p_out = lerp(p, transformed(p), sel); без провода = все.
    fieldInputs: [{ in: "sel", param: "transformSelection", label: "sel" }],
    convertInputs: [{ in: "points", param: "transformSource" }],
    controls: [
      R("transformTx", "сдвиг X", -1, 1, 0.01), R("transformTy", "сдвиг Y", -1, 1, 0.01),
      R("transformScale", "масштаб", 0, 3, 0.01), R("transformRotate", "поворот (рад)", 0, 6.283, 0.01),
      R("transformPivotX", "pivot X", 0, 1, 0.01), R("transformPivotY", "pivot Y", 0, 1, 0.01),
    ],
  },
  merge: {
    kind: "merge", label: "Merge (точки A+B)", group: "2D", domain: "convert",
    enabledField: "mergeEnabled", singleton: false, desc: "объединяет точки двух источников (A + B)",
    convertInputs: [
      { in: "points", param: "mergeSourceA" },
      { in: "b", param: "mergeSourceB", optional: true },
    ],
    controls: [],
  },
  sort: {
    kind: "sort", label: "Sort (точки)", group: "2D", domain: "convert",
    enabledField: "sortEnabled", singleton: false, desc: "переупорядочивает точки по атрибуту (меняет путь линий)",
    convertInputs: [{ in: "points", param: "sortSource" }],
    controls: [
      SEL("sortAttr", "сортировать по", [
        ["pscale", "размер (pscale)"], ["value", "значение (value)"], ["x", "X"], ["y", "Y"],
      ]),
      SEL("sortDir", "направление", [["asc", "по возрастанию"], ["desc", "по убыванию"]]),
    ],
  },
  trail: {
    kind: "trail", label: "Trail (шлейфы)", group: "2D", domain: "convert",
    enabledField: "trailEnabled", singleton: false,
    desc: "хвост из позиций точки за прошлые кадры; нужен id-источник (hands/faceMesh/scatter)",
    convertInputs: [{ in: "points", param: "trailSource" }],
    controls: [
      R("trailLength", "длина (кадров)", 2, 60, 1),
      R("trailFade", "сужение хвоста", 0, 1, 0.01),
    ],
  },
  split: {
    kind: "split", label: "Split (по полю)", group: "2D", domain: "convert",
    enabledField: "splitEnabled", singleton: false,
    desc: "оставляет точки по полю-критерию (порог) — реализация Group/Split; инверсия = вторая нода",
    // Field-критерий на точку (как sel в setAttr): position/index/readAttr/randomPt → реальный разрез.
    fieldInputs: [{ in: "field", param: "splitField", label: "поле" }],
    convertInputs: [{ in: "points", param: "splitSource" }],
    controls: [
      R("splitThreshold", "порог", 0, 1, 0.01),
      SEL("splitKeep", "оставить", [["above", "≥ порога"], ["below", "< порога"]]),
    ],
  },
  pointForce: {
    kind: "pointForce", label: "Силы (точки)", group: "2D", domain: "convert",
    enabledField: "pointForceEnabled", singleton: false,
    desc: "CPU-солвер сил над ЛЮБЫМИ точками (облако/grid/руки): гравитация · curl|turbulence · drag · границы — паритет с GPU-Force (направление U: частицы = точки)",
    convertInputs: [{ in: "points", param: "pointForceSource" }],
    controls: [
      R("pfStrength", "сила шага (общий множитель)", 0, 4, 0.05),
      R("pfLife", "жизнь до респавна (сек, 0=∞)", 0, 20, 0.5),
      C("forceGravityOn", "гравитация"),
      R("forceGravityX", "грав. X", -2, 2, 0.05), R("forceGravityY", "грав. Y", -2, 2, 0.05),
      R("forceGravityStrength", "грав. сила", 0, 5, 0.05),
      C("forceNoiseOn", "шум"),
      SEL("forceNoiseMode", "тип шума", [["curl", "curl (div-free)"], ["turbulence", "turbulence"]]),
      R("forceNoiseAmp", "шум: амплитуда", 0, 10, 0.1), R("forceNoiseScale", "шум: масштаб", 0.05, 2, 0.01),
      R("forceNoiseSpeed", "шум: скорость", 0, 2, 0.02),
      C("forceDragOn", "drag (сопротивление)"), R("forceDrag", "drag: сила", 0, 1, 0.02),
      SEL("forceBoundsMode", "границы кадра", [["none", "нет"], ["bounce", "отражение"], ["wrap", "телепорт (тор)"]]),
    ],
  },
  // U2 (направление U: частицы=точки): конвертер Particles→Points. Вход — `particles`-сокет от
  // Render-ноды (терминал GPU-цепочки); выход — обычный PointSet (CPU). Явный переезд GPU→CPU
  // downsample-readback ≤p2pMaxPoints на низкой частоте (легально, как кадр глубины). Открывает над
  // GPU-частицами весь CPU-кит: Lines/Split/Sort/Trail/спредшит. z несётся (U1 3D-проекция).
  particlesToPoints: {
    kind: "particlesToPoints", label: "Particles→Points", group: "2D", domain: "convert",
    enabledField: "particlesToPointsEnabled", singleton: false,
    desc: "переезд GPU-популяции в CPU-точки (downsample-readback ≤N на низкой частоте); даёт Lines/Split/спредшит над частицами",
    convertInputs: [{ in: "particles", param: "particlesSource", socket: "particles" }],
    controls: [
      R("p2pMaxPoints", "макс. точек (бюджет readback)", 200, 4000, 100),
      C("p2pColor", "цвет частиц (Cd, +readback)"), // U3: тянуть Cd сквозь границу (второй readback)
    ],
  },
  // ===== GPU-частицы (T5 v2, domain "particle"): Emitter → [Force…] → [Color] → Render =====
  // НЕ point-продюсеры (POINT_PRODUCERS не содержит) и НЕ shader. Образуют particles-цепочку по
  // рёбрам графа; resolveConfig эмитит particleSystems pull-от-Render. enabledField не задан
  // (мультиэкземпляр, гейтятся layer.enabled + pull). НЕ в LAYER_ORDER — добавляются из палитры графа.
  emitter: {
    kind: "emitter", label: "Emitter (частицы)", group: "2D", domain: "particle",
    singleton: false, desc: "рождает частицы на воткнутом источнике (точки/карта); фьюз-солвер (v1)",
    // points-вход через generic convertInputs (граф рисует/резолвит ребро). optional: без источника
    // эмиттер падает в box-фолбэк (как спайк). map-вход (emitterMapSource) — провод в part-2 (defer).
    convertInputs: [{ in: "points", param: "emitterSource", optional: true }],
    wiringFields: ["emitterMapSource"],
    controls: [
      // ДОЛЯ максимума популяции 0..1 (>1 клампится — старый диапазон 0..4 был на ¾ мёртв)
      R("emitterRate", "интенсивность (доля макс.)", 0, 1, 0.02),
      R("emitterMapThreshold", "порог карты (map)", 0, 1, 0.02),
      R("emitterLife", "жизнь (сек)", 0.2, 12, 0.1),
      R("emitterLifeVar", "разброс жизни", 0, 1, 0.05),
      R("emitterInitSpeed", "стартовая скорость", 0, 4, 0.05),
      R("emitterVelSpread", "разброс направления", 0, 1, 0.05),
      R("emitterJitterPos", "джиттер позиции", 0, 0.2, 0.005),
      R("emitterMaxParticles", "макс. частиц", 10000, 2000000, 10000),
      R("emitterTimeScale", "масштаб времени", 0, 3, 0.05),
      R("emitterDamping", "затухание (вязкость)", 0, 1, 0.02),
    ],
  },
  // U2-b (направление U): ЕДИНАЯ нода «Force» — авто-диспатч по РЕЗИДЕНТНОСТИ входа. Воткнут
  // `particles` (GPU-цепочка Emitter→Force→Render) → GPU-сила (buildParticleSystems). Воткнут `points`
  // (pointForceSource) → CPU-солвер над PointSet (fieldForLayerId, ТОТ ЖЕ pointForceToField, что U0).
  // force*-поля общие обоим бэкендам; pfStrength/pfLife — только CPU-ветка (GPU игнорит). domain
  // остаётся "particle" (nonVisual → не флипает any2D; applyGraph particle-ветка читает convertInputs;
  // enabled не гейтится отсутствием points-входа — GPU-режим жив без него). Инвариант U: НЕ слияние
  // бэкендов — один словарь/UX, два проверенных пути по резидентности.
  force: {
    kind: "force", label: "Force (силы · точки/частицы)", group: "2D", domain: "particle",
    singleton: false, desc: "силы по резидентности входа: GPU-частицы (вход particles) ИЛИ CPU-точки (вход points). Секции: Гравитация / Шум (curl|turbulence) / Drag / Границы",
    convertInputs: [{ in: "points", param: "pointForceSource", socket: "points", optional: true }],
    controls: [
      C("forceGravityOn", "гравитация"),
      R("forceGravityX", "грав. X", -2, 2, 0.05), R("forceGravityY", "грав. Y", -2, 2, 0.05),
      R("forceGravityZ", "грав. Z", -2, 2, 0.05), R("forceGravityStrength", "грав. сила", 0, 5, 0.05),
      C("forceNoiseOn", "шум"),
      SEL("forceNoiseMode", "тип шума", [["curl", "curl (div-free)"], ["turbulence", "turbulence"]]),
      R("forceNoiseAmp", "шум: амплитуда", 0, 10, 0.1), R("forceNoiseScale", "шум: масштаб", 0.05, 2, 0.01),
      R("forceNoiseSpeed", "шум: скорость", 0, 2, 0.02),
      C("forceDragOn", "drag (сопротивление)"), R("forceDrag", "drag: сила", 0, 1, 0.02),
      // секция «Границы» (аналог limit1 zigzag из TD): bounce/wrap по X/Y у рамки видео, Z свободен
      SEL("forceBoundsMode", "границы кадра", [["none", "нет"], ["bounce", "отражение (zigzag)"], ["wrap", "телепорт (тор)"]]),
      // CPU-ветка (вход points): множитель шага + жизнь до респавна (GPU-ветка их игнорит)
      R("pfStrength", "CPU: сила шага", 0, 4, 0.05),
      R("pfLife", "CPU: жизнь до респавна (0=∞)", 0, 20, 0.5),
    ],
  },
  particleColor: {
    kind: "particleColor", label: "ParticleColor (цвет)", group: "2D", domain: "particle",
    singleton: false, desc: "цвет частиц: byAge (рамп) / byVelocity / constant",
    controls: [
      SEL("pcolorMode", "режим", [["byAge", "по возрасту"], ["byVelocity", "по скорости"], ["constant", "константа"]]),
      COL("pcolorA", "цвет A"), COL("pcolorB", "цвет B"),
    ],
  },
  // Свет (частицы): прожектор-конус с НАСТОЯЩИМ самозатенением (voxel-плотность + рей-марч в материале,
  // Beer-затухание). Чейнится в particles-цепочку как Force/Color; в системе учитывается ПЕРВЫЙ по цепочке.
  particleLight: {
    kind: "particleLight", label: "Свет (частицы)", group: "2D", domain: "particle",
    singleton: false, desc: "прожектор: конус/спред/интенсивность/размер/цвет + самозатенение частиц (voxel + рей-марч)",
    controls: [
      R("plightX", "позиция X", -3, 3, 0.05), R("plightY", "позиция Y", -3, 3, 0.05), R("plightZ", "позиция Z", -3, 3, 0.05),
      COL("plightColor", "цвет"),
      R("plightIntensity", "интенсивность", 0, 5, 0.05),
      R("plightAngle", "угол конуса (°)", 5, 90, 1),
      R("plightSpread", "спред (мягкость края)", 0, 1, 0.02),
      R("plightSize", "размер (радиус спада)", 0.1, 4, 0.05),
      R("plightShadow", "тень (самозатенение)", 0, 1, 0.02),
      R("plightAmbient", "заполнение (0 = darkroom)", 0, 0.5, 0.01),
      C("plightGizmo", "показывать гизмо света"),
    ],
  },
  particleRender: {
    kind: "particleRender", label: "Render (частицы)", group: "2D", domain: "particle",
    singleton: false, desc: "терминал particles-домена: размер/прозрачность/блендинг",
    controls: [
      R("prenderSize", "размер точки", 0.5, 16, 0.5),
      R("prenderSizeVar", "разброс размера (per-particle)", 0, 1, 0.05), // U3: рандомный pscale частиц
      R("prenderOpacity", "прозрачность", 0, 1, 0.05),
      SEL("prenderBlend", "блендинг", [["additive", "additive"], ["normal", "normal"]]),
      C("prenderDepthWrite", "3D-глубина (ближние перекрывают дальние)"), // настоящий depth-тест vs HUD-glow
    ],
  },

  // ===== Map2D-ноды (T5 v2 Phase B, domain "map2d"): CPU-карты для particle/scatter =====
  // НЕ рисуют сами (исключены из any2D/any3D). Резолвятся mapSources.mapForRef в кадр. НЕ в LAYER_ORDER.
  noise2d: {
    kind: "noise2d", label: "Noise (карта)", group: "2D", domain: "map2d",
    singleton: false, desc: "генератор FBM value-noise (Map2D) — напр. модуляция эмиссии частиц",
    controls: [
      R("noiseFreq", "частота", 1, 32, 1),
      R("noiseOctaves", "октавы", 1, 6, 1),
      R("noiseSeed", "зерно", 0, 100, 1),
      R("noiseSpeed", "скорость", 0, 2, 0.02),
      R("noiseContrast", "контраст", 0.2, 3, 0.05),
    ],
  },
  mapCombine: {
    kind: "mapCombine", label: "Combine (карты A×B)", group: "2D", domain: "map2d",
    singleton: false, desc: "комбинирует две карты (multiply/add/screen/min/max); напр. глубина×нойз",
    mapInputs: [{ in: "a", param: "mapInputA", optional: true }, { in: "b", param: "mapInputB", optional: true }],
    controls: [
      SEL("combineMode", "режим", [["multiply", "умножение"], ["add", "сложение"], ["screen", "screen"], ["min", "минимум"], ["max", "максимум"]]),
    ],
  },

  // ===== Аудио-источник сигналов (T-Beauty): WebAudio FFT -> Field-драйверы =====
  // Не отдаёт точки (POINT_PRODUCERS не содержит); только Field (audioLow/Mid/High/Kick).
  audio: {
    kind: "audio", label: "Аудио (FFT-сигналы)", group: "2D", domain: "overlay",
    enabledField: "audioEnabled", singleton: true,
    desc: "WebAudio AnalyserNode: FFT-полосы low/mid/high + kick как Field-сигналы",
    controls: [
      SEL("audioSource", "источник", [["video", "звук видео"], ["mic", "микрофон"]]),
      R("audioGain", "усиление", 0, 4, 0.05),
    ],
  },

  hud: {
    kind: "hud", label: "HUD-текст", group: "2D", domain: "overlay", singleton: true,
    controls: [
      T("hudText", "текст"), R("hudTextSize", "размер", 8, 64, 1), COL("hudTextColor", "цвет"),
      R("hudX", "позиция X", 0, 1, 0.01), R("hudY", "позиция Y", 0, 1, 0.01),
    ],
  },

  // ===== 3D — эффекты поверх облака точек (само облако — секция «3D · облако» в левой панели) =====
  scan: {
    kind: "scan", label: "Сканер по глубине (3D)", group: "3D", domain: "three",
    enabledField: "scanEnabled", singleton: true,
    controls: [
      R("scanSpeed", "скорость", 0.05, 1.5, 0.05), R("scanWidth", "толщина", 0.01, 0.3, 0.005),
      C("scanHide", "скрывать за сканером"), C("scanOnly", "только подсвеченные"),
      COL("scanColor", "цвет 1"), C("scanGradient", "3-цв. градиент"), COL("scanColor2", "цвет 2"), COL("scanColor3", "цвет 3"),
      R("scanNoiseAmount", "нойз (сила)", 0, 0.3, 0.005), R("scanNoiseScale", "нойз (блок)", 4, 120, 2),
    ],
  },
  scanAscii: {
    kind: "scanAscii", label: "ASCII от сканера (3D)", group: "3D", domain: "three",
    enabledField: "scanAsciiEnabled", singleton: true,
    controls: [
      COL("scanAsciiColor", "цвет"), R("scanAsciiDensity", "плотность", 0, 1, 0.05), R("scanAsciiSpeed", "скорость", 0.1, 3, 0.1),
      R("scanAsciiFade", "затухание (сек)", 0.2, 6, 0.1), R("scanAsciiFadeRandom", "рандом затухания", 0, 1, 0.05),
      R("scanAsciiScaleMin", "скейл: дальние", 1, 40, 1), R("scanAsciiScaleMax", "скейл: ближние", 1, 64, 1),
      R("scanAsciiOpacity", "прозрачность", 0, 1, 0.05),
    ],
  },
  constellation3D: {
    kind: "constellation3D", label: "Constellation (3D)", group: "3D", domain: "three",
    enabledField: "constellationEnabled", singleton: true, desc: "по поверхности глубины",
    controls: [
      R("featureCount", "кол-во точек", 20, 200, 10), R("linkDistance", "дистанция связи", 0.04, 0.3, 0.01),
      R("constellationSmooth", "сглаживание", 0, 1, 0.05), COL("constellationColor", "цвет A"), COL("constellationColor2", "цвет B"),
      R("lineWidth", "толщина линий", 0.3, 4, 0.1), R("lineWidthRandom", "рандом толщины", 0, 1, 0.05),
      R("constellationCurve", "кривизна", 0, 1, 0.05), R("constellationLabelChance", "доля со значениями", 0, 1, 0.05),
      R("constellationScaleMin", "скейл: дальние", 0.2, 6, 0.1), R("constellationScaleMax", "скейл: ближние", 0.5, 10, 0.1),
      SEL("constellationLineAxis", "ось касательной", [["x", "горизонталь"], ["y", "вертикаль"], ["auto", "по оси A→B"]]),
    ],
  },
};

// Порядок в меню добавления и в дефолтной стопке (сверху вниз = передний->задний).
export const LAYER_ORDER: LayerKind[] = [
  "hud", "audio", "motion", "constellation2D", "faceBoxes", "faceMesh", "hands", "peopleBox",
  "peopleMask", "selfie", "thermal", "sobel", "scanlines", "pixelate", "pixelArt", "lookup", "feedback", "mirror", "displace", "chromAb", "grain",
  "grid", "scatter", "sample", "setAttr", "transform", "merge", "sort", "pointForce", "particlesToPoints", "constellation3D", "scanAscii", "scan",
];

// Wiring-параметры слоя (T2-3): поля params, которые ведутся ПРОВОДОМ графа (а не значением) —
// convert-входы (источники точек) + field-wiring (setAttrSignal). По ним App.setParams рисует/снимает
// ребро при правке из инспектора (паритет с graphDoc.edgeForLayerParam). Единый источник правды.
export function layerWiringParams(kind: LayerKind): (keyof SceneConfig)[] {
  const def = LAYER_DEFS[kind];
  if (!def) return [];
  const out: (keyof SceneConfig)[] = [];
  const seen = new Set<string>();
  for (const ci of def.convertInputs ?? []) if (!seen.has(ci.param)) { seen.add(ci.param); out.push(ci.param); }
  for (const fi of def.fieldInputs ?? []) if (!seen.has(fi.param)) { seen.add(fi.param); out.push(fi.param); } // T1-3
  for (const mi of def.mapInputs ?? []) if (!seen.has(mi.param)) { seen.add(mi.param); out.push(mi.param); } // Phase B
  for (const f of def.wiringFields ?? []) if (!seen.has(f)) { seen.add(f); out.push(f); }
  return out;
}

// Биндабельные числовые поля слоя (direction A): какие params shader-FX можно драйвить
// проводом графа. Пусто для не-shader слоёв. Единый источник правды для GraphView/applyGraph/FlatView.
export function layerBindable(kind: LayerKind): string[] {
  return (LAYER_DEFS[kind]?.bindable ?? []) as string[];
}

// Поля-параметры слоя = поля контролов + wiring-поля + convert-источники (ведутся проводом графа,
// без контрола). Дедуп: convert-источник может быть И контролом (sample/setAttr), и в convertInputs.
// Все они должны попасть в producers[].params, иначе resolveConfig выкинет провод-параметр.
export function paramFields(kind: LayerKind): (keyof SceneConfig)[] {
  const def = LAYER_DEFS[kind];
  const out: (keyof SceneConfig)[] = [];
  const seen = new Set<string>();
  const add = (f: keyof SceneConfig) => { if (!seen.has(f)) { seen.add(f); out.push(f); } };
  for (const c of def.controls) add(c.field);
  for (const f of def.wiringFields ?? []) add(f);
  for (const ci of def.convertInputs ?? []) add(ci.param);
  for (const fi of def.fieldInputs ?? []) add(fi.param); // T1-3: field-wiring (сигнал/selection)
  for (const mi of def.mapInputs ?? []) add(mi.param);   // Phase B: Map2D-входы (хендлы источников карт)
  return out;
}

// Дефолтные params слоя — выдёргиваем из DEFAULT_CONFIG по полям контролов.
export function layerDefaults(kind: LayerKind): Partial<SceneConfig> {
  const out: Partial<SceneConfig> = {};
  for (const f of paramFields(kind)) {
    const v = DEFAULT_CONFIG[f];
    (out as any)[f] = Array.isArray(v) ? v.slice() : v; // массивы (палитра) копируем, не шарим ссылку
  }
  return out;
}

let _seq = 0;
function newId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* ignore */ }
  return `layer_${Date.now().toString(36)}_${(_seq++).toString(36)}`;
}

// Создать новый слой с дефолтными params (опц. переопределение).
export function makeLayer(kind: LayerKind, over?: Partial<SceneConfig>, enabled = true): Layer {
  return {
    id: newId(),
    kind,
    name: LAYER_DEFS[kind].label,
    enabled,
    params: { ...layerDefaults(kind), ...(over ?? {}) },
    start: null,
    end: null,
  };
}

export function findLayer(layers: Layer[], kind: LayerKind): Layer | undefined {
  return layers.find((l) => l.kind === kind);
}
