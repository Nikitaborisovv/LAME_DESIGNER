# GLITCH_NODES.md — спецификация нод цифрового глитч-дизайна

Документ описывает **новые 2D map→map шейдер-ноды** для трека T-Beauty: **Pixel Sort**,
**Glitch** (с вариантами) и **Displace по цифровым паттернам** — плюс каталог дополнительных
эффектов для цифрового глитч-дизайна с приоритетами.

Это **дизайн-спека**, не реализация. Каждая нода описана так, чтобы её можно было собрать
по готовому шаблону `B1–B8 + T0c` (см. §6 «Шаблон добавления»), не трогая `resolveConfig`,
миграции и типы сокетов (это Opus-класс — `config-reviewer`). Под спеку заточен агент
`fx-pass-builder`.

> **Модель исполнителя:** расширение по готовому шаблону (Field-нода, map→map проход) —
> Sonnet (см. CLAUDE.md «Модели по классам задач»). Pixel Sort с многопроходным состоянием —
> пограничный кейс, может потребовать Opus-ревью (stateful ping-pong, как `feedback`).

---

## 0. Что УЖЕ есть в проекте (чтобы не дублировать)

Цепочка 2D-FX — это отдельные `map→map` проходы (`domain:"shader"`), чейнятся
`Видео.видео → FX → … → Экран.видео` через FBO-движок ping-pong (`fxRTA/fxRTB`) в
`render/FlatView.tsx`. Текущий список извлечённых проходов:

| Нода | kind | Что делает | Параметры |
|------|------|-----------|-----------|
| Тепловизор/ИК | `thermal` | яркость→градиент | `thermalMix`, 2 цвета |
| Sobel-обводка | `sobel` | детектор краёв | strength, color, thickness, tolerance |
| Сканлайны | `scanlines` | синус-затемнение строк | `scanlineIntensity` |
| Пикселизация по глубине | `pixelate` | блоки по Z | near/far, ramp, grid, blur |
| Пиксель-арт / ASCII | `pixelArt` | квантизация + ASCII | size, levels, palette, ascii-mode |
| Lookup-колоризация | `lookup` | палитра-градиент | colors, stops, mix |
| Feedback | `feedback` | автообратная связь (свои RT) | decay, zoom, rotate, offset |
| Kaleidoscope | `mirror` | зеркальные сектора | sectors, angle |
| **Displace** | `displace` | **UV-смещение: noise / self** | amount, scale, speed, mode |
| **Chromatic Aberration** | `chromAb` | **RGB-split: radial / linear** | amount, angle, mode |
| Grain | `grain` | плёночное зерно | amount, size, colored |

**Важные следствия для дизайна новых нод:**

- **RGB-split / хроматическая аберрация уже есть** (`chromAb`, radial+linear). Новая нода
  **Glitch НЕ должна** делать «ещё один RGB-split» как основную фичу — канальный сдвиг в
  Glitch допустим как **под-эффект** одного из режимов (block/slice corruption), но базовый
  чистый RGB-split остаётся за `chromAb`. Их можно чейнить: `Glitch → ChromAb`.
- **Базовый UV-displace уже есть** (`displace`, value-noise + self). Нода **Displace по
  цифровым паттернам** — это его **расширение/брат** с другими картами смещения (блоки,
  voronoi-ячейки, Bayer, scanline, hash-grid). Решение по форме (новая нода vs `displaceMode`-
  enum) — в §3.
- Все три новые ноды — `singleton:false` (мультиэкземпляр T0c): можно поставить две Glitch-ноды
  с разными настройками в одну цепочку.

---

## 1. Нода **Pixel Sort** (`pixelSort`)

### 1.1. Что это и как выглядит

Алгоритмический глитч: внутри строк (или столбцов) находятся **спаны** последовательных
пикселей по порогу (яркость/оттенок/насыщенность), и пиксели внутри спана **сортируются**
по выбранному ключу. Визуально — характерные «потёки»/«дождь» из растянутых цветных полос,
вытекающих из ярких или тёмных областей. Один из самых узнаваемых эффектов цифрового глитча.

