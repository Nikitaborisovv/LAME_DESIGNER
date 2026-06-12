import { useEffect, useRef } from "react";
import type { SceneConfig, VisionResult, FaceResult, PeopleFrame } from "../core/types";
import type { DepthApi } from "../ml/useDepth";
import { perf } from "../core/perf";
import { oneEuro, newEuroState, type EuroState } from "./oneEuro";
import { serpCurve, tintRgba } from "./constellationUtil";

// Векторный оверлей: движение, constellation-сетка, лица, ASCII-частицы, HUD-текст.
// Вся временная стабилизация (сглаживание/фейк-трекинг) живёт здесь, в ref'ах, и крутится
// на rAF — без React-ререндера. Нормированные координаты (0..1 кадра) маппятся в экран тем
// же фитом, что и шейдер (App передаёт "contain").
//
// Рендер: Canvas2D, не SVG (ARCHITECTURE §0.2/§3 P1). Иммедиэйт-мод убирает per-frame reparse
// `innerHTML` и reflow — главный лаг по замеру. Размер кешируем через ResizeObserver, НЕ читаем
// clientWidth в кадре (чтение layout форсирует reflow). При текущих количествах точек
// (constellation ≤ ~200, faceMesh 468) Canvas2D достаточно; WebGL — для тысяч+ точек/3D.

const ASCII = "01<>/\\*#+=±¥§".split("");

// 4-цветная палитра для случайного раскраса точек сетки лица.
const MESH_PALETTE = ["#ffe23c", "#3cff8b", "#36a0ff", "#ff4d4d"]; // жёлтый, зелёный, синий, красный

// детерминированный «рандом» 0..1 по числу (стабилен между кадрами)
const h01 = (n: number) => {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};

const hexToRgb = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 255, g: 255, b: 255 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
const rgba = (hex: string, a: number) => {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
};

interface Track { id: number; x: number; y: number; w: number; h: number; act: number; alpha: number; matched: boolean; }
interface Particle { x: number; y: number; baseX: number; vy: number; seed: number; life: number; max: number; ch: string; size: number; }
interface SmFaceBox { x: number; y: number; w: number; h: number; score: number; kp: { x: number; y: number }[]; }

