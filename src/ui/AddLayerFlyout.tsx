// Меню добавления слоя: по кнопке выезжает ВЛЕВО (из правой панели) и показывает
// ДВА СТОЛБЦА — 2D и 3D. Клик по пункту добавляет слой. Singleton, уже добавленные, заблокированы.

import { useState } from "react";
import { createPortal } from "react-dom";
import { LAYER_DEFS, LAYER_ORDER } from "../core/layerRegistry";
import type { LayerKind } from "../core/types";

export function AddLayerFlyout({
  existingKinds, onAdd,
}: {
  existingKinds: Set<LayerKind>;
  onAdd: (kind: LayerKind) => void;
}) {
  const [open, setOpen] = useState(false);

  const groups: Record<"2D" | "3D", LayerKind[]> = { "2D": [], "3D": [] };
  for (const k of LAYER_ORDER) groups[LAYER_DEFS[k].group].push(k);

  return (
    <div className="add-layer">
      <button className={open ? "mode on" : "mode"} style={{ width: "100%" }} onClick={() => setOpen((o) => !o)}>
        ＋ добавить слой
      </button>
      {open && createPortal(
        // через портал в body: иначе backdrop-filter у .panel зажимает position:fixed
        // (панель становится containing-block) и всплывашку обрезает overflow панели.
        <>
          <div className="flyout-backdrop" onClick={() => setOpen(false)} />
          <div className="flyout flyout-cols">
            {(["2D", "3D"] as const).map((g) => (
              <div key={g} className="flyout-col">
                <div className="flyout-title">{g}</div>
                {groups[g].map((k) => {
                  const used = LAYER_DEFS[k].singleton && existingKinds.has(k);
                  return (
                    <button
                      key={k}
                      className="flyout-item"
                      disabled={used}
                      title={LAYER_DEFS[k].desc}
                      onClick={() => { onAdd(k); setOpen(false); }}
                    >
                      {LAYER_DEFS[k].label}{used ? " ·✓" : ""}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
