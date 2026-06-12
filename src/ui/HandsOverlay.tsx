import { useEffect, useRef } from "react";
import type { SceneConfig, HandResult, HandLandmark } from "../core/types";
import { HAND_CONNECTIONS, FINGERTIPS } from "../ml/handTopology";
import { perf } from "../core/perf";

// Самостоятельный оверлей трекинга рук (НЕ часть общего Overlay): скелет + точки +
// квадраты на кончиках + текстовый HUD позы/жеста. Гейтится своими флагами handsEnabled и
// handSkeleton/handPoints/handHud. Координаты норм. 0..1 кадра маппятся тем же фитом, что и
// шейдер (App передаёт "contain"). Сглаживание дрожи уже сделано в useHands (One Euro);
// здесь добавлен лёгкий покадровый catch-up-lerp, чтобы движение шло на 60fps без «ступенек».
//
// Рендер: Canvas2D, не SVG (ARCHITECTURE §0.2/§3 P1). Иммедиэйт-мод убирает per-frame
// reparse `innerHTML`, который был главным лагом (`hands.draw` ~15мс → ~1мс). Для оверлеев с
// малым числом элементов и богатой стилизацией (толстые линии, квадраты, текст) Canvas2D даёт
// точную паритетность дешевле, чем WebGL; WebGL остаётся для масштабных (constellation/частицы).

interface DispHand {
  handedness: "Left" | "Right";
  pts: { x: number; y: number }[]; // отображаемые (lerp), 21 точка
}

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

const GGRAD = "#ffe23c"; // жёлтый акцент для HUD-значений

export function HandsOverlay({
  resultRef,
  config,
  video,
  fit = "contain",
}: {
  resultRef: React.MutableRefObject<HandResult>;
  config: SceneConfig;
  video: HTMLVideoElement | null;
  fit?: "cover" | "contain";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const videoRef = useRef(video);
  videoRef.current = video;
  const dispRef = useRef<DispHand[]>([]); // отображаемые руки (catch-up по handedness)

  const active = config.handsEnabled && (config.handSkeleton || config.handPoints || config.handHud);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;

    // Размер кешируем через ResizeObserver, НЕ читаем clientWidth в кадре: чтение layout в
    // горячем цикле форсирует синхронный reflow (layout-thrash рядом с любым DOM-оверлеем).
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
    applySize(canvas.clientWidth, canvas.clientHeight); // один раз на старте (до первого тика обсервера)

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

    const draw = () => {
      const { cw, ch, dpr } = size;
      if (!videoRef.current || !cw || !ch) { raf = requestAnimationFrame(draw); return; }
      const endDraw = perf.mark("hands.draw");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // рисуем в CSS-пикселях
      ctx.clearRect(0, 0, cw, ch);

      const cfg = cfgRef.current;
      const hands = resultRef.current.hands;

      // catch-up-lerp отображаемых точек к последней детекции (по личности руки).
      // При появлении новой руки / смене числа рук — снап без интерполяции.
      const disp = dispRef.current;
      const next: DispHand[] = [];
      for (const h of hands) {
        const prev = disp.find((d) => d.handedness === h.handedness);
        const src: HandLandmark[] = h.landmarks;
        if (!prev || prev.pts.length !== src.length) {
          next.push({ handedness: h.handedness, pts: src.map((p) => ({ x: p.x, y: p.y })) });
        } else {
          const k = 0.5; // плавность 60fps-движения поверх реже идущей детекции
          for (let i = 0; i < src.length; i++) {
            prev.pts[i].x += (src[i].x - prev.pts[i].x) * k;
            prev.pts[i].y += (src[i].y - prev.pts[i].y) * k;
          }
          next.push(prev);
        }
      }
      dispRef.current = next;

      const tipSet = new Set<number>(FINGERTIPS as readonly number[]);
      for (let hi = 0; hi < hands.length; hi++) {
        const h = hands[hi];
        const d = next[hi];
        const col = h.handedness === "Left" ? cfg.handColorLeft : cfg.handColorRight;
        const scr = d.pts.map((p) => map(p.x, p.y, cw, ch));

        // скелет (кости) — один путь на руку, общий цвет/толщина
        if (cfg.handSkeleton) {
          ctx.strokeStyle = rgba(col, 0.85);
          ctx.lineWidth = cfg.handLineWidth;
          ctx.lineCap = "round";
          ctx.beginPath();
          for (const [a, b] of HAND_CONNECTIONS) {
            const A = scr[a], B = scr[b];
            if (!A || !B) continue;
            ctx.moveTo(A[0], A[1]);
            ctx.lineTo(B[0], B[1]);
          }
          ctx.stroke();
        }

        // точки суставов + квадраты на кончиках
        if (cfg.handPoints) {
          const r = cfg.handTipDotSize / 2;
          const s = cfg.handTipSquareSize;
          ctx.lineWidth = 2;
          for (let i = 0; i < scr.length; i++) {
            const [x, y] = scr[i];
            if (tipSet.has(i)) {
              ctx.strokeStyle = col;
              ctx.strokeRect(x - s / 2, y - s / 2, s, s);
            } else {
              ctx.fillStyle = rgba(col, 0.9);
              ctx.beginPath();
              ctx.arc(x, y, r, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }

        // HUD-текст позы/жеста над запястьем
        if (cfg.handHud) {
          const [wx, wy] = scr[0];
          const rot = (h.pose.rotation.roll * 180) / Math.PI;
          const lines = [
            `${h.handedness} ${(h.score * 100).toFixed(0)}%`,
            cfg.handGestures ? `gesture: ${h.gesture}` : null,
            `open ${(h.pose.openness * 100).toFixed(0)}%  pinch ${(h.pose.pinch * 100).toFixed(0)}%`,
            `roll ${rot.toFixed(0)}°`,
          ].filter(Boolean) as string[];
          ctx.font = "11px monospace";
          ctx.textBaseline = "alphabetic";
          const ty = wy + 18;
          for (let li = 0; li < lines.length; li++) {
            ctx.fillStyle = li === 1 ? GGRAD : col;
            ctx.fillText(lines[li], wx + 12, ty + li * 13);
          }
        }
      }

      endDraw();
      perf.tick("hands.overlayFps");
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [active, resultRef, fit]);

  if (!active) return null;
  return (
    <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 6 }} />
  );
}
