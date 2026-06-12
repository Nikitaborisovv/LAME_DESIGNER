// Инспектор выбранного слоя: рендерит ТОЛЬКО его крутилки (data-driven из реестра).
// Решает проблему «захламления» — крутилки выключенных/прочих эффектов не мозолят глаза.
// Плюс globalControls: общие поля (цвета людей, общие лица) показываются прямо тут,
// чтобы всё связанное было в одном месте (редактируются как глобалы).

import { LAYER_DEFS, PIXEL_PALETTES, type ControlSpec } from "../core/layerRegistry";
import { MODIFIER_DEFS, type ModControlSpec } from "../core/modifierRegistry";
import { POINT_PRODUCERS } from "../core/pointSources";
import { DRIVER_OPTIONS } from "../core/drivers";
import type { Layer, LayeredConfig, SceneConfig, EffectNode, LayerKind, ParamBinding, DriverKind } from "../core/types";
import { Field, Row, PaletteControl } from "./controlField";

// Человекочитаемые подписи продюсеров точек (для селектора source эффекта).
const PRODUCER_LABEL: Record<string, string> = {
  motion: "движение", hands: "руки", faceMesh: "лица — сетка",
  faceBoxes: "лица — боксы", peopleBox: "люди — боксы",
};

// Строка привязки параметра к драйверу: выпадашка драйвера + (для числовых) мин/макс.
function BindingRow({ spec, binding, onChange }: {
  spec: ModControlSpec;
  binding: ParamBinding | undefined;
  onChange: (b: ParamBinding | null) => void;
}) {
  const isColor = spec.field === "colorA";
  const driver: DriverKind = binding?.driver ?? "none";
  const lo = binding?.lo ?? spec.min ?? 0;
  const hi = binding?.hi ?? spec.max ?? 1;
  const smooth = binding?.smooth ?? 0.6;
  const curve = binding?.curve ?? 0;
  const curveLabel = curve > 0.05 ? "ease-in" : curve < -0.05 ? "ease-out" : "линейно";
  return (
    <div style={{ margin: "2px 0 6px 0", paddingLeft: 8, borderLeft: "2px solid var(--accent, #ff2d8e)" }}>
      <Row label="↳ драйвер">
        <select
          value={driver}
          onChange={(e) => {
            const d = e.target.value as DriverKind;
            if (d === "none") onChange(null);
            else onChange({ driver: d, lo, hi, smooth, curve });
          }}
        >
          {DRIVER_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Row>
      {driver !== "none" && !isColor && (
        <div style={{ display: "flex", gap: 6 }}>
          <label style={{ flex: 1, fontSize: 11, color: "var(--muted)" }}>
            мин
            <input type="number" value={lo} step={spec.step}
              onChange={(e) => onChange({ driver, lo: Number(e.target.value), hi, smooth, curve })} style={{ width: "100%" }} />
          </label>
          <label style={{ flex: 1, fontSize: 11, color: "var(--muted)" }}>
            макс
            <input type="number" value={hi} step={spec.step}
              onChange={(e) => onChange({ driver, lo, hi: Number(e.target.value), smooth, curve })} style={{ width: "100%" }} />
          </label>
        </div>
      )}
      {driver !== "none" && isColor && (
        <small style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.3 }}>цвет лерпится A→B по драйверу</small>
      )}
      {driver !== "none" && (
        <label style={{ fontSize: 11, color: "var(--muted)" }}>
          плавность · {smooth.toFixed(2)}
          <input type="range" min={0} max={0.95} step={0.05} value={smooth}
            onChange={(e) => onChange({ driver, lo, hi, smooth: Number(e.target.value), curve })} style={{ width: "100%" }} />
        </label>
      )}
      {driver !== "none" && (
        <label style={{ fontSize: 11, color: "var(--muted)" }}>
          отклик · {curveLabel}
          <input type="range" min={-1} max={1} step={0.1} value={curve}
            onChange={(e) => onChange({ driver, lo, hi, smooth, curve: Number(e.target.value) })} style={{ width: "100%" }} />
        </label>
      )}
    </div>
  );
}