Источники: спаны определяются «выделением всех последовательных пикселей под/над порогом
яркости и сортировкой их по свойству (яркость)»; на GPU делается либо настоящим многопроходным
odd-even сортом, либо однопроходной псевдо-аппроксимацией.

### 1.2. Два пути реализации (выбрать ОДИН на старте)

**Путь A — «псевдо-сорт», ОДИН проход (рекомендую для MVP).**
Stateless, идеально ложится на стандартный ping-pong без своих RT (как `scanlines`/`displace`).
Для каждого фрагмента сканируем вдоль оси сортировки фиксированное число выборок (N≈8..16),
ограниченных текущим спаном (по порогам low/high), делаем мини-bubble-sort выборок по ключу
и интерполируем. Это аппроксимация (не идеально точный сорт), но визуально «читается» как
pixel sort и держит 60 fps. По мотивам haxademic `glitch-pseudo-pixel-sorting`.

```glsl
// pixelSortPassFragment (псевдо, один проход)
precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel;          // 1/размер входа
uniform float uAxis;           // 0 = по столбцам (верт.), 1 = по строкам (гориз.)
uniform float uThreshLow;      // нижний порог спана (0..1)
uniform float uThreshHigh;     // верхний порог спана (0..1)
uniform float uSortKey;        // 0=luma, 1=hue, 2=sat
uniform float uReverse;        // 0=по возрастанию, 1=по убыванию
uniform float uMaxSpan;        // макс. длина спана в долях экрана (0..1)
uniform float uMix;            // 0..1 сухой/мокрый
varying vec2 vUv;
float luma(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
float key(vec3 c){ /* по uSortKey: luma / hue / sat */ }
void main(){
  vec2 dir = (uAxis > 0.5) ? vec2(uTexel.x,0.0) : vec2(0.0,uTexel.y);
  // 1) найти границы спана от vUv в обе стороны, пока key в [low,high] и длина < uMaxSpan
  // 2) выбрать N точек вдоль спана, bubble-sort по key (uReverse инвертирует)
  // 3) интерполировать цвет по позиции фрагмента внутри спана
  // 4) mix(orig, sorted, uMix)
  gl_FragColor = vec4(/* result */, 1.0);
}
```

**Путь B — «настоящий» odd-even sort, МНОГОПРОХОДНЫЙ (stateful, как `feedback`).**
Каждый кадр — один шаг сравнения-обмена соседей: по чётности кадра берём пары (2i,2i+1) либо
(2i+1,2i+2), сравниваем по ключу, при нарушении порядка — меняем местами. За несколько кадров
ряд «досортировывается» (bitonic/odd-even). Требует **собственной пары RT** (история кадра) и
swap read/write в конце прохода — точная калька механики `feedback` в `FlatView`. Даёт точный
сорт и «живую» анимацию досортировки, но дороже и сложнее (Opus-ревью).

> **Рекомендация:** стартовать с **Пути A** (один проход, stateless). Поле `pixelSortMode`
> (`pseudo`/`exact`) оставить как точку расширения — Путь B добавить позже, если нужен «настоящий»
> сорт, по шаблону `feedback`.

### 1.3. Параметры (`SceneConfig`)

| Поле | Тип | Диапазон | Контрол | Смысл |
|------|-----|----------|---------|-------|
| `pixelSortEnabled` | bool | — | (enabledField) | вкл |
| `pixelSortAxis` | select | `column`/`row` | SEL | ось сортировки |
| `pixelSortKey` | select | `luma`/`hue`/`sat` | SEL | ключ сортировки |
| `pixelSortThreshLow` | number | 0..1, 0.02 | R | нижний порог спана |
| `pixelSortThreshHigh` | number | 0..1, 0.02 | R | верхний порог спана |
| `pixelSortMaxSpan` | number | 0..1, 0.01 | R | макс. длина потёка |
| `pixelSortReverse` | bool | — | C | инверсия направления |
| `pixelSortMix` | number | 0..1, 0.05 | R | сухой/мокрый |

