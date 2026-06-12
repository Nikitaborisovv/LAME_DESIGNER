// Панель слоёв (как в редакторах): список с видимостью, выбором, переименованием
// (двойной клик), дублированием/удалением и драг-реордером (HTML5 DnD, без зависимостей).
// Верх списка = передний план; выключенные слои приглушены, но остаются в списке.

import { useRef, useState } from "react";
import { LAYER_DEFS } from "../core/layerRegistry";
import type { LayersApi } from "../App";

export function LayersPanel({ layers }: { layers: LayersApi }) {
  const [editing, setEditing] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);

  if (layers.list.length === 0) {
    return <div className="layers-empty">нет слоёв — добавь из меню ниже ↓</div>;
  }

  return (
    <div className="layers-list">
      {layers.list.map((l) => (
        <div
          key={l.id}
          draggable
          className={"layer-row" + (l.id === layers.selectedId ? " sel" : "") + (l.enabled ? "" : " off")}
          onClick={() => layers.select(l.id)}
          onDragStart={() => { dragId.current = l.id; }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => { if (dragId.current && dragId.current !== l.id) layers.reorder(dragId.current, l.id); dragId.current = null; }}
        >
          <input
            type="checkbox"
            checked={l.enabled}
            title="видимость"
            onClick={(e) => e.stopPropagation()}
            onChange={() => layers.toggle(l.id)}
          />
          {editing === l.id ? (
            <input
              className="layer-name-edit"
              autoFocus
              defaultValue={l.name}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => { layers.rename(l.id, e.target.value.trim() || l.name); setEditing(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
          ) : (
            <span className="layer-name" title="двойной клик — переименовать"
              onDoubleClick={(e) => { e.stopPropagation(); setEditing(l.id); }}>
              {l.name}
            </span>
          )}
          <span className="layer-kind">{LAYER_DEFS[l.kind].group}</span>
          <button className="layer-act" title="дублировать"
            onClick={(e) => { e.stopPropagation(); layers.duplicate(l.id); }}>⧉</button>
          <button className="layer-act del" title="удалить"
            onClick={(e) => { e.stopPropagation(); layers.remove(l.id); }}>✕</button>
        </div>
      ))}
    </div>
  );
}
