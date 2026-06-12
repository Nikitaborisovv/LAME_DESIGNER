// Единый конфиг сцены. UI пишет сюда, рендер читает каждый кадр.
// Добавляешь новый параметр эффекта -> добавляешь поле сюда + контрол в ui/Controls.tsx.

// Два режима рендера верхнего уровня:
//  - "flat":  кадр как полноэкранная текстура + цепочка дешёвых 2D-эффектов (быстро, без нейронок).
//  - "cloud": 3D-облако точек из нейро-глубины (Depth Anything, нужен WebGPU).
export type RenderMode = "flat" | "cloud";

// T3 Composite (canvas-level): порядок и режим смешивания 2D-сцены (flat) и 3D-облака (cloud),
// когда активны ОБА (composite). Закрывает жалобу #3 «облако всегда сверху»: раньше zIndex был
// захардкожен (облако над flat), теперь — параметр графа/ноды Композит.
//  - "cloudOver": облако сверху (прежнее поведение), blend накладывается на ВЕРХНИЙ канвас (облако);
//  - "flatOver":  2D-сцена сверху, облако — непрозрачный фон, blend на flat.
export type CompositeOrder = "cloudOver" | "flatOver";
// Режим смешивания верхнего канваса с нижним — значения CSS mix-blend-mode (DOM-композит двух
// канвасов-сиблингов). "normal" = прежнее поведение (верхний просто перекрывает прозрачностью).
export type CompositeBlend = "normal" | "screen" | "multiply" | "lighten" | "difference" | "overlay";

// Вкладка панели управления (UI-группировка контролов). Две из трёх — flat-база:
//  - "fx2d":    2D-эффекты экранного пространства (тепловизор, sobel, пикселизация, движение, hud).
//  - "human":   детекция человека (лица-боксы, сетка лица, маски людей) — оверлеи поверх 2D-видео.
//  - "depth3d": 3D-облако точек из глубины.
// fx2d и human рендерят одну и ту же flat-сцену -> их эффекты складываются на общем видео.
export type UiTab = "fx2d" | "human" | "depth3d";

// Режим темпорального сглаживания карты глубины (гасит джиттер покадровой модели).
//  - "off":    сырая карта как есть.
//  - "ema":    motion-adaptive EMA (дефолт) — стабильно на статике, быстро на движении.
//  - "median": темпоральная медиана последних 3 карт — давит «выстрелы» пикселей.
export type DepthSmoothMode = "off" | "ema" | "median";

// Модель гладкой сегментации людей: selfie (под селфи-портрет) или deeplab (общий план, VOC).
export type SegModel = "selfie" | "deeplab";

export interface SceneConfig {
  // --- источник ---
  videoUrl: string | null;
  renderMode: RenderMode;
  uiTab: UiTab; // активная вкладка панели (fx2d/human обе -> flat; depth3d -> cloud)
  fpsCap: number; // потолок FPS рендера (меньше = холоднее GPU)
  hideVideo: boolean; // скрыть фоновое видео (чёрный фон); эффекты/оверлеи остаются

  // Порядок цепочки 2D-FB-проходов (B-edge-authoritative): какой 2D-FX за каким применяется.
  // Ведётся рёбрами графа (обход цепочки Видео→FX→…→Экран пишет сюда). T0c: теперь это id СЛОЁВ
  // (инстансов), а не виды — поэтому возможны ДВА thermal-слоя с разными настройками в цепочке.
  shaderFxOrder: string[];

  // Резолвнутая цепочка shader-FX (T0c, instance-keyed): resolveConfig эмитит сюда массив включённых
  // shader-слоёв в порядке shaderFxOrder, КАЖДЫЙ со своими params. FlatView итерирует его и выставляет
  // uniform'ы per-pass из pass.params (а не из плоских singleton-полей). Заполняется только в
  // резолвнутом SceneConfig (НЕ в GLOBAL_FIELDS, НЕ в LayeredConfig). undefined у старых конфигов.
  fxChain?: ResolvedFxPass[];

  // Резолвнутые продюсеры/конвертеры точек (T0c, instance-keyed): resolveConfig эмитит сюда
  // ВКЛЮЧЁННЫЕ продюсер-слои (id+kind+params). ModifierOverlay/SplatMask резолвят effect.source
  // (id) по этому массиву — поэтому возможны два scatter-инстанса с разными density. Резолвнутый-only.
  producers?: ResolvedProducer[];

  // T5 v2 (instance-keyed): resolveConfig эмитит сюда particle-системы — обход particles-цепочки
  // графа pull-от-Render (рисуется только цепочка, дотянутая до терминала Render). Каждая система —
  // независимая (Режим 1): свои эмиттер/силы/цвет/рендер; ParticleField гонит их в ОДНОМ канвасе.
  // Резолвнутый-only (как fxChain/producers). undefined/[] у конфигов без particle-цепочки.
  particleSystems?: ResolvedParticleSystem[];

  // T5 v2 Phase B: резолвнутые Map2D-ноды (id+kind+params) — для CPU-резолвера `mapSources.mapForRef`
  // (адресует ref по id, как fieldForLayerId адресует продюсера). Резолвнутый-only (как producers).
  mapNodes?: ResolvedMapNode[];

  // T0e pull: есть ли путь Видео→…→Экран.видео в графе. false = базовый кадр НЕ рисуется (чёрный
  // фон; оверлеи поверх живут). Выставляется компилятором графа (graphDoc.compileLayered);
  // у конфигов без графа всегда true. Резолвнутый-only (как fxChain/producers).
  videoToScreen?: boolean;

  // «Карта → Экран.видео»: провод от Map2D-выхода (Видео.глубина / noise2d / mapCombine) во вход
  // Экрана = полноэкранный ЧБ-просмотр CPU-карты ВМЕСТО видеотракта (рисует ui/MapScreenOverlay,
  // GPU-цепочка при этом спит: videoToScreen=false). Хендл: "video" (глубина) | id map2d-ноды.
  // Резолвнутый-only (выставляет compileLayered из рёбер).
  screenMapRef?: string;

  // === FLAT-режим: 2D-эффекты экранного пространства (чистый GPU-шейдер) ===

  // Тепловизор / ИК: яркость -> градиент между двумя цветами.
  thermalEnabled: boolean;
  thermalMix: number; // 0..1 — насколько подменяем оригинал тепловой картой
  thermalColdColor: string; // холодный конец (тёмный)
  thermalHotColor: string; // горячий конец (яркий)

  // Обводка объектов (Sobel edge detection).
  sobelEnabled: boolean;
  sobelStrength: number; // усиление контуров
  sobelOnly: boolean; // только контуры на тёмном фоне (HUD-вид)
  sobelColor: string; // цвет контура
  sobelThickness: number; // ширина выборки (толщина линий)
  sobelTolerance: number; // 0..1 — порог: слабее этого края отбрасываются
  sobelPixelate: number; // размер пикселя для блочности (0 = выкл)

  // Сканлайны (скрыты из UI, оставлены в шейдере; по умолчанию выкл).
  scanlinesEnabled: boolean;
  scanlineIntensity: number;

  // Пикселизация по глубине (2D): размер блока зависит от карты глубины.
  // Ближе -> мельче блок (выше качество), дальше -> крупнее. Рампа задаёт переход.
  pixelateEnabled: boolean;
  pixelateNear: number; // размер блока вблизи (px, меньше = качественнее)
  pixelateFar: number; // размер блока вдали (px)
  pixelateRampNear: number; // глубина «вблизи» 0..1
  pixelateRampFar: number; // глубина «вдали» 0..1
  pixelateGrid: boolean; // ровная сетка: блок -> степень 2 (квадродерево), выровнено (без наезда)
  pixelateBlur: number; // 0..1 усреднение внутри блока перед пикселизацией (мягкие пиксели)

  // Пиксель-арт / ASCII (отдельный слой, не зависит от глубины): блочная пикселизация
  // фиксированного размера + опц. превращение в ASCII-символы. Цвет: видео (sharp) или
  // монохром (рампа A->B по яркости с заданным числом уровней). ASCII можно подкрасить.
  pixelArtEnabled: boolean;
  pixelArtSize: number; // размер пикселя/ячейки (видео-px)
  pixelArtAscii: boolean; // превращать в ASCII-символы
  pixelArtMono: boolean; // монохром (палитра по яркости) вместо цвета видео
  pixelArtLevels: number; // 2..16 — число уровней/цветов в монохроме (= сколько свотчей палитры активно)
  pixelArtPalette: string[]; // палитра (16 цветов; используются первые pixelArtLevels по яркости)
  pixelArtAsciiTint: boolean; // красить ASCII отдельным цветом (иначе цветом пикселя)
  pixelArtAsciiColor: string; // цвет ASCII при подкраске
  pixelArtAsciiMode: string; // набор символов: "ramp"|"retro"|"letters"|"digits"|"blocks"|"binary"
  // Свечение (glow) выбранных цветов палитры: двойной клик по свотчу включает glow его уровня.
  pixelArtGlowMask: boolean[]; // длина 16 — какие уровни палитры светятся
  pixelArtGlowSize: number; // 0..4 — радиус/разброс свечения (в ячейках)
  pixelArtGlowIntensity: number; // 0..3 — сила свечения

