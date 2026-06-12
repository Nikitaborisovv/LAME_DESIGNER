// Полноэкранный 2D-шейдер: видео-текстура -> цепочка дешёвых эффектов.
// Всё в одном фрагментном проходе, ветвление по uniform'ам -> 60 fps без лишних пассов.

export const flatVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const flatFragment = /* glsl */ `
  precision highp float;

  uniform sampler2D uTex;
  uniform vec2  uTexel;        // 1.0 / разрешение
  uniform float uVideoAspect;
  uniform float uViewAspect;
  uniform float uFit;          // 0 = cover (заполнить+обрезать), 1 = contain (вписать)
  uniform float uTime;

  uniform float uThermal;      // 0..1 сила тепловой карты
  uniform vec3  uThermalCold;  // холодный конец
  uniform vec3  uThermalHot;   // горячий конец

  uniform float uSobel;        // усиление контуров (0 = выкл)
  uniform float uSobelOnly;    // 1 = только контуры на тёмном
  uniform vec3  uSobelColor;
  uniform float uSobelThickness;
  uniform float uSobelTolerance; // 0..1 порог
  uniform float uSobelPixelate;  // размер блока в пикселях (0 = выкл)

  uniform float uScanlines;    // 0..1
  uniform float uTransparentVideo; // 1 = верхний слой: видео не рисуем, только эффекты с альфой
  uniform float uHideVideo;        // 1 = скрыть фоновое видео (чёрная база), эффекты/маски остаются

  // Пиксель-арт / ASCII (отдельный слой): блочная пикселизация + опц. ASCII-глифы.
  uniform float uPixelArt;       // 1 = режим включён
  uniform float uPixelArtSize;   // размер ячейки (видео-px)
  uniform float uPixelArtAscii;  // 1 = рисовать ASCII-глифы
  uniform float uPixelArtMono;   // 1 = монохром (палитра по яркости), иначе цвет видео
  uniform float uPixelArtLevels; // кол-во уровней/цветов палитры (2..16)
  uniform vec3  uPalette[16];    // палитра монохрома (используются первые uPixelArtLevels)
  uniform float uPAAsciiTint;    // 1 = красить ASCII в uPAAsciiColor, иначе цветом пикселя
  uniform vec3  uPAAsciiColor;   // цвет ASCII
  uniform sampler2D uAsciiAtlas; // атлас глифов (1 ряд символов слева->плотнее)
  uniform float uAsciiCount;     // число символов в атласе
  uniform float uGlowMask[16];   // 1 = уровень палитры светится
  uniform float uGlowSize;       // разброс свечения (в ячейках)
  uniform float uGlowIntensity;  // сила свечения
  uniform sampler2D uBloom;      // предрассчитанный bloom (FBO) светящихся цветов
  uniform float uBloomOn;        // 1 = добавлять bloom поверх

  uniform sampler2D uDepthMap; // карта глубины для пикселизации
  uniform float uHasDepth;     // 1 = пикселизация по глубине включена
  uniform float uPixNear;      // размер блока вблизи (px)
  uniform float uPixFar;       // размер блока вдали (px)
  uniform float uRampNear;     // глубина «вблизи» 0..1
  uniform float uRampFar;      // глубина «вдали» 0..1
  uniform float uPixGrid;      // 1 = ровная сетка: блок -> степень 2 (квадродерево), выровнено
  uniform float uPixBlur;      // 0..1 усреднение внутри блока перед пикселизацией

  // Маски людей (YOLOv8-seg): RGBA proto-текстура (цвет инстанса + альфа-покрытие).
  uniform sampler2D uMask;     // маска инстансов
  uniform float uMaskOn;       // 1 = композитить маски
  uniform vec2  uMaskMul;      // video_uv (y-down) -> mask_uv: умножение
  uniform vec2  uMaskOff;      // и смещение (обратный letterbox)
  uniform vec2  uMaskTexel;    // 1/размер маски (для детекции края)
  uniform float uMaskFill;     // 1 = заливка силуэта
  uniform float uMaskOutline;  // 1 = контур по краю
  uniform float uMaskFillOpacity;  // прозрачность заливки сверху (A)
  uniform float uMaskFillOpacity2; // прозрачность заливки снизу (B) — рампа A->B

  // Гладкая маска (MediaPipe Selfie): одноканальное покрытие 0..1 (R). Гибрид: заливка
  // берётся отсюда (мягкий край), цвет — от YOLO-инстанса, контур — крисп от YOLO.
  uniform sampler2D uSelfie;
  uniform float uSelfieOn;     // 1 = гладкая заливка из selfie
  uniform vec2  uSelfieMul;    // video_uv(y-down) -> selfie_uv
  uniform vec2  uSelfieOff;
  uniform float uSelfieFeather;   // мягкость края 0..0.4
  uniform float uSelfieThreshold; // порог уверенности (выше = меньше фона)
  uniform vec2  uSelfieTexel;     // 1/размер selfie-маски (для контура гладкой маски)
  // Splat-маска (конвертер PointSet->Map2D, рисуется в CanvasTexture в video-нормированном
  // пространстве, y-down как у канваса). Композит: overlay-цвет или alpha-вырез видео.
  uniform sampler2D uSplat;
  uniform float uSplatOn;   // 1 = композитить splat-маску
  uniform float uSplatMode; // 0 = цвет поверх видео (overlay), 1 = видео сквозь альфу (вырез)

  uniform vec3  uPeopleColor;     // цвет заливки A

  // Градиенты заливки/контура (вертикальные по экрану vUv.y). Работают на YOLO и гладкой маске.
  uniform vec3  uPeopleColor2;        // цвет заливки B
  uniform float uPeopleFillGradient;  // 1 = заливка градиентом A->B
  uniform vec3  uOutlineColor;        // цвет контура A
  uniform vec3  uOutlineColor2;       // цвет контура B
  uniform float uPeopleOutlineGradient; // 1 = контур градиентом A->B
  uniform float uGradByInstance;      // 1 = крутить hue градиента по цвету YOLO-инстанса

  varying vec2 vUv;

  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  // RGB<->HSV для hue-сдвига градиента по цвету инстанса.
  vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
  }
  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }
  // цвет градиента g, при необходимости провёрнутый по hue на оттенок инстанса instRgb
  vec3 gradTint(vec3 g, bool byInst, vec3 instRgb) {
    if (!byInst) return g;
    vec3 h = rgb2hsv(g);
    h.x = fract(h.x + rgb2hsv(instRgb).x);
    return hsv2rgb(h);
  }

  // Тепловой градиент между двумя выбранными цветами, с «горбом» насыщенности.
  vec3 thermal(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 base = mix(uThermalCold, uThermalHot, t);
    // лёгкий подъём середины к горячему для «тепловизорного» вида
    float boost = smoothstep(0.35, 0.85, t);
    return mix(base, uThermalHot, boost * 0.35);
  }

  // Палитра по уровню (эмиссия для свечения считается отдельным bloom-проходом — emissiveFragment).
  vec3 paletteAt(float lvl) { vec3 c = uPalette[0]; for (int i = 0; i < 16; i++) { if (float(i) == lvl) c = uPalette[i]; } return c; }
  float levelOf(float L, float steps) { return clamp(floor(L * steps), 0.0, steps - 1.0); }

  // Блочная пикселизация + опц. ASCII (атлас глифов) + свечение выбранных уровней палитры.
  vec3 pixelArt(vec2 uv) {
    vec2 res = 1.0 / uTexel;
    float cell = max(uPixelArtSize, 1.0);
    vec2 g = floor(uv * res / cell);
    vec2 cuv = (g + 0.5) * cell / res;          // центр ячейки -> резкие пиксели
    vec3 cc = texture2D(uTex, cuv).rgb;
    float L = luma(cc);
    float steps = max(uPixelArtLevels, 1.0);

    // базовый цвет: палитра (моно) или цвет видео (sharp)
    vec3 pcol = (uPixelArtMono > 0.5) ? paletteAt(levelOf(L, steps)) : cc;

    // ASCII через атлас: символ по яркости (темнее -> плотнее)
    vec3 base = pcol;
    if (uPixelArtAscii > 0.5) {
      vec2 f = fract(uv * res / cell);
      float idx = floor((1.0 - L) * (uAsciiCount - 1.0) + 0.5);
      vec2 auv = vec2((idx + clamp(f.x, 0.0, 1.0)) / uAsciiCount, clamp(f.y, 0.0, 1.0));
      float on = texture2D(uAsciiAtlas, auv).a;
      vec3 gcol = (uPAAsciiTint > 0.5) ? uPAAsciiColor : pcol;
      base = gcol * on;                          // фон чёрный, символ цветной
    }

    // свечение НЕ здесь: оно считается отдельным bloom-проходом (FBO) и добавляется в main
    // как uBloom -> мягкий halo в полном разрешении, без привязки к размеру пикселя и без дублей.
    return base;
  }

  // Гибридный композитинг масок людей. uv — video-uv (y-up, как у uTex).
  // Заливка: гладкая selfie-маска (мягкий край) если включена, иначе ступенчатая YOLO.
  // Цвет заливки: от YOLO-инстанса там, где он есть, иначе uPeopleColor.
  // Контур: крисп по краю YOLO-инстанса (в цвет инстанса).
  vec3 composePeople(vec3 col, vec2 uv) {
    if (uMaskOn < 0.5 && uSelfieOn < 0.5) return col;
    // video_uv (y-up) -> letterbox-пространство (y-down)
    vec2 mv = vec2(uv.x, 1.0 - uv.y);

    // --- YOLO-инстанс: цвет + покрытие (бинарное -> пиксельный край, как нравится) ---
    vec4 ym = vec4(0.0);
    bool yoloHere = false;   // «есть инстанс» — для цвета, заливки и контура
    vec2 muv = mv * uMaskMul + uMaskOff;
    bool muvIn = muv.x >= 0.0 && muv.x <= 1.0 && muv.y >= 0.0 && muv.y <= 1.0;
    if (uMaskOn > 0.5 && muvIn) {
      ym = texture2D(uMask, muv);
      yoloHere = ym.a > 0.5;
    }

    // --- Selfie: гладкое покрытие с пером края ---
    float sCov = 0.0;
    if (uSelfieOn > 0.5) {
      vec2 suv = mv * uSelfieMul + uSelfieOff;
      if (suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0) {
        float r = texture2D(uSelfie, suv).r;
        float f = max(uSelfieFeather, 0.001);
        sCov = smoothstep(uSelfieThreshold - f, uSelfieThreshold + f, r);
      }
    }

    // вертикальный градиент по экрану (верх=A, низ=B)
    float gt = clamp(1.0 - vUv.y, 0.0, 1.0);
    bool byInst = (uGradByInstance > 0.5) && (uMaskOn > 0.5) && yoloHere; // тинт по цвету инстанса

    // --- заливка (цвет: градиент/инстанс; прозрачность: рампа A->B) ---
    float fillCov = (uSelfieOn > 0.5) ? sCov : (yoloHere ? 1.0 : 0.0); // selfie гладкий / YOLO пиксельный
    vec3 fillColor = (uPeopleFillGradient > 0.5)
      ? gradTint(mix(uPeopleColor, uPeopleColor2, gt), byInst, ym.rgb)
      : (yoloHere ? ym.rgb : uPeopleColor);
    float fillOp = mix(uMaskFillOpacity, uMaskFillOpacity2, gt); // рампа прозрачности сверху->вниз
    if (uMaskFill > 0.5) col = mix(col, fillColor, fillCov * fillOp);

    // --- контур (по краю активной маски) ---
    if (uMaskOutline > 0.5) {
      vec3 outColor = (uPeopleOutlineGradient > 0.5)
        ? gradTint(mix(uOutlineColor, uOutlineColor2, gt), byInst, ym.rgb)
        : (yoloHere ? ym.rgb : uOutlineColor);
      float edge = 0.0;
      if (uSelfieOn > 0.5) {
        // край гладкой маски: центр покрыт, а сосед — нет
        vec2 suv = mv * uSelfieMul + uSelfieOff;
        float nl = step(uSelfieThreshold, texture2D(uSelfie, suv + vec2(-uSelfieTexel.x, 0.0)).r);
        float nr = step(uSelfieThreshold, texture2D(uSelfie, suv + vec2( uSelfieTexel.x, 0.0)).r);
        float nt = step(uSelfieThreshold, texture2D(uSelfie, suv + vec2(0.0,  uSelfieTexel.y)).r);
        float nb = step(uSelfieThreshold, texture2D(uSelfie, suv + vec2(0.0, -uSelfieTexel.y)).r);
        if (sCov > 0.5 && min(min(nl, nr), min(nt, nb)) < 0.5) edge = 1.0;
      } else if (uMaskOn > 0.5 && yoloHere && muvIn) {
        // край YOLO: покрыто, а кто-то из 4 соседей — нет
        float nl = texture2D(uMask, muv + vec2(-uMaskTexel.x, 0.0)).a;
        float nr = texture2D(uMask, muv + vec2( uMaskTexel.x, 0.0)).a;
        float nt = texture2D(uMask, muv + vec2(0.0,  uMaskTexel.y)).a;
        float nb = texture2D(uMask, muv + vec2(0.0, -uMaskTexel.y)).a;
        if (min(min(nl, nr), min(nt, nb)) < 0.5) edge = 1.0;
      }
      if (edge > 0.5) col = outColor;
    }
    return col;
  }

  // Композит splat-маски (PointSet->Map2D). uv — video-uv (y-up); канвас маски y-down -> флипаем.
  //  overlay: цветные формы поверх видео (mix по альфе).
  //  alpha:   видео видно только внутри форм («белые квадраты на движении как альфа видео»).
  vec3 composeSplat(vec3 col, vec2 uv) {
    if (uSplatOn < 0.5) return col;
    vec4 s = texture2D(uSplat, vec2(uv.x, 1.0 - uv.y));
    if (uSplatMode > 0.5) return col * s.a;
    return mix(col, s.rgb, s.a);
  }

  vec2 coverUv(vec2 uv) {
    float r = uViewAspect / uVideoAspect;
    vec2 c = uv - 0.5;
    if (uFit < 0.5) {
      if (r > 1.0) c.y /= r; else c.x *= r;       // cover (обрезать)
    } else {
      if (r > 1.0) c.x *= r; else c.y /= r;       // contain (вписать с полями)
    }
    return c + 0.5;
  }

  void main() {
    vec2 uv = coverUv(vUv);
    bool outside = (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0);

    // пикселизация по глубине: размер блока из карты глубины (с рампой).
    // uPixGrid -> блок квантуется в степень 2 (квадродерево) на ЕДИНОЙ выровненной сетке,
    // и пере-оценивается по глубине в центре ячейки -> блоки не наезжают, сетка ровная.
    vec2 suv = uv;
    float blk = 0.0; // активный размер блока (px); 0 = пикселизация выкл
    if (uHasDepth > 0.5 && !outside) {
      vec2 res = 1.0 / uTexel;
      vec2 pix = uv * res;
      float dd = texture2D(uDepthMap, vec2(uv.x, 1.0 - uv.y)).r;
      float t = clamp((uRampNear - dd) / (uRampNear - uRampFar + 1e-4), 0.0, 1.0);
      float block = max(1.0, mix(uPixNear, uPixFar, t));
      if (uPixGrid > 0.5) {
        block = exp2(floor(log2(block) + 0.5));                 // -> ближайшая степень 2
        vec2 c0 = (floor(pix / block) + 0.5) * block;           // центр предварительной ячейки
        float dd2 = texture2D(uDepthMap, vec2(c0.x / res.x, 1.0 - c0.y / res.y)).r;
        float t2 = clamp((uRampNear - dd2) / (uRampNear - uRampFar + 1e-4), 0.0, 1.0);
        block = max(1.0, exp2(floor(log2(mix(uPixNear, uPixFar, t2)) + 0.5))); // единый размер на ячейку
      }
      suv = (floor(pix / block) + 0.5) * block / res;
      blk = block;
    }
    vec3 src;
    if (outside) {
      src = vec3(0.0);
    } else if (blk > 0.0 && uPixBlur > 0.001) {
      // усреднение внутри блока (мягкая «доразмытость» перед пикселизацией)
      vec2 o = uTexel * blk * 0.33 * clamp(uPixBlur, 0.0, 1.0);
      vec3 a = texture2D(uTex, suv).rgb;
      a += texture2D(uTex, suv + vec2( o.x,  o.y)).rgb;
      a += texture2D(uTex, suv + vec2(-o.x,  o.y)).rgb;
      a += texture2D(uTex, suv + vec2( o.x, -o.y)).rgb;
      a += texture2D(uTex, suv + vec2(-o.x, -o.y)).rgb;
      src = a / 5.0;
    } else {
      src = texture2D(uTex, suv).rgb;
    }

    // --- Sobel edge (вычисляем заранее, нужен в обоих режимах) ---
    float edge = 0.0;
    if (uSobel > 0.0 && !outside) {
      vec2 px = 1.0 / uTexel;
      vec2 suv = uv;
      float scale = 1.0;
      if (uSobelPixelate > 0.5) {
        float blk = max(uSobelPixelate, 1.0);
        suv = (floor(uv * px / blk) + 0.5) * blk / px;
        scale = blk;
      }
      vec2 off = uTexel * uSobelThickness * scale;
      float tl = luma(texture2D(uTex, suv + off * vec2(-1.0,  1.0)).rgb);
      float  t = luma(texture2D(uTex, suv + off * vec2( 0.0,  1.0)).rgb);
      float tr = luma(texture2D(uTex, suv + off * vec2( 1.0,  1.0)).rgb);
      float  l = luma(texture2D(uTex, suv + off * vec2(-1.0,  0.0)).rgb);
      float  r = luma(texture2D(uTex, suv + off * vec2( 1.0,  0.0)).rgb);
      float bl = luma(texture2D(uTex, suv + off * vec2(-1.0, -1.0)).rgb);
      float  b = luma(texture2D(uTex, suv + off * vec2( 0.0, -1.0)).rgb);
      float br = luma(texture2D(uTex, suv + off * vec2( 1.0, -1.0)).rgb);
      float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
      float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
      edge = clamp(sqrt(gx * gx + gy * gy) * uSobel, 0.0, 1.0);
      edge = (edge < uSobelTolerance) ? 0.0 : edge;
    }

    // === Прозрачный 2D-слой: видео НЕ рисуем, только эффекты, альфа = сила эффекта ===
    if (uTransparentVideo > 0.5) {
      vec3 col = uSobelColor * edge;
      float a = edge;
      if (uThermal > 0.0 && !outside) {
        vec3 th = thermal(luma(src));
        col = mix(col, th, uThermal);
        a = max(a, uThermal);
      }
      gl_FragColor = vec4(col, outside ? 0.0 : a);
      return;
    }

    // === Обычный непрозрачный режим (видео + эффекты) ===
    if (outside) { gl_FragColor = vec4(0.02, 0.03, 0.05, 1.0); return; }
    // база: пиксель-арт/ASCII (если включён) перекрывает sobel/thermal; иначе видео (или чёрное при hide)
    vec3 col;
    if (uPixelArt > 0.5) {
      col = pixelArt(uv);
    } else {
      col = uHideVideo > 0.5 ? vec3(0.0) : src;
    }
    if (uPixelArt < 0.5) {
      if (uSobel > 0.0) {
        if (uSobelOnly > 0.5) col = uSobelColor * edge;
        else col = mix(col, uSobelColor, edge);
      }
      if (uThermal > 0.0) col = mix(col, thermal(luma(src)), uThermal);
    }
    col = composePeople(col, uv);
    col = composeSplat(col, uv);
    if (uScanlines > 0.0) {
      float line = sin(vUv.y * 1400.0) * 0.5 + 0.5;
      col *= 1.0 - uScanlines * (1.0 - line);
    }
    vec2 d = vUv - 0.5;
    col *= 1.0 - dot(d, d) * 0.6;
    // bloom светящихся цветов (предрассчитан в FBO) — добавляем поверх
    if (uBloomOn > 0.5) col += texture2D(uBloom, vUv).rgb * uGlowIntensity;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// === Фаза B (распил мега-шейдера на цепочку map→map FBO-проходов) ===
// Каждый 2D-эффект становится отдельным проходом: сэмплит вход `uTex` в `vUv` (полный кадр,
// без fit — fit остаётся в финальном композите мега-шейдера) и пишет результат в FBO. Проходы
// чейнятся (выход одного = вход следующего), порядок цепочки = порядок рёбер в графе. Пока
// извлечён только Тепловизор (B1); остальные FX мигрируют по одному, мега-шейдер дотягивает
// композит (маски/splat/scanlines/виньетка/bloom). См. ARCHITECTURE.md §3.5.5.
//
// Тепловизор как map→map: t000 luma -> градиент cold..hot. Идентичен `thermal()` мега-шейдера.
export const thermalPassFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform float uThermal;       // 0..1 сила (mix исходник -> тепловая карта)
  uniform vec3  uThermalCold;
  uniform vec3  uThermalHot;
  varying vec2 vUv;
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  vec3 thermal(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 base = mix(uThermalCold, uThermalHot, t);
    float boost = smoothstep(0.35, 0.85, t);
    return mix(base, uThermalHot, boost * 0.35);
  }
  void main() {
    vec3 src = texture2D(uTex, vUv).rgb;
    vec3 col = mix(src, thermal(luma(src)), uThermal);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Sobel как map→map (B2): контуры по luma-градиенту входа. uTexel = 1/размер ВХОДА (для смещений
// соседей). Идентичен sobel-блоку мега-шейдера: pixelate-блок, толщина, толеранс, only/overlay.
export const sobelPassFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform vec2  uTexel;          // 1/размер входной текстуры (масштаб смещений)
  uniform float uSobel;          // сила (>0)
  uniform float uSobelOnly;      // 1 = только контуры на чёрном
  uniform vec3  uSobelColor;
  uniform float uSobelThickness;
  uniform float uSobelTolerance; // 0..1 порог отсечки
  uniform float uSobelPixelate;  // размер блока (px), 0 = выкл
  varying vec2 vUv;
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  void main() {
    vec2 uv = vUv;
    vec2 px = 1.0 / uTexel;
    vec2 suv = uv;
    float scale = 1.0;
    if (uSobelPixelate > 0.5) {
      float blk = max(uSobelPixelate, 1.0);
      suv = (floor(uv * px / blk) + 0.5) * blk / px;
      scale = blk;
    }
    vec2 off = uTexel * uSobelThickness * scale;
    float tl = luma(texture2D(uTex, suv + off * vec2(-1.0,  1.0)).rgb);
    float  t = luma(texture2D(uTex, suv + off * vec2( 0.0,  1.0)).rgb);
    float tr = luma(texture2D(uTex, suv + off * vec2( 1.0,  1.0)).rgb);
    float  l = luma(texture2D(uTex, suv + off * vec2(-1.0,  0.0)).rgb);
    float  r = luma(texture2D(uTex, suv + off * vec2( 1.0,  0.0)).rgb);
    float bl = luma(texture2D(uTex, suv + off * vec2(-1.0, -1.0)).rgb);
    float  b = luma(texture2D(uTex, suv + off * vec2( 0.0, -1.0)).rgb);
    float br = luma(texture2D(uTex, suv + off * vec2( 1.0, -1.0)).rgb);
    float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
    float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
    float edge = clamp(sqrt(gx * gx + gy * gy) * uSobel, 0.0, 1.0);
    edge = (edge < uSobelTolerance) ? 0.0 : edge;
    vec3 base = texture2D(uTex, uv).rgb;
    vec3 col = (uSobelOnly > 0.5) ? (uSobelColor * edge) : mix(base, uSobelColor, edge);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Пиксель-арт / ASCII как map→map (B3): блочная пикселизация + опц. ASCII-глифы (атлас) + моно-
// палитра по яркости. Идентичен `pixelArt()` мега-шейдера. uTexel = 1/размер входа (для сетки ячеек).
// Свечение (bloom) — отдельный pre-pass (emissiveFragment) + добавка в мега-композите, как и раньше.
export const pixelArtPassFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform vec2  uTexel;
  uniform float uPixelArtSize;
  uniform float uPixelArtAscii;
  uniform float uPixelArtMono;
  uniform float uPixelArtLevels;
  uniform vec3  uPalette[16];
  uniform float uPAAsciiTint;
  uniform vec3  uPAAsciiColor;
  uniform sampler2D uAsciiAtlas;
  uniform float uAsciiCount;
  varying vec2 vUv;
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  vec3 paletteAt(float lvl) { vec3 c = uPalette[0]; for (int i = 0; i < 16; i++) { if (float(i) == lvl) c = uPalette[i]; } return c; }
  float levelOf(float L, float steps) { return clamp(floor(L * steps), 0.0, steps - 1.0); }
  void main() {
    vec2 uv = vUv;
    vec2 res = 1.0 / uTexel;
    float cell = max(uPixelArtSize, 1.0);
    vec2 g = floor(uv * res / cell);
    vec2 cuv = (g + 0.5) * cell / res;          // центр ячейки -> резкие пиксели
    vec3 cc = texture2D(uTex, cuv).rgb;
    float L = luma(cc);
    float steps = max(uPixelArtLevels, 1.0);
    vec3 pcol = (uPixelArtMono > 0.5) ? paletteAt(levelOf(L, steps)) : cc;
    vec3 base = pcol;
    if (uPixelArtAscii > 0.5) {
      vec2 f = fract(uv * res / cell);
      float idx = floor((1.0 - L) * (uAsciiCount - 1.0) + 0.5);
      vec2 auv = vec2((idx + clamp(f.x, 0.0, 1.0)) / uAsciiCount, clamp(f.y, 0.0, 1.0));
      float on = texture2D(uAsciiAtlas, auv).a;
      vec3 gcol = (uPAAsciiTint > 0.5) ? uPAAsciiColor : pcol;
      base = gcol * on;                          // фон чёрный, символ цветной
    }
    gl_FragColor = vec4(base, 1.0);
  }
`;