**bindable** (direction A — драйв сигналом от движения/звука): `pixelSortThreshLow`,
`pixelSortThreshHigh`, `pixelSortMaxSpan`, `pixelSortMix`. Очень выразительно гонять `maxSpan`
от энергии движения — потёки «выстреливают» на резком движении.

### 1.4. Заметки

- Порог — главный «художественный» параметр: узкое окно `[low,high]` → сортируются только
  средние тона (тонкие потёки), широкое → почти весь кадр течёт.
- `uTexel` **обязателен** (сэмплим соседей вдоль оси).
- Псевдо-путь stateless → стандартный ping-pong, своих RT не нужно.

---

## 2. Нода **Glitch** (`glitch`) — с вариантами

### 2.1. Что это

Композитная «цифровая порча» с переключаемым **режимом** (`glitchMode`) — это enum-вариации
ОДНОГО действия (порча кадра по времени), а не мега-нода. Базовый чистый RGB-split вынесен в
`chromAb`; здесь канальный сдвиг — лишь акцент внутри block/slice-режимов.

### 2.2. Варианты (`glitchMode`)

**`block` — блочное смещение (databending / DCT-артефакты).**
UV квантуется в прямоугольные блоки (`trunc(uv / blockSize)`), на каждый блок — hash от
(координата блока · время), и блоки, чьё hash-значение прошло порог `intensity`, смещаются на
случайный UV-вектор (+ опциональный канальный сдвиг внутри смещённых). Имитирует разрушение
8×8 макроблоков JPEG/DCT — «рваные» прямоугольные сдвиги, цветовые скачки.

**`slice` — горизонтальные срезы / tearing (sync-loss).**
Кадр делится на горизонтальные полосы (`floor(uv.y · sliceCount)`); каждой полосе — hash·время →
горизонтальный сдвиг и шанс «провала». Узнаваемый VHS/CRT tearing: строки уезжают вбок,
картинка «рвётся».

**`wave` — волновое дрожание (jitter).**
UV-смещение синусом/value-шумом по времени с высокой частотой — «дрожащий» нестабильный сигнал,
аналоговая нестабильность синхронизации. (Отличие от `displace`: здесь упор на быстрый
дёрганый временной джиттер + порог срабатывания, а не плавный поток.)

**`digital` — цифровая порча (bitcrush + corruption).**
Комбо: постеризация цвета (квантование по уровням) + случайные «битые» блоки (заливка
инвертированным/сдвинутым каналом) + редкие «мёртвые»/«горячие» пиксели. Самый «сломанный»
вид — экран словно ловит повреждённый поток данных.

```glsl
// glitchPassFragment (скелет, режим выбирается uGlitchMode)
precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform float uTime;
uniform float uGlitchMode;     // 0 block, 1 slice, 2 wave, 3 digital
uniform float uIntensity;      // 0..1 доля затронутого / сила
uniform float uBlockSize;      // размер блока/срезов (px или count)
uniform float uSpeed;          // частота смены паттерна порчи
uniform float uColorShift;     // 0..1 канальный сдвиг внутри глитча
uniform float uSeed;           // зерно (разводит инстансы)
varying vec2 vUv;
float hash21(vec2 p){ p=fract(p*vec2(127.1,311.7)); p+=dot(p,p+19.19); return fract(p.x*p.y); }
void main(){
  vec2 uv = vUv;
  float t = floor(uTime * uSpeed);   // дискретное «тиканье» порчи
  // ... ветка по uGlitchMode: block / slice / wave / digital
  // block:  vec2 b=floor(uv/blk); if(hash21(b+t+uSeed)<uIntensity) uv+=rndOffset; +colorShift
  // slice:  float row=floor(uv.y*cnt); if(hash21(vec2(row,t))<uIntensity) uv.x+=rnd;
  // wave:   uv += jitter(uv,t)*uIntensity;
  // digital: posterize(col, levels) + corrupt blocks + dead/hot pixels
  gl_FragColor = vec4(/* sampled+processed */, 1.0);
}
```