  // Lookup-колоризация: люма пикселя -> плавный градиент-рампа из N цветовых стопов.
  // «Форма ч/б, цвет отдельным слоем». Стопы задаются пользователем (lookupColors).
  lookupEnabled: boolean;
  lookupColors: string[];  // палитра стопов (переживает JSON-экспорт/импорт)
  lookupStops: number;     // кол-во стопов реально используется (2..5)
  lookupMix: number;       // сила: 0=оригинал, 1=полная колоризация

  // Kaleidoscope (зеркала/мандала): складывает кадр в N секторов вокруг центра с зеркалом.
  mirrorEnabled: boolean;
  mirrorSectors: number; // 2..16 — число секторов
  mirrorAngle: number;   // угол поворота в радианах (0..2π)

  // Displace (UV-смещение): глитч / жидкость. Режим "noise" — процедурный шум; "self" — кадр как карта.
  displaceEnabled: boolean;
  displaceAmount: number;  // амплитуда (0..0.2)
  displaceScale: number;   // масштаб нойза (1..50)
  displaceSpeed: number;   // скорость анимации (0..5)
  displaceMode: string;    // "noise" | "self"

  // Chromatic Aberration: раздельный сдвиг R/G/B каналов.
  chromAbEnabled: boolean;
  chromAbAmount: number;   // сила (0..0.05)
  chromAbAngle: number;    // угол фиксированного вектора (0..6.283, только для linear)
  chromAbMode: string;     // "radial" | "linear"

  // Grain: плёночное зерно, анимируется по времени. amount=0 -> выход==вход.
  grainEnabled: boolean;
  grainAmount: number;     // сила зерна (0..1)
  grainSize: number;       // размер зерна (1..8)
  grainColored: boolean;   // цветной шум (три независимых канала)

  // Feedback петля (map→map): текущий кадр смешивается с историей предыдущего кадра.
  // Каждый инстанс имеет свою пару RT (ping-pong внутри инстанса), хранится в feedbackHistory.
  feedbackEnabled: boolean;
  feedbackDecay: number;   // 0..1 коэф. затухания истории (выше = длиннее шлейф)
  feedbackZoom: number;    // масштаб истории (>1 = расширение, <1 = сжатие)
  feedbackRotate: number;  // поворот истории в радианах за кадр
  feedbackOffsetX: number; // горизонтальное смещение истории (-0.05..0.05)
  feedbackOffsetY: number; // вертикальное смещение истории
  feedbackMode: string;    // "over" — src перекрывает; "add" — сложение (накопление яркости)

  // === Конвертеры (оп-ноды, фаза C) ===
  // Grid: ГЕНЕРАТОР PointSet (0 входов) — процедурная стартовая сетка точек (аналог ramp1+ramp2+
  // reorder из TD-разбора Particles.4: «каждая точка знает свой UV»). Не зависит от видео/глубины —
  // первый продюсер, оживающий без источника кадров. id = row*cols+col (стабилен), jitter
  // детерминирован по (id, seed) — статичное микросмещение, как noise1 (amp 0.001) в TD.
  gridEnabled: boolean;
  gridCols: number;   // колонок (точек по X)
  gridRows: number;   // рядов (точек по Y)
  gridJitter: number; // 0..0.5 — случайный сдвиг точки в долях ячейки (ломает решётку)
  gridSeed: number;   // зерно джиттера

  // Scatter: Map2D(глубина) -> PointSet. Прорежённая сетка по карте глубины: точка в ячейке,
  // если глубина проходит порог. Точки питают рисовалку (Линии) -> «точки из глубины в линии».
  // Дёшево для 2D (sparse, не O(N²)): шаг сетки крупный, число точек ограничено.
  scatterEnabled: boolean;
  scatterDensity: number; // шаг сетки в видео-px (меньше = больше точек)
  scatterThreshold: number; // 0..1 порог глубины: точка только где d >= порога (ближе)
  scatterInvert: boolean; // инвертировать порог (точки в ДАЛЬНИХ областях)
  scatterMaxPoints: number; // потолок числа точек (защита от O(N²) в линиях)
  // U1 (направление U): 3D-точки сквозь CPU-тракт. Включённый scatterZ пишет z = глубина·scatterZScale
  // в каждую точку (раньше точки были плоские) → pointForce интегрирует z, рисовалки проецируют через
  // камеру облака / fakePerspective, Emitter-мост уносит z в GPU (uvToWorld·depthScale). «Форсы на облако».
  scatterZ: boolean; // включить 3D-экструзию точек по глубине
  scatterZScale: number; // масштаб z = (глубина 0..1)·scatterZScale (0..2); итоговая выраженность — ×depthScale
  // B-раунд-2: источник карты Scatter — Видео.глубина ("video") ИЛИ Map2D-цепочка (id noise2d/mapCombine/…).
  // Ведётся проводом графа (вход "depth" — сокет sMap принимает и глубину, и map2d). Резолвится mapForRef
  // в потребителе → кадр-карта → scatterToField (плотность точек по карте). Дефолт "video" = back-compat.
  scatterMapSource: string;

  // Sample: PointSet × Map2D -> PointSet. Берёт точки продюсера sampleSource и сэмплит в каждую
  // ЗНАЧЕНИЕ из карты глубины (атрибут value). Так 2D-точки получают Z из глубины (§6) /
  // value для размера-метки в рисовалке. Источник точек — хендл продюсера (как effect.source).
  sampleEnabled: boolean;
  sampleSource: string; // хендл продюсера точек (motion/hands/faceMesh/faceBoxes/peopleBox/scatter)
  sampleGain: number; // множитель сэмплированного значения (0..2)

  // SetAttr: PointSet × Field -> PointSet (T2-1). Присваивает каждой точке источника атрибут
  // (pscale/Cd/v/age/life) из Field-сигнала: attr = clamp01(field·gain + offset). Если сигнал не
  // подключён — константа (field=1 -> clamp01(gain+offset)). Сигнал — хендл драйвера/Math-цепочки.
  setAttrEnabled: boolean;
  setAttrSource: string; // хендл продюсера точек (как sampleSource)
  setAttrName: string;   // имя атрибута (AttrName): pscale/Cd/v/age/life
  setAttrSignal: string; // Field-сигнал ("none" | DriverKind | "op:"+id) — ведётся проводом в графе
  // T1-3 selection-вход (на точку, 0..1): атрибут пишется только «выбранным» — val=lerp(прежнее, новое, sel).
  // "none" (нет провода) = все выбраны (sel=1). Ведётся проводом графа (fieldInputs).
  setAttrSelection: string;
  setAttrGain: number;   // множитель сигнала (0..4)
  setAttrOffset: number; // смещение (-1..1)
  // Для name==="Cd" (векторный атрибут comps=3): цвет = lerp(colorLo, colorHi) по значению сигнала
  // t=clamp01(field·gain+offset). Для скалярных атрибутов (pscale/…) эти поля игнорируются.
  setAttrColorLo: string;
  setAttrColorHi: string;

  // Transform: PointSet -> PointSet (T2-3). Сдвиг/масштаб/поворот точек источника вокруг pivot.
  // Источник точек — провод графа (transformSource, wiring-поле, без инспектор-контрола).
  transformEnabled: boolean;
  transformSource: string; // хендл продюсера точек (ведётся проводом графа)
  transformTx: number;     // сдвиг по X (норм. 0..1 кадра), -1..1
  transformTy: number;     // сдвиг по Y, -1..1
  transformScale: number;  // равномерный масштаб вокруг pivot, 0..3 (1 = без изменений)
  transformRotate: number; // поворот вокруг pivot, радианы 0..2π
  transformPivotX: number; // центр преобразования X, 0..1 (дефолт 0.5)
  transformPivotY: number; // центр преобразования Y, 0..1 (дефолт 0.5)
  // T1-3 selection-вход (на точку, 0..1): p_out = lerp(p, transformed(p), sel) — «мягкое» смещение
  // выбранных; "none" (нет провода) = все точки (sel=1). Ведётся проводом графа (fieldInputs).
  transformSelection: string;

  // Merge: PointSet + PointSet -> PointSet (T2-3). Объединяет группы двух источников (как Mix-2вход).
  // Оба источника — провода графа (входы «точки» A и «точки» B). B опционален.
  mergeEnabled: boolean;
  mergeSourceA: string; // первый продюсер точек (вход points)
  mergeSourceB: string; // второй продюсер точек (вход b), опционально

  // Sort: PointSet -> PointSet (T2-3). Переупорядочивает точки В КАЖДОЙ группе по атрибуту
  // (меняет порядок chain/links → путь линий). Источник — провод графа (sortSource, wiring).
  sortEnabled: boolean;
  sortSource: string; // хендл продюсера точек (ведётся проводом графа)
  sortAttr: string;   // по чему сортировать: "pscale"|"value"|"x"|"y" (атрибут/координата)
  sortDir: string;    // "asc" | "desc"

  // Trail: PointSet -> PointSet (STATEFUL). Каждая точка источника оставляет хвост из своих позиций
  // за прошлые кадры (трекинг по стабильному атрибуту `id`; без id — фолбэк по индексу). Выход — по
  // одной группе-полилинии на отслеживаемую точку (chain), pscale сужается к хвосту (trailFade).
  // Источник — провод графа (trailSource, convertInputs). История живёт в модульной карте pointSources.
  trailEnabled: boolean;
  trailSource: string; // хендл продюсера точек (ведётся проводом графа)
  trailLength: number; // макс. длина истории (кадров), 2..60
  trailFade: number;   // 0..1 — сила сужения хвоста (pscale: 0=без сужения, 1=линейно к нулю)

