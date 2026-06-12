// Лёгкий диагностический сборщик метрик производительности.
// Главный поток пишет сюда per-stage ms (readback / overlay / render) и счётчики
// частоты (fps видео/рендера/перцепций). Воркеры меряют инференс у себя и присылают
// числа в сообщениях — главный поток их сюда же кладёт (perf.add).
//
// Включается ТОЛЬКО когда открыта PerfPanel (perf.enabled=true). Пока выключено —
// add/mark/tick делают ранний выход -> в обычной работе оверхед ~ноль.

interface Stage {
  ema: number;     // сглаженная длительность, мс (0 для чистых счётчиков)
  winMax: number;  // пик за текущее окно
  max: number;     // пик за прошлое окно (для показа)
  count: number;   // событий за текущее окно
  rate: number;    // событий/сек (из прошлого окна)
}

const NOOP = () => {};

class Perf {
  enabled = false;
  private stages = new Map<string, Stage>();
  private lastFlush = 0;

  private get(name: string): Stage {
    let s = this.stages.get(name);
    if (!s) { s = { ema: 0, winMax: 0, max: 0, count: 0, rate: 0 }; this.stages.set(name, s); }
    return s;
  }

  // Записать длительность стадии (мс).
  add(name: string, ms: number) {
    if (!this.enabled || !(ms >= 0)) return;
    const s = this.get(name);
    s.ema = s.ema ? s.ema + (ms - s.ema) * 0.12 : ms;
    if (ms > s.winMax) s.winMax = ms;
    s.count++;
  }

  // Засечь время: const end = perf.mark("stage"); ...; end();
  mark(name: string): () => void {
    if (!this.enabled) return NOOP;
    const t = performance.now();
    return () => this.add(name, performance.now() - t);
  }

  // Посчитать событие (для частот без длительности, напр. fps).
  tick(name: string) {
    if (!this.enabled) return;
    this.get(name).count++;
  }

  // Пересчёт частот и пиков за окно. Вызывает PerfPanel ~4 раза/сек.
  flush(now: number) {
    const dt = (now - this.lastFlush) / 1000;
    if (dt > 0) {
      for (const s of this.stages.values()) {
        s.rate = s.count / dt;
        s.count = 0;
        s.max = s.winMax;
        s.winMax = 0;
      }
    }
    this.lastFlush = now;
  }

  snapshot(): { name: string; ema: number; max: number; rate: number }[] {
    const out: { name: string; ema: number; max: number; rate: number }[] = [];
    for (const [name, s] of this.stages) out.push({ name, ema: s.ema, max: s.max, rate: s.rate });
    return out;
  }

  reset() { this.stages.clear(); this.lastFlush = performance.now(); }
}

export const perf = new Perf();

// dev-хук: доступ к метрикам из консоли/инструментов (window.__perf). Только в dev.
if (import.meta.env.DEV) (globalThis as any).__perf = perf;
