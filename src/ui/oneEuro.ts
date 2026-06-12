// One-Euro фильтр (Casiez, Roussel, Vogel 2012) — сглаживание координат с адаптивной
// частотой среза: на медленном движении сильно гасит дрожь, на быстром — почти не лагает.
// Именно такой фильтр стоит в ARKit/Snapchat на ландмарках лица. Состояние на канал
// (одну координату) хранит вызывающий; передаём реальный dt каждого кадра.

export interface OneEuroParams {
  minCutoff: number; // нижняя частота среза (меньше = глаже на статике, но больше лаг)
  beta: number;      // насколько ускоряемся на быстром движении (больше = отзывчивее)
  dCutoff: number;   // срез для производной (обычно ~1)
}

export interface EuroState { rawPrev: number; hatPrev: number; dxPrev: number; has: boolean; }

export const newEuroState = (): EuroState => ({ rawPrev: 0, hatPrev: 0, dxPrev: 0, has: false });

const alpha = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

// Один шаг фильтра для скаляра x. Мутирует state, возвращает сглаженное значение.
export function oneEuro(s: EuroState, x: number, dt: number, p: OneEuroParams): number {
  if (!s.has || dt <= 0) { s.rawPrev = x; s.hatPrev = x; s.dxPrev = 0; s.has = true; return x; }
  const dx = (x - s.rawPrev) / dt;
  const dxHat = s.dxPrev + alpha(p.dCutoff, dt) * (dx - s.dxPrev);
  const cutoff = p.minCutoff + p.beta * Math.abs(dxHat);
  const xHat = s.hatPrev + alpha(cutoff, dt) * (x - s.hatPrev);
  s.rawPrev = x; s.hatPrev = xHat; s.dxPrev = dxHat;
  return xHat;
}