  // Split: PointSet -> PointSet (реализация Group/Split-по-полю, stateless). Оставляет точки по
  // per-element полю-критерию vs порог (selection T1-3): keep "above" = поле≥порог, "below" = поле<порог.
  // Источник — провод графа (splitSource, convertInputs); поле — провод (splitField, fieldInputs).
  // Инверсия = вторая Split-нода с другим keep (модель одного выхода). links/attrs/values ремапятся.
  splitEnabled: boolean;
  splitSource: string;    // хендл продюсера точек (ведётся проводом графа)
  splitField: string;     // Field-критерий ("none"|DriverKind|"op:"+id) — на точку, ведётся проводом
  splitThreshold: number; // порог 0..1
  splitKeep: string;      // "above" (≥порог) | "below" (<порог)

  // Силы (точки): PointSet -> PointSet, STATEFUL (направление U — унификация точек и частиц).
  // ТЕ ЖЕ секции сил, что у GPU-Force (переиспользует force*-поля в params своего инстанса):
  // гравитация / curl|turbulence-шум / drag / границы — но интегрирует CPU-PointSet (облако
  // scatter, grid, руки…). Состояние {pos,vel,age} по стабильному id — модульная карта +
  // frameTick-барьер (шаблон Trail). pfLife: сек до респавна на исходную позицию (0 = бессмертно).
  pointForceEnabled: boolean;
  pointForceSource: string; // хендл продюсера точек (ведётся проводом графа)
  pfLife: number;           // 0 = без респавна; >0 — жизнь, затем возврат на точку источника
  pfStrength: number;       // общий множитель сил (масштаб шага, ср. math1.gain в TD)

  // particlesToPoints (U2 — направление U: частицы=точки): конвертер GPU-популяция→CPU-PointSet.
  // Вход — `particles`-сокет от Render-ноды (ведётся проводом графа, convertInputs socket:"particles").
  // Явный downsample-readback ≤p2pMaxPoints на низкой частоте (легально, как кадр глубины). Данные
  // публикует ParticleFieldCanvas (GPU-владелец) в модульный particleReadbackStore; резолвер читает.
  particlesToPointsEnabled: boolean;
  particlesSource: string;  // хендл Render-ноды particle-цепочки ("none") — ведётся проводом графа
  p2pMaxPoints: number;     // бюджет точек readback (downsample живой популяции)
  p2pColor: boolean;        // U3: тянуть Cd (цвет частицы) сквозь границу — второй readback colorBuffer

  // === GPU-частицы (T5 v2, domain "particle") — per-instance поля particle-нод ===
  // Имена 1:1 с layer.params (как у shader-FX). resolveConfig НЕ читает их из плоского конфига —
  // эмитит per-instance в particleSystems[] (обход particles-цепочки графа). Плоские поля здесь —
  // только для DEFAULT_CONFIG/типизации (мультиэкземпляр: 2 эмиттера = 2 слоя со своими params).

  // Emitter (+ Solver-роль, фьюзится в эмиттер в v1): рождает частицы НА ТОМ, что воткнули.
  emitterSource: string;     // points-вход (id продюсера / "none") — ведётся проводом графа (convertInputs)
  emitterMapSource: string;  // map-вход (Map2D — Видео.глубина, "none") — ведётся проводом графа
  emitterMapThreshold: number; // 0..1 — порог карты: частицы рождаются только где значение ≥ порога
  emitterRate: number;       // частиц/сек (доля популяции, оживляющая респавн)
  emitterLife: number;       // средняя жизнь частицы, сек
  emitterLifeVar: number;    // 0..1 — доля разброса жизни (lifeVar)
  emitterJitterPos: number;  // 0..0.2 — джиттер позиции спавна (норм. кадра)
  emitterInitSpeed: number;  // стартовая скорость частицы
  emitterVelSpread: number;  // 0..1 — разброс направления стартовой скорости
  emitterMaxParticles: number; // потолок популяции этой системы (буфер аллоцируется на нём)
  emitterTimeScale: number;  // множитель времени симуляции (slow-mo / ускорение)
  emitterDamping: number;    // 0..1 — общее затухание скорости за кадр (вязкость солвера)

  // Force — ОДНА нода с секциями (Гравитация / Шум curl|turbulence / Drag). Несколько Force-нод
  // чейнятся аккумуляцией (коммутативно). Каждая секция — enable + params.
  forceGravityOn: boolean;
  forceGravityX: number; forceGravityY: number; forceGravityZ: number; // вектор силы (антиграв = +Y)
  forceGravityStrength: number; // множитель вектора
  forceNoiseOn: boolean;
  forceNoiseMode: string;    // "curl" (div-free) | "turbulence" (сырой fbm)
  forceNoiseAmp: number;     // амплитуда силы шума
  forceNoiseScale: number;   // частота шума (swirlSize: меньше = крупнее завихрения)
  forceNoiseSpeed: number;   // скорость анимации поля шума
  forceDragOn: boolean;
  forceDrag: number;         // 0..1 — сопротивление среды (targetv=0)
  // Секция «Границы» (аналог limit1 zigzag из TD): держит частицы в рамке видео (±uRect по X/Y,
  // Z свободен — как chanmask=3). bounce = отражение (zigzag), wrap = телепорт через край (тор).
  // Структурный параметр (ветка TSL) — входит в structureKey, смена пересобирает пайплайн.
  forceBoundsMode: string;   // "none" | "bounce" | "wrap"

  // ParticleColor — цвет частиц (рендер-стадия colorNode). Режим byAge/byVelocity/constant.
  pcolorMode: string;        // "byAge" | "byVelocity" | "constant"
  pcolorA: string;           // цвет A (молодые / медленные / константа)
  pcolorB: string;           // цвет B (старые / быстрые)

  // Render — терминал particles-домена. Размер/прозрачность/блендинг точек.
  prenderSize: number;       // размер точки (px, sizeAttenuation off — HUD-look)
  prenderSizeVar: number;    // U3: 0..1 — per-particle разброс размера (size·(1+(rand(seed)-0.5)·2·var)); 0=одинаковый
  prenderOpacity: number;    // 0..1 — общая прозрачность
  prenderBlend: string;      // "additive" | "normal"
  prenderDepthWrite: boolean; // НАСТОЯЩЕЕ 3D: depth-тест+write → ближние частицы перекрывают дальние
                              // (общий depth-буфер сортирует ВСЕ системы по реальному z). false = старый
                              // HUD-glow (depthTest off, аддитив всегда поверх, без перекрытия). Default true.

  // ParticleLight (нода «Свет (частицы)», domain particle): прожектор-конус с НАСТОЯЩИМ самозатенением —
  // частицы биннятся в воксельную сетку плотности (compute, атомики), материал рей-марчит от частицы к
  // свету сквозь сетку → Beer-затухание exp(-σ·density). Свет целит в центр сцены (0,0,0).
  plightX: number;          // позиция света в мире частиц (видео-rect ≈ [-aspect..aspect]×[-1..1], z свободен)
  plightY: number;
  plightZ: number;
  plightColor: string;      // цвет света (hex) — умножает цвет частицы
  plightIntensity: number;  // 0..5 — яркость
  plightAngle: number;      // 5..90° — полуугол конуса прожектора
  plightSpread: number;     // 0..1 — спред: мягкость края конуса (penumbra)
  plightSize: number;       // 0.1..4 — размер: радиус спада яркости по дистанции (1/(1+(d/size)²))
  plightShadow: number;     // 0..1 — сила самозатенения (σ рей-марча; 0 = тени выкл)
  plightAmbient: number;    // 0..0.5 — заполняющий свет (0 = darkroom: вне луча ЧЁРНОЕ, ничего не видно)
  plightGizmo: boolean;     // показывать гизмо света (позиция-маркер + луч направления + рёбра конуса)

  // === Map2D-ноды (T5 v2 Phase B, domain "map2d") — CPU-карты для particle/scatter ===
  // noise2d — генератор FBM value-noise (Map2D). params читает mapSources.noise2dToMap.
  noiseFreq: number;         // частота шума (число ячеек по стороне)
  noiseOctaves: number;      // 1..6 — число октав FBM
  noiseSeed: number;         // зерно
  noiseSpeed: number;        // скорость анимации поля по времени
  noiseContrast: number;     // 0.2..3 — контраст (гамма выхода)
  // mapCombine — Map2D × Map2D → Map2D. Входы — провода графа (mapInputs).
  mapInputA: string;         // хендл Map2D-источника A ("none" | "video" | id map2d-ноды)
  mapInputB: string;         // хендл Map2D-источника B (опц.)
  combineMode: string;       // "multiply" | "add" | "screen" | "min" | "max"

  // === Оверлеи (рисуются поверх канваса) ===

