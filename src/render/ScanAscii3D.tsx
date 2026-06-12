import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { SceneConfig } from "../core/types";
import type { DepthApi } from "../ml/useDepth";

// ASCII-частицы как НАСТОЯЩИЕ 3D-точки в сцене облака:
//  - стоят в 3D на сканируемом слое, летят вверх по Y, угасают;
//  - depthTest -> объекты переднего плана их перекрывают;
//  - разный размер; глиф берётся из атласа шрифта (point-sprite + atlas).

const CHARS = "01<>/\\*#+=x%·:^░▒".split("");
const ATLAS_COLS = 8;
const CAP = 1800; // ёмкость пула частиц

function buildAtlas() {
  const cell = 64;
  const rows = Math.ceil(CHARS.length / ATLAS_COLS);
  const cv = document.createElement("canvas");
  cv.width = ATLAS_COLS * cell;
  cv.height = rows * cell;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.font = `${Math.round(cell * 0.7)}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  CHARS.forEach((ch, i) => {
    const cx = (i % ATLAS_COLS) * cell + cell / 2;
    const cy = Math.floor(i / ATLAS_COLS) * cell + cell / 2;
    ctx.fillText(ch, cx, cy);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return { tex, rows };
}

export function ScanAscii3D({
  video,
  config,
  depth,
  scanRef,
}: {
  video: HTMLVideoElement | null;
  config: SceneConfig;
  depth: DepthApi;
  scanRef: React.MutableRefObject<number>;
}) {
  const head = useRef(0);
  const vy = useRef(new Float32Array(CAP));

  const { geometry, material } = useMemo(() => {
    const { tex, rows } = buildAtlas();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(CAP * 3), 3));
    g.setAttribute("aChar", new THREE.BufferAttribute(new Float32Array(CAP), 1));
    g.setAttribute("aAge", new THREE.BufferAttribute(new Float32Array(CAP).fill(9), 1));
    g.setAttribute("aMax", new THREE.BufferAttribute(new Float32Array(CAP).fill(1), 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(CAP), 1));
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      uniforms: {
        uAtlas: { value: tex },
        uCols: { value: ATLAS_COLS },
        uRows: { value: rows },
        uColor: { value: new THREE.Color("#39ff8b") },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute float aChar; attribute float aAge; attribute float aMax; attribute float aSize;
        varying float vChar; varying float vAlpha;
        void main() {
          vChar = aChar;
          vAlpha = (aAge >= 0.0 && aAge < aMax) ? (1.0 - aAge / aMax) : 0.0;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (vAlpha > 0.0) ? aSize : 0.0;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uAtlas; uniform float uCols; uniform float uRows;
        uniform vec3 uColor; uniform float uOpacity;
        varying float vChar; varying float vAlpha;
        void main() {
          if (vAlpha <= 0.0) discard;
          float col = mod(vChar, uCols);
          float row = floor(vChar / uCols);
          vec2 uv = (vec2(col, row) + gl_PointCoord) / vec2(uCols, uRows);
          float g = texture2D(uAtlas, uv).a;
          if (g < 0.15) discard;
          gl_FragColor = vec4(uColor, g * vAlpha * uOpacity);
        }
      `,
    });
    return { geometry: g, material: m };
  }, []);

  // Освобождение GPU-ресурсов на анмаунте: геометрия, материал и атлас глифов.
  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
    (material.uniforms.uAtlas.value as THREE.Texture)?.dispose();
  }, [geometry, material]);

  useFrame((_, delta) => {
    if (!video || video.readyState < 2) return;
    const dt = Math.min(delta, 0.05);
    const pos = geometry.getAttribute("position").array as Float32Array;
    const age = geometry.getAttribute("aAge").array as Float32Array;
    const max = geometry.getAttribute("aMax").array as Float32Array;
    const chr = geometry.getAttribute("aChar").array as Float32Array;
    const siz = geometry.getAttribute("aSize").array as Float32Array;
    const v = vy.current;
    const speed = config.scanAsciiSpeed;

    // подъём + старение
    for (let k = 0; k < CAP; k++) {
      if (age[k] < max[k]) {
        age[k] += dt;
        pos[k * 3 + 1] += v[k] * speed * dt;
      }
    }

    // спавн на сканируемом слое
    if (config.scanAsciiEnabled) {
      const frame = config.cacheEnabled && depth.hasCache()
        ? depth.getCached(video.currentTime)
        : depth.latestRef.current;
      if (frame && frame.width > 1) {
        const W = frame.width, H = frame.height, data = frame.data;
        const scan = scanRef.current;
        const band = Math.max(0.02, config.scanWidth);
        const aspect = video.videoWidth / video.videoHeight || 16 / 9;
        const depthScale = config.depthScale;
        const attempts = Math.round(220 * config.scanAsciiDensity);
        const fade = Math.max(0.15, config.scanAsciiFade);
        const fr = config.scanAsciiFadeRandom;
        const scMin = config.scanAsciiScaleMin, scMax = config.scanAsciiScaleMax;
        for (let a = 0; a < attempts; a++) {
          const i = (Math.random() * W) | 0;
          const j = (Math.random() * H) | 0;
          const d = data[j * W + i] / 255;
          if (Math.abs(d - scan) < band) {
            const k = head.current; head.current = (head.current + 1) % CAP;
            const ux = 1 - i / W, uy = 1 - j / H;
            pos[k * 3] = (ux * 2 - 1) * aspect;
            pos[k * 3 + 1] = uy * 2 - 1;
            pos[k * 3 + 2] = -d * depthScale;
            chr[k] = (Math.random() * CHARS.length) | 0;
            // скейл по глубине: дальше (d->0) меньше, ближе (d->1) больше, + лёгкий рандом ±10%
            const sc = scMin + (scMax - scMin) * d;
            siz[k] = Math.max(1, sc * (0.9 + Math.random() * 0.2));
            const life = Math.max(0.15, fade * (1 + (Math.random() - 0.5) * 2 * fr));
            age[k] = 0; max[k] = life;
            v[k] = 0.2 + Math.random() * 0.4;
          }
        }
      }
    }

    geometry.getAttribute("position").needsUpdate = true;
    geometry.getAttribute("aAge").needsUpdate = true;
    geometry.getAttribute("aMax").needsUpdate = true;
    geometry.getAttribute("aChar").needsUpdate = true;
    geometry.getAttribute("aSize").needsUpdate = true;
    (material.uniforms.uColor.value as THREE.Color).set(config.scanAsciiColor);
    material.uniforms.uOpacity.value = config.scanAsciiOpacity;
  });

  if (!video) return null;
  return <points geometry={geometry} material={material} frustumCulled={false} />;
}