### 2.3. Параметры (`SceneConfig`)

| Поле | Тип | Диапазон | Контрол | Смысл |
|------|-----|----------|---------|-------|
| `glitchEnabled` | bool | — | (enabledField) | вкл |
| `glitchMode` | select | `block`/`slice`/`wave`/`digital` | SEL | вариант |
| `glitchIntensity` | number | 0..1, 0.02 | R | доля/сила порчи |
| `glitchBlockSize` | number | 2..128, 1 | R | размер блока/число срезов |
| `glitchSpeed` | number | 0..30, 0.5 | R | частота смены паттерна |
| `glitchColorShift` | number | 0..1, 0.02 | R | канальный сдвиг внутри глитча |
| `glitchSeed` | number | 0..100, 1 | R | зерно (разводит мультиэкземпляры) |

**bindable**: `glitchIntensity`, `glitchSpeed`, `glitchColorShift`. **Киллер-фича** — гонять
`glitchIntensity` от энергии движения/звука (нода-сигнал): кадр «ломается» в такт музыке/движению.
`glitchSpeed` от того же сигнала даёт ускорение порчи на пиках.

### 2.4. Заметки

- `uTime` тикается **вне цикла проходов** (как `displace`/`grain`), один раз за кадр; `uSeed`
  разводит два инстанса Glitch, чтобы они не совпадали по фазе.
- Дискретизация времени `floor(uTime·speed)` даёт «ступенчатую» цифровую анимацию (а не плавную) —
  это и есть нужный «цифровой» характер.
- `block`/`slice` сэмплят смещённый UV → нужен `clamp` UV в [0,1] (как в `displace`).

---

## 3. Нода **Displace по цифровым паттернам** (`patternDisplace`)

### 3.1. Что это и связь с существующим `displace`

`displace` уже умеет `noise` (плавный value-шум) и `self` (кадр как карта). Новая нода —
его **«цифровой» брат**: UV-смещение по **дискретным/структурным паттернам**, дающим
геометричный, «машинный» вид (не органический шум). Domain warping + структурные карты.

> **Решение по форме (рекомендация):** сделать **отдельную ноду** `patternDisplace`, а не
> добавлять режимы в `displace`. Причины: (1) у `displace` свой набор bindable/контролов, новые
> паттерны добавят 3-4 поля и раздуют SEL; (2) отдельная нода чище читается в графе и палитре;
> (3) их можно чейнить (`displace` плавный + `patternDisplace` структурный). Архитектура
> data-driven — две почти-одинаковые ноды стоят дёшево. *Альтернатива* — расширить
> `displaceMode` enum новыми пунктами (меньше файлов, но смешивает органику и структуру в одной
> ноде); допустимо, если хочется минимализма.

### 3.2. Паттерны смещения (`patternKind`)

| Паттерн | Карта смещения | Вид |
|---------|---------------|-----|
| `blocks` | UV квантуется в сетку, на блок — hash-вектор | ступенчатые прямоугольные сдвиги |
| `voronoi` | ворнои/Worley-ячейки, смещение к центру ячейки | органик-ячеистая деформация, «битое стекло» |
| `bayer` | упорядоченная Bayer-матрица 4×4/8×8 как карта | регулярная dither-сетка смещений |
| `scanline` | смещение зависит только от `floor(uv.y·N)` | строчные горизонтальные сдвиги (телесигнал) |
| `hashgrid` | псевдослучайная сетка (hash на ячейку) | «пиксельный шум» — резкие квадраты |
| `radialRings` | смещение по кольцам от центра | концентрические волны/«линза» |