  // Детекция движения.
  motionEnabled: boolean;
  motionSensitivity: number; // ниже = чувствительнее (порог разницы)
  // --- устойчивость детекции (frame-diff пайплайн в visionWorker) ---
  motionGap: number; // с каким кадром назад сравнивать (1..4); больше = для медленного движения
  motionDecay: number; // затухание «тепла» 0..0.98; больше = строже, меньше ложных боксов
  motionHeatThreshold: number; // 0..1 — сколько тепла накопить, чтобы зажечь пиксель
  motionMinArea: number; // мин. площадь компоненты (px в кадре обработки) — отсекает мусор
  motionMaxBoxes: number; // сколько самых крупных боксов показывать
  motionSmooth: number; // 0..1 — сглаживание боксов во времени
  motionColor: string;
  motionColor2: string; // второй цвет для градиента
  motionThickness: number;
  motionLabel: string; // редактируемая подпись
  motionLabelSize: number;
  motionAscii: boolean; // ASCII-частицы из источников движения
  motionAsciiDensity: number; // 0..1
  // Цепь-линия между боксами движения выпилена из продюсера (Фаза 3, 2-A): теперь это
  // отдельная top-level нода «Линии» (EffectNode, source="motion") поверх точек движения.

  // Соединяющиеся точки (constellation / сетка).
  constellationEnabled: boolean;
  featureCount: number; // сколько характерных точек искать
  linkDistance: number; // 0..1 — макс. дистанция связи (доля кадра)
  constellationSmooth: number; // 0..1 — сглаживание/фейк-трекинг точек
  constellationColor: string;
  constellationColor2: string; // градиент линии от точки к точке
  lineWidth: number;
  lineWidthRandom: number; // 0..1 — рандом толщины линий
  constellationCurve: number; // 0..1 — кривизна Безье (0 = прямые)
  constellationLabelChance: number; // 0..1 — доля точек со случайным значением
  constellationScaleMin: number; // размер точки/линии для дальней точки (d->0)
  constellationScaleMax: number; // размер точки/линии для ближней точки (d->1)
  constellationLineAxis: "x" | "y" | "auto"; // ось касательной node-«лапши»: гориз./верт./по оси A→B

  // Детекция лиц (MediaPipe).
  faceBoxesEnabled: boolean; // BlazeFace: рамки + ключевые точки
  faceMeshEnabled: boolean; // FaceLandmarker: сетка 468 точек
  maxFaces: number; // макс. число лиц
  faceSmooth: number; // 0..1 — сглаживание движения лица
  faceBoxColor: string;
  faceBoxThickness: number;
  faceLabel: string; // редактируемая подпись над боксом
  faceLabelSize: number;
  faceLabelColor: string;
  faceMeshColor: string;
  faceMeshDensity: number; // 0.1..1 — какую долю точек показывать (прореживание)
  faceMeshPointSize: number; // базовый размер точек сетки
  faceMeshColorRandom: number; // 0..1 — доля точек со случайным цветом из 4-цветной палитры
  facePointScaleRandom: number; // 0..1 — рандом размера точек сетки
  faceSquareChance: number; // 0..1 — доля точек, рождающихся квадратиками

  // Маски людей (YOLOv8n-seg, onnxruntime-web/WebGPU). Instance-сегментация:
  // каждый человек — своя маска своим цветом. Заливка и/или контур, композитинг
  // в flatShader (обратный letterbox). Тяжёлая нейронка -> опционально, гейтится флагом.
  peopleMasksEnabled: boolean;
  peopleInput: number; // размер входа модели (640/480/384) — меньше = быстрее
  peopleConf: number; // 0..1 порог уверенности детекции
  peopleMaskThreshold: number; // 0..1 порог бинаризации маски
  peopleIou: number; // 0..1 порог NMS
  peopleFill: boolean; // заливка силуэта полупрозрачным цветом
  peopleOutline: boolean; // контур по краю маски
  peopleFillOpacity: number; // 0..1 прозрачность заливки
  peopleEveryNthFrame: number; // троттлинг инференса (каждый N-й кадр)
  peopleMaskSmooth: number; // 0..0.9 сглаживание ДВИЖЕНИЯ маски во времени (края остаются пиксельными)

  // Гладкая заливка из MediaPipe Selfie Segmentation (как фон в Zoom/Meet) — НЕЗАВИСИМЫЙ
  // от YOLO слой: можно включить одно, выключить другое. YOLO даёт инстансы/цвет/контур,
  // selfie — мягкое покрытие с пером края (30fps, стабильно).
  peopleSmoothEnabled: boolean; // включить гладкую маску (независимо от YOLO-масок)
  segModel: SegModel; // модель сегментации: selfie (портрет) / deeplab (общий план)
  peopleFeather: number; // 0..0.4 мягкость края гладкой маски
  peopleSegThreshold: number; // 0.1..0.9 порог уверенности (выше = меньше захватывает фон)
  peopleSegSmooth: number; // 0..0.9 темпоральная стабилизация маски (гасит дрожь; больше = инертнее)
  peopleSegEveryNthFrame: number; // троттлинг сегментации (каждый N-й кадр)
  peopleColor: string; // цвет заливки (A) — там, где нет YOLO-инстанса / при градиенте
  // Градиенты заливки и контура (вертикальные, по экрану). Работают и на YOLO, и на гладкой маске.
  peopleColor2: string; // цвет заливки B (конец градиента)
  peopleFillGradient: boolean; // заливка градиентом A->B (иначе один цвет / цвет инстанса)
  peopleOutlineColor: string; // цвет контура A
  peopleOutlineColor2: string; // цвет контура B
  peopleOutlineGradient: boolean; // контур градиентом A->B (иначе цвет инстанса / A)
  peopleGradientByInstance: boolean; // крутить hue градиента по цвету YOLO-инстанса (разные люди — разный оттенок)
  peopleFillOpacity2: number; // 0..1 прозрачность заливки внизу (B) — рампа A(сверху)->B(снизу)

  // Bounding box вокруг каждого человека (по YOLO-детекции). Рисуется в SVG-оверлее.
  peopleBoxEnabled: boolean; // показывать bbox людей
  peopleBoxThickness: number; // толщина рамки
  peopleBoxGradient: boolean; // рамка градиентом A->B (вертикальный), иначе один цвет
  peopleBoxColor: string; // цвет рамки A
  peopleBoxColor2: string; // цвет рамки B

  // Глобальная HUD-надпись (редактируемый текст поверх сцены).
  hudText: string;
  hudTextSize: number;
  hudTextColor: string;
  hudX: number; // 0..1 позиция
  hudY: number;

  // === CLOUD-режим: глубина / облако точек ===
  depthEnabled: boolean;
  depthScale: number;
  pointSize: number; // размер точки
  pointSquare: boolean; // квадратные точки
  depthEveryNthFrame: number;
  depthResolution: number; // px по длинной стороне входа инференса (меньше = быстрее)

  // Темпоральное сглаживание глубины (см. DEPTH_SMOOTHING.md). Применяется
  // централизованно в useDepth к live-карте -> и 3D-облако, и 2D-пикселизация
  // берут уже сглаженную. Работает на частоте обновления глубины (дёшево).
  depthSmoothMode: DepthSmoothMode;
  depthSmoothAlpha: number; // базовая alpha EMA 0.05..0.6 (меньше = стабильнее, инертнее)
  depthMotionBoost: number; // 0..4 — насколько быстрее принимать изменившиеся пиксели (анти-гост)
  depthDeadband: number; // 0..0.1 — мёртвая зона: микро-дрожь ниже порога игнорим

  // Кеш карты глубины: запечь всё видео офлайн в максимальном размере и брать из кеша.
  cacheEnabled: boolean; // брать глубину из кеша (не считать каждый кадр)
  cacheResolution: number; // px по длинной стороне при запекании (макс. качество)
  cacheFps: number; // сколько карт глубины в секунду запекать

  scanEnabled: boolean;
  scanSpeed: number;
  scanWidth: number;
  scanColor: string;
  scanColor2: string; // 2-й цвет градиента сканера
  scanColor3: string; // 3-й цвет градиента сканера
  scanGradient: boolean; // 3-цветный градиент сканера
  scanNoiseScale: number; // размер блока квадратного нойза
  scanNoiseAmount: number; // сила нойза (0 = выкл)
  scanHide: boolean; // скрывать точки за плоскостью сканера (визуально)
  scanOnly: boolean; // показывать ТОЛЬКО подсвеченные сканером точки (остальные прозрачны -> видны 2D-эффекты)

  // ASCII-символы, рождающиеся в месте прохода сканера (летят вверх, угасают).
  scanAsciiEnabled: boolean;
  scanAsciiColor: string;
  scanAsciiDensity: number; // 0..1 плотность спавна
  scanAsciiSpeed: number; // скорость подъёма
  scanAsciiOpacity: number; // 0..1 макс. прозрачность
  scanAsciiFade: number; // время жизни/затухания, сек (меньше = быстрее гаснут)
  scanAsciiFadeRandom: number; // 0..1 — рандом времени затухания
  scanAsciiScaleMin: number; // размер символа для дальней точки (d->0)
  scanAsciiScaleMax: number; // размер символа для ближней точки (d->1)

  frontLock: boolean; // фронтальный вид-оверлей (ортокамера ровно на кадр) vs свободная орбита
  composite: boolean; // слои: видео -> 3D-облако -> 2D-эффекты сверху (только cloud)
  // T3 Composite: порядок (что-над-чем) и режим смешивания flat↔cloud при composite. Глобалы,
  // пишет нода Композит / контрол ScenePanel. Дефолты = прежнее поведение (cloudOver/normal).
  compositeOrder: CompositeOrder;
  compositeBlend: CompositeBlend;

