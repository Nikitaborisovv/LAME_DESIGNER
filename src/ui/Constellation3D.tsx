import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { SceneConfig, VisionResult } from "../core/types";
import type { DepthApi } from "../ml/useDepth";
import { serpPath, tintRgba } from "./constellationUtil";

// 3D-constellation: точки vision-фич поднимаются на поверхность по глубине
// (z = −d·depthScale), проецируются через камеру облака на экран, соединяются
// кривыми Безье. Привязано к 3D-поверхности -> едет за камерой при вращении.
// Часть точек получает случайное значение (метку).

const h01 = (n: number) => { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); };
const hexToRgb = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 60, g: 255, b: 170 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
const rgba = (hex: string, a: number) => { const c = hexToRgb(hex); return `rgba(${c.r},${c.g},${c.b},${a.toFixed(3)})`; };
const labelOf = (i: number) => (((h01(i * 3.13) * 0xfff) | 0).toString(16).toUpperCase().padStart(3, "0"));

interface Sm { x: number; y: number; a: number; }

export function Constellation3D({
  resultRef, depth, video, config, cameraRef,
}: {
  resultRef: React.MutableRefObject<VisionResult>;
  depth: DepthApi;
  video: HTMLVideoElement | null;
  config: SceneConfig;
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const sm = useRef<Sm[] | null>(null);
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const vec = useRef(new THREE.Vector3());
  // Пулы переиспользуются между кадрами (никаких аллокаций массивов/Vector3 в rAF).
  const buf = useRef<{
    n: number; ds: Float32Array; sx: Float32Array; sy: Float32Array; sv: Uint8Array;
    px: Float32Array; py: Float32Array; pz: Float32Array;
  } | null>(null);

  useEffect(() => {
    if (!video) return;
    let raf = 0;
    const draw = () => {
      const svg = svgRef.current;
      const cam = cameraRef.current;
      if (svg && cam) {
        const cw = svg.clientWidth, ch = svg.clientHeight;
        const cfg = cfgRef.current;
        if (!cfg.constellationEnabled) { svg.innerHTML = ""; raf = requestAnimationFrame(draw); return; }

        const target = resultRef.current.features;
        if (!sm.current || sm.current.length !== target.length) {
          sm.current = target.map((p) => ({ x: p.x, y: p.y, a: 0 }));
        }
        const s = sm.current;
        const k = 1 - cfg.constellationSmooth * 0.92;
        for (let i = 0; i < s.length; i++) {
          const t = target[i];
          if (t.strength > 0) { s[i].x += (t.x - s[i].x) * k; s[i].y += (t.y - s[i].y) * k; }
          s[i].a += ((t.strength > 0 ? 1 : 0) - s[i].a) * Math.min(1, k + 0.05);
        }

        const frame = cfg.cacheEnabled && depth.hasCache()
          ? depth.getCached(video.currentTime) : depth.latestRef.current;
        const aspect = video.videoWidth / video.videoHeight || 16 / 9;
        const depthScale = cfg.depthScale;

        // пулы переиспользуются между кадрами; растут только при смене числа точек
        const n = s.length;
        let B = buf.current;
        if (!B || B.n !== n) {
          B = { n, ds: new Float32Array(n), sx: new Float32Array(n), sy: new Float32Array(n),
                sv: new Uint8Array(n), px: new Float32Array(n), py: new Float32Array(n), pz: new Float32Array(n) };
          buf.current = B;
        }
        const { ds, sx, sy, sv, px, py, pz } = B;

        // глубина каждой точки (0..1; 1 ближе, 0 дальше), 3D-позиция и проекция на экран —
        // одним проходом, без аллокаций. sv[i] — попала ли точка в кадр (видима).
        const W = frame && frame.width > 1 ? frame.width : 0;
        const H = frame ? frame.height : 0;
        for (let i = 0; i < n; i++) {
          const p = s[i];
          if (p.a < 0.15) { ds[i] = 0; sv[i] = 0; continue; }
          if (W) {
            const ix = Math.min(W - 1, Math.max(0, Math.round(p.x * (W - 1))));
            const jy = Math.min(H - 1, Math.max(0, Math.round(p.y * (H - 1))));
            ds[i] = frame!.data[jy * W + ix] / 255;
          } else ds[i] = 0;
          px[i] = (1 - 2 * p.x) * aspect; py[i] = 1 - 2 * p.y; pz[i] = -ds[i] * depthScale;
          vec.current.set(px[i], py[i], pz[i]).project(cam);
          if (vec.current.z < -1 || vec.current.z > 1) { sv[i] = 0; continue; }
          sx[i] = (vec.current.x * 0.5 + 0.5) * cw; sy[i] = (-vec.current.y * 0.5 + 0.5) * ch; sv[i] = 1;
        }

        const c1 = cfg.constellationColor, c2 = cfg.constellationColor2;
        const maxD = cfg.linkDistance * 2.6; // в 3D-нормированных единицах
        const zWeight = 1.7; // глубина весомее в дистанции -> линии льнут к поверхностям (реконструкция)
        const scMin = cfg.constellationScaleMin, scMax = cfg.constellationScaleMax;
        const defs: string[] = [], body: string[] = [];
        let gid = 0, links = 0;

        for (let i = 0; i < n && links < 600; i++) {
          if (!sv[i]) continue;
          for (let j = i + 1; j < n && links < 600; j++) {
            if (!sv[j]) continue;
            // дистанция с усиленным весом глубины -> связываются точки одной поверхности
            const dx = px[i] - px[j], dy = py[i] - py[j], dz = (pz[i] - pz[j]) * zWeight;
            if (dx * dx + dy * dy + dz * dz > maxD * maxD) continue;
            links++;
            const ax = sx[i], ay = sy[i], bx = sx[j], by = sy[j];
            // толщина линии по глубине (ближе -> толще)
            const df = (scMin + (scMax - scMin) * (ds[i] + ds[j]) * 0.5) / scMax;
            const sw = Math.max(0.12, cfg.lineWidth * df * (1 + (h01(i * 131 + j) - 0.5) * 2 * cfg.lineWidthRandom));
            const o = Math.min(s[i].a, s[j].a) * 0.6;
            const id = `c${gid++}`;
            defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>`);
            body.push(`<path d="${serpPath(ax, ay, bx, by, cfg.constellationCurve, cfg.constellationLineAxis)}" fill="none" stroke="url(#${id})" stroke-width="${sw.toFixed(2)}" stroke-opacity="${o.toFixed(2)}"/>`);
          }
        }
        for (let i = 0; i < n; i++) {
          if (!sv[i]) continue;
          const x = sx[i], y = sy[i];
          const r = Math.max(0.3, scMin + (scMax - scMin) * ds[i]); // ближе -> крупнее точка
          const tint = tintRgba(c1, c2, h01(i * 1.7), s[i].a);
          body.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="${tint}"/>`);
          if (h01(i * 7.31) < cfg.constellationLabelChance) {
            body.push(`<text x="${(x + 4).toFixed(1)}" y="${(y - 4).toFixed(1)}" fill="${tintRgba(c1, c2, h01(i * 1.7), s[i].a * 0.9)}" font-size="9" font-family="monospace">${labelOf(i)}</text>`);
          }
        }

        svg.innerHTML = `<defs>${defs.join("")}</defs>${body.join("")}`;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [video, depth, resultRef, cameraRef]);

  return (
    <svg ref={svgRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 4 }} />
  );
}
