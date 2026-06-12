# CLAUDE.md — конвенции проекта

Реалтайм-обработчик видео на WebGL в эстетике камер видеонаблюдения. Источник кадров —
файл / поток с телефона (WebRTC) / Kinect. Поверх видео — слои эффектов с модификаторами.

Этот файл — **конвенции текущего кода**. Целевая архитектура, принципы производительности,
модель данных, словарь операторов и дорожная карта — в [ARCHITECTURE.md](ARCHITECTURE.md).
При нетривиальных изменениях сверяйся с ним и держи оба документа в согласии.

## Два режима рендера (`config.renderMode`)

- **flat (по умолчанию, база):** кадр как полноэкранная текстура + дешёвые 2D-эффекты
  на одном GPU-шейдере (тепловизор/ИК, Sobel-обводка, пиксель-арт/ASCII по глубине,
  маски людей) + векторные оверлеи (движение, лица, руки, constellation-сетка).
  Не требует ни WebGPU, ни нейронок для базы — работает в любом браузере на 60 fps.
- **cloud:** облако точек из карты глубины (Depth Anything V2, WebGPU) + эффект-сканер по Z.
  Опционально `composite` — flat-2D и облако-3D на двух канвасах-сиблингах. **T3 Composite:** порядок
  (что-над-чем, `compositeOrder`) и режим смешивания (`compositeBlend` = CSS mix-blend-mode) задаются
  глобалами/нодой Композит, НЕ захардкожены (закрыта жалоба #3 «облако всегда сверху»).

Принцип: вся «база» (flat) не зависит от тяжёлых нейронок и заводится сразу;
глубина — опциональный режим сверху.

## Два главных принципа (детали — ARCHITECTURE.md §0)

1. **Разделение частот.** Рендер (Three.js, шейдеры) идёт на 60 fps. Тяжёлое (нейронки, CV)
   НЕ считается каждый кадр — на своей, более низкой частоте (воркеры / детекторы вне
   `useFrame`), рендер переиспользует последний результат из `ref`. **Никогда не вызывай
   инференс синхронно в `useFrame`.** Управление частотой — `config.depthEveryNthFrame`,
   `config.peopleEveryNthFrame`, busy-флаги воркеров, троттлинг по timestamp, `core/scheduler.ts`.
2. **GPU-resident: не гонять per-element через CPU/DOM каждый кадр.** Самое дорогое — границы
   GPU↔CPU и «поэлементная раздача». Замер (ARCHITECTURE §2) показал: текущий лаг = SVG-оверлеи
   (`innerHTML` по каждой точке) + синхронный MediaPipe на главном потоке; сам WebGL-рендер
   почти бесплатен. **Новые оверлеи — off-DOM, гибридно:** `Canvas2D` для мало-элементных
   стилизованных (руки/лица/HUD — см. `HandsOverlay.tsx`), WebGL-геометрия для масштабных
   (constellation/частицы) и 3D. **Никогда не читай `clientWidth`/layout в rAF-цикле** —
   форсирует reflow (layout-thrash); кешируй размер через `ResizeObserver`. Из SVG-оверлеев
   остался только `Constellation3D` (остаток P1, см. ARCHITECTURE §3/§7).

## Система слоёв (текущая модель данных)

Конфиг — `LayeredConfig` (`core/types.ts`): глобальные поля + массив **слоёв** + массив
**эффектов**. Слой = `{ kind, params: Partial<SceneConfig> }`; эффект (top-level нода) =
`{ id, kind, enabled, source, params, bindings? }`. `resolveConfig` сворачивает слои в
плоский `SceneConfig`, который читает весь рендер (движок про слои/эффекты не знает).

- **Слой** (`core/layerRegistry.ts`) — продюсер: эффект-шейдер или источник точек
  (движение/лица/руки/боксы/облако).
- **Эффект** (`EffectNode`, реестр в `core/modifierRegistry.ts`) — **top-level**
  потребитель точек (сейчас «линии»), НЕ вложен в слой. `source` — хендл продюсера точек
  (= вид слоя-продюсера); рисуется `ui/ModifierOverlay.tsx` по `config.effects`. Старые
  пресеты с вложенными `layer.modifiers[]` мигрируются в `effects[]`
  (`layerMigrate.drainModifiers`, backward-compat).
- **Драйвер** (`core/drivers.ts`) — биндинг сигнала (энергия движения/жест) на параметр.
  В графе (принцип 2 «wire vs reference») это **ссылка** — пунктир-провод от ноды «Сигналы рук»
  (Field/жёлтый) к ref-входу параметра эффекта, отдельно от **потоков** (сплошной провод
  points/map). Список биндабельных полей — `MODIFIER_DEFS[kind].bindable` (эффекты) ИЛИ
  `LAYER_DEFS[kind].bindable` (числовые params shader-FX — direction A, хелпер `layerBindable`);
  создание/снятие ссылки в графе пишет/чистит `EffectNode.bindings[field]` ИЛИ `Layer.bindings[field]`
  (в паритете с `BindingRow` инспектора). Нормализация field-рёбер в bindings — общий `bindingsFromEdges`
  (graphDoc); shader-биндинги резолвятся в кадре в `FlatView.applyFxBindings` (рефы сигналов через
  `FxDriverRefs`-проп App→Scene→FlatCanvas→FlatView; тот же `drivenValue`/EMA, что у `ModifierOverlay`).
  **Новый биндабельный param shader-FX = запись числового (range) поля в `LAYER_DEFS[kind].bindable`.**
  Сигналы — не только руки: `DRIVER_GROUPS` группирует их по нодам-источникам («Сигналы рук»,
  «Движение · энергия», «Лица · центроид», «Люди · число») — это Reduce'ы любых продюсеров
  (`motionEnergy`/`faceCentroid`/`peopleCountNorm`), работают без рук. Ссылка несёт Remap: `lo/hi`
  диапазон + `curve` нелинейный отклик (ease-in/out, `drivers.shapeT`) + `smooth` лаг. `computeDrivers(DriverSources)`
  берёт тот же DataBus-вход, что и точки. Новый драйвер = запись в `DriverKind` +
  `DRIVER_OPTIONS`/`DRIVER_SIGNALS`/`DRIVER_GROUPS` + расчёт-Reduce в `computeDrivers`. **Math (фаза C):**
  оп-нода Field→Field (`OpNode` в `config.opNodes`, `out=clamp01(gain·shapeT(in,curve)+offset)`); `binding.signal=
  "op:"+id` направляет резолв в цепочку, `resolveSignal` тянет сырой драйвер ИЛИ Math-цепочку (аддитивно).
  **Field-алгебра:** `OpNode.op` = `OpKind` (вид ноды, НЕ мега-нода) — реестр `OP_DEFS` (drivers.ts, как
  `MODIFIER_DEFS`: метка/число входов 0|1|2/поля-крутилки/дефолты), `evalOp` считает по виду (все выходы
  clamp01). Виды в коде: Math·Constant·MapRange·Compare·LFO·Random·Mix·Noise·Ramp·Lag. Граф: одна `OpControl`
  (data-driven), палитра «Поле/Сигнал» — пункт на вид. **Новая Field-нода = запись в `OP_DEFS` + case в
  `evalOp` + пункт палитры (без других изменений).**
  **Per-element поля (T1-3):** поле = значение на ТОЧКУ. `FieldFn=(ElementCtx{i,n,group})=>number`;
  `compileFieldFn(handle,…) → {perElement, value, fn?}` — цепочка БЕЗ element-источников = скаляр прежним
  путём байт-в-байт (быстрая ветка `data.fill`), с ними = замыкание (вычисляет потребитель над СВОИМ
  PointSet; материализация = SetAttr). Element-источники (`OP_DEFS[..].element`): Позиция/Индекс/Атрибут/
  Random-на-точку (стабилен по атрибуту `id`, который пишут hands/faceMesh/scatter). Стейт-ноды (Lag/Random) —
  uniform-БАРЬЕРЫ: prepass-кеш `uniformCache`, один шаг стейта на потребителя на кадр; `lag(element)`
  деградирует к uniform. Скомпилированные входы текут потребителем через `PointResultRefs.layerFieldFns`
  (generic-цикл по `LAYER_DEFS[kind].fieldInputs`). **Selection — это ВХОД** ("sel", 0..1, "none"=все):
  setAttr/transform лерпят к прежнему/исходному по sel_i; бинарность — Compare на проводе. **Новый
  element-источник = OP_DEFS(element:true) + case в evalOp + палитра; новый field-вход конвертера =
  запись в `LAYER_DEFS[kind].fieldInputs` + чтение param в `*ToField` (graphDoc/GraphView — data-driven).**
- **Мультиэкземпляр (instance-id, T0c):** `resolveConfig` НЕ схлопывает мультивиды (shader-FX и конвертеры
  scatter/sample/setAttr) в плоские поля — эмитит per-instance массивы на `SceneConfig`: `fxChain:
  ResolvedFxPass[]` (FlatView гонит проходы, uniform'ы из `pass.params`) и `producers: ResolvedProducer[]`
  (резолвер `fieldForLayerId(ref,…)`: `ref` = id слоя ИЛИ вид для back-compat). `shaderFxOrder: string[]` —
  id слоёв. Детекторы/оверлеи — single-instance (ML-хуки по одному). **Новый мультивид = снять `singleton`
  в LAYER_DEFS + (shader) поля в `fxChain`-ветке FlatView / (продюсер) ветка в `fieldForLayerId`.**
  **Wiring-поля:** параметр, который пишется ПРОВОДОМ графа без контрола в инспекторе, обязан быть в
  `LAYER_DEFS[kind]` — в `convertInputs` (points-вход), `fieldInputs` (Field-вход: сигнал/selection, T1-3)
  или `wiringFields` (прочее) — иначе `paramFields()` выкинет его из `producers[].params` и рендер
  молча проигнорирует провод.

Это уже фактически граф (продюсер → эффект → экран); нод-редактор (`ui/GraphView.tsx`) —
проекция поверх той же модели. Ноды-сигналы несут живой CHOP-вьюер (`SignalMeters`): полоска+число
на канал, обновление на rAF по DOM-ref (без React-ререндера, §0.2; рефы продюсеров → `GraphView`).
**T-Debug:** каждая PointSet-нода несёт `PointMeters` — live кол-во точек/групп/атрибутов + disclosure
«▸ точки» → мини-спредшит первых ~12 точек (idx·x·y·атрибуты; читает общий `statsRef`-кеш GraphView,
throttled-rAF `fieldForLayerId` из DataBus: рефы + `depth` + `resolved.producers`, пропы App→GraphView). Эффект-ноды несут контрол действий (`NodeActions`: ⏻ дизейбл / ✕ удаление). Каждый 2D-шейдер-эффект
(тепловизор/sobel/scanlines/pixelate/pixelArt) — ОТДЕЛЬНАЯ `map→map` нода (B5), чейнятся
`Видео.видео → … → Экран.видео`; на ноде `NodeActions` (⏻ вкл/выкл слоя · ✕ убрать из цепочки),
клик → крутилки в инспекторе (`onToggleShaderFx`/`onSelectShaderFx`, `nodeToShaderFx`). Список нод
data-driven по `LAYER_DEFS[k].domain==="shader"` (`SHADER_FX_KINDS`). **Рёбра цепочки авторитетны:**
обход `Видео→FX→…→Экран` пишет `config.shaderFxOrder`, `FlatView` строит проходы в этом порядке
(`computeFxOrder`/`writeFxOrder`/`onSetShaderFxOrder`). Полная дорожная карта — в ARCHITECTURE.md.

## Карта файлов

**Ядро / конфиг:**
- `core/types.ts` — `SceneConfig` + `LayeredConfig` (единый источник правды по параметрам).
  **Новый параметр = поле здесь + контрол в UI + чтение в шейдере/рендере + (если слойный) в `layerRegistry`.**
- `core/layerRegistry.ts` (слои; `wiringFields` — параметры-провода без контрола) ·
  `core/modifierRegistry.ts` (эффекты, `makeEffect`) · `core/drivers.ts` (драйверы + `OP_DEFS`/`evalOp`).
- `core/mapSources.ts` — **CPU-резолвер Map2D-нод (T5 v2 Phase B, зеркало pointSources):** `mapForRef(ref,
  {depth,mapNodes,time})` рекурсивно разворачивает цепочку `noise2d`/`mapCombine` в кадр-карту
  (DepthFrame-форма, WORK=128); `mapChainNeedsDepth` (App.depthActive). Домен `map2d` — CPU-карты для
  particle/scatter (низкая частота, НЕ GPU-FBO-путь). **Новая Map2D-нода = LAYER_DEFS(domain map2d,
  mapInputs) + ветка в mapForRef + поля SceneConfig.** Резолвится в `resolveConfig.mapNodes`.
- `core/pointSources.ts` — продюсеры точек (`PointField`) + DataBus-резолвер `fieldForKind` +
  `PRODUCER_ENABLE` (продюсер→флаги для авто-активации). **Конвертеры (фаза C):** `scatterToField`
  (Map2D(глубина)→PointSet — «точки из глубины») + `sampleToField` (PointSet×Map2D→PointSet — сэмплит
  глубину в `value` точек продюсера `sampleSource`); входы `depth`/`scatter`/`sample` в `PointResultRefs`.
  **T2-3 PointSet→PointSet:** `transformToField` (сдвиг/масштаб/поворот вокруг pivot) · `mergeToField`
  (A+B, B опц.) · `sortToField` (по атрибуту, ремап links). **Trail (первый STATEFUL-конвертер):**
  `trailToField` — хвост позиций точки по стабильному `id`; история в МОДУЛЬНОЙ `trailState`-карте +
  `frameTick`-барьер в `PointResultRefs` (ModifierOverlay шагает раз в кадр; снапшот-потребители без
  tick НЕ мутируют стейт). Выход — chain-полилинии с pscale-таперингом (рисует `drawLines`). **Новый
  stateful-конвертер = модульный стейт + frameTick-барьер.** **Split (Group/Split-по-полю, stateless):**
  `splitToField` — фильтр точек в группе по per-element полю (`splitField`, fieldInputs) vs порог
  (`splitKeep` above/below); ремап links/attrs/values (как sort). Инверсия = вторая нода. **Convert-входы data-driven:**
  `LAYER_DEFS[kind].convertInputs:{in,param,optional?}[]` — graphDoc (`synthesize`/`applyGraph`/
  `edgeForLayerParam`/`mirrorGraphToChannels`), `paramFields`, `layerWiringParams`, App.setParams и GraphView
  buildEditor обходят его вместо хардкода sample/setAttr. **Новая PointSet→PointSet нода = `LAYER_DEFS`(convertInputs) +
  `*ToField` + case в `fieldForLayerId` + пункт палитры — БЕЗ правок graphDoc.** **Генераторы (U/2026-06-11):**
  `gridToField` — ПЕРВЫЙ 0-входовый генератор (процедурная сетка, стабильный id=row·cols+col, детерм.
  джиттер; живёт БЕЗ видео — аналог стартовой сетки TD). **`pointForceToField` («Силы (точки)», U0 —
  направление U §3.6.13 «частицы=точки»):** ВТОРОЙ stateful-конвертер (шаблон Trail: `pfState` {p,v,age}
  по id + frameTick-барьер) — CPU-солвер сил над ЛЮБЫМ PointSet в паритете с GPU-Force (переиспользует
  ТЕ ЖЕ `force*`-params: гравитация/curl|turbulence/drag/границы) + `pfStrength`/`pfLife` (респавн на
  источник). «Форсы на облако» = `глубина→Scatter→Силы(точки)→…`. **ГОЧА producerMapIn (баг 2026-06-11):**
  конвертер, забытый в хардкод-списке, гейтился ФАНТОМНЫМ ребром Видео→.video → молча выключен; теперь
  data-driven (`convertInputs.length>0 → null`) — новые конвертеры обходятся без правки graphDoc.
- `core/layerMigrate.ts` — `resolveConfig` (слои→`SceneConfig`) + миграция старых конфигов и
  `modifiers[]`→`effects[]`. **Авто-активация зависимостей:** включённый эффект форс-поднимает свой
  `source`-продюсер и продюсеров своих драйверов (`PRODUCER_ENABLE`/`driverProducer`) — провод/ссылка
  «оживляет» детектор без ручного включения слоя.
- `core/presets.ts` — автосейв + именованные пресеты (localStorage) + экспорт/импорт JSON.
- `core/depthCacheStore.ts` — кеш глубины в IndexedDB.
- `core/VideoSource.ts` — `<video>` + покадровый колбэк (requestVideoFrameCallback).
- `core/perf.ts` — лёгкий профайлер (`__perf` в DEV).

**Рендер:**
- `render/Scene.tsx` — компоновщик: flat / cloud / cloud+composite. **T3 Composite:** чистая
  `compositeLayout(order, blend)` решает z-порядок + `mixBlendMode` верхнего канваса + `transparent`
  облака; `FlatCanvas`/`CloudCanvas` несут проп `blendMode`→`style.mixBlendMode`. `.stage{isolation:isolate}`.
- `render/FlatCanvas.tsx` · `render/CloudCanvas.tsx` — `<Canvas>`-обёртки.
- `render/flatShader.ts` — GLSL flat-quad: тепловизор + Sobel + пиксель-арт/ASCII + маски. **Фаза B
  (распил мега-шейдера):** ВСЕ 5 2D-FX извлечены как отдельные `map→map` проходы (`thermalPassFragment`,
  `sobelPassFragment`, `pixelArtPassFragment`, `scanlinesPassFragment`, `pixelatePassFragment` — B1–B4);
  сэмплят вход `uTex` в `vUv` (без fit), чейнятся; мега = только композит (маски/splat/виньетка/bloom).
- `render/FlatView.tsx` — fullscreen quad, проброс uniform'ов, bloom-проход, текстуры масок/глубины.
  **Движок цепочки FBO-проходов (B):** ping-pong `fxRTA/fxRTB` + сцена-quad `fxChain` гоняют ВСЕ извлечённые
  FX (thermal→sobel→scanlines→pixelate→pixelArt) ДО мега-шейдера, выход → мега `uTex`; `uTexel` каждого
  прохода = 1/размер ЕГО входа. Мега `uThermal/uSobel/uScanlines/uHasDepth/uPixelArt=0`. **Порядок
  проходов = `config.shaderFxOrder`** (рёбра графа авторитетны, B-edge: обход цепочки пишет порядок).
- `render/scanShader.ts` · `render/PointCloud.tsx` — облако точек + сканер по Z.
- `render/ScanAscii3D.tsx` — ASCII-частицы в 3D. `render/FpsLimiter.tsx` — кап fps.
- **T5-СПАЙК GPU-частиц (`three/webgpu`+TSL, ИЗОЛИРОВАН от ядра):** `render/particles/ParticleSpike.ts` —
  императивный класс (свой `WebGPURenderer`+canvas+rAF, НЕ R3F: WebGPURenderer не умеет `ShaderMaterial`,
  поэтому flatShader/FBO НЕ мигрируем) · `render/ParticleCanvas.tsx` — React-обёртка (box-демо-фолбэк при
  `particlesEnabled` + 0 particle-цепочек). **WebGPU целиком; WebGL2-фолбэк: compute да, рендер из storage — нет.**
- **T5 v2 — СИСТЕМА particle-нод (Phase A ✅, GPU-домен, сокет `particles` оранжевый):**
  `render/particles/ParticleSystem.ts` — ОДНА независимая система (SoA `instancedArray` pos/vel/data/color;
  силы компилируются в TSL по `forces[]`, цвет по `pcolorMode`; **params=uniforms**, пересборка TSL только на
  смену `structureKey`; спавн из CPU через DataTexture, Cd-тинт) · `ParticleField.ts` — менеджер (ОДИН
  `WebGPURenderer`+ortho-frontLock-камера+rAF, диффит `particleSystems[]`, ОДИН `render` N Points, адаптивный
  бюджет делит население, dispose всех систем/буферов/рендерера) · `render/ParticleFieldCanvas.tsx` — обёртка +
  мост CPU→GPU (emitter.points через `fieldForLayerId`+`PointResultRefs` как ModifierOverlay, throttle ~12Гц).
  Ноды `emitter`/`force`/`particleColor`/`particleLight`/`particleRender` — `domain:"particle"` в LAYER_DEFS (НЕ в LAYER_ORDER,
  из палитры «Частицы»). **Pull-модель:** рисуется только цепочка до терминала `Render`;
  `resolveConfig.buildParticleSystems` обходит particles-рёбра pull-от-Render → `SceneConfig.particleSystems`
  (как `fxChain`); particle-слои исключены из any2D/any3D (не флипают composite). Монтаж АВТО ПО ГРАФУ
  (`particleSystems.length>0 && particlesEnabled`; флаг авто-вкл при add particle-ноды + мастер-рубильник).
  **Новая particle-нода = LAYER_DEFS(domain particle) + поля в SceneConfig + ветка в buildParticleSystems +
  ветка в ParticleSystem (сила/цвет).** **A-часть-2 ✅:** map-вход (`Видео.глубина→Emitter.map`; ParticleSystem
  держит фикс 256×256 R8-карту, TSL 4-сэмпл max-density + порог `emitterMapThreshold`; `App.depthActive`
  поднимает depth при particle-map) · orbit-камера (`ParticleField.setFrontLock` ortho↔OrbitControls,
  ведётся `config.frontLock`; канвас включает pointerEvents при unlock). **ParticleLight (2026-06-12):**
  нода «Свет (частицы)» — прожектор (позиция/цвет/интенсивность/угол/спред/размер/тень/ambient) с
  НАСТОЯЩИМ самозатенением, **darkroom-модель** (цвет = АЛЬБЕДО × освещённость; ambient=0 → вне луча
  ЧЁРНОЕ). ParticleField владеет ОДНИМ voxel-гридом плотности 64³ (мир [-2,2]³, atomic u32); все системы
  биннят при любой ноде Света (`binActive` через needsRestructure → кросс-системные тени). **Тень — в
  ОТДЕЛЬНОМ compute-проходе** (`buildLightPass`/`lightPass`, ПОСЛЕ биннинга всех систем, ПЕРЕД render):
  раз на ЧАСТИЦУ марчит грид к свету (ТРИЛИНЕЙНЫЙ сэмпл — без «лесенки»; отступ uLSelf — не тенит себя;
  blur по спреду = мягкость; Beer exp(-σ·density)) → per-particle `litBuffer`; материал лишь читает
  litBuffer (дёшево). **УРОК: per-particle марч/освещение — в COMPUTE (atomicLoad валиден, раз на
  частицу), НЕ в материале (per-vertex дорого + atomic read в vertex невалиден по WGSL).** Все ручки =
  uniforms, structureKey += наличие Света; WebGL2 → свет без тени. ОТЛОЖЕНО → v2: ParticleColor
  field-вход · наследование `v`. Спек — ARCHITECTURE §3.6.12.

**ML / CV (разделение частот):**
- `ml/useFrameGrab.ts` — ОДИН грабер кадра (`SharedFrame`): одна выемка `<video>→CPU-канвас` на
  кадр, общая для vision/seg/people (рисуют из неё CPU→CPU, дёшево). CPU-детекторы берут
  `SharedFrame`, НЕ `<video>`. faces/hands — мимо (MediaPipe грузит видео на GPU сам).
- `ml/visionWorker.ts` + `ml/useVision.ts` — чистый JS: разница кадров → боксы движения + точки.
- `ml/useFaces.ts` — MediaPipe FaceDetector + FaceLandmarker (сетка 468 точек), main-thread вне `useFrame`.
- `ml/useHands.ts` + `ml/handModel.ts` + `ml/handTopology.ts` — MediaPipe HandLandmarker + жесты.
- `ml/peopleWorker.ts` + `ml/usePeople.ts` — YOLOv8-seg (ONNX) маски людей.
- `ml/useSegmentation.ts` — MediaPipe Selfie/DeepLab гладкая маска.
- `ml/depthWorker.ts` + `ml/useDepth.ts` + `ml/depthRouter.ts` — глубина (transformers.js webgpu) + роутинг источника.
- `public/mediapipe/` — wasm + модели локально (same-origin, под COOP/COEP, офлайн).

**Сеть (источники кадров):**
- `net/useCameraStream.ts` — приёмник WebRTC-потока с телефона. `phone.html` + `phone/main.ts` — отправитель.
- `net/useKinect.ts` + `net/kinectProtocol.ts` — Kinect как RGB+depth вход (мост/мок). См. `signaling.ts`, `PHONE_STREAMING.md`.

**UI:**
- `ui/ScenePanel.tsx` — левая панель (источник/глубина/пресеты/кеш/Kinect).
- `ui/Controls.tsx` + `ui/LayersPanel.tsx` + `ui/LayerInspector.tsx` + `ui/AddLayerFlyout.tsx` — правая панель слоёв.
- `ui/controlField.tsx` — generic-контрол поля по спеке из реестра.
- `ui/Overlay.tsx` (движение, constellation2D, лица, боксы людей) · `ui/HandsOverlay.tsx`
  (скелет рук) · `ui/ModifierOverlay.tsx` (эффекты-линии по `config.effects`) — все на **Canvas2D**
  (ResizeObserver, без чтения layout в кадре; `renderLines.drawLines` рисует линии в ctx).
- `ui/Constellation3D.tsx` — ещё `innerHTML` (3D-оверлей, только cloud; остаток P1).
- `ui/SplatMask.tsx` + `ui/renderSplat.ts` — **конвертер Splat (PointSet→Map2D)**: off-DOM растеризация
  форм точек в `THREE.CanvasTexture`, публикуется через `SplatApi`-реф в `flatShader` (uSplat,
  overlay/alpha). Новый конвертер = продюсер-текстуры + uniform в шейдере + проброс App→Scene→FlatView.
- `ui/MapScreenOverlay.tsx` — **полноэкранный ЧБ-просмотр Map2D**: провод `карта → Экран.видео`
  (Видео.глубина / noise2d / mapCombine) рисует CPU-карту вместо видеотракта (Canvas2D, mapForRef
  ~10Гц; `resolved.screenMapRef` выставляет `compileLayered` из ребра; депth будится `mapChainNeedsDepth`).
  Раньше такой провод молча давал чёрный кадр (вход одиночный, видеотракт снят, CPU-карты GPU-цепочка
  не умеет).
- Координаты оверлеев маппятся **тем же фитом, что и шейдер («contain»)** — иначе разъедутся.
  **Частицы соблюдают тот же contain** (`ParticleField.updateCamera`: rect видео = `(±va, ±1)`,
  frustum `W=max(va,ca)`); при активном cloud камера частиц FOLLOW'ит cloud-камеру (`App.cameraRef` →
  `setExternalCamera`, зеркало Y180 — облако смотрит с −Z) — единое 3D-пространство, мышь у облака.

## Конвенции

- Каждый эффект управляется только через `SceneConfig` — без скрытого состояния.
- **ГОЧА three TSL `hash()`:** это PCG от `seed.toUint()` — ЦЕЛОЙ части! Дробные сиды (0..1)
  коллапсируют в 1-2 значения (баг «частицы из 2 точек»). Правило: `hash` — только от целых
  (instanceIndex); дробное — через `h01(x)=hash(x.fract()·2^22)` (ParticleSystem); большие суммы
  (`i·φ+time`) теряют дробь на f32 — композить из дробных слагаемых.
- Параметры прокидываются в `useFrame`/rAF из конфига (живая правка), значения читаются
  из `config.*` каждый кадр.
- Тяжёлое считается не каждый кадр; оверлей читает последний результат из `ref` на rAF и
  не вызывает React-ререндер.
- **Освобождай GPU-ресурсы.** Любые созданные вне R3F-дерева `geometry`/`material`/
  `Texture`/`RenderTarget`/`Scene` должны диспозиться в cleanup-`useEffect` при
  размонтировании и при смене зависимостей (образец — блок cleanup'ов в `FlatView.tsx`;
  закрыто для FlatView/ScanAscii3D/PointCloud/SplatMask, остатки — в реестре ARCHITECTURE §7).
- Новый 2D-эффект-шейдер = uniform в `flatShader.ts` + проброс в `FlatView.tsx` + поле в
  `SceneConfig` + спека слоя в `layerRegistry.ts` + контрол (+ опц. в `LAYER_DEFS[kind].bindable`,
  если числовой param должен драйвиться проводом графа — direction A).
- Новый оверлей = поле в результате продюсера + отрисовка тем же `dims()/map()`-фитом, но
  **на WebGL-геометрию** (инстансы/line-segments, позиции в буфере), не через `svg.innerHTML`.
- **Мануальный ввод значений (T0d):** любой числовой контрол (на ноде — `OpControl`/`MathControl`; в инспекторе —
  `controlField`) = слайдер + **поле ручного ввода** рядом. Числа должны вводиться руками везде, где они есть.

## Развитие

Дорожная карта, треки и история сделанного — **только** в [ARCHITECTURE.md](ARCHITECTURE.md) §3/§3.6.9
(здесь не дублируется). Состояние на 2026-06-11:

- **Сделано:** миграция слои→ноды (A→C) · T0 граф-фундамент (singleton снят, граф-менеджмент, Tab-палитра,
  undo/redo, UX T0d) · T0e GraphDoc+compile+pull · direction A (биндабельные params shader-FX — жалоба #1
  закрыта) · **T3 Composite canvas-level (нода Композит, порядок+blend 2D↔3D — жалоба #3 закрыта, ВСЕ ТРИ
  корневые жалобы закрыты)** · T1-1/T1-2 Field-ноды · T2-1/T2-2 атрибуты+SetAttr · **T2-3 Transform/Merge/Sort
  (PointSet→PointSet конвертеры + генерализация convert-входов `convertInputs`)** · **T-Debug(а,в): `PointMeters`
  (live точки/атрибуты + спредшит-таблица точек на PointSet-нодах)** · **T1-3 per-element поля + selection
  (FieldFn/compileFieldFn, element-источники Позиция/Индекс/Атрибут/Random-на-точку, `fieldInputs`,
  sel-входы setAttr/transform, стабильный `id` hands/faceMesh/scatter — ядро парадигмы)** · **T5-СПАЙК частиц
  (three/webgpu+TSL изолированный прототип: солвер Euler+age-recycle+curl, THREE.Points аддитивно, фичефлаг
  `particlesEnabled`; WebGPU полностью ✓, WebGL2-фолбэк compute✓/рендер✗ — лимит бэкенда; ядро не тронуто)** ·
  **Trail (первый stateful-конвертер: шлейфы точек по id, модульный стейт + frameTick-барьер, chain-полилинии
  с pscale-таперингом, рисует drawLines; graphDoc не тронут)** · **Split (Group/Split-по-полю: stateless-фильтр
  точек по per-element полю vs порог, ремап links; чистый convertInputs+fieldInputs шаблон)**.
- **Направление — §3.6 ПРОЦЕДУРНАЯ НОДА-СИСТЕМА v2** (Houdini/TD/Blender): ноды по смыслу, НЕ мега-ноды;
  enum — только вариации одного действия; границы типов = явные конвертеры. Ревизия плана 2026-06-10 по
  разведке — §3.6.11 (выводы) и memory `node-research-2026-06`.
- **Порядок (§3.6.9):** `T2-3 ✅ → T-Beauty ∥ T-Debug (частично ✅) → T1-3 per-element ✅ →
  T5-спайк частиц ✅ (TSL/WebGPU) → Trail ✅ → Split ✅ → **T5 v2 Phase A ✅ (фундамент + A-часть-2:
  map-вход глубины + orbit) → Phase B Map2D-кит ✅ РАУНД-1 (домен map2d: Noise+Combine, CPU-резолвер
  mapSources, «глубина×нойз→эмит») → 2026-06-11 ✅: **TD/Houdini-аналог живьём** (Grid-генератор ·
  bounds bounce/wrap в Force · цвет видео у частиц (vidTex map-спавна + CPU-сэмпл points) · единая
  камера cloud↔частицы (follow, зеркало Y180) · MapScreenOverlay (карта→Экран) · фиксы: producerMapIn
  data-driven (фантомный video-гейт trail/split), hash01-лавина (drivers) + h01 (ParticleSystem, «2
  точки»), ModifierOverlay без видео, adapt-гистерезис (рейт «не работал» на 60Гц), фит частиц=contain)
  · **U0 ✅ «Силы (точки)»** (направление U §3.6.13 — унификация точек и частиц, установка пользователя)
  · **U1 ✅ 3D-точки сквозь CPU-тракт** (Scatter пишет `z=глубина·scatterZScale` по флагу `scatterZ`;
  `drawLines.map(nx,ny,z?)` проецирует z через камеру облака / fakePerspective, 2D-путь байт-в-байт;
  pointForce интегрирует z; `CloudCamera` зануляет cameraRef в cleanup-эффекте)
  · **U2-a ✅ конвертер Particles→Points** (нода `particlesToPoints`: GPU-популяция→CPU-PointSet через
  `ParticleSystem.readback`/`getArrayBufferAsync` downsample ≤N на ~7Гц; вход `particles`-сокет от
  Render-«отвода»; модульный `particleReadbackStore`; socket-обобщение `convertInputs.socket`; над
  частицами весь CPU-кит Lines/Split/спредшит, z несётся)
  · **U2-b ✅ единая нода «Force»** (`force`-вид ДВОЙНОЙ домен isParticle+isPointProducer; particles-вход
  → GPU-сила, points-вход → CPU-солвер `pointForceToField`; domain particle→nonVisual не флипает any2D;
  GraphView строит force только в particle-проходе +points-сокеты; `pointForce` back-compat вне палитры)
  · **U3-a ✅ Cd сквозь границу GPU→CPU** (Particles→Points readback тянет colorBuffer по флагу `p2pColor`
  → атрибут Cd → цветные Lines; круг «цвет видео→частица→readback→линии» замкнут; pscale/v отложены)
  · **B-раунд-2 Map2D→Scatter ✅** (`scatterMapSource` — Scatter берёт любую Map2D-цепочку, не только глубину;
  `глубина×нойз→Scatter→точки`; аддитивно, сокет "depth" сохранён, дефолт "video" байт-в-байт; резолв
  `resolveProducerMaps`/mapForRef в потребителях через `layerMaps`)
  → СЛЕДУЮЩЕЕ: B-раунд-2 Mask2D (люди→Map2D) ∥ U3-b (pscale/v CPU→GPU, Phase D) ∥ C поверхности
  → D спрайты/группы**`.
  T0e уже ✅. Перф и техдолг §7 — параллельно.
- **T5 v2 — СИСТЕМА, не фичи (установка пользователя 2026-06-10):** Emitter рождает частицы НА ТОМ,
  что воткнули (входы points И map), Force — одна нода с секциями (Гравитация/Шум curl|turbulence/Drag),
  цвет/группы/спрайты — ноды; сокет `particles` (GPU-домен); РЕАЛТАЙМ-инварианты (params=uniforms,
  пересборка TSL только на смену структуры и асинхронно, разделение частот, ноль readback).
  **Полный утверждённый спек — ARCHITECTURE §3.6.12; не делать частичные фичи мимо него.**
  **Phase A ✅ ФУНДАМЕНТ (2026-06-10, Opus, config-reviewer чист по ядру):** сокет `particles`, ноды
  Emitter/Force/Color/Render (`domain:"particle"`), pull-от-Render (`buildParticleSystems`→`particleSystems`),
  мульти-эмиттер Режим 1, движок `ParticleSystem`/`ParticleField` (params=uniforms, пересборка по
  `structureKey`), points-мост, монтаж авто-по-графу. Проверено end-to-end в живом приложении (карта
  файлов — секция «Рендер» выше). **A-часть-2 ✅:** map-вход (`Видео.глубина→Emitter.map`, эмит по
  плотности) + orbit-камера (`config.frontLock`). points-вход работает (scatter/split/hands/SetAttr(Cd)→
  Emitter). **Phase B ✅ РАУНД-1:** домен `map2d` (ноды `noise2d`+`mapCombine`), CPU-резолвер
  `core/mapSources.ts` (`mapForRef`, обобщение `mapInputs`), `resolveConfig.mapNodes` → headline
  «глубина×нойз→эмит» собирается цепочкой. СЛЕДУЮЩЕЕ — B-раунд-2 (превью-нод/Mask/scatter-вход);
  Color-field/`v` → v2.

**Модели по классам задач** (полно — §3.6.10; распределение по агентам — [AGENTS.md](AGENTS.md)): Opus —
архитектура/высокий риск (T0e, движок частиц, per-element, миграции конфига, ревью) · Sonnet — расширение по
готовому шаблону (Field-нода, map→map проход, примитив/сила, T-Beauty/T-Debug) · Haiku — механика. MAIN-цикл
на одной модели; 1М-контекст на everyday выключить.

## Ограничения окружения

- WebGPU обязателен для realtime-глубины; без него фолбэк на WASM (медленно).
- COOP/COEP-заголовки нужны для SharedArrayBuffer / многопоточного onnxruntime
  (`vite.config.ts`, сейчас только dev-сервер — см. техдолг).
- Модель глубины качается с HF hub при первом запуске (нужен интернет), потом кешируется.
- HTTPS — только в режиме телефона (`npm run dev:phone`); подробности в `PHONE_STREAMING.md`.