  // T5-СПАЙК: GPU-частицы (three/webgpu + TSL) отдельным канвасом-сиблингом поверх flat.
  // Фичефлаг (canvas-level глобал, как compositeOrder/Blend — resolveConfig переносит автоматом).
  // Дефолт false → нулевая поверхность регрессии. Изолированный прототип, БЕЗ нод-обвязки.
  particlesEnabled: boolean;

  // --- 2D-constellation (screen-space, во flat): объём без ухода от видео ---
  // Точки рисуются ровно на 2D-позициях изображения; глубина лишь модулирует размер/
  // яркость/связи, а fakePerspective радиально растягивает их ∝ глубине (имитация линзы).
  constellation2DEnabled: boolean;
  fakePerspective: number; // 0..1 — сила радиального растягивания от центра кадра по глубине

  // === Трекинг рук (MediaPipe HandLandmarker) — слой-оверлей "hands" в реестре ===
  // Гейтится handsEnabled (enabledField слоя), крутилки — params слоя (LAYER_DEFS.hands),
  // рисуется собственным HandsOverlay (не в общем Overlay), маппится "contain" как лица.
  // === Аудио-источник сигналов (T-Beauty): WebAudio FFT-анализ ===
  audioEnabled: boolean; // мастер-тумблер WebAudio-анализа
  audioSource: string;   // "video" — звук видео-элемента, "mic" — микрофон
  audioGain: number;     // усиление полос (0..4, дефолт 1.5)

  handsEnabled: boolean; // мастер-тумблер трекинга рук
  handSkeleton: boolean; // рисовать кости (HAND_CONNECTIONS)
  handPoints: boolean; // точки + квадраты на кончиках пальцев
  handHud: boolean; // текстовый readout позы/жеста над рукой
  handGestures: boolean; // считать жесты (геометрия)
  maxHands: number; // 1..2
  handMirror: boolean; // зеркалить X (селфи-режим: фронталка телефона)
  handSmooth: number; // 0..1 — сила One Euro-сглаживания (0 = сырьё, 1 = максимально гладко)
  handColorLeft: string; // цвет левой руки
  handColorRight: string; // цвет правой руки
  handLineWidth: number; // толщина костей скелета
  handTipDotSize: number; // радиус точки на кончике пальца
  handTipSquareSize: number; // размер квадрата на кончике пальца
}

export const DEFAULT_CONFIG: SceneConfig = {
  videoUrl: null,
  renderMode: "flat",
  uiTab: "fx2d",
  fpsCap: 25,
  hideVideo: false,
  shaderFxOrder: [], // T0c: id слоёв-инстансов (пусто по умолчанию; цепочку строит граф/миграция)

  thermalEnabled: false,
  thermalMix: 0.85,
  thermalColdColor: "#05011a",
  thermalHotColor: "#fff3c0",

  sobelEnabled: true,
  sobelStrength: 1.6,
  sobelOnly: false,
  sobelColor: "#33ffaa",
  sobelThickness: 1.0,
  sobelTolerance: 0.0,
  sobelPixelate: 0,

  scanlinesEnabled: false,
  scanlineIntensity: 0.25,

  pixelateEnabled: false,
  pixelateNear: 2,
  pixelateFar: 24,
  pixelateRampNear: 1.0,
  pixelateRampFar: 0.0,
  pixelateGrid: true,
  pixelateBlur: 0.0,

  pixelArtEnabled: false,
  pixelArtSize: 8,
  pixelArtAscii: false,
  pixelArtMono: false,
  pixelArtLevels: 4,
  // дефолтная палитра — 16-ступенчатый ч/б-рамп (используются первые pixelArtLevels)
  pixelArtPalette: Array.from({ length: 16 }, (_, i) => {
    const h = Math.round((i / 15) * 255).toString(16).padStart(2, "0");
    return `#${h}${h}${h}`;
  }),
  pixelArtAsciiTint: false,
  pixelArtAsciiColor: "#ff2d8e",
  pixelArtAsciiMode: "ramp",
  pixelArtGlowMask: Array.from({ length: 16 }, () => false),
  pixelArtGlowSize: 1.5,
  pixelArtGlowIntensity: 1.2,

  lookupEnabled: false,
  lookupColors: ["#04121f", "#1d6e8c", "#ff8a1e", "#ffe24a"],
  lookupStops: 4,
  lookupMix: 1,

  mirrorEnabled: false,
  mirrorSectors: 6,
  mirrorAngle: 0,

  displaceEnabled: false,
  displaceAmount: 0.03,
  displaceScale: 8,
  displaceSpeed: 1.0,
  displaceMode: "noise",

  chromAbEnabled: false,
  chromAbAmount: 0.008,
  chromAbAngle: 0,
  chromAbMode: "radial",

  grainEnabled: false,
  grainAmount: 0.25,
  grainSize: 1,
  grainColored: false,

  feedbackEnabled: false,
  feedbackDecay: 0.92,
  feedbackZoom: 1.01,
  feedbackRotate: 0.0,
  feedbackOffsetX: 0.0,
  feedbackOffsetY: 0.0,
  feedbackMode: "over",

  gridEnabled: false,
  gridCols: 24,
  gridRows: 16,
  gridJitter: 0.0,
  gridSeed: 1,
  scatterEnabled: false,
  scatterDensity: 18,
  scatterThreshold: 0.5,
  scatterInvert: false,
  scatterMaxPoints: 300,
  scatterZ: false,
  scatterZScale: 1,
  scatterMapSource: "video",
  sampleEnabled: false,
  sampleSource: "motion",
  sampleGain: 1,
  setAttrEnabled: false,
  setAttrSource: "motion",
  setAttrName: "pscale",
  setAttrSignal: "none",
  setAttrSelection: "none",
  setAttrGain: 1,
  setAttrOffset: 0,
  setAttrColorLo: "#1a1033",
  setAttrColorHi: "#36e6ff",

  transformEnabled: false,
  transformSource: "none",
  transformTx: 0,
  transformTy: 0,
  transformScale: 1,
  transformRotate: 0,
  transformPivotX: 0.5,
  transformPivotY: 0.5,
  transformSelection: "none",
  mergeEnabled: false,
  mergeSourceA: "none",
  mergeSourceB: "none",
  sortEnabled: false,
  sortSource: "none",
  sortAttr: "pscale",
  sortDir: "asc",
  trailEnabled: false,
  trailSource: "none",
  trailLength: 16,
  trailFade: 0.7,
  splitEnabled: false,
  splitSource: "none",
  splitField: "none",
  splitThreshold: 0.5,
  splitKeep: "above",
  pointForceEnabled: false,
  pointForceSource: "none",
  particlesToPointsEnabled: false,
  particlesSource: "none",
  p2pMaxPoints: 1500,
  p2pColor: false,
  pfLife: 0,
  pfStrength: 1.0,

  // GPU-частицы (T5 v2). Дефолты по спайку (ParticleSpike): box-эмиттер невидим без source/map,
  // curl-шум читаемый, гравитация лёгкая вниз, аддитив поверх видео.
  emitterSource: "none",
  emitterMapSource: "none",
  emitterMapThreshold: 0.5,
  emitterRate: 1.0,
  emitterLife: 4.0,
  emitterLifeVar: 0.5,
  emitterJitterPos: 0.01,
  emitterInitSpeed: 0.0,
  emitterVelSpread: 0.3,
  emitterMaxParticles: 200000,
  emitterTimeScale: 1.0,
  emitterDamping: 0.0,
  forceGravityOn: true,
  forceGravityX: 0, forceGravityY: -0.2, forceGravityZ: 0,
  forceGravityStrength: 1.0,
  forceNoiseOn: true,
  forceNoiseMode: "curl",
  forceNoiseAmp: 0.35,  // под нормализованный мир [-1,1] (большие значения уносят частицы за кадр)
  forceNoiseScale: 2.5, // выше частота → видимые завихрения в единичном мире
  forceNoiseSpeed: 0.3,
  forceDragOn: false,
  forceDrag: 0.1,
  forceBoundsMode: "none",
  pcolorMode: "byVelocity",
  pcolorA: "#40b3ff",
  pcolorB: "#ffd966",
  prenderSize: 3.0,
  prenderSizeVar: 0.0,
  prenderOpacity: 1.0,
  prenderDepthWrite: true,
  plightX: 0.9,
  plightY: 0.9,
  plightZ: 1.4,
  plightColor: "#ffffff",
  plightIntensity: 1.6,
  plightAngle: 40,
  plightSpread: 0.35,
  plightSize: 1.6,
  plightShadow: 0.7,
  plightAmbient: 0.04,
  plightGizmo: true,
  prenderBlend: "additive",

  noiseFreq: 6,
  noiseOctaves: 3,
  noiseSeed: 1,
  noiseSpeed: 0.2,
  noiseContrast: 1.0,
  mapInputA: "none",
  mapInputB: "none",
  combineMode: "multiply",

  motionEnabled: true,
  motionSensitivity: 0.12,
  motionGap: 2,
  motionDecay: 0.9,
  motionHeatThreshold: 0.35,
  motionMinArea: 24,
  motionMaxBoxes: 8,
  motionSmooth: 0.6,
  motionColor: "#ff6a28",
  motionColor2: "#ffd23c",
  motionThickness: 1.6,
  motionLabel: "TRACK",
  motionLabelSize: 10,
  motionAscii: true,
  motionAsciiDensity: 0.5,

  constellationEnabled: true,
  featureCount: 80,
  linkDistance: 0.12,
  constellationSmooth: 0.6,
  constellationColor: "#3cffaa",
  constellationColor2: "#36e6ff",
  lineWidth: 1.0,
  lineWidthRandom: 0.5,
  constellationCurve: 0.35,
  constellationLabelChance: 0.2,
  constellationScaleMin: 0.6,
  constellationScaleMax: 3.5,
  constellationLineAxis: "x",

  faceBoxesEnabled: true,
  faceMeshEnabled: false,
  maxFaces: 3,
  faceSmooth: 0.6,
  faceBoxColor: "#36e6ff",
  faceBoxThickness: 1.6,
  faceLabel: "FACE",
  faceLabelSize: 10,
  faceLabelColor: "#36e6ff",
  faceMeshColor: "#7be6ff",
  faceMeshDensity: 1,
  faceMeshPointSize: 1.3,
  faceMeshColorRandom: 0,
  facePointScaleRandom: 0.6,
  faceSquareChance: 0.25,

  peopleMasksEnabled: false,
  peopleInput: 640,
  peopleConf: 0.4,
  peopleMaskThreshold: 0.5,
  peopleIou: 0.45,
  peopleFill: true,
  peopleOutline: true,
  peopleFillOpacity: 0.45,
  peopleEveryNthFrame: 2,
  peopleMaskSmooth: 0.4,
  peopleSmoothEnabled: false,
  segModel: "deeplab",
  peopleFeather: 0.08,
  peopleSegThreshold: 0.62,
  peopleSegSmooth: 0.55,
  peopleSegEveryNthFrame: 2,
  peopleColor: "#36e6ff",
  peopleColor2: "#ff36a0",
  peopleFillGradient: true,
  peopleOutlineColor: "#39ff8b",
  peopleOutlineColor2: "#36e6ff",
  peopleOutlineGradient: true,
  peopleGradientByInstance: false,
  peopleFillOpacity2: 0.45,
  peopleBoxEnabled: true,
  peopleBoxThickness: 2,
  peopleBoxGradient: true,
  peopleBoxColor: "#ff4d4d",
  peopleBoxColor2: "#ffd23c",

  hudText: "",
  hudTextSize: 16,
  hudTextColor: "#39ff8b",
  hudX: 0.5,
  hudY: 0.08,

  depthEnabled: false, // облако точек по умолчанию выкл (база — 2D); включается в левой панели
  depthScale: 1.4,
  pointSize: 2.2,
  pointSquare: false,
  depthEveryNthFrame: 2,
  depthResolution: 256,

  depthSmoothMode: "ema",
  depthSmoothAlpha: 0.28,
  depthMotionBoost: 2.5,
  depthDeadband: 0,

  cacheEnabled: false,
  cacheResolution: 512,
  cacheFps: 15,

  scanEnabled: true,
  scanSpeed: 0.35,
  scanWidth: 0.07,
  scanColor: "#39ff8b",
  scanColor2: "#36e6ff",
  scanColor3: "#ff36a0",
  scanGradient: false,
  scanNoiseScale: 40,
  scanNoiseAmount: 0,
  scanHide: false,
  scanOnly: false,

  scanAsciiEnabled: false,
  scanAsciiColor: "#39ff8b",
  scanAsciiDensity: 0.5,
  scanAsciiSpeed: 1.0,
  scanAsciiOpacity: 0.9,
  scanAsciiFade: 2.0,
  scanAsciiFadeRandom: 0.5,
  scanAsciiScaleMin: 6,
  scanAsciiScaleMax: 30,

  frontLock: true,
  composite: false,
  compositeOrder: "cloudOver",
  compositeBlend: "normal",
  particlesEnabled: false,

  constellation2DEnabled: false,
  fakePerspective: 0,

  audioEnabled: false,
  audioSource: "video",
  audioGain: 1.5,

  handsEnabled: false,
  handSkeleton: true,
  handPoints: true,
  handHud: false,
  handGestures: true,
  maxHands: 2,
  handMirror: false,
  handSmooth: 0.5,
  handColorLeft: "#3da9fc",
  handColorRight: "#ef4565",
  handLineWidth: 3,
  handTipDotSize: 5,
  handTipSquareSize: 11,
};