Карта смещения вычисляется процедурно в шейдере (без текстур — как `valueNoise` в `displace`)
ИЛИ опционально берётся с **map-входа** (сокет `map2d` → `Видео.глубина` / `noise2d` /
`mapCombine`), что переиспользует CPU-резолвер `mapForRef` (см. CLAUDE.md `core/mapSources.ts`).
Для MVP — процедурно в шейдере; map-вход — расширение фазы B.

```glsl
// patternDisplacePassFragment (скелет)
precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform float uTime;
uniform float uPatternKind;   // 0 blocks,1 voronoi,2 bayer,3 scanline,4 hashgrid,5 radial
uniform float uAmount;        // амплитуда (0..0.3)
uniform float uScale;         // плотность паттерна (2..64)
uniform float uSpeed;         // анимация паттерна
uniform float uQuantize;      // 0..1 ступенчатость смещения (digital feel)
varying vec2 vUv;
void main(){
  vec2 disp = vec2(0.0);
  // ... ветка по uPatternKind строит disp (см. таблицу)
  if (uQuantize > 0.0) disp = floor(disp / (uQuantize*uTexel)) * (uQuantize*uTexel); // дискретизация
  vec2 uv = clamp(vUv + disp*uAmount, 0.0, 1.0);
  gl_FragColor = vec4(texture2D(uTex, uv).rgb, 1.0);
}
```

### 3.3. Параметры (`SceneConfig`)

| Поле | Тип | Диапазон | Контрол | Смысл |
|------|-----|----------|---------|-------|
| `patternDisplaceEnabled` | bool | — | (enabledField) | вкл |
| `patternDisplaceKind` | select | blocks/voronoi/bayer/scanline/hashgrid/radial | SEL | паттерн |
| `patternDisplaceAmount` | number | 0..0.3, 0.005 | R | амплитуда |
| `patternDisplaceScale` | number | 2..64, 1 | R | плотность паттерна |
| `patternDisplaceSpeed` | number | 0..5, 0.1 | R | анимация |
| `patternDisplaceQuantize` | number | 0..1, 0.02 | R | ступенчатость (цифровость) |

**bindable**: `patternDisplaceAmount`, `patternDisplaceScale`, `patternDisplaceSpeed`.

### 3.4. Заметки

- `uQuantize` — ключ «цифрового» характера: дискретизирует смещение по сетке пикселей, убирая
  плавность (отличает от органического `displace`).
- `voronoi` дороже (несколько hash-сэмплов на фрагмент) — держать `scale` умеренным.
- `uTexel` обязателен; `uTime` — вне цикла (анимированный проход).

---

## 4. Дополнительные эффекты цифрового глитч-дизайна (предложения)

Ранжировано по соотношению «выразительность / стоимость реализации». Все — `map→map` проходы
по тому же шаблону; кроме помеченных `[stateful]` (нужны свои RT, как `feedback`).

### Приоритет 1 — высокая отдача, дёшево (stateless, один проход)

1. **Posterize / Bitcrush** (`posterize`) — квантование цвета по уровням (`floor(col·N)/N`),
   опц. раздельно по каналам. Резкие цветовые «ступени», постеризация — фундамент «цифрового»
   вида. 10 строк шейдера.
2. **Bayer / Ordered Dither** (`dither`) — упорядоченное растрирование Bayer-матрицей 4×4/8×8
   при низком числе уровней. Ретро-«газетный»/1-bit вид; отлично поверх `posterize`.
3. **Halftone / Dot Screen** (`halftone`) — модуляция яркости в сетку точек/линий (CMYK-углы).
   Полиграфический растр, «комикс».
4. **Scanline tear / VHS** (`vhs`) — горизонтальный шум-сдвиг строк + лёгкий канальный bleed +
   виньетка/шум. Аналоговая ностальгия (родственник `glitch:slice`, но «мягкий», постоянный).
