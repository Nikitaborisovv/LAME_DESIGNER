import type { LayeredConfig, Layer, SceneConfig, EffectNode } from "./types";
import { DEFAULT_LAYERED, flatConfigToLayers, drainModifiers, sanitizeEffects, migrateShaderFxOrder } from "./layerMigrate";
import { ensureGraph } from "./graphDoc";
import { LAYER_DEFS, layerDefaults } from "./layerRegistry";

// Отбросить слои неизвестного/устаревшего вида (старый pointCloud и т.п.) и ДОБАВИТЬ
// недостающие дефолтные параметры (forward-compat: у старых слоёв появляются новые поля).
function sanitizeLayers(layers: Layer[]): Layer[] {
  return (layers ?? [])
    .filter((l) => l && (LAYER_DEFS as Record<string, unknown>)[l.kind])
    .map((l) => ({ ...l, params: { ...layerDefaults(l.kind), ...l.params } }));
}

// Сохранение настроек: автосейв последней сессии + именованные пресеты в localStorage,
// плюс экспорт/импорт JSON. Хранится МОДЕЛЬ СЛОЁВ (LayeredConfig). Старые плоские
// пресеты (без поля layers) авто-мигрируются в слои при загрузке (merge).

const LAST_KEY = "videofx.lastConfig";
const PRESETS_KEY = "videofx.presets";

// blob:-URL видео — ЛЕТУЧИЙ (живёт в памяти вкладки, не переживает перезагрузку) → не персистим.
// Реальные пути (/videos/…, http(s)) сохраняем: демо-видео по пути и файловый источник переживают
// перезагрузку (App при маунте авто-грузит videoUrl, если он не blob:).
const persistUrl = (u: string | null | undefined): string | null =>
  u && !u.startsWith("blob:") ? u : null;

function strip(c: LayeredConfig): Partial<LayeredConfig> {
  const { videoUrl, ...rest } = c;
  const keep = persistUrl(videoUrl);
  return keep ? { ...rest, videoUrl: keep } : rest;
}

// Привести сохранённое к актуальному LayeredConfig: новый формат склеиваем с дефолтом
// (на случай новых глобальных полей), старый плоский — мигрируем в слои.
export function merge(partial: Partial<LayeredConfig> | Partial<SceneConfig> | null): LayeredConfig {
  if (!partial) return ensureGraph({ ...DEFAULT_LAYERED, videoUrl: null });
  if (Array.isArray((partial as LayeredConfig).layers)) {
    const p = partial as Partial<LayeredConfig>;
    // Backward-compat Фазы 3 #2: разворачиваем legacy layer.modifiers[] в top-level effects[]
    // (старые пресеты держали эффекты внутри слоёв) и склеиваем с уже мигрированными effects.
    const drained = drainModifiers(sanitizeLayers(p.layers as Layer[]), (p.effects as EffectNode[]) ?? []);
    // T0e: гарантируем граф — у старых пресетов синтезируем рёбра из легаси-каналов,
    // у новых санитайзим (выброс рёбер на отсутствующие ноды, ремап sig:, дедуп).
    return ensureGraph({
      ...DEFAULT_LAYERED, ...p,
      layers: drained.layers,
      effects: sanitizeEffects(drained.effects),
      // T0c: shaderFxOrder из старых ВИДОВ -> id слоёв (идемпотентно, если уже ids).
      shaderFxOrder: migrateShaderFxOrder(p.shaderFxOrder, drained.layers),
      videoUrl: persistUrl(p.videoUrl), // реальный путь сохраняем (демо/restore), blob: -> null
    });
  }
  // старый плоский конфиг -> авто-миграция
  return ensureGraph({ ...flatConfigToLayers(partial as Partial<SceneConfig>), videoUrl: persistUrl((partial as Partial<SceneConfig>).videoUrl) });
}

export function saveLast(c: LayeredConfig): void {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(strip(c))); } catch { /* ignore */ }
}

export function loadLast(): LayeredConfig | null {
  try {
    const s = localStorage.getItem(LAST_KEY);
    return s ? merge(JSON.parse(s)) : null;
  } catch { return null; }
}

export function listPresets(): Record<string, Partial<LayeredConfig>> {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || "{}"); } catch { return {}; }
}

export function presetNames(): string[] {
  return Object.keys(listPresets()).sort();
}

// true — сохранилось; false — отказ (например, переполнена квота localStorage).
export function savePreset(name: string, c: LayeredConfig): boolean {
  const all = listPresets();
  all[name] = strip(c);
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(all));
    return true;
  } catch (e) {
    console.error("[presets] не удалось сохранить (квота localStorage?)", e);
    return false;
  }
}

export function loadPreset(name: string): LayeredConfig | null {
  const all = listPresets();
  return all[name] ? merge(all[name]) : null;
}

export function deletePreset(name: string): void {
  const all = listPresets();
  delete all[name];
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(all)); }
  catch (e) { console.error("[presets] не удалось удалить", e); }
}

// Экспорт текущих настроек в файл .json (скачивание).
export function exportConfig(c: LayeredConfig): void {
  const blob = new Blob([JSON.stringify(strip(c), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "videofx-preset.json";
  a.click();
  URL.revokeObjectURL(url);
}

// Импорт настроек из файла.
export async function importConfig(file: File): Promise<LayeredConfig> {
  const text = await file.text();
  return merge(JSON.parse(text));
}
