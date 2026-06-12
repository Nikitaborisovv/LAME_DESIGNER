// Круговой планировщик тяжёлых СИНХРОННЫХ детекторов на главном потоке (лица, руки и т.п.).
//
// Проблема: faces и hands — оба блокирующие GPU-вызовы MediaPipe (`detectForVideo`). Если
// пустить их в один кадр, второй крадёт main-thread у рендера. Раньше в App стоял бинарный
// стаггеринг «faces ИЛИ hands»: раз сетка лица отрабатывала почти каждый кадр, руки почти не
// запускались — отсюда «руки отваливаются».
//
// Решение (см. ARCHITECTURE.md §4.3): каждый тик пускаем НЕ БОЛЬШЕ `budget` тяжёлых задач,
// выбирая их по кругу — так ни одна не голодает. Сам детектор остаётся источником своей
// частоты: его `run` возвращает false, если в этот тик он зашроттлился, и тогда планировщик
// отдаёт бюджет следующей задаче.

export interface SchedTask {
  key: string;
  // true — инференс реально отработал в этом тике; false — пропущен (внутренний троттлинг).
  run: (nowMs: number) => boolean;
}

export class RoundRobin {
  private cursor = 0;

  // budget — максимум тяжёлых задач на тик (по умолчанию 1: один тяжёлый GPU-вызов на кадр,
  // остальное кадра — рендеру и воркерам).
  tick(nowMs: number, tasks: SchedTask[], budget = 1): void {
    const n = tasks.length;
    if (n === 0) return;
    let ran = 0;
    let tried = 0;
    while (ran < budget && tried < n) {
      const idx = (this.cursor + tried) % n;
      tried++;
      if (tasks[idx].run(nowMs)) {
        ran++;
        this.cursor = (idx + 1) % n; // в следующий раз начинаем со следующей задачи
      }
    }
  }
}