// Lookup-колоризация как map→map: люма пикселя -> плавная интерполяция по N цветовым стопам рампы.
// «Форма ч/б, цвет отдельным слоем» — градиент задаётся пользователем (2..5 стопов).
// uLookup[16] — массив vec3 стопов; заполняются первые uLookupStops; остальные не используются.
// Интерполяция: L*(stops-1) -> индекс+фракция -> mix двух соседних стопов (плавная, не ступенчатая).
export const lookupPassFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform vec3  uLookup[16];    // палитра рампы (заполнены первые uLookupStops стопов)
  uniform float uLookupStops;   // кол-во стопов (2..5)
  uniform float uLookupMix;     // сила (0=оригинал, 1=полная колоризация)
  varying vec2 vUv;
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  vec3 stopAt(float idx) { vec3 c = uLookup[0]; for (int i = 0; i < 16; i++) { if (float(i) == idx) c = uLookup[i]; } return c; }
  void main() {
    vec3 src = texture2D(uTex, vUv).rgb;
    float L = luma(src);
    float stops = max(uLookupStops, 2.0);
    float t = clamp(L * (stops - 1.0), 0.0, stops - 1.0);
    float idx = floor(t);
    float f = fract(t);
    vec3 ramp = mix(stopAt(idx), stopAt(min(idx + 1.0, stops - 1.0)), f);
    vec3 col = mix(src, ramp, clamp(uLookupMix, 0.0, 1.0));
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Сканлайны как map→map (B4): горизонтальная развёртка-затемнение. Идентичен мега-ветке scanlines
// (но в цепочке применяется к видео ДО композита масок, а не поверх — нишевое отличие).
export const scanlinesPassFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform float uScanlines; // 0..1 интенсивность
  varying vec2 vUv;
  void main() {
    vec3 col = texture2D(uTex, vUv).rgb;
    float line = sin(vUv.y * 1400.0) * 0.5 + 0.5;
    col *= 1.0 - uScanlines * (1.0 - line);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Пикселизация по глубине как map→map (B4): размер блока из карты глубины (рампа near..far),
// опц. ровная сетка (степени 2, квадродерево) + усреднение внутри блока. Вход +`глубина`(map).
// Идентичен depth-блоку мега-шейдера. uHasDepth=0 -> сквозной проброс (нет глубины — нет эффекта).
export const pixelatePassFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform vec2  uTexel;
  uniform sampler2D uDepthMap;
  uniform float uHasDepth;
  uniform float uPixNear;
  uniform float uPixFar;
  uniform float uRampNear;
  uniform float uRampFar;
  uniform float uPixGrid;
  uniform float uPixBlur;
  varying vec2 vUv;
  void main() {
    vec2 uv = vUv;
    vec2 suv = uv;
    float blk = 0.0;
    if (uHasDepth > 0.5) {
      vec2 res = 1.0 / uTexel;
      vec2 pix = uv * res;
      float dd = texture2D(uDepthMap, vec2(uv.x, 1.0 - uv.y)).r;
      float t = clamp((uRampNear - dd) / (uRampNear - uRampFar + 1e-4), 0.0, 1.0);
      float block = max(1.0, mix(uPixNear, uPixFar, t));
      if (uPixGrid > 0.5) {
        block = exp2(floor(log2(block) + 0.5));                 // -> ближайшая степень 2
        vec2 c0 = (floor(pix / block) + 0.5) * block;           // центр предварительной ячейки
        float dd2 = texture2D(uDepthMap, vec2(c0.x / res.x, 1.0 - c0.y / res.y)).r;
        float t2 = clamp((uRampNear - dd2) / (uRampNear - uRampFar + 1e-4), 0.0, 1.0);
        block = max(1.0, exp2(floor(log2(mix(uPixNear, uPixFar, t2)) + 0.5))); // единый размер на ячейку
      }
      suv = (floor(pix / block) + 0.5) * block / res;
      blk = block;
    }
    vec3 src;
    if (blk > 0.0 && uPixBlur > 0.001) {
      vec2 o = uTexel * blk * 0.33 * clamp(uPixBlur, 0.0, 1.0);
      vec3 a = texture2D(uTex, suv).rgb;
      a += texture2D(uTex, suv + vec2( o.x,  o.y)).rgb;
      a += texture2D(uTex, suv + vec2(-o.x,  o.y)).rgb;
      a += texture2D(uTex, suv + vec2( o.x, -o.y)).rgb;
      a += texture2D(uTex, suv + vec2(-o.x, -o.y)).rgb;
      src = a / 5.0;
    } else {
      src = texture2D(uTex, suv).rgb;
    }
    gl_FragColor = vec4(src, 1.0);
  }
`;

// Эмиссия для bloom: выводит цвет палитры там, где уровень яркости помечен светящимся,
// иначе чёрный. Полное разрешение (сэмпл видео в точке, без привязки к ячейке).
export const emissiveFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform vec2  uTexel;
  uniform float uVideoAspect;
  uniform float uViewAspect;
  uniform float uFit;
  uniform float uOn;        // 1 = pixelArt && mono && есть светящиеся уровни
  uniform float uLevels;
  uniform vec3  uPalette[16];
  uniform float uGlowMask[16];
  varying vec2 vUv;
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  vec3 emissiveAt(float lvl) { vec3 c = vec3(0.0); for (int i = 0; i < 16; i++) { if (float(i) == lvl) c = uPalette[i] * uGlowMask[i]; } return c; }
  vec2 coverUv(vec2 uv) {
    float r = uViewAspect / uVideoAspect;
    vec2 c = uv - 0.5;
    if (uFit < 0.5) { if (r > 1.0) c.y /= r; else c.x *= r; }
    else { if (r > 1.0) c.x *= r; else c.y /= r; }
    return c + 0.5;
  }
  void main() {
    if (uOn < 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec2 uv = coverUv(vUv);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float steps = max(uLevels, 1.0);
    float L = luma(texture2D(uTex, uv).rgb);
    float lvl = clamp(floor(L * steps), 0.0, steps - 1.0);
    gl_FragColor = vec4(emissiveAt(lvl), 1.0);
  }
`;

// Feedback петля (map→map): смешивает текущий кадр с затухающей историей.
// Микротрансформ истории (zoom/rotate/offset) даёт эффект движения/шлейфа.
// uHistory — RT предыдущего кадра; uTex — текущий вход цепочки.
// Режимы: over (history·decay перекрыт src) / add (сложение — яркое накапливается).
// БЕЗ гамма-коррекции: только texture2D + gl_FragColor (как scanlinesPassFragment).
export const feedbackPassFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform sampler2D uHistory;
  uniform float uDecay;
  uniform float uFbZoom;
  uniform float uFbRotate;
  uniform float uFbOffX;
  uniform float uFbOffY;
  uniform float uFbMode;   // 0 = over, 1 = add
  varying vec2 vUv;
  void main() {
    vec2 c = vUv - 0.5;
    float cs = cos(uFbRotate), sn = sin(uFbRotate);
    vec2 r = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y);
    vec2 huv = r / max(uFbZoom, 0.001) + 0.5 + vec2(uFbOffX, uFbOffY);
    vec3 h = texture2D(uHistory, huv).rgb;
    vec3 src = texture2D(uTex, vUv).rgb;
    vec3 col;
    if (uFbMode > 0.5) {
      col = clamp(src + h * uDecay, 0.0, 1.0);          // add: яркое накапливается (блюм)
    } else {
      col = mix(src, h, uDecay);                        // over: эхо/шлейф; статика остаётся full-bright
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Kaleidoscope (зеркала/мандала) как map→map: складывает кадр в N секторов вокруг центра.
// Внутри клина — зеркальное отражение. Параметры: uSectors (2..16), uAngle (поворот рад).
// БЕЗ fit: координаты vUv напрямую (как scanlines/lookup); uTexel не нужен (нет смещений).
export const mirrorPassFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform float uSectors;
  uniform float uAngle;
  varying vec2 vUv;
  void main() {
    vec2 c = vUv - 0.5;
    float r = length(c);
    float a = atan(c.y, c.x) + uAngle;
    float seg = 6.28318530718 / max(uSectors, 1.0);
    a = mod(a, seg);
    a = abs(a - seg * 0.5);
    vec2 p = vec2(cos(a), sin(a)) * r + 0.5;
    p = clamp(p, 0.0, 1.0);
    gl_FragColor = vec4(texture2D(uTex, p).rgb, 1.0);
  }
`;

// Displace (UV-смещение): глитч/жидкость map→map.
// Режим "noise" — 2D value-hash нойз (без текстур); "self" — сам кадр как карта смещения.
// БЕЗ гаммы: только texture2D + gl_FragColor (SRGB round-trip как у соседних).
export const displacePassFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform float uDisplaceAmount;   // амплитуда смещения (0..0.2)
  uniform float uDisplaceScale;    // масштаб нойза (1..50)
  uniform float uDisplaceSpeed;    // скорость анимации (0..5)
  uniform float uTime;
  uniform float uDisplaceMode;     // 0 = noise, 1 = self
  varying vec2 vUv;
  // 2D value-hash нойз (классический, без текстур).
  float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }
  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f); // smooth
    return mix(
      mix(hash21(i),          hash21(i + vec2(1.0, 0.0)), u.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
  void main() {
    vec2 disp;
    if (uDisplaceMode > 0.5) {
      // self: luma соседнего сэмпла как карта смещения
      float lum = dot(texture2D(uTex, vUv).rgb, vec3(0.299, 0.587, 0.114));
      disp = vec2(cos(lum * 6.2832), sin(lum * 6.2832)) * uDisplaceAmount;
    } else {
      // noise: процедурный 2D value-шум
      vec2 sp = vUv * uDisplaceScale + uTime * uDisplaceSpeed * 0.1;
      float nx = valueNoise(sp);
      float ny = valueNoise(sp + vec2(31.41, 17.97));
      disp = (vec2(nx, ny) - 0.5) * 2.0 * uDisplaceAmount;
    }
    vec2 uv = clamp(vUv + disp, 0.0, 1.0);
    gl_FragColor = vec4(texture2D(uTex, uv).rgb, 1.0);
  }
`;

// Chromatic Aberration: раздельный сдвиг R/G/B каналов. G на месте; R и B в противоположные стороны.
// Режим "radial" — сдвиг от центра, сила растёт к краям; "linear" — фикс-вектор по углу.
// Stateless, времени не нужно.
export const chromAbPassFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform float uChromAbAmount;  // сила (0..0.05)
  uniform float uChromAbAngle;   // угол (rad, для linear режима, 0..2π)
  uniform float uChromAbMode;    // 0 = radial, 1 = linear
  varying vec2 vUv;
  void main() {
    vec2 center = vUv - 0.5;
    vec2 dir;
    if (uChromAbMode > 0.5) {
      // linear: фиксированный вектор по углу
      dir = vec2(cos(uChromAbAngle), sin(uChromAbAngle)) * uChromAbAmount;
    } else {
      // radial: сила растёт к краям (длина от центра)
      dir = center * uChromAbAmount * 2.0;
    }
    float r = texture2D(uTex, clamp(vUv + dir,        0.0, 1.0)).r;
    float g = texture2D(uTex, vUv).g;
    float b = texture2D(uTex, clamp(vUv - dir,        0.0, 1.0)).b;
    gl_FragColor = vec4(r, g, b, 1.0);
  }
`;

// Grain: плёночное зерно, анимируется по uTime. Аддитивно-центрированный микс (при amount=0 выход==вход).
// grainSize — квантование координат пикселя через floor (1=полный пиксель, 8=крупные зёрна).
// grainColored — три независимых hash-канала (цветной) vs один канал на все (монохром).
// Hash-шум от (квантованный gl_FragCoord, uTime) — без текстур, без аллокаций.
export const grainPassFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform float uGrainAmount;   // сила зерна (0..1)
  uniform float uGrainSize;     // размер зерна (1..8)
  uniform float uGrainColored;  // 1 = цветное зерно, 0 = монохром
  uniform float uTime;
  varying vec2 vUv;
  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }
  void main() {
    vec3 src = texture2D(uTex, vUv).rgb;
    // Квантование координат для размера зерна: floor(coord/grainSize)*grainSize
    vec2 coord = floor(gl_FragCoord.xy / max(uGrainSize, 1.0));
    float t = floor(uTime * 24.0); // 24 кадра/сек «плёнки»
    float noise;
    vec3 grain;
    if (uGrainColored > 0.5) {
      grain = vec3(
        hash(coord + vec2(t * 1.31, 0.0)) - 0.5,
        hash(coord + vec2(0.0, t * 1.71)) - 0.5,
        hash(coord + vec2(t * 0.93, t * 1.13)) - 0.5
      );
    } else {
      noise = hash(coord + vec2(t * 1.31, t * 0.71)) - 0.5;
      grain = vec3(noise);
    }
    gl_FragColor = vec4(src + grain * uGrainAmount, 1.0);
  }
`;

// Сепарабельный гаусс (9 тапов) — для bloom-блюра. uDir — шаг в uv по одной оси.
export const blurFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform vec2 uDir;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(uTex, vUv).rgb * 0.2270270270;
    c += texture2D(uTex, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
    c += texture2D(uTex, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
    c += texture2D(uTex, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
    c += texture2D(uTex, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
    gl_FragColor = vec4(c, 1.0);
  }
`;