5. **Threshold / 1-bit** (`threshold`) — бинаризация по порогу яркости (опц. с dither).
   Жёсткий ЧБ-силуэт.
6. **Channel swap / invert glitch** (`channelFx`) — перестановка/инверсия R/G/B каналов
   (rgb→gbr и т.п.), опц. по маске/времени. Дёшево, очень «сломанно».

### Приоритет 2 — выразительно, средняя сложность

7. **Datamosh / motion smear** (`datamosh`) `[stateful]` — смешивание текущего кадра с
   предыдущим по «движению» (разница кадров управляет переносом), «тающие» переходы. Калька
   механики `feedback` (своя пара RT). Один из самых узнаваемых видео-глитчей.
8. **Time displacement / rolling shutter** (`timeWarp`) `[stateful]` — разные строки/столбцы
   показывают кадр с разной задержкой (буфер истории). «Желейный» rolling-shutter, временной
   сдвиг по Y.
9. **Echo / Ghosting / Trails** (`echo`) `[stateful]` — экспоненциальный след прошлых кадров
   (моушн-трейлы). Похоже на `feedback`, но без зума/поворота — чистые временные хвосты.
10. **CRT / convergence** (`crt`) — бочкообразная дисторсия + маска апертурной решётки +
    convergence-сдвиг каналов + scanlines. Полный «телевизор».

### Приоритет 3 — нишевые/экспериментальные

11. **Slice shuffle** (`sliceShuffle`) — горизонтальные полосы случайно переставляются местами
    (не сдвигаются, а тасуются). «Перемешанный» кадр.
12. **Quantize / banding** (`banding`) — намеренный color-banding (грубая глубина цвета) +
    dither-инъекция. Деградация битности.
13. **Pixel drift / melt** (`melt`) `[stateful]` — пиксели «стекают» вниз по яркости (накопление
    в истории). Эффект «плавящегося» изображения.
14. **Hex / triangle mosaic** (`mosaicShape`) — пикселизация не квадратами, а гексами/треугольниками
    (вариация `pixelArt` с другой решёткой).
15. **Sort-driven hue cycle** — циклический сдвиг hue по спанам (родственник Pixel Sort, но
    вместо перестановки — вращение цвета).

### Сводная рекомендация по очерёдности постройки

```
Запрошено:  pixelSort → glitch → patternDisplace
Затем П1:   posterize → dither → channelFx → threshold → vhs → halftone   (всё stateless, быстро)
Затем П2:   datamosh → echo → timeWarp → crt                              (stateful / составные)
```

`posterize` + `dither` + `channelFx` — самые дешёвые и при этом сильно расширяют палитру
«цифрового» глитча; их разумно сделать сразу следом за тремя запрошенными.

---

## 5. Сводная таблица новых нод

| Нода | kind | domain | singleton | Режимы | bindable (direction A) | stateful |
|------|------|--------|-----------|--------|------------------------|----------|
| Pixel Sort | `pixelSort` | shader | false | axis·key (псевдо/exact) | threshLow/High, maxSpan, mix | путь B — да |
| Glitch | `glitch` | shader | false | block/slice/wave/digital | intensity, speed, colorShift | нет |
| Pattern Displace | `patternDisplace` | shader | false | blocks/voronoi/bayer/scanline/hashgrid/radial | amount, scale, speed | нет |
| Posterize | `posterize` | shader | false | — | levels | нет |
| Dither | `dither` | shader | false | bayer4/8 | levels | нет |
| Channel FX | `channelFx` | shader | false | swap/invert | amount | нет |
| Datamosh | `datamosh` | shader | false | — | strength | **да** |

---

## 6. Шаблон добавления (B1–B8 + T0c) — чек-лист на одну ноду