export function LayerInspector({
  layer, onParams, globals, onGlobal,
}: {
  layer: Layer | null;
  onParams: (params: Partial<SceneConfig>) => void;
  globals: LayeredConfig;
  onGlobal: (patch: Partial<LayeredConfig>) => void;
}) {
  if (!layer) {
    return (
      <section>
        <span className="legend">инспектор ноды</span>
        <small style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.4 }}>
          открой граф (⬡) и тыкни ноду — её настройки появятся здесь. Tab в графе — добавить ноду.
        </small>
      </section>
    );
  }
  const def = LAYER_DEFS[layer.kind];
  return (
    <section>
      <span className="legend">⚙ {layer.name}</span>
      {def.desc && (
        <small style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.4 }}>{def.desc}</small>
      )}
      {def.controls.map((spec) =>
        spec.type === "palette" ? (
          <PaletteControl
            key={spec.field as string}
            palette={(layer.params as Record<string, unknown>)[spec.field as string] as string[] | undefined}
            levels={Number((layer.params as Record<string, unknown>).pixelArtLevels ?? 4)}
            glowMask={(layer.params as Record<string, unknown>).pixelArtGlowMask as boolean[] | undefined}
            onPalette={(p) => onParams({ pixelArtPalette: p } as Partial<SceneConfig>)}
            onLevels={(num) => onParams({ pixelArtLevels: num } as Partial<SceneConfig>)}
            onGlow={(mask) => onParams({ pixelArtGlowMask: mask } as Partial<SceneConfig>)}
            presets={PIXEL_PALETTES}
          />
        ) : (
          <Field
            key={spec.field as string}
            spec={spec}
            value={(layer.params as Record<string, unknown>)[spec.field as string]}
            onChange={(v) => onParams({ [spec.field]: v } as Partial<SceneConfig>)}
          />
        )
      )}
      {def.globalControls && def.globalControls.length > 0 && (
        <>
          <span className="sub" style={{ marginTop: 4 }}>общие (на все слои этой группы)</span>
          {def.globalControls.map((spec) => (
            <Field
              key={spec.field as string}
              spec={spec}
              value={(globals as Record<string, unknown>)[spec.field as string]}
              onChange={(v) => onGlobal({ [spec.field]: v } as Partial<LayeredConfig>)}
            />
          ))}
        </>
      )}
    </section>
  );
}

// Инспектор выбранного top-level эффекта (Фаза 3 #2). Показывается, когда в графе выбрана
// нода-эффект. Source — хендл продюсера точек (редактируется и тут, и проводом в графе).
export function EffectInspector({
  effect, onParams, onSource, onToggle, onRemove, onBinding,
}: {
  effect: EffectNode;
  onParams: (params: Record<string, number | string | boolean>) => void;
  onSource: (source: LayerKind) => void;
  onToggle: () => void;
  onRemove: () => void;
  onBinding: (field: string, binding: ParamBinding | null) => void;
}) {
  const mdef = MODIFIER_DEFS[effect.kind];
  const bindable = new Set(mdef.bindable);
  const showField = (f: string) => (f !== "nearestDist" && f !== "maxLinks") || effect.params.topology === "nearest";
  return (
    <section>
      <span className="legend">⬡ {mdef.label}</span>
      {mdef.desc && (
        <small style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.4 }}>{mdef.desc}</small>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, fontSize: 12 }}>
          <input type="checkbox" checked={effect.enabled} onChange={onToggle} /> включён
        </label>
        <button className="preset-del" title="удалить эффект" onClick={onRemove}>✕</button>
      </div>
      <Row label="источник точек">
        <select value={effect.source} onChange={(e) => onSource(e.target.value as LayerKind)}>
          {POINT_PRODUCERS.map((k) => (
            <option key={k} value={k}>{PRODUCER_LABEL[k] ?? k}</option>
          ))}
        </select>
      </Row>
      {mdef.controls.filter((spec) => showField(spec.field)).map((spec) => (
        <div key={spec.field}>
          <Field
            spec={spec as unknown as ControlSpec}
            value={effect.params[spec.field]}
            onChange={(v) => onParams({ [spec.field]: v as number | string | boolean })}
          />
          {bindable.has(spec.field) && (
            <BindingRow
              spec={spec}
              binding={effect.bindings?.[spec.field]}
              onChange={(b) => onBinding(spec.field, b)}
            />
          )}
        </div>
      ))}
    </section>
  );
}