// ============================================================================
// МОДЕЛЬ СЛОЁВ (новый источник правды UI). SceneConfig выше — «резолвнутая»
// (плоская) форма, которую читает рендер. Документ-конфиг — LayeredConfig:
// глобальные поля + упорядоченный список слоёв. resolveConfig() (layerMigrate.ts)
// разворачивает слои обратно в SceneConfig, поэтому движок рендера не меняется.
// ============================================================================

export type LayerKind =
  // 2D экранные эффекты (мега-шейдер flatShader)
  | "thermal" | "sobel" | "scanlines" | "pixelate" | "pixelArt" | "lookup" | "feedback" | "mirror"
  | "displace" | "chromAb" | "grain"
  // 2D-маски людей (композитинг в flatShader)
  | "peopleMask" | "selfie"
  // 2D-оверлеи (SVG поверх канваса)
  | "motion" | "constellation2D" | "faceBoxes" | "faceMesh" | "hands" | "peopleBox" | "hud"
  // конвертеры (оп-ноды): Map2D -> PointSet (Scatter), PointSet×Map2D -> PointSet (Sample) — фаза C;
  // PointSet×Field -> PointSet (SetAttr — присвоение атрибута точкам) — T2-1;
  // PointSet -> PointSet: Transform/Sort (1 вход), Merge (2 входа) — T2-3; Trail (шлейфы по id) — stateful;
  // Split (фильтр точек по per-element полю — реализация Group/Split, selection T1-3);
  // Grid — ГЕНЕРАТОР точек (0 входов, процедурная сетка — не зависит от видео);
  // pointForce — «Силы (точки)»: CPU-солвер сил над PointSet (направление U: частицы=точки)
  | "grid" | "scatter" | "sample" | "setAttr" | "transform" | "merge" | "sort" | "trail" | "split" | "pointForce" | "particlesToPoints"
  // GPU-частицы (T5 v2, domain "particle", сокет `particles`): композиционная цепочка нод
  // Emitter → [Force…] → [ParticleColor] → Render. НЕ point-продюсеры, НЕ shader — свой GPU-домен
  // (рисуются в WebGPU-канвас-сиблинг, resolveConfig эмитит particleSystems обходом particles-рёбер).
  | "emitter" | "force" | "particleColor" | "particleLight" | "particleRender"
  // Map2D-ноды (T5 v2 Phase B, domain "map2d", сокет `map`): CPU-карты для particle/scatter-потребителей
  // (низкая частота, как глубина). noise2d — генератор; mapCombine — Map2D×Map2D. Резолвятся
  // `mapSources.mapForRef` в кадр (DepthFrame-форма), эмитятся в resolveConfig как `mapNodes`.
  | "noise2d" | "mapCombine"
  // 3D-эффекты поверх облака точек (само облако — глобальная секция сцены, не слой)
  | "scan" | "scanAscii" | "constellation3D"
  // Аудио-источник сигналов (T-Beauty): WebAudio FFT-полосы как Field-драйверы
  | "audio";

// Один слой = инстанс эффекта. enabled заменяет старые xEnabled-флаги; params —
// подмножество полей SceneConfig этого эффекта (имена полей сохранены 1:1).
export interface Layer {
  id: string;
  kind: LayerKind;
  name: string; // редактируемая подпись
  enabled: boolean;
  params: Partial<SceneConfig>;
  // Привязки числовых params shader-FX слоя к Field-сигналам (direction A): ключ = имя поля
  // SceneConfig (биндабельные перечислены в LAYER_DEFS[kind].bindable). Паритет с EffectNode.bindings:
  // провод графа от сигнала/Math-цепочки к field-входу shader-ноды пишет сюда (компилятор applyGraph).
  bindings?: Record<string, ParamBinding>;
  // forward-compat под таймлайн (этап 1 не использует): окно активности, сек видео.
  start?: number | null;
  end?: number | null;
}

// Один резолвнутый shader-FX-проход (T0c, instance-keyed): id инстанса + его вид + ПОЛНЫЙ набор
// его params (слитый с дефолтами вида). FlatView читает uniform'ы из `params`, не из плоского конфига.
// `bindings` (direction A): привязки числовых params к сигналам — FlatView резолвит их в кадре.
export interface ResolvedFxPass { id: string; kind: LayerKind; params: Partial<SceneConfig>; bindings?: Record<string, ParamBinding> }

// Один резолвнутый продюсер/конвертер точек (T0c, instance-keyed): id инстанса + вид + его params
// (слитые с дефолтами). Резолвер точек (fieldForLayerId) адресует source эффекта по этому id.
export interface ResolvedProducer { id: string; kind: LayerKind; params: Partial<SceneConfig> }

