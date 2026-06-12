// Правая панель = ИНСПЕКТОР ВЫБРАННОЙ НОДЫ (§3.5, A2). Список слоёв убран — ноды добавляются
// Tab-палитрой в графе, выбираются кликом по ноде. Всё «общее» (источник/сцена/кеш/пресеты) — слева.

import type { LayeredConfig } from "../core/types";
import type { LayersApi } from "../App";
import { LayerInspector, EffectInspector } from "./LayerInspector";

interface Props {
  config: LayeredConfig;
  onChange: (patch: Partial<LayeredConfig>) => void;
  layers: LayersApi;
  onCollapse: () => void;
}

export function Controls({ config, onChange, layers, onCollapse }: Props) {
  const selected = layers.list.find((l) => l.id === layers.selectedId) ?? null;
  const selectedEffect = layers.effects.find((e) => e.id === layers.selectedEffectId) ?? null;

  return (
    <aside className="panel right">
      <div className="panel-head">
        <button className="panel-collapse" title="свернуть" onClick={onCollapse}>»</button>
        <h1>VIDEOFX<span className="dot">.</span>SCANNER</h1>
      </div>

      {selectedEffect ? (
        <EffectInspector
          effect={selectedEffect}
          onParams={(p) => layers.setEffectParams(selectedEffect.id, p)}
          onSource={(s) => layers.setEffectSource(selectedEffect.id, s)}
          onToggle={() => layers.toggleEffect(selectedEffect.id)}
          onRemove={() => layers.removeEffect(selectedEffect.id)}
          onBinding={(field, b) => layers.setEffectBinding(selectedEffect.id, field, b)}
        />
      ) : (
        <LayerInspector
          layer={selected}
          onParams={(p) => { if (selected) layers.setParams(selected.id, p); }}
          globals={config}
          onGlobal={onChange}
        />
      )}

      <footer>инспектор ноды · открой граф ⬡, тыкни ноду · Tab — добавить</footer>
    </aside>
  );
}
