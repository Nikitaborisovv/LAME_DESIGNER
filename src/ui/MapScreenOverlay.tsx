// Полноэкранный ЧБ-просмотр Map2D-цепочки: провод «Map2D → Экран.видео» показывает CPU-карту
// (Видео.глубина / noise2d / mapCombine) вместо видеотракта (GPU-цепочка при этом спит,
// videoToScreen=false — чёрный фон под нами). Тот же приём, что MapPreview на нодах, но на весь
// экран: резолв mapForRef на НИЗКОЙ частоте (~10Гц), отрисовка — дешёвый drawImage off-DOM
// канваса. Конвенции: Canvas2D, ResizeObserver (без чтения layout в rAF), contain-фит.

import { useEffect, useRef } from "react";
import type { ResolvedMapNode } from "../core/types";
import type { DepthApi } from "../ml/useDepth";
import { mapForRef } from "../core/mapSources";

export function MapScreenOverlay({ mapRef, mapNodes, depth }: {
  mapRef: string;
  mapNodes?: ResolvedMapNode[];
  depth?: DepthApi;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // живые пропы для rAF-цикла (без переподписки эффекта-маунта)
  const pr = useRef({ mapRef, mapNodes, depth });
  pr.current = { mapRef, mapNodes, depth };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let last = 0;

    const size = { cw: 0, ch: 0, dpr: 1 };
    const applySize = (cw: number, ch: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      size.cw = cw; size.ch = ch; size.dpr = dpr;
      const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    };
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      applySize(r.width, r.height);
    });
    ro.observe(canvas);
    applySize(canvas.clientWidth, canvas.clientHeight);

    const off = document.createElement("canvas");
    const octx = off.getContext("2d");

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (!octx || !size.cw || !size.ch || t - last < 100) return; // ~10Гц — CPU-карта, не видеотракт
      last = t;
      const p = pr.current;
      const dApi = p.depth;
      const frame = mapForRef(p.mapRef, {
        depth: dApi?.smoothedRef.current ?? dApi?.latestRef.current ?? null,
        mapNodes: p.mapNodes,
        time: t / 1000,
      });
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      ctx.clearRect(0, 0, size.cw, size.ch);
      if (!frame) return;
      if (off.width !== frame.width || off.height !== frame.height) { off.width = frame.width; off.height = frame.height; }
      const img = octx.createImageData(frame.width, frame.height);
      for (let i = 0; i < frame.data.length; i++) {
        const v = frame.data[i];
        const b = i * 4;
        img.data[b] = v; img.data[b + 1] = v; img.data[b + 2] = v; img.data[b + 3] = 255;
      }
      octx.putImageData(img, 0, 0);
      // contain-фит по аспекту кадра карты (глубина — аспект видео; генераторы — квадрат)
      const fa = frame.width / frame.height, ca = size.cw / size.ch;
      let dw: number, dh: number;
      if (fa > ca) { dw = size.cw; dh = size.cw / fa; } else { dh = size.ch; dw = size.ch * fa; }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, (size.cw - dw) / 2, (size.ch - dh) / 2, dw, dh);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return (
    // z=1 + DOM после Scene: над flat-канвасом (место видеокадра), ПОД частицами (z2) и оверлеями (z5+)
    <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 1 }} />
  );
}