// Резолвнутая Map2D-нода (T5 v2 Phase B): id+вид+params (вкл. входы-хендлы mapInputA/B). CPU-резолвер
// `mapForRef` рекурсивно разворачивает цепочку в кадр-карту (DepthFrame-форма). Как ResolvedProducer.
export interface ResolvedMapNode { id: string; kind: LayerKind; params: Partial<SceneConfig> }

// Одна резолвнутая particle-система (T5 v2): результат обхода particles-цепочки графа от терминала
// Render назад до эмиттера. `emitters` — МАССИВ источников рождения (v1 = ровно 1; Merge-particles
// в Phase D кладёт несколько в одну популяцию — форвард-совместимо). solver-параметры живут на
// системе (в v1 = на эмиттере). forces[] — в порядке цепочки (kind всегда "force", секции в params).
export interface ResolvedParticleEmitter { params: Partial<SceneConfig>; sourceRef: string | null; mapRef: string | null }
export interface ResolvedParticleSystem {
  id: string; // id эмиттера = id системы (стабилен между кадрами для диффа в ParticleField)
  renderId?: string; // U2: id Render-ноды-терминала — конвертер Particles→Points ссылается на неё (мост маппит renderId→sysId)
  emitters: ResolvedParticleEmitter[];
  solver: { maxParticles: number; timeScale: number; damping: number };
  forces: { params: Partial<SceneConfig> }[];
  color: { params: Partial<SceneConfig> } | null;
  light: { params: Partial<SceneConfig> } | null; // нода «Свет (частицы)»: прожектор + voxel-самозатенение
  render: { params: Partial<SceneConfig> } | null;
}

// === Точки-данные (PointField) — общий контракт «производителей точек» для модификаторов ===
// Слои hands/motion/... нормализуют свой результат в это; модификаторы (линии/точки/метки)
// читают и рисуют по своим настройкам. Координаты x,y нормированы 0..1 кадра (как везде).
export interface PVec { x: number; y: number; z?: number }

// === Атрибуты точек (T2-1) — типизированные именованные каналы на PointSet (Houdini/TD-стиль) ===
// Имена-конвенции: Cd (цвет), pscale (размер), id, v (скорость), age, life, N (нормаль).
// Произвольная строка тоже допустима (кастомные атрибуты).
export type AttrName = "Cd" | "pscale" | "id" | "v" | "age" | "life" | "N";
// Один атрибут = имя + плотный буфер. `comps` — число компонент на точку (1=скаляр дефолт,
// 2=xy, 3=rgb/xyz). Данные плоские: data[j*comps + c]. comps undefined/1 = скалярный путь
// (байт-в-байт как T2-1). Векторные: Cd (comps=3 rgb 0..1), v/N (comps=3 xyz).
export interface PointAttr { name: AttrName | string; data: Float32Array | Uint16Array; comps?: 1 | 2 | 3; }

export interface PointGroup {
  points: PVec[];
  links?: [number, number][]; // явные рёбра (скелет руки, рёбра меша)
  chain?: boolean;           // последовательная цепь по порядку точек
  values?: number[];         // УСТАР. alias для attrs[{name:"pscale"}] (активность/размер 0..1). См. attrs.
  // SoA (Structure of Arrays): attrs[i].data[j] = j-я точка, i-й атрибут. Произвольный набор каналов.
  attrs?: PointAttr[];
  color?: string;            // подсказка цвета группы (напр. левая/правая рука)
}
export interface PointField {
  kind: LayerKind;
  groups: PointGroup[]; // одна или несколько групп (напр. 2 руки = 2 группы)
}

// Прочитать атрибут точек: сперва SoA attrs[] по имени, для "pscale" — фолбэк на устар. values[].
// Возвращает буфер значений (по точке) или undefined, если атрибута нет (вызывающий ставит дефолт).
export function getPointAttr(g: PointGroup, name: AttrName | string): Float32Array | Uint16Array | number[] | undefined {
  const a = g.attrs?.find((x) => x.name === name);
  if (a) return a.data;
  if (name === "pscale" && g.values) return g.values;
  return undefined;
}

// Прочитать ВЕКТОРНЫЙ атрибут точки j как [x,y,z] (недостающие компоненты = 0). Учитывает comps:
// скаляр (comps undefined/1) -> [s,0,0]; rgb/xyz (comps=3) -> [data[j*3], data[j*3+1], data[j*3+2]].
// Возвращает undefined, если атрибута нет (вызывающий ставит дефолт). Скалярный getPointAttr не трогаем.
export function getPointAttrVec(g: PointGroup, name: AttrName | string, j: number): [number, number, number] | undefined {
  const a = g.attrs?.find((x) => x.name === name);
  if (!a) {
    if (name === "pscale" && g.values) return [g.values[j] ?? 0, 0, 0];
    return undefined;
  }
  const c = a.comps ?? 1;
  const base = j * c;
  return [a.data[base] ?? 0, c > 1 ? (a.data[base + 1] ?? 0) : 0, c > 2 ? (a.data[base + 2] ?? 0) : 0];
}

// Драйвер — непрерывный сигнал 0..1, которым можно модулировать параметр модификатора (TD CHOP).
//  - openness:     раскрытие ладони (кулак=0 ↔ ладонь=1)
//  - pinch:        щипок (0..1)
//  - roll:         поворот ладони (влево=0 ↔ центр=0.5 ↔ вправо=1)
//  - handsDist:    дистанция между двумя руками (вместе=0 ↔ далеко=1)
//  - motionEnergy: энергия движения (Reduce боксов движения по активности; нет рук — работает)
//  - faceX/faceY:  центроид лиц (Reduce: средний центр боксов, 0..1; нет лиц — центр 0.5)
//  - peopleCount:  число людей (Reduce: count, норм. на PEOPLE_MAX; нет — 0)
//  - audioLow:     энергия НЧ (20–250 Гц) 0..1
//  - audioMid:     энергия СЧ (250–2000 Гц) 0..1
//  - audioHigh:    энергия ВЧ (2000–8000 Гц) 0..1
//  - audioKick:    транзиент НЧ (EMA-фильтр kick-детектора) 0..1
export type DriverKind =
  | "none" | "openness" | "pinch" | "roll" | "handsDist"
  | "motionEnergy" | "faceX" | "faceY" | "peopleCount"
  | "audioLow" | "audioMid" | "audioHigh" | "audioKick";

// Привязка параметра к драйверу: value = lo + (hi-lo)*shape(driver). Для цвета lo/hi не нужны
// (цвет лерпится между colorA и colorB по shape(драйверу)). smooth — темпоральное сглаживание
// (0 = мгновенно за сигналом, ~0.95 = очень плавно нарастает/спадает). curve — нелинейный
// отклик (Math/Remap на проводе, TD): −1 ease-out (быстро в начале) … 0 линейно … +1 ease-in.
// Привязка параметра к сигналу. `driver` — сырой драйвер (DriverKind). `signal` (фаза C-Math) —
// опц. хендл Math-оп-ноды ("op:"+id): если задан, значение берётся из цепочки Field-нод, а не из
// сырого драйвера. Пусто/нет signal -> поведение прежнее (резолв = d[driver]) — аддитивно, без риска.
export interface ParamBinding { driver: DriverKind; signal?: string; lo: number; hi: number; smooth?: number; curve?: number }

// Оп-нода = Field→Field узел (конвертер сигнала). T1 Field-алгебра: семейство РАЗНЫХ нод по смыслу
// (Math/Constant/MapRange/Compare/LFO…), а не мега-нода — `op` дискриминирует ВИД ноды (как LayerKind),
// каждая со своими полями (реестр OP_DEFS в drivers.ts) и своим резолвом в resolveSignal. Все выходы
// нормированы clamp01 (конвенция Field 0..1). `input` — хендл входа A (сырой драйвер DriverKind ИЛИ
// "op:"+id — цепочка Field-нод); для 0-входных нод (const/lfo/random/noise) = "none". `input2` —
// хендл входа B (только Mix). Параметры — надмножество (каждый вид читает свои). Живут в LayeredConfig.opNodes.
//  • math:     out = gain·shapeT(in,curve) + offset
//  • const:    out = value (источник-константа, без входа)
//  • mapRange: out = remap(in, inLo..inHi → outLo..outHi) [clamp] с нелинейностью curve
//  • compare:  out = smoothstep(threshold±width, in) [invert] — гейт/порог
//  • lfo:      out = lo + (hi-lo)·wave(t·rate) — анимированный сигнал (время, без входа)
//  • random:   out = EMA-сглаженное случайное значение, обновляется с частотой rate Гц
//  • mix:      out = lerp(A, B, t) — смешать два входа с весом t
//  • noise:    out = FBM value-шум по времени (freq·octaves·seed)
//  • ramp:     out = кусочно-линейный lookup по stops[] (x→y)
// T1-3 per-element источники (OP_DEFS[..].element — значение НА ТОЧКУ, считается потребителем
// над его PointSet через ElementCtx; в скалярном контексте дают фолбэк — см. evalOp):
//  • position: out = координата точки по оси axis (x|y|z, норм. 0..1)
//  • index:    out = i/(n-1) — нормированный градиент по порядку точек
//  • readAttr: out = атрибут точки по имени (attrName; comp — компонента векторного)
//  • randomPt: out = hash(id точки ?? индекс, seed) — стабильный случайный на точку
export type OpKind = "math" | "const" | "mapRange" | "compare" | "lfo" | "random" | "mix" | "noise" | "ramp" | "lag"
  | "position" | "index" | "readAttr" | "randomPt";
