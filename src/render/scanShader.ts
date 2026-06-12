// Шейдер облака точек со сканером.
// Сетка точек в плоскости XY (нормированной), Z вытягивается из карты глубины.
// uScan (0..1) бежит по глубине; точки рядом со сканирующим слоем светятся.
//
// Доработки: квадратный нойз сканера, 3-цветный градиент, скрытие по маске сканера,
// градиент размера точек по глубине (дальше — крупнее).

export const scanVertex = /* glsl */ `
  uniform sampler2D uDepth;
  uniform sampler2D uColor;
  uniform float uDepthScale;
  uniform float uPointSize;
  uniform float uScan;
  uniform float uScanWidth;
  uniform float uScanEnabled;
  uniform float uAspect;
  uniform float uNoiseScale;       // размер блока квадратного нойза
  uniform float uNoiseAmount;      // сила нойза (смещение порога сканера)

  varying vec3 vColor;
  varying float vGlow;
  varying float vGradT;            // 0..1 — параметр градиента сканера (по вертикали)
  varying float vDepth;            // нормированная глубина

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec2 uv = position.xy * 0.5 + 0.5;
    vec2 tuv = vec2(1.0 - uv.x, 1.0 - uv.y);

    float d = texture2D(uDepth, tuv).r;
    vColor = texture2D(uColor, tuv).rgb;
    vDepth = d;
    vGradT = uv.y;

    vec3 pos = vec3(position.x * uAspect, position.y, -d * uDepthScale);

    // квадратный (воксельный) нойз: смещаем порог сканера по блочной сетке
    float n = 0.0;
    if (uNoiseAmount > 0.0) {
      vec2 cell = floor(position.xy * uNoiseScale);
      n = (hash(cell) - 0.5) * uNoiseAmount;
    }
    float dist = abs(d - uScan + n);
    vGlow = uScanEnabled * smoothstep(uScanWidth, 0.0, dist);

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uPointSize * (1.0 + vGlow * 2.0), 1.0, 240.0);
  }
`;

export const scanFragment = /* glsl */ `
  precision highp float;
  uniform vec3 uScanColor;
  uniform vec3 uScanColor2;
  uniform vec3 uScanColor3;
  uniform float uScanGradient;   // 1 = 3-цветный градиент
  uniform float uScanHide;       // 1 = скрывать точки за плоскостью сканера
  uniform float uScanOnly;       // 1 = показывать ТОЛЬКО подсвеченные сканером точки
  uniform float uScan;           // позиция сканера (для скрытия)
  uniform float uSquare;         // 1 = квадратные точки (без обрезки в круг)
  varying vec3 vColor;
  varying float vGlow;
  varying float vGradT;
  varying float vDepth;

  vec3 grad3(vec3 a, vec3 b, vec3 c, float t) {
    return t < 0.5 ? mix(a, b, t * 2.0) : mix(b, c, (t - 0.5) * 2.0);
  }

  void main() {
    vec2 cc = gl_PointCoord - 0.5;
    if (uSquare < 0.5 && dot(cc, cc) > 0.25) discard; // круглые/квадратные точки

    // показывать только подсвеченные сканером точки (остальные прозрачны -> видны 2D-эффекты под облаком)
    if (uScanOnly > 0.5 && vGlow < 0.04) discard;

    // скрытие по маске сканера (только визуально)
    if (uScanHide > 0.5 && vDepth > uScan) discard;

    vec3 scanCol = (uScanGradient > 0.5)
      ? grad3(uScanColor, uScanColor2, uScanColor3, vGradT)
      : uScanColor;

    vec3 col = mix(vColor, scanCol, clamp(vGlow, 0.0, 1.0));
    col += scanCol * vGlow * 1.5; // лёгкий bloom
    gl_FragColor = vec4(col, 1.0);
  }
`;
