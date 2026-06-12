// T5-СПАЙК: React-обёртка жизненного цикла GPU-частиц (ParticleSpike).
//
// Монтируется ТОЛЬКО когда particlesEnabled=true (App рендерит условно) → канвас создаётся свежим
// на каждое включение и полностью освобождается на выключении (см. dispose). Это снимает риск
// повторного бинда WebGPU-контекста к уже использованному канвасу (double-ownership).
//
// Канвас — position:absolute поверх flat (zIndex по образцу CloudCanvas), pointerEvents:none
// (не перехватывает UI). Размер держим через ResizeObserver — НЕ читаем layout в rAF (CLAUDE.md §0.2).

import { useEffect, useRef } from "react";
import type { CompositeBlend } from "../core/types";
import { ParticleSpike, type ParticleBackend } from "./particles/ParticleSpike";

interface Props {
  zIndex?: number;
  blendMode?: CompositeBlend; // CSS mix-blend-mode (для спайка канвас прозрачный → "normal" ок)
  onBackend?: (b: ParticleBackend | null) => void; // диагностика: какой бэкенд реально активен
}

export function ParticleCanvas({ zIndex = 2, blendMode = "normal", onBackend }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let alive = true;
    let raf = 0;
    let last = 0;
    const spike = new ParticleSpike(canvas);

    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) spike.resize(r.width, r.height);
    });
    ro.observe(canvas);

    const initP = spike
      .init()
      .then(() => {
        if (!alive) return; // размонтировали пока шёл init — не стартуем цикл
        onBackend?.(spike.backend);
        if (import.meta.env.DEV) (window as unknown as { __particles?: unknown }).__particles = spike;
        const r = canvas.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) spike.resize(r.width, r.height);
        last = performance.now();
        const loop = (t: number) => {
          if (!alive) return;
          const dt = t - last;
          last = t;
          spike.frame(dt);
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      })
      .catch((e) => console.error("[ParticleCanvas] init failed", e));

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      // dispose ТОЛЬКО после того, как init() полностью завершится — иначе renderer.dispose()
      // гонится с await renderer.init()/computeAsync внутри init и роняет WebGPU-девайс (config-reviewer).
      initP.finally(() => spike.dispose());
      onBackend?.(null);
      if (import.meta.env.DEV) delete (window as unknown as { __particles?: unknown }).__particles;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex, mixBlendMode: blendMode, pointerEvents: "none" }}
    />
  );
}