export function Overlay({
  resultRef,
  facesRef,
  peopleRef,
  config,
  video,
  fit = "contain",
  depth,
}: {
  resultRef: React.MutableRefObject<VisionResult>;
  facesRef: React.MutableRefObject<FaceResult>;
  peopleRef: React.MutableRefObject<PeopleFrame | null>;
  config: SceneConfig;
  video: HTMLVideoElement | null;
  fit?: "cover" | "contain";
  depth?: DepthApi; // для 2D-constellation: глубинные кью + фейк-перспектива
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const depthRef = useRef(depth);
  depthRef.current = depth;
  // живой ref на видео — чтобы цикл отрисовки не зависел от тайминга загрузки видео.
  const videoRef = useRef(video);
  videoRef.current = video;

  // стабилизированное состояние
  const tracks = useRef<Track[]>([]);
  const particles = useRef<Particle[]>([]);
  const smFaceBoxes = useRef<SmFaceBox[] | null>(null);
  // сглаженная сетка лица: каждая из 468 точек фильтруется One-Euro к последней детекции.
  const smMeshes = useRef<{ pts: { x: number; y: number }[]; sx: EuroState[]; sy: EuroState[]; edges: number[] }[] | null>(null);
  const smPeopleBoxes = useRef<{ x: number; y: number; w: number; h: number }[] | null>(null);
  const smConst = useRef<{ x: number; y: number; a: number }[] | null>(null);
  const nextId = useRef(0);
  const lastT = useRef(0);

  const active =
    config.motionEnabled || config.constellation2DEnabled ||
    config.faceBoxesEnabled || config.faceMeshEnabled || config.hudText.length > 0 ||
    config.peopleBoxEnabled;

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;

    // Размер кешируем через ResizeObserver, НЕ читаем clientWidth в кадре (избегаем reflow).
    const size = { cw: 0, ch: 0, dpr: 1 };
    const applySize = (cw: number, ch: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      size.cw = cw; size.ch = ch; size.dpr = dpr;
      const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    };
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      applySize(cr.width, cr.height);
    });
    ro.observe(canvas);
    applySize(canvas.clientWidth, canvas.clientHeight);

    // размеры видео в контейнере при выбранном фите (для маппинга нормир. координат)
    const dims = (cw: number, ch: number) => {
      const v = videoRef.current;
      const va = (v ? v.videoWidth / v.videoHeight : 0) || 16 / 9;
      const ca = cw / ch;
      let dw: number, dh: number;
      if (fit === "cover") {
        if (va > ca) { dh = ch; dw = ch * va; } else { dw = cw; dh = cw / va; }
      } else {
        if (va > ca) { dw = cw; dh = cw / va; } else { dh = ch; dw = ch * va; }
      }
      return { dw, dh };
    };
    const map = (nx: number, ny: number, cw: number, ch: number) => {
      const { dw, dh } = dims(cw, ch);
      return [(cw - dw) / 2 + nx * dw, (ch - dh) / 2 + ny * dh] as const;
    };

    // L-уголки рамки (бокс движения/лица): тот же вид, что был у SVG-corners.
    const corners = (x: number, y: number, x2: number, y2: number, stroke: string | CanvasGradient, sw: number) => {
      const w = x2 - x, hh = y2 - y;
      const t = Math.max(8, Math.min(w, hh) * 0.18);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = sw;
      ctx.beginPath();
      ctx.moveTo(x, y + t); ctx.lineTo(x, y); ctx.lineTo(x + t, y);
      ctx.moveTo(x2 - t, y); ctx.lineTo(x2, y); ctx.lineTo(x2, y + t);
      ctx.moveTo(x2, y2 - t); ctx.lineTo(x2, y2); ctx.lineTo(x2 - t, y2);
      ctx.moveTo(x + t, y2); ctx.lineTo(x, y2); ctx.lineTo(x, y2 - t);
      ctx.stroke();
    };

    const draw = () => {
      const { cw, ch, dpr } = size;
      if (!videoRef.current || !cw || !ch) { raf = requestAnimationFrame(draw); return; }
      const endDraw = perf.mark("overlay.draw");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.lineJoin = "miter";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";

      const cfg = cfgRef.current;
      const now = performance.now();
      let dt = lastT.current ? (now - lastT.current) / 1000 : 0.016;
      lastT.current = now;
      dt = Math.min(dt, 0.05);
      const time = now / 1000;

      // ===== MOTION (трекер боксов + градиент + ASCII-частицы) =====
      if (cfg.motionEnabled) {
        const dets = resultRef.current.boxes;
        const used = new Array(dets.length).fill(false);
        const km = 1 - cfg.motionSmooth * 0.9;
        for (const tr of tracks.current) {
          let best = -1, bestD = 0.18 * 0.18;
          const cx = tr.x + tr.w / 2, cy = tr.y + tr.h / 2;
          for (let i = 0; i < dets.length; i++) {
            if (used[i]) continue;
            const d = dets[i];
            const dx = d.x + d.w / 2 - cx, dy = d.y + d.h / 2 - cy;
            const dd = dx * dx + dy * dy;
            if (dd < bestD) { bestD = dd; best = i; }
          }
          if (best >= 0) {
            const d = dets[best]; used[best] = true; tr.matched = true;
            tr.x += (d.x - tr.x) * km; tr.y += (d.y - tr.y) * km;
            tr.w += (d.w - tr.w) * km; tr.h += (d.h - tr.h) * km;
            tr.act += (d.activity - tr.act) * km;
          } else tr.matched = false;
        }
        for (let i = 0; i < dets.length; i++) {
          if (used[i]) continue;
          const d = dets[i];
          tracks.current.push({ id: nextId.current++, x: d.x, y: d.y, w: d.w, h: d.h, act: d.activity, alpha: 0, matched: true });
        }
        tracks.current = tracks.current.filter((tr) => {
          tr.alpha += ((tr.matched ? 1 : 0) - tr.alpha) * 0.2;
          return tr.alpha > 0.03;
        });

        const c1 = cfg.motionColor, c2 = cfg.motionColor2;
        for (const tr of tracks.current) {
          const [x, y] = map(tr.x, tr.y, cw, ch);
          const [x2, y2] = map(tr.x + tr.w, tr.y + tr.h, cw, ch);
          ctx.globalAlpha = tr.alpha;
          const grad = ctx.createLinearGradient(x, 0, x2, 0);
          grad.addColorStop(0, c1); grad.addColorStop(1, c2);
          corners(x, y, x2, y2, grad, cfg.motionThickness);
          ctx.fillStyle = rgba(c1, 0.06);
          ctx.fillRect(x, y, x2 - x, y2 - y);
          if (cfg.motionLabel) {
            ctx.fillStyle = c1;
            ctx.font = `${cfg.motionLabelSize}px monospace`;
            ctx.fillText(`${cfg.motionLabel} ${(tr.act * 100).toFixed(0)}%`, x + 3, y - 4);
          }
          ctx.globalAlpha = 1;

          // спавн ASCII-частиц от источника движения
          if (cfg.motionAscii && tr.alpha > 0.5) {
            const prob = cfg.motionAsciiDensity * (0.3 + tr.act) * dt * 14;
            if (Math.random() < prob && particles.current.length < 240) {
              const [px, py] = map(tr.x + Math.random() * tr.w, tr.y + tr.h * (0.5 + Math.random() * 0.5), cw, ch);
              particles.current.push({
                x: px, baseX: px, y: py, vy: 28 + Math.random() * 55,
                seed: Math.random() * 100, life: 1.0 + Math.random() * 1.8,
                max: 0, ch: ASCII[(Math.random() * ASCII.length) | 0], size: 9 + Math.random() * 6,
              });
              const p = particles.current[particles.current.length - 1]; p.max = p.life;
            }
          }
        }
      }

      // ===== ASCII-частицы: апдейт + отрисовка =====
      if (particles.current.length) {
        const col = cfg.motionColor;
        particles.current = particles.current.filter((p) => {
          p.life -= dt;
          if (p.life <= 0) return false;
          p.y -= p.vy * dt;
          p.x = p.baseX + Math.sin(time * 2.5 + p.seed) * 14 + Math.sin(time * 0.7 + p.seed * 3) * 8;
          const a = Math.min(1, p.life / p.max) * 0.9;
          ctx.fillStyle = rgba(col, a);
          ctx.font = `${p.size.toFixed(1)}px monospace`;
          ctx.fillText(p.ch, p.x, p.y);
          return true;
        });
      }

      // ===== CONSTELLATION 2D (screen-space: точки ровно на видео; глубина -> размер/
      // яркость/связи; fakePerspective радиально растягивает по глубине = имитация линзы) =====
      if (cfg.constellation2DEnabled) {
        const target = resultRef.current.features;
        if (!smConst.current || smConst.current.length !== target.length) {
          smConst.current = target.map((p) => ({ x: p.x, y: p.y, a: 0 }));
        }
        const s = smConst.current;
        const kk = 1 - cfg.constellationSmooth * 0.92;
        for (let i = 0; i < s.length; i++) {
          const t = target[i];
          if (t.strength > 0) { s[i].x += (t.x - s[i].x) * kk; s[i].y += (t.y - s[i].y) * kk; }
          s[i].a += ((t.strength > 0 ? 1 : 0) - s[i].a) * Math.min(1, kk + 0.05);
        }
        const dp = depthRef.current;
        const dframe = dp
          ? (cfg.cacheEnabled && dp.hasCache()
              ? dp.getCached(videoRef.current!.currentTime)
              : (dp.smoothedRef.current ?? dp.latestRef.current))
          : null;
        const W = dframe && dframe.width > 1 ? dframe.width : 0;
        const H = dframe ? dframe.height : 0;
        const fp = cfg.fakePerspective;
        const c1 = cfg.constellationColor, c2 = cfg.constellationColor2;
        const scMin = cfg.constellationScaleMin, scMax = cfg.constellationScaleMax;

        // позиции с фейк-перспективой: ближние (d→1) — наружу, дальние (d→0) — к центру
        const P = s.map((p) => {
          if (p.a < 0.12) return null;
          let d = 0.5;
          if (W) {
            const ix = Math.min(W - 1, Math.max(0, Math.round(p.x * (W - 1))));
            const jy = Math.min(H - 1, Math.max(0, Math.round(p.y * (H - 1))));
            d = dframe!.data[jy * W + ix] / 255;
          }
          const f = 1 + fp * (2 * d - 1) * 0.9;
          const nx = 0.5 + (p.x - 0.5) * f, ny = 0.5 + (p.y - 0.5) * f;
          const [sx, sy] = map(nx, ny, cw, ch);
          return { nx, ny, sx, sy, d, a: p.a };
        });

        const maxD = cfg.linkDistance;
        let links = 0;
        for (let i = 0; i < P.length && links < 600; i++) {
          const a = P[i]; if (!a) continue;
          for (let j = i + 1; j < P.length && links < 600; j++) {
            const b = P[j]; if (!b) continue;
            const dx = a.nx - b.nx, dy = a.ny - b.ny;
            if (dx * dx + dy * dy > maxD * maxD) continue;
            links++;
            const df = (scMin + (scMax - scMin) * (a.d + b.d) * 0.5) / scMax;
            const sw = Math.max(0.12, cfg.lineWidth * df * (1 + (h01(i * 131 + j) - 0.5) * 2 * cfg.lineWidthRandom));
            const o = Math.min(a.a, b.a) * 0.6;
            const grad = ctx.createLinearGradient(a.sx, a.sy, b.sx, b.sy);
            grad.addColorStop(0, c1); grad.addColorStop(1, c2);
            ctx.strokeStyle = grad;
            ctx.lineWidth = sw;
            ctx.globalAlpha = o;
            ctx.beginPath();
            serpCurve(ctx, a.sx, a.sy, b.sx, b.sy, cfg.constellationCurve, cfg.constellationLineAxis);
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
        for (let i = 0; i < P.length; i++) {
          const p = P[i]; if (!p) continue;
          const r = Math.max(0.3, scMin + (scMax - scMin) * p.d);
          ctx.fillStyle = tintRgba(c1, c2, h01(i * 1.7), p.a);
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
          ctx.fill();
          if (h01(i * 7.31) < cfg.constellationLabelChance) {
            const lbl = (((h01(i * 3.13) * 0xfff) | 0).toString(16).toUpperCase().padStart(3, "0"));
            ctx.fillStyle = tintRgba(c1, c2, h01(i * 1.7), p.a * 0.9);
            ctx.font = "9px monospace";
            ctx.fillText(lbl, p.sx + 4, p.sy - 4);
          }
        }
      }

      // ===== FACE MESH (One-Euro сглаживание на 60гц поверх ~6гц инференса) =====
      if (cfg.faceMeshEnabled) {
        const fm = cfg.faceMeshColor;
        const tgt = facesRef.current.meshes;
        if (!smMeshes.current || smMeshes.current.length !== tgt.length) {
          smMeshes.current = tgt.map((m) => ({
            pts: m.points.map((p) => ({ ...p })),
            sx: m.points.map(() => newEuroState()),
            sy: m.points.map(() => newEuroState()),
            edges: m.edges,
          }));
        }
        const euro = { minCutoff: 2.0 + (1 - cfg.faceSmooth) * 10, beta: 1.5, dCutoff: 1 };
        for (let fi = 0; fi < smMeshes.current.length; fi++) {
          const sm = smMeshes.current[fi], t = tgt[fi];
          if (!t) continue;
          sm.edges = t.edges;
          const tp = t.points, sp = sm.pts;
          const nn = Math.min(sp.length, tp.length);
          for (let i = 0; i < nn; i++) {
            sp[i].x = oneEuro(sm.sx[i], tp[i].x, dt, euro);
            sp[i].y = oneEuro(sm.sy[i], tp[i].y, dt, euro);
          }
          const scr = sp.map((p) => map(p.x, p.y, cw, ch));
          // контуры-сетка (овал, глаза, брови, губы, радужки) — один путь, общий цвет
          ctx.strokeStyle = rgba(fm, 0.55);
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let e = 0; e + 1 < sm.edges.length; e += 2) {
            const a = scr[sm.edges[e]], b = scr[sm.edges[e + 1]];
            if (a && b) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
          }
          ctx.stroke();
          // точки: прореживание + размер + рандом; часть — квадратики; часть — палитра.
          const step = Math.max(1, Math.round(1 / cfg.faceMeshDensity));
          for (let i = 0; i < scr.length; i++) {
            if (i % step !== 0) continue;
            const [x, y] = scr[i];
            const pc =
              cfg.faceMeshColorRandom > 0 && h01(i + 701) < cfg.faceMeshColorRandom
                ? MESH_PALETTE[(h01(i + 1337) * 4) | 0]
                : fm;
            const r = cfg.faceMeshPointSize * (1 + (h01(i) - 0.5) * 2 * cfg.facePointScaleRandom);
            if (h01(i + 9301) < cfg.faceSquareChance) {
              const s2 = Math.max(1.0, r * 1.5);
              ctx.fillStyle = rgba(pc, 0.95);
              ctx.fillRect(x - s2, y - s2, s2 * 2, s2 * 2);
            } else {
              ctx.fillStyle = rgba(pc, 0.9);
              ctx.beginPath();
              ctx.arc(x, y, Math.max(0.7, r), 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }

      // ===== FACE BOXES (EMA + настраиваемый бокс/подпись) =====
      if (cfg.faceBoxesEnabled) {
        const tgt = facesRef.current.boxes;
        if (!smFaceBoxes.current || smFaceBoxes.current.length !== tgt.length) {
          smFaceBoxes.current = tgt.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, score: b.score, kp: b.keypoints.map((p) => ({ ...p })) }));
        }
        const kf = 1 - cfg.faceSmooth * 0.85;
        const col = cfg.faceBoxColor;
        for (let i = 0; i < smFaceBoxes.current.length; i++) {
          const sm = smFaceBoxes.current[i], t = tgt[i];
          if (!t) continue;
          sm.x += (t.x - sm.x) * kf; sm.y += (t.y - sm.y) * kf;
          sm.w += (t.w - sm.w) * kf; sm.h += (t.h - sm.h) * kf;
          sm.score = t.score;
          for (let k = 0; k < sm.kp.length && k < t.keypoints.length; k++) { sm.kp[k].x += (t.keypoints[k].x - sm.kp[k].x) * kf; sm.kp[k].y += (t.keypoints[k].y - sm.kp[k].y) * kf; }
          const [x, y] = map(sm.x, sm.y, cw, ch);
          const [x2, y2] = map(sm.x + sm.w, sm.y + sm.h, cw, ch);
          corners(x, y, x2, y2, col, cfg.faceBoxThickness);
          ctx.fillStyle = rgba(col, 0.06);
          ctx.fillRect(x, y, x2 - x, y2 - y);
          if (cfg.faceLabel) {
            ctx.fillStyle = cfg.faceLabelColor;
            ctx.font = `${cfg.faceLabelSize}px monospace`;
            ctx.fillText(`${cfg.faceLabel} ${(sm.score * 100).toFixed(0)}%`, x + 3, y - 4);
          }
          ctx.fillStyle = col;
          for (const k of sm.kp) {
            const [kx, ky] = map(k.x, k.y, cw, ch);
            ctx.beginPath(); ctx.arc(kx, ky, 1.6, 0, Math.PI * 2); ctx.fill();
          }
        }
      }

      // ===== PEOPLE BBOX (по YOLO; вертикальный градиент + толщина + сглаживание движения) =====
      if (cfg.peopleBoxEnabled) {
        const tgt = peopleRef.current?.boxes ?? [];
        if (!smPeopleBoxes.current || smPeopleBoxes.current.length !== tgt.length) {
          smPeopleBoxes.current = tgt.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
        }
        const kf = 0.35;
        const A = cfg.peopleBoxColor, B = cfg.peopleBoxColor2;
        ctx.lineWidth = cfg.peopleBoxThickness;
        for (let i = 0; i < smPeopleBoxes.current.length; i++) {
          const sm = smPeopleBoxes.current[i], t = tgt[i];
          if (!t) continue;
          sm.x += (t.x - sm.x) * kf; sm.y += (t.y - sm.y) * kf;
          sm.w += (t.w - sm.w) * kf; sm.h += (t.h - sm.h) * kf;
          const [x, y] = map(sm.x, sm.y, cw, ch);
          const [x2, y2] = map(sm.x + sm.w, sm.y + sm.h, cw, ch);
          if (cfg.peopleBoxGradient) {
            const grad = ctx.createLinearGradient(0, y, 0, y2);
            grad.addColorStop(0, A); grad.addColorStop(1, B);
            ctx.strokeStyle = grad;
          } else {
            ctx.strokeStyle = A;
          }
          ctx.strokeRect(x, y, x2 - x, y2 - y);
        }
      }

      // ===== HUD-текст =====
      if (cfg.hudText) {
        const x = cfg.hudX * cw, y = cfg.hudY * ch;
        ctx.fillStyle = cfg.hudTextColor;
        ctx.font = `${cfg.hudTextSize}px monospace`;
        ctx.textAlign = "center";
        (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "2px";
        ctx.fillText(cfg.hudText, x, y);
        (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px";
        ctx.textAlign = "left";
      }

      endDraw();
      perf.tick("overlay.fps");
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [active, resultRef, facesRef, peopleRef, fit]);

  if (!active) return null;
  return (
    <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 5 }} />
  );
}