export interface OpNode {
  id: string;
  op: OpKind;
  input: string;        // вход A (драйвер / "op:"+id / "none")
  input2?: string;      // вход B — только Mix (хендл 2-го Field-входа)
  gain?: number; offset?: number; curve?: number;                                 // math
  value?: number;                                                                 // const
  inLo?: number; inHi?: number; outLo?: number; outHi?: number; clamp?: boolean;  // mapRange
  threshold?: number; width?: number; invert?: boolean;                           // compare
  rate?: number; wave?: string; lo?: number; hi?: number;                         // lfo + random(rate)
  smooth?: number;                                                                // random: EMA лаг
  freq?: number; octaves?: number; seed?: number;                                 // noise
  t?: number;                                                                     // mix: вес B
  stops?: { x: number; y: number }[];                                             // ramp: lookup-таблица
  attack?: number; release?: number;                                               // lag: атака/спад (секунды)
  axis?: string;                                                                   // position: ось x|y|z
  attrName?: string; comp?: number;                                                // readAttr: имя атрибута + компонента вектора
}

export type ModifierKind = "lines" | "splat";

// LEGACY: модификатор как ВЛОЖЕННЫЙ в слой эффект (старая модель до Фазы 3 #2). Теперь
// эффекты — top-level ноды (EffectNode ниже). Тип оставлен только для чтения старых
// пресетов при миграции (layerMigrate.drainModifiers); новый код его не создаёт.
export interface ModifierInstance {
  id: string;
  kind: ModifierKind;
  enabled: boolean;
  params: Record<string, number | string | boolean>;
  bindings?: Record<string, ParamBinding>;
}

// Эффект — top-level нода-потребитель точек (Фаза 3 #2). В отличие от LEGACY-модификатора
// не вложен в слой: `source` — хендл продюсера точек (= вид слоя-продюсера, см. pointSources),
// «self» больше нет. Множественный: эффектов может быть сколько угодно, в любом порядке.
export interface EffectNode {
  id: string;
  kind: ModifierKind;
  enabled: boolean;
  // T0c: хендл продюсера точек = id СЛОЯ-инстанса (не вид) — поэтому два scatter-инстанса
  // адресуются раздельно. Старые конфиги (source=вид) мигрируются в id (migrateSourceRefs).
  source: string;
  params: Record<string, number | string | boolean>;
  // Привязки параметров к драйверам (ключ = имя поля params: "width"/"maxLinks"/"colorA").
  bindings?: Record<string, ParamBinding>;
}

// Глобальные (не привязанные к одному эффекту) поля: источник, темп, depth-ресурс,
// камера, общие для людей цвета/градиенты. Держим список в одном месте — по нему
// resolveConfig переносит глобалы, а pickGlobals их вычленяет.
export const GLOBAL_FIELDS = [
  "videoUrl", "fpsCap", "hideVideo", "shaderFxOrder",
  "depthEveryNthFrame", "depthResolution",
  "depthSmoothMode", "depthSmoothAlpha", "depthMotionBoost", "depthDeadband",
  "cacheEnabled", "cacheResolution", "cacheFps",
  "depthScale", "frontLock",
  "compositeOrder", "compositeBlend",
  "particlesEnabled",
  "depthEnabled", "pointSize", "pointSquare",
  "maxFaces", "faceSmooth",
  "peopleColor", "peopleColor2", "peopleFillGradient", "peopleFillOpacity", "peopleFillOpacity2",
  "peopleOutlineColor", "peopleOutlineColor2", "peopleOutlineGradient", "peopleGradientByInstance",
] as const;

export type GlobalKey = (typeof GLOBAL_FIELDS)[number];

// === T0e GraphDoc: явные рёбра графа (ARCHITECTURE §3.5.3 / §3.6.9 T0e) ===
// Ребро — ОДНА сущность вместо четырёх ad-hoc каналов (effect.source / shaderFxOrder /
// bindings / setAttrSignal). Нод-сет ВЫВОДИТСЯ из сущностей (instance-id модель T0c):
// id ноды = id слоя/эффекта/оп-ноды; спец-ноды "video" (корень) и "screen" (сток);
// "sig:<kind>" — фолбэк-нода сигналов продюсера, чей слой не добавлен (напр. "sig:audio").
// pos — позиции нод в графе (персист раскладки). Легаси-каналы зеркалируются при правке
// рёбер (читаемость экспорта/back-compat), но при расхождении РЕБРО ПОБЕЖДАЕТ (applyGraph).
export interface GraphEdge {
  from: { node: string; out: string }; // out: "video"|"depth"|"cloud"|"points"|"out"|<сигнал>
  to: { node: string; in: string };    // in: "video"|"depth"|"points"|"in"|"b"|"field"|<параметр>
}
export interface GraphDoc {
  edges: GraphEdge[];
  pos: Record<string, { x: number; y: number }>;
}

// Документ-конфиг приложения: глобалы (та же типизация, что в SceneConfig) + слои +
// top-level эффекты (Фаза 3 #2). effects — ноды-потребители точек поверх продюсеров.
// graph (T0e) — явные рёбра + позиции; отсутствует только у старых пресетов (merge синтезирует).
export type LayeredConfig = Pick<SceneConfig, GlobalKey> & {
  layers: Layer[]; effects: EffectNode[]; opNodes?: OpNode[]; graph?: GraphDoc;
};

// Результат инференса глубины, который воркер шлёт в основной поток.
export interface DepthFrame {
  data: Uint8Array; // grayscale, length = width*height
  width: number;
  height: number;
}

// Точка трекинга/constellation: позиция + признак активности (для фейк-трекинга).
export interface FeaturePoint {
  x: number;
  y: number;
  strength: number; // 0 = ячейка без фичи (точка «спит»)
}

// Бокс движущегося объекта (нормированные координаты 0..1).
export interface MotionBox {
  x: number;
  y: number;
  w: number;
  h: number;
  activity: number; // 0..1
}

// Всё, что vision-воркер отдаёт за один кадр.
export interface VisionResult {
  boxes: MotionBox[];
  features: FeaturePoint[]; // фиксированная длина (по одной на ячейку сетки)
}

// Лицо-бокс (MediaPipe FaceDetector). Координаты нормированы 0..1.
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  keypoints: { x: number; y: number }[];
}

// Сетка лица (MediaPipe FaceLandmarker): точки + рёбра контуров (нормированы).
export interface FaceMesh {
  points: { x: number; y: number }[];
  edges: number[]; // плоский список пар индексов
}

export interface FaceResult {
  boxes: FaceBox[];
  meshes: FaceMesh[];
}

// Результат сегментации людей: RGBA-маска в proto-разрешении (цвет инстанса + альфа-
// покрытие) + линейный маппинг proto->видео для обратного letterbox в шейдере.
export interface PeopleBox {
  x: number; y: number; w: number; h: number; // нормированные 0..1 координаты видео
  score: number;
}

export interface PeopleFrame {
  data: Uint8Array; // RGBA, length = width*height*4
  width: number; // proto W (напр. 160)
  height: number; // proto H
  mul: [number, number]; // множитель video_uv -> mask_uv
  off: [number, number]; // смещение
  count: number; // число найденных людей
  boxes: PeopleBox[]; // bbox каждого человека (нормированные) — для оверлея
}

// Результат гладкой сегментации (MediaPipe Selfie): одноканальное покрытие 0..255
// в разрешении входа (letterbox-квадрат) + маппинг для обратного letterbox в шейдере.
export interface PeopleSegFrame {
  data: Uint8Array; // coverage 0..255, length = width*height (один канал)
  width: number;
  height: number;
  mul: [number, number];
  off: [number, number];
}

// === Трекинг рук (MediaPipe HandLandmarker) ===
// Одна точка руки: нормированные 0..1 координаты кадра + относительная глубина z.
export interface HandLandmark { x: number; y: number; z: number; }

export type HandGesture = "open_palm" | "fist" | "pinch" | "point" | "victory" | "none";

// Готовые показатели руки для эффектов. Координаты нормированы 0..1, rotation — радианы.
export interface HandPose {
  palmCenter: { x: number; y: number }; // центр ладони (среднее точек 0,5,9,13,17)
  palmNormal: { x: number; y: number; z: number }; // нормаль ладони (cross двух векторов на ладони)
  rotation: { roll: number; pitch: number; yaw: number }; // ориентация руки
  openness: number; // 0..1 раскрытость (сумма дистанций кончиков от ладони)
  pinch: number; // 0..1 щипок (нормированная дистанция точек 4<->8)
  fingertips: { x: number; y: number }[]; // 5 кончиков [thumb, index, middle, ring, pinky]
}

// Одна рука после нормализации: ландмарки + поза + жест. Две руки = два таких объекта.
export interface Hand {
  handedness: "Left" | "Right";
  score: number;
  landmarks: HandLandmark[]; // 21, норм. координаты кадра (для отрисовки на SVG)
  worldLandmarks: HandLandmark[]; // 21, метрические относительно центра ладони (для углов/3D)
  pose: HandPose;
  gesture: HandGesture;
}

// Всё, что useHands отдаёт за один кадр (0..2 руки).
export interface HandResult { hands: Hand[]; }