Точные точки правки (по разбору архитектуры; пути от `src/`). Для **stateless** проходов
(Glitch, PatternDisplace, Posterize, …) — 8 шагов; для **stateful** (Pixel Sort путь B,
Datamosh) — плюс своя пара RT и swap, как у `feedback`.

1. **`core/types.ts`** — поля в `SceneConfig` (+ дефолты в `DEFAULT_CONFIG`) и новый `kind` в
   union `LayerKind`.
2. **`render/flatShader.ts`** — экспорт `<kind>PassFragment` (вход `uTex`+`vUv`, выход
   `gl_FragColor = vec4(col,1.0)`; `uTexel` если сэмплим соседей; `uTime` если анимировано).
3. **`render/FlatView.tsx`** (import) — добавить `<kind>PassFragment` в импорт из `./flatShader`.
4. **`render/FlatView.tsx`** (`fxChain` useMemo) — создать `THREE.ShaderMaterial` (`<kind>Mat`)
   с uniforms 1:1 к шейдеру.
5. **`render/FlatView.tsx`** (dispose useEffect) — `fxChain.<kind>Mat.dispose()`.
6. **`render/FlatView.tsx`** (цикл проходов) — `else if (passes[i].kind === "<kind>")`:
   `m.uTex.value = srcTex`, пробросить params из `pp.*`, **обновить `uTexel` через `1/inW,1/inH`**.
   Анимированный — тикать `uTime` **до** цикла. Stateful — своя пара RT + swap + `continue`.
7. **`core/layerRegistry.ts`** (`LAYER_DEFS`) — запись `<kind>: { label, group:"2D",
   domain:"shader", enabledField, singleton:false, bindable:[…], controls:[…] }`. Контролы
   должны совпадать с полями (их собирает `paramFields`).
8. **`core/layerRegistry.ts`** (`LAYER_ORDER`) — добавить `"<kind>"` в массив рядом с прочими 2D-FX.

**Критичные правила (из разбора):**
- `uTexel` пересчитывать на КАЖДОМ проходе (`1/inW, 1/inH`) — RT ресайзится.
- `uTime` для анимированных тикать ОДИН раз за кадр вне цикла (иначе мультиэкземпляр × delta).
- Ничего не трогать в `resolveConfig`/миграциях/типах сокетов — это держит `config-reviewer`
  зелёным; новый map→map проход обходится без этих правок.
- `bindable` (числовые range-поля) → автоматически драйвятся проводом графа от нод-сигналов
  (direction A) с Remap/EMA — это и есть «глитч в такт музыке/движению».

---

## 7. Источники

- [ciphrd — Pixel sorting on shader using sorting filters (GLSL)](https://ciphrd.com/2020/04/08/pixel-sorting-on-shader-using-well-crafted-sorting-filters-glsl/)
- [haxademic — glitch-pseudo-pixel-sorting.glsl](https://github.com/cacheflowe/haxademic/blob/master/data/haxademic/shaders/filters/glitch-pseudo-pixel-sorting.glsl)
- [Harry Alisavakis — My take on shaders: Glitch image effect](https://halisavakis.com/my-take-on-shaders-glitch-image-effect/)
- [Agate Dragon — Glitch shader: RGB split / blocks / displacement lines](https://agatedragon.blog/2023/12/21/glitch-shader-effect-using-blocks-part-2/)
- [Kyle Halladay — Fixeds, Floats and a Block Damage Effect](https://kylehalladay.com/blog/tutorial/2017/03/13/GlitchFX-In-Unity.html)
- [SHRTX — Designing Glitch Art (image glitching guide)](https://shrtx.in/blog/guides/designing-glitch-art-image-glitching-guide)
- [Glitchology — Datamoshing / glitch glossary](https://glitchology.com/datamoshing/)
- [The Book of Shaders — Noise / patterns (Voronoi, value noise)](https://thebookofshaders.com/12/)
- [Glitch art — Wikipedia](https://en.wikipedia.org/wiki/Glitch_art)
