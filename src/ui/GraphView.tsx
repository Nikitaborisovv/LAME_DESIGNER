// Нодовый редактор (Фаза 3). Проекция поверх LayeredConfig: продюсеры точек -> эффекты-ноды
// -> экран. Построен на Rete.js v2 (тело ноды = React, совместимо с React 19).
//
// Принцип 2 (TD «wire vs reference»): в графе ДВА вида связей.
//  • ПОТОК (сплошной провод) — данные одного типа (points-голубой / map-розовый) текут
//    от выхода к входу: продюсер -> эффект -> экран.
//  • ССЫЛКА (пунктир, field-жёлтый) — драйвер-сигнал руки переопределяет ПАРАМЕТР эффекта
//    (TD export-to-param). Источник — нода «Сигналы рук»; приёмник — ref-вход параметра.
//    Снятие ссылки чистит binding; создание пишет bindings[param]. См. ARCHITECTURE.md §6.

import { useEffect, useMemo, useRef, useState, type ReactElement, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { NodeEditor, ClassicPreset, type GetSchemes } from "rete";
import { AreaPlugin, AreaExtensions } from "rete-area-plugin";
import { ConnectionPlugin, Presets as ConnectionPresets } from "rete-connection-plugin";
import { ReactPlugin, Presets as ReactPresets, type ReactArea2D } from "rete-react-plugin";
import type {
  LayeredConfig, LayerKind, ModifierKind, OpKind,
  HandResult, VisionResult, FaceResult, PeopleFrame,
  CompositeOrder, CompositeBlend, ResolvedProducer, ResolvedMapNode,
} from "../core/types";
import type { AudioBands } from "../ml/useAudio";
import type { DepthApi } from "../ml/useDepth";
import { VIDEO_NODE, SCREEN_NODE, sigNodeId, edgeKey, producerMapIn } from "../core/graphDoc";
import { isPointProducer, fieldForLayerId, resolveProducerMaps, type PointResultRefs } from "../core/pointSources";
import { mapForRef } from "../core/mapSources";
import { MODIFIER_DEFS } from "../core/modifierRegistry";
import { LAYER_DEFS, layerBindable } from "../core/layerRegistry";
import { DRIVER_GROUPS, DRIVER_SHORT, driverProducer, computeDrivers, compileFieldFn, OP_DEFS, type Signal, type DriverValues } from "../core/drivers";

type OpParams = Record<string, number | string | boolean>;

type Schemes = GetSchemes<ClassicPreset.Node, ClassicPreset.Connection<ClassicPreset.Node, ClassicPreset.Node>>;
type AreaExtra = ReactArea2D<Schemes>;

const PRODUCER_LABEL: Partial<Record<LayerKind, string>> = {
  motion: "Движение", hands: "Руки", faceMesh: "Лица — сетка",
  faceBoxes: "Лица — боксы", peopleBox: "Люди — боксы", grid: "Grid (сетка точек)", scatter: "Scatter (глубина→точки)",
  sample: "Sample (точки×карта)", setAttr: "SetAttr (атрибут)",
  transform: "Transform (точки)", merge: "Merge (точки A+B)", sort: "Sort (точки)",
  trail: "Trail (шлейфы)", split: "Split (по полю)", pointForce: "Силы (точки)",
};


// Типы данных графа (как семейства операторов в TouchDesigner). Цвет = тип; см. ARCHITECTURE.md §6.
type DType = "points" | "map" | "field" | "particles";
const SOCKET_COLORS: Record<DType, string> = {
  points: "#36e6ff",    // PointSet — голубой
  map: "#ff4fa3",       // Map2D — розовый
  field: "#ffd23f",     // Field — жёлтый
  particles: "#ff8a3c", // Particles (GPU-домен, T5 v2) — оранжевый
};
class TypedSocket extends ClassicPreset.Socket {
  constructor(public dtype: DType) { super(dtype); }
}
// Кастомный сокет: цветной кружок по типу данных. (data — базовый Socket; читаем dtype кастом.)
function TypedSocketComp(props: { data: ClassicPreset.Socket }) {
  const dt = (props.data as { dtype?: DType }).dtype ?? "points";
  const c = SOCKET_COLORS[dt] ?? "#9aa3b2";
  return (
    <div
      title={dt}
      style={{
        width: 16, height: 16, borderRadius: "50%", boxSizing: "border-box",
        background: c, border: "2px solid rgba(255,255,255,0.85)", boxShadow: `0 0 6px ${c}`,
      }}
    />
  );
}

// Кастомная связь: тот же путь Rete (из useConnection), но стиль = тип/роль связи.
// styles дописывается ПОСЛЕ дефолтного `stroke: steelblue` -> переопределяет.
//  • поток (ref=false): сплошной провод цвета типа, толстый.
//  • ссылка (ref=true): пунктир (TD reference), тоньше — драйвер -> параметр.
const RawConnection = ReactPresets.classic.Connection as unknown as (
  p: { data: unknown; styles?: () => string }
) => ReactElement | null;
function TypedConnection(props: { data: ClassicPreset.Connection<ClassicPreset.Node, ClassicPreset.Node> }) {
  const d = props.data as { dtype?: DType; ref?: boolean };
  const dt = d.dtype ?? "points";
  const c = SOCKET_COLORS[dt];
  const style = d.ref
    ? `stroke: ${c}; stroke-width: 2.5px; stroke-dasharray: 7 5; opacity: 0.9;`
    : `stroke: ${c}; stroke-width: 4px;`;
  return <RawConnection {...props} styles={() => style} />;
}

// T0d: кастом нода — серая по умолчанию, при выделении жёлтая РАМКА (не заливка).
// styles-функция вызывается последней в NodeStyles и переопределяет встроенные цвета Rete.
const RawNode = ReactPresets.classic.Node as unknown as (p: {
  data: ClassicPreset.Node & { selected?: boolean };
  emit: (d: unknown) => void;
  styles?: (p: { selected?: boolean }) => string;
}) => ReactElement | null;
const nodeStylesFn = (p: { selected?: boolean }) =>
  p.selected
    ? "background:rgba(28,32,44,0.96);border-color:#ffd23f;box-shadow:0 0 0 1px rgba(255,210,63,0.35);"
    : "background:rgba(28,32,44,0.96);border-color:rgba(65,78,115,0.8);";
function StyledNode(props: { data: ClassicPreset.Node & { selected?: boolean }; emit: (d: unknown) => void }) {
  return <RawNode {...props} styles={nodeStylesFn} />;
}

// Короткие подписи ref-входов параметров на ноде-эффекте (место ограничено).
const PARAM_SHORT: Record<string, string> = {
  width: "толщина", maxLinks: "связей", colorA: "цвет", curve: "кривизна",
  // direction A: биндабельные params shader-FX (короткие подписи field-входов на нодах-FX).
  thermalMix: "сила", sobelStrength: "сила", sobelThickness: "толщина", scanlineIntensity: "интенс.",
  pixelateNear: "блок ближ", pixelateFar: "блок дальн", lookupMix: "сила",
  mirrorSectors: "секторы", mirrorAngle: "угол", displaceAmount: "ампл.", displaceScale: "масштаб",
  displaceSpeed: "скорость", chromAbAmount: "сила", chromAbAngle: "угол", grainAmount: "зерно",
  grainSize: "размер", pixelArtSize: "пиксель", pixelArtGlowIntensity: "свечение",
  feedbackDecay: "затух.", feedbackZoom: "zoom", feedbackRotate: "поворот",
};

// Кастом-контрол: живой CHOP-вьюер сигналов на ноде-источнике (превью выхода, P4). Показывает
// текущее значение каждого канала-драйвера полоской+числом, обновляясь на rAF БЕЗ React-ререндера
// (пишем в DOM по ref — §0.2: не гоняем per-frame через React). Чтение — общий getDrivers().
class SignalMeters extends ClassicPreset.Control {
  constructor(public signals: Signal[], public getDrivers: () => DriverValues) { super(); }
}
function SignalMetersComp(props: { data: SignalMeters }) {
  const { signals, getDrivers } = props.data;
  const bars = useRef<(HTMLDivElement | null)[]>([]);
  const vals = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const d = getDrivers();
      for (let i = 0; i < signals.length; i++) {
        const v = Math.max(0, Math.min(1, d[signals[i]] ?? 0));
        const b = bars.current[i]; if (b) b.style.width = (v * 100).toFixed(1) + "%";
        const s = vals.current[i]; if (s) s.textContent = v.toFixed(2);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [signals, getDrivers]);
  return (
    <div onPointerDown={(e) => e.stopPropagation()} style={{ padding: "2px 6px 5px", minWidth: 132 }}>
      {signals.map((s, i) => (
        <div key={s} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "#cdd3df", lineHeight: 1.6 }}>
          <span style={{ flex: "0 0 62px", opacity: 0.85 }}>{DRIVER_SHORT[s]}</span>
          <div style={{ flex: 1, height: 6, background: "rgba(255,255,255,0.1)", borderRadius: 3, overflow: "hidden" }}>
            <div ref={(el) => { bars.current[i] = el; }} style={{ height: "100%", width: "0%", background: SOCKET_COLORS.field, transition: "width 60ms linear" }} />
          </div>
          <span ref={(el) => { vals.current[i] = el; }} style={{ flex: "0 0 26px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>0.00</span>
        </div>
      ))}
    </div>
  );
}

// T-Debug: живой вьюер ДАННЫХ на PointSet-ноде (аналог Houdini MMB-инфо / TD-вьюера) — кол-во
// точек + групп + список атрибутов, обновляется на rAF БЕЗ React-ререндера (§0.2, как SignalMeters).
// Лечит «граф непрозрачен»: видно, сколько точек реально течёт из продюсера/конвертера.
type SamplePt = { x: number; y: number; a: Record<string, string> }; // одна строка спредшита
type PointStats = { count: number; groups: number; attrs: string[]; sample: SamplePt[] };
class PointMeters extends ClassicPreset.Control {
  constructor(public layerId: string, public getStats: (id: string) => PointStats | null) { super(); }
}
function PointMetersComp(props: { data: PointMeters }) {
  const { layerId, getStats } = props.data;
  const countEl = useRef<HTMLSpanElement>(null);
  const attrsEl = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);          // T-Debug(c): развёрнут ли спредшит
  const [rows, setRows] = useState<SamplePt[]>([]);  // сэмпл точек (обновляется интервалом, только когда open)
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const s = getStats(layerId);
      if (countEl.current) countEl.current.textContent = s ? `${s.count} тчк · ${s.groups} гр` : "—";
      if (attrsEl.current) attrsEl.current.textContent = s && s.attrs.length ? s.attrs.join(" · ") : "—";
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [layerId, getStats]);
  // спредшит: пока развёрнут — тянем сэмпл из кеша раз в 200мс (React-ререндер таблицы только этой ноды).
  useEffect(() => {
    if (!open) return;
    const pull = () => setRows(getStats(layerId)?.sample ?? []);
    pull();
    const id = setInterval(pull, 200);
    return () => clearInterval(id);
  }, [open, layerId, getStats]);
  // колонки атрибутов — объединение ключей по строкам сэмпла (стабильный порядок появления).
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r.a)) if (!cols.includes(k)) cols.push(k);
  const cell = { padding: "1px 4px", borderBottom: "1px solid rgba(255,255,255,0.07)", whiteSpace: "nowrap" as const };
  return (
    <div onPointerDown={(e) => e.stopPropagation()} style={{ padding: "1px 6px 3px", minWidth: 132, fontSize: 10, color: "#9fb4c8", lineHeight: 1.5 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <span style={{ flex: "0 0 auto", opacity: 0.7 }}>◈</span>
        <span ref={countEl} style={{ fontVariantNumeric: "tabular-nums", color: SOCKET_COLORS.points }}>—</span>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <span style={{ flex: "0 0 auto", opacity: 0.7 }}>attr</span>
        <span ref={attrsEl} style={{ opacity: 0.85, wordBreak: "break-word" }}>—</span>
      </div>
      <div onClick={() => setOpen((o) => !o)} style={{ cursor: "pointer", opacity: 0.8, userSelect: "none", marginTop: 1 }}>
        {open ? "▾" : "▸"} точки
      </div>
      {open && (
        <div style={{ maxHeight: 132, overflow: "auto", marginTop: 2, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 4 }}>
          {rows.length === 0 ? (
            <div style={{ padding: "3px 5px", opacity: 0.6 }}>нет точек</div>
          ) : (
            <table style={{ borderCollapse: "collapse", fontSize: 9, fontVariantNumeric: "tabular-nums" }}>
              <thead>
                <tr style={{ color: "#cdd3df" }}>
                  <th style={cell}>#</th><th style={cell}>x</th><th style={cell}>y</th>
                  {cols.map((c) => <th key={c} style={cell}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ ...cell, opacity: 0.6 }}>{i}</td>
                    <td style={cell}>{(Math.round(r.x * 1000) / 1000).toString()}</td>
                    <td style={cell}>{(Math.round(r.y * 1000) / 1000).toString()}</td>
                    {cols.map((c) => <td key={c} style={cell}>{r.a[c] ?? "·"}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// T5 v2 Phase B (T-Debug(б)): ЧБ-превью карты на Map2D-ноде. Лечит «глубина чёрная / поля невидимы»:
// видно, что реально выдаёт noise2d/mapCombine. Кадр (CPU-резолв mapForRef, downsample PREVIEW×PREVIEW)
// читается из кеша на rAF и рисуется в мини-канвас (putImageData) — БЕЗ React-ререндера (§0.2, как
// PointMeters/SignalMeters). Ноль GPU-readback (карты уже CPU).
const PREVIEW = 48;
type MapPreviewData = { rgba: Uint8ClampedArray } | null; // PREVIEW×PREVIEW RGBA (серый) или null (нет карты)
class MapPreview extends ClassicPreset.Control {
  constructor(public layerId: string, public getMap: (id: string) => MapPreviewData) { super(); }
}
function MapPreviewComp(props: { data: MapPreview }) {
  const { layerId, getMap } = props.data;
  const cvRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    let img: ImageData | null = null;
    const tick = () => {
      const cv = cvRef.current;
      const ctx = cv?.getContext("2d");
      const d = getMap(layerId);
      if (ctx && cv) {
        if (d) {
          if (!img) img = ctx.createImageData(PREVIEW, PREVIEW);
          img.data.set(d.rgba);
          ctx.putImageData(img, 0, 0);
        } else {
          ctx.clearRect(0, 0, cv.width, cv.height);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [layerId, getMap]);
  return (
    <div onPointerDown={(e) => e.stopPropagation()} style={{ padding: "2px 6px 4px" }}>
      <canvas
        ref={cvRef}
        width={PREVIEW}
        height={PREVIEW}
        style={{ width: 72, height: 72, imageRendering: "pixelated", borderRadius: 4, border: `1px solid ${SOCKET_COLORS.map}55`, background: "#000", display: "block" }}
      />
    </div>
  );
}

// Кастом-контрол действий на ноде-эффекте: ⏻ дизейбл + ✕ удалить (P4-UX, чтобы не только Delete).
class NodeActions extends ClassicPreset.Control {
  constructor(
    public enabled: boolean,
    public onToggle: (enabled: boolean) => void,
    public onRemove: () => void,
  ) { super(); }
}
// stopPropagation на pointerdown — иначе клик уводит в драг/пик ноды Rete вместо действия кнопки.
function NodeActionsComp(props: { data: NodeActions }) {
  const a = props.data;
  const [on, setOn] = useState(a.enabled);
  const btn = (active: boolean): CSSProperties => ({
    fontSize: 12, lineHeight: 1, padding: "2px 7px", borderRadius: 6, cursor: "pointer",
    border: "1px solid rgba(255,255,255,0.25)", background: active ? "rgba(60,255,170,0.18)" : "rgba(255,255,255,0.06)",
    color: active ? "#bfffe0" : "#cdd3df",
  });
  return (
    <div onPointerDown={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6, padding: "4px 6px 2px" }}>
      <button title={on ? "выключить эффект" : "включить эффект"} style={btn(on)}
        onClick={() => { const n = !on; setOn(n); a.onToggle(n); }}>⏻ {on ? "вкл" : "выкл"}</button>
      <button title="удалить ноду" style={{ ...btn(false), color: "#ff8a8a", borderColor: "rgba(255,120,120,0.4)" }}
        onClick={() => a.onRemove()}>✕</button>
    </div>
  );
}

// T1: кастом-контрол на оп-ноде (Field-алгебра) — крутилки data-driven по OP_DEFS[kind].fields
// (range/check/select). Один компонент на ВСЕ виды (Math/Constant/MapRange/Compare/LFO…). Локальный
// стейт (как NodeActions) → правка не пересобирает граф; мутация конфига — живым колбэком.
// T1-2: initStops/onStops — расширение для Ramp (кривая хранится отдельно от OpParams).
type RampStop = { x: number; y: number };
class OpControl extends ClassicPreset.Control {
  constructor(
    public kind: OpKind,
    public init: OpParams,
    public onParams: (p: OpParams) => void,
    public onRemove: () => void,
    public initStops?: RampStop[],
    public onStops?: (stops: RampStop[]) => void,
  ) { super(); }
}

// Ramp curve mini-editor: SVG 120×60, клик=добавить точку, drag=двигать, ПКМ=удалить.
function RampEditor({ initStops, onStops }: { initStops: RampStop[]; onStops?: (s: RampStop[]) => void }) {
  const W = 120, H = 60, PAD = 6, R = 5;
  const [stops, setStops] = useState<RampStop[]>(initStops);
  const [drag, setDrag] = useState<number | null>(null); // индекс в stops (не sorted)
  const svgRef = useRef<SVGSVGElement>(null);

  const toSvg = (p: RampStop) => ({
    sx: PAD + p.x * (W - 2 * PAD),
    sy: PAD + (1 - p.y) * (H - 2 * PAD),
  });
  const fromSvg = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left - PAD) / (W - 2 * PAD))),
      y: Math.max(0, Math.min(1, 1 - (e.clientY - r.top - PAD) / (H - 2 * PAD))),
    };
  };
  const commit = (s: RampStop[]) => { setStops(s); onStops?.(s); };
  const sorted = [...stops].sort((a, b) => a.x - b.x);
  const pts = sorted.map(toSvg);

  return (
    <div style={{ marginBottom: 3 }}>
      <span style={{ display: "block", fontSize: 10, color: "#cdd3df", lineHeight: 1.5 }}>кривая</span>
      <svg
        ref={svgRef} width={W} height={H}
        style={{ display: "block", cursor: "crosshair", touchAction: "none",
          border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4, background: "rgba(0,0,0,0.35)" }}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (e.button !== 0) return;
          const r = svgRef.current!.getBoundingClientRect();
          const mx = e.clientX - r.left, my = e.clientY - r.top;
          // найти точку под курсором (в оригинальном stops, не sorted)
          const hitIdx = stops.findIndex((p) => { const s = toSvg(p); return Math.hypot(mx - s.sx, my - s.sy) <= R + 2; });
          if (hitIdx >= 0) {
            setDrag(hitIdx);
            (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
          } else {
            commit([...stops, fromSvg(e)]);
          }
        }}
        onPointerMove={(e) => {
          if (drag === null) return;
          e.stopPropagation();
          commit(stops.map((s, i) => (i === drag ? fromSvg(e) : s)));
        }}
        onPointerUp={(e) => {
          if (drag !== null) (e.currentTarget as SVGElement).releasePointerCapture(e.pointerId);
          setDrag(null);
        }}
        onContextMenu={(e) => {
          e.preventDefault(); e.stopPropagation();
          if (stops.length <= 2) return;
          const r = svgRef.current!.getBoundingClientRect();
          const mx = e.clientX - r.left, my = e.clientY - r.top;
          const hitIdx = stops.findIndex((p) => { const s = toSvg(p); return Math.hypot(mx - s.sx, my - s.sy) <= R + 2; });
          if (hitIdx >= 0) commit(stops.filter((_, i) => i !== hitIdx));
        }}
      >
        {pts.length > 1 && (
          <polyline
            points={pts.map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(" ")}
            stroke={SOCKET_COLORS.field} strokeWidth={1.5} fill="none" opacity={0.9}
          />
        )}
        {stops.map((p, i) => {
          const { sx, sy } = toSvg(p);
          return <circle key={i} cx={sx} cy={sy} r={R - 1} fill={SOCKET_COLORS.field} opacity={drag === i ? 1 : 0.75} style={{ cursor: "move" }} />;
        })}
      </svg>
      <span style={{ fontSize: 9, color: "#6c7686" }}>клик=добавить · drag=двигать · ПКМ=удалить</span>
    </div>
  );
}

function OpControlComp(props: { data: OpControl }) {
  const { kind, init, onParams, onRemove, initStops, onStops } = props.data;
  const [v, setV] = useState<OpParams>(init);
  const def = OP_DEFS[kind];
  const set = (f: string, val: number | string | boolean) => { setV((s) => ({ ...s, [f]: val })); onParams({ [f]: val }); };
  const lab = { display: "block", fontSize: 10, color: "#cdd3df", lineHeight: 1.5 } as const;
  return (
    <div onPointerDown={(e) => e.stopPropagation()} style={{ padding: "2px 6px 5px", minWidth: 160 }}>
      {def.fields.map((fs) => {
        const cur = v[fs.field] ?? def.defaults[fs.field];
        if (fs.type === "check") return (
          <label key={fs.field} style={lab}>
            <input type="checkbox" checked={!!cur} onChange={(e) => set(fs.field, e.target.checked)} /> {fs.label}
          </label>
        );
        if (fs.type === "select") return (
          <label key={fs.field} style={lab}>{fs.label}
            <select value={String(cur)} onChange={(e) => set(fs.field, e.target.value)} style={{ width: "100%" }}>
              {(fs.options ?? []).map(([val, l]) => <option key={val} value={val}>{l}</option>)}
            </select>
          </label>
        );
        return (
          <label key={fs.field} style={lab}>
            {fs.label}
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input type="range" min={fs.min} max={fs.max} step={fs.step} value={Number(cur)}
                onChange={(e) => set(fs.field, +e.target.value)} style={{ flex: 1, minWidth: 0 }} />
              <input type="number" value={Number(cur)} min={fs.min} max={fs.max} step={fs.step}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => { const v = +e.target.value; if (!isNaN(v)) set(fs.field, v); }}
                style={{ width: 44, fontSize: 10, padding: "1px 3px", flexShrink: 0,
                  borderRadius: 4, border: "1px solid rgba(255,255,255,0.18)",
                  background: "rgba(0,0,0,0.4)", color: "#eef2f8", fontVariantNumeric: "tabular-nums" }} />
            </div>
          </label>
        );
      })}
      {kind === "ramp" && (
        <RampEditor
          initStops={initStops ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }]}
          onStops={onStops}
        />
      )}
      <button title="удалить ноду" onClick={onRemove} style={{
        marginTop: 3, fontSize: 11, lineHeight: 1, padding: "2px 7px", borderRadius: 6, cursor: "pointer",
        border: "1px solid rgba(255,120,120,0.4)", background: "rgba(255,255,255,0.06)", color: "#ff8a8a",
      }}>✕ удалить</button>
    </div>
  );
}

// T3 Composite: контрол ноды Композит — порядок (что-над-чем) + режим смешивания flat↔cloud.
// Singleton-нода (как Видео/Экран), появляется при активном 3D. Пишет ГЛОБАЛЫ конфига через
// onSetComposite (паритет с контролом ScenePanel) — НЕ сущность графа, рёбра декоративные.
const COMPOSITE_ORDER_OPTS: [CompositeOrder, string][] = [
  ["cloudOver", "облако над 2D"], ["flatOver", "2D над облаком"],
];
const COMPOSITE_BLEND_OPTS: [CompositeBlend, string][] = [
  ["normal", "обычное"], ["screen", "экран (add)"], ["multiply", "умножение"],
  ["lighten", "осветление"], ["difference", "разница"], ["overlay", "перекрытие"],
];
class CompositeControl extends ClassicPreset.Control {
  constructor(
    public order: CompositeOrder,
    public blend: CompositeBlend,
    public onSet: (p: { compositeOrder?: CompositeOrder; compositeBlend?: CompositeBlend }) => void,
  ) { super(); }
}
function CompositeControlComp(props: { data: CompositeControl }) {
  const { order, blend, onSet } = props.data;
  const [o, setO] = useState<CompositeOrder>(order);
  const [b, setB] = useState<CompositeBlend>(blend);
  const lab = { display: "block", fontSize: 10, color: "#cdd3df", lineHeight: 1.5 } as const;
  return (
    <div onPointerDown={(e) => e.stopPropagation()} style={{ padding: "2px 6px 5px", minWidth: 150 }}>
      <label style={lab}>порядок
        <select value={o} onChange={(e) => { const v = e.target.value as CompositeOrder; setO(v); onSet({ compositeOrder: v }); }} style={{ width: "100%" }}>
          {COMPOSITE_ORDER_OPTS.map(([val, l]) => <option key={val} value={val}>{l}</option>)}
        </select>
      </label>
      <label style={lab}>смешивание
        <select value={b} onChange={(e) => { const v = e.target.value as CompositeBlend; setB(v); onSet({ compositeBlend: v }); }} style={{ width: "100%" }}>
          {COMPOSITE_BLEND_OPTS.map(([val, l]) => <option key={val} value={val}>{l}</option>)}
        </select>
      </label>
    </div>
  );
}

// Буфер копирования нод (граф-менеджмент T0b). Модульный — переживает пересборку графа
// (structSig). Хранит id мультиэкземплярных сущностей; вставка/дубль клонирует их с новым id.
let nodeClipboard: { effectIds: string[]; opIds: string[] } = { effectIds: [], opIds: [] };

async function buildEditor(
  container: HTMLElement,
  config: LayeredConfig,
  onSelectLayer: (layerId: string) => void,
  onSelectEffect: (effectId: string) => void,
  onRemoveEffect: (effectId: string) => void,
  onSetEnabled: (effectId: string, enabled: boolean) => void,
  getDrivers: () => DriverValues,
  getStats: (layerId: string) => PointStats | null, // T-Debug: live кол-во точек/атрибутов на ноде
  getMapPreview: (layerId: string) => MapPreviewData, // Phase B: ЧБ-превью карты на Map2D-ноде
  onSetLayerEnabled: (layerId: string, enabled: boolean) => void,
  onRemoveLayer: (layerId: string) => void,
  onSetOpNodeParams: (opId: string, p: OpParams) => void,              // T1: крутилки оп-ноды
  onRemoveOpNode: (opId: string) => void,
  onDuplicate: (effectIds: string[], opIds: string[]) => void,
  // T0e: РЁБРА АВТОРИТЕТНЫ — единственные write-колбэки топологии. Все легаси-каналы
  // (source/bindings/op.input/setAttr*/shaderFxOrder) выводит компилятор из рёбер.
  onAddEdge: (from: { node: string; out: string }, to: { node: string; in: string }) => void,
  onRemoveEdge: (key: string) => void,
  onSetNodePos: (entityId: string, pos: { x: number; y: number }) => void,
  onSetComposite: (p: { compositeOrder?: CompositeOrder; compositeBlend?: CompositeBlend }) => void, // T3 Composite
  pendingPos: { current: { x: number; y: number } | null },
  seenConfigIds: { current: Set<string> },
  areaOut: { current: unknown },
  savedTransform: { current: { k: number; x: number; y: number } | null },
) {
  const sPoints = new TypedSocket("points"); // PointSet (голубой)
  const sMap = new TypedSocket("map");        // Map2D (розовый)
  const sField = new TypedSocket("field");    // Field/сигнал (жёлтый) — ссылки на параметры
  const sParticles = new TypedSocket("particles"); // Particles (GPU-домен, T5 v2) — оранжевый
  const editor = new NodeEditor<Schemes>();
  const area = new AreaPlugin<Schemes, AreaExtra>(container);
  areaOut.current = area;
  const connection = new ConnectionPlugin<Schemes, AreaExtra>();
  const render = new ReactPlugin<Schemes, AreaExtra>({ createRoot });

  render.addPreset(ReactPresets.classic.setup({
    customize: {
      node() { return StyledNode as unknown as () => ReactElement | null; },
      socket() { return TypedSocketComp; },
      connection() { return TypedConnection; },
      control(data) {
        if (data.payload instanceof NodeActions) {
          return NodeActionsComp as unknown as () => ReactElement | null;
        }
        if (data.payload instanceof SignalMeters) {
          return SignalMetersComp as unknown as () => ReactElement | null;
        }
        if (data.payload instanceof PointMeters) {
          return PointMetersComp as unknown as () => ReactElement | null;
        }
        if (data.payload instanceof MapPreview) {
          return MapPreviewComp as unknown as () => ReactElement | null;
        }
        if (data.payload instanceof OpControl) {
          return OpControlComp as unknown as () => ReactElement | null;
        }
        if (data.payload instanceof CompositeControl) {
          return CompositeControlComp as unknown as () => ReactElement | null;
        }
        return null; // прочих контролов в графе нет -> дефолт
      },
    },
  }));
  connection.addPreset(ConnectionPresets.classic.setup());
  editor.use(area);
  area.use(connection);
  area.use(render);
  AreaExtensions.simpleNodesOrder(area);
  // Граф-менеджмент (T0): множественное выделение нод — click (один) / Ctrl+click (аккумуляция) /
  // Shift+drag по фону (box-select, ниже). Выделенные подсвечиваются Rete-флагом `selected`;
  // Delete удаляет ВСЕ выделенные (multi-delete). selectNode(id, accumulate) — программный выбор.
  const selector = AreaExtensions.selector();
  const { select: selectNode } = AreaExtensions.selectableNodes(
    area, selector, { accumulating: AreaExtensions.accumulateOnCtrl() },
  );

  // Карты нода -> сущность конфига.
  const nodeToLayer = new Map<string, string>();        // нода-продюсер -> слой (для инспектора)
  const nodeToKind = new Map<string, LayerKind>();      // нода-продюсер -> её вид
  const nodeToEffect = new Map<string, string>();       // нода-эффект -> id эффекта (top-level)
  const nodeToEffectKind = new Map<string, ModifierKind>(); // нода-эффект -> её вид (для bindable)
  const nodeToShaderFx = new Map<string, string>();     // T0c: нода-2D-FX -> id СЛОЯ-инстанса (клик -> инспектор)
  const nodeToOpNode = new Map<string, string>();       // C-Math: нода-Math -> id opNode
  // T0e: двусторонний маппинг rete-нода <-> id ноды ДОКА ("video"/"screen"/id сущности/"sig:<kind>").
  // Рёбра дока адресуются entity-id; rete-id живёт только внутри редактора.
  const entityOfNode = new Map<string, string>();             // rete id -> doc id
  const nodeOfEntity = new Map<string, ClassicPreset.Node>(); // doc id -> rete нода
  const signalNodeIds = new Set<string>();              // rete-id нод-источников сигналов (слой или sig:)
  let videoNodeId = "";                                 // rete-id ноды «Видео»
  let screenNodeId = "";                                // rete-id ноды «Экран»
  let building = true; // пока строим граф программно — не реагируем на свои же addConnection
  const doc = config.graph ?? { edges: [], pos: {} };   // T0e: рёбра/позиции дока (источник правды)

  // T0d: курсор (контейнер-относительный) для knife/Ctrl+V/Shift+drag dup-at-cursor.
  let cursorContainerX = 0, cursorContainerY = 0;
  const onMouseMoveCursor = (e: MouseEvent) => {
    const r = container.getBoundingClientRect();
    cursorContainerX = e.clientX - r.left; cursorContainerY = e.clientY - r.top;
  };
  container.addEventListener("mousemove", onMouseMoveCursor);
  // screen(container-relative) → граф координаты через area.area.transform
  const toGraph = (cx: number, cy: number) => {
    const t = (area as { area?: { transform?: { k:number;x:number;y:number } } })?.area?.transform ?? { k:1,x:0,y:0 };
    return { x: (cx - t.x) / t.k, y: (cy - t.y) / t.k };
  };
  // Размещает ноду: приоритет — сохранённая позиция дока (T0e) -> pendingPos нового
  // узла (у курсора; сразу персистится, чтобы пережить пересборку) -> дефолт-колонка.
  const placeNode = async (nodeId: string, configId: string, x: number, y: number) => {
    const saved = doc.pos[configId];
    if (saved) {
      seenConfigIds.current.add(configId);
      await area.translate(nodeId, saved);
      return;
    }
    if (!seenConfigIds.current.has(configId) && pendingPos.current) {
      const p = pendingPos.current; pendingPos.current = null;
      seenConfigIds.current.add(configId);
      await area.translate(nodeId, p);
      setTimeout(() => onSetNodePos(configId, p), 0); // персист после сборки
    } else {
      seenConfigIds.current.add(configId);
      await area.translate(nodeId, { x, y });
    }
  };

  // Параметр-ссылка? (ref-вход эффект-ноды по биндабельному полю её вида). Ключ — id НОДЫ.
  const bindableField = (nodeId: string, key: string): boolean => {
    const kind = nodeToEffectKind.get(nodeId);
    if (kind) return MODIFIER_DEFS[kind].bindable.includes(key);
    // direction A: ref-входы shader-FX нод тоже биндабельны (по LAYER_DEFS[kind].bindable).
    const layerId = nodeToShaderFx.get(nodeId);
    if (layerId) {
      const l = config.layers.find((x) => x.id === layerId);
      return !!l && layerBindable(l.kind).includes(key);
    }
    return false;
  };

  // Клик по ноде -> выбрать сущность в инспекторе (эффект ИЛИ слой) + запомнить (для Delete).
  let lastPicked: string | null = null;
  area.addPipe((ctx) => {
    if ((ctx as { type?: string }).type === "nodepicked") {
      const id = (ctx as { data: { id: string } }).data.id;
      lastPicked = id;
      const effId = nodeToEffect.get(id);
      if (effId) onSelectEffect(effId);
      else { const layerId = nodeToLayer.get(id); if (layerId) onSelectLayer(layerId); } // продюсер ИЛИ 2D-FX-слой
    }
    return ctx;
  });

  // T0e: перетаскивание ноды -> персист позиции в док (дебаунс на ноду; не во время сборки —
  // свои же area.translate при построении не должны писать в конфиг).
  const posTimers = new Map<string, ReturnType<typeof setTimeout>>();
  area.addPipe((ctx) => {
    if ((ctx as { type?: string }).type === "nodetranslated" && !building) {
      const d = (ctx as unknown as { data: { id: string; position: { x: number; y: number } } }).data;
      const ent = entityOfNode.get(d.id);
      if (ent) {
        const prev = posTimers.get(ent);
        if (prev) clearTimeout(prev);
        posTimers.set(ent, setTimeout(() => { posTimers.delete(ent); onSetNodePos(ent, d.position); }, 300));
      }
    }
    return ctx;
  });

  // Delete/Backspace -> удалить ВСЕ выделенные ноды (граф пересоберётся). Маппинг id->колбэк
  // через авторитетные карты (НЕ DOM-текст — см. memory autosave-race: .find по тексту опасен).
  container.tabIndex = 0; // чтобы канвас мог получать клавиатуру
  const removeNodeById = (id: string) => {
    if (id === videoNodeId || id === screenNodeId) return; // корень/сток не удаляем
    const effId = nodeToEffect.get(id); if (effId) { onRemoveEffect(effId); return; }
    const opId = nodeToOpNode.get(id); if (opId) { onRemoveOpNode(opId); return; }
    const layerId = nodeToLayer.get(id); if (layerId) { onRemoveLayer(layerId); return; } // продюсер ИЛИ 2D-FX-слой
  };
  // id выделенных нод (selector, иначе последняя пикнутая). Используют delete и copy/dup.
  const selectedIds = (): string[] =>
    selector.entities.size ? [...selector.entities.values()].map((en) => (en as { id: string }).id)
                           : (lastPicked ? [lastPicked] : []);
  // Дублируемы только МУЛЬТИЭКЗЕМПЛЯРНЫЕ сущности — effects/opNodes (списки). Продюсеры/шейдеры —
  // singleton (их дубль коллизит в resolveConfig: один плоский SceneConfig), копировать нельзя до
  // GraphDoc-фазы (T0b). Разбиваем выделение на id эффектов/оп-нод (прочее игнорим).
  const splitDup = (ids: string[]) => ({
    effectIds: ids.map((id) => nodeToEffect.get(id)).filter((x): x is string => !!x),
    opIds: ids.map((id) => nodeToOpNode.get(id)).filter((x): x is string => !!x),
  });
  const onKey = (e: KeyboardEvent) => {
    // Текст-поля внутри нод (OpControl и т.п.): Backspace/Delete/Ctrl+C/V/D — правка текста,
    // не операции над нодами (иначе стирание цифры удаляет ноду, Ctrl+C не копирует текст).
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && "cvd".includes(e.key.toLowerCase())) {
      e.preventDefault();
      const k = e.key.toLowerCase();
      if (k === "c") { const sel = splitDup(selectedIds()); if (sel.effectIds.length || sel.opIds.length) nodeClipboard = sel; }
      else { // v: из буфера; d: из текущего выделения — кладём у курсора (T0d)
        const src = k === "v" ? nodeClipboard : splitDup(selectedIds());
        if (src.effectIds.length || src.opIds.length) {
          pendingPos.current = toGraph(cursorContainerX, cursorContainerY);
          onDuplicate(src.effectIds, src.opIds);
        }
      }
      return;
    }
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const ids = selectedIds();
    if (!ids.length) return;
    for (const id of ids) removeNodeById(id);
    selector.unselectAll().catch(() => {});
    lastPicked = null;
  };
  container.addEventListener("keydown", onKey);

  // T0d НАВИГАЦИЯ: Alt+drag = pan (Rete-дефолт); обычный drag по ФОНУ = box-select.
  // Y+drag по фону = knife (разрез провода). Shift+drag по НОДЕ = duplicate-at-cursor.
  // Всё через capture-фазу pointerdown, чтобы перехватить до pan-хендлера Rete.

  // Рамка box-select
  const boxEl = document.createElement("div");
  Object.assign(boxEl.style, {
    position: "absolute", border: "1px solid rgba(60,200,255,0.9)", background: "rgba(60,200,255,0.12)",
    pointerEvents: "none", zIndex: "15", display: "none", left: "0px", top: "0px", width: "0px", height: "0px",
  } as Partial<CSSStyleDeclaration>);
  container.appendChild(boxEl);

  // Canvas для knife-линии (рисуется поверх графа, не пишет в конфиг)
  const knifeCanvas = document.createElement("canvas");
  Object.assign(knifeCanvas.style, { position:"absolute", inset:"0", pointerEvents:"none", zIndex:"18", display:"none" } as Partial<CSSStyleDeclaration>);
  container.appendChild(knifeCanvas);
  const resizeKnifeCanvas = () => { knifeCanvas.width = container.offsetWidth; knifeCanvas.height = container.offsetHeight; };
  resizeKnifeCanvas();

  // Knife: получить центр сокета по nodeId + ключу + стороне (container-relative screen coords)
  const socketScreenPos = (nodeId: string, key: string, side: "input"|"output"): {x:number;y:number}|null => {
    const view = area.nodeViews.get(nodeId) as {element:HTMLElement}|undefined;
    if (!view) return null;
    const el = view.element.querySelector<HTMLElement>(`[data-testid="${side}-${key}"] [data-testid="${side}-socket"]`);
    if (!el) return null;
    const cr = container.getBoundingClientRect(), sr = el.getBoundingClientRect();
    return { x: sr.left + sr.width/2 - cr.left, y: sr.top + sr.height/2 - cr.top };
  };
  const sampleBez = (p0:{x:number;y:number}, cp1:{x:number;y:number}, cp2:{x:number;y:number}, p3:{x:number;y:number}, t:number) => {
    const m = 1-t; return { x:m*m*m*p0.x+3*m*m*t*cp1.x+3*m*t*t*cp2.x+t*t*t*p3.x, y:m*m*m*p0.y+3*m*m*t*cp1.y+3*m*t*t*cp2.y+t*t*t*p3.y };
  };
  const segsIntersect = (ax:number,ay:number,bx:number,by:number,cx:number,cy:number,dx:number,dy:number) => {
    const d1x=bx-ax,d1y=by-ay,d2x=dx-cx,d2y=dy-cy; const cross=d1x*d2y-d1y*d2x;
    if (Math.abs(cross)<1e-10) return false;
    const t=((cx-ax)*d2y-(cy-ay)*d2x)/cross, u=((cx-ax)*d1y-(cy-ay)*d1x)/cross;
    return t>=0&&t<=1&&u>=0&&u<=1;
  };
  const knifeHitsConn = (path:{x:number;y:number}[], conn:ClassicPreset.Connection<ClassicPreset.Node,ClassicPreset.Node>) => {
    const src = socketScreenPos(conn.source, conn.sourceOutput, "output");
    const tgt = socketScreenPos(conn.target, conn.targetInput, "input");
    if (!src||!tgt) return false;
    const dx = Math.max(Math.abs(tgt.x-src.x)*0.5,60);
    const cp1={x:src.x+dx,y:src.y}, cp2={x:tgt.x-dx,y:tgt.y};
    const pts = Array.from({length:13},(_,i)=>sampleBez(src,cp1,cp2,tgt,i/12));
    for (let ki=1;ki<path.length;ki++) { const ka=path[ki-1],kb=path[ki]; for (let si=1;si<pts.length;si++) { const sa=pts[si-1],sb=pts[si]; if (segsIntersect(ka.x,ka.y,kb.x,kb.y,sa.x,sa.y,sb.x,sb.y)) return true; } }
    return false;
  };

  // Глобальный трекинг Y-клавиши (knife mode)
  const yKey = {pressed:false};
  const onYKey = (e:KeyboardEvent) => { if (e.key==="y"||e.key==="Y") yKey.pressed = e.type==="keydown"; };
  document.addEventListener("keydown", onYKey); document.addEventListener("keyup", onYKey);

  // Нода-id по DOM-элементу (для Shift+drag dup)
  const nodeIdFromTarget = (target:EventTarget|null):string|null => {
    if (!target) return null; const el = target as HTMLElement;
    for (const [id, view] of area.nodeViews) { const v = view as {element:HTMLElement}; if (v.element===el||v.element.contains(el)) return id; }
    return null;
  };

  type Mode = "none"|"box"|"knife";
  let mode:Mode = "none";
  let boxStart:{x:number;y:number}|null = null;
  let knifePath:{x:number;y:number}[] = [];
  let shiftDrag:{nodeId:string;x:number;y:number}|null = null; // Shift+drag на ноде

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const onNodeId = nodeIdFromTarget(e.target);
    // Shift+drag по НОДЕ → duplicate-at-cursor: стопаем Rete-drag, ждём первого move
    if (e.shiftKey && onNodeId) {
      shiftDrag = {nodeId:onNodeId, x:e.clientX, y:e.clientY};
      e.stopPropagation(); // блокируем Rete node-drag
      return;
    }
    // Alt+drag → pan (не перехватываем, Rete обрабатывает)
    if (e.altKey) return;
    // Клик/drag по ноде без Shift/Alt → Rete обрабатывает (pick + drag)
    if (onNodeId) return;
    // Drag по ФОНУ — box-select или knife
    e.stopPropagation(); e.preventDefault();
    const r = container.getBoundingClientRect();
    const px = e.clientX-r.left, py = e.clientY-r.top;
    if (yKey.pressed) {
      mode = "knife"; knifePath = [{x:px,y:py}];
      resizeKnifeCanvas(); knifeCanvas.style.display="block";
    } else {
      mode = "box"; boxStart = {x:px,y:py};
      Object.assign(boxEl.style,{display:"block",left:px+"px",top:py+"px",width:"0px",height:"0px"});
    }
    try { container.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const onPointerMove = (e: PointerEvent) => {
    // Shift+drag: проверяем порог → duplicate
    if (shiftDrag) {
      const dx=e.clientX-shiftDrag.x, dy=e.clientY-shiftDrag.y;
      if (Math.sqrt(dx*dx+dy*dy) > 6) {
        const d = splitDup([shiftDrag.nodeId]); shiftDrag=null;
        if (d.effectIds.length||d.opIds.length) {
          const r = container.getBoundingClientRect();
          pendingPos.current = toGraph(e.clientX-r.left, e.clientY-r.top);
          onDuplicate(d.effectIds, d.opIds);
        }
      }
      return;
    }
    if (mode==="knife") {
      const r=container.getBoundingClientRect();
      knifePath.push({x:e.clientX-r.left,y:e.clientY-r.top});
      const ctx=knifeCanvas.getContext("2d"); if (!ctx) return;
      ctx.clearRect(0,0,knifeCanvas.width,knifeCanvas.height);
      ctx.beginPath(); ctx.strokeStyle="rgba(255,80,80,0.85)"; ctx.lineWidth=2; ctx.setLineDash([6,3]);
      knifePath.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y)); ctx.stroke();
      return;
    }
    if (mode!=="box"||!boxStart) return;
    const r=container.getBoundingClientRect();
    const cx=e.clientX-r.left, cy=e.clientY-r.top;
    Object.assign(boxEl.style,{left:Math.min(boxStart.x,cx)+"px",top:Math.min(boxStart.y,cy)+"px",width:Math.abs(cx-boxStart.x)+"px",height:Math.abs(cy-boxStart.y)+"px"});
  };

  const onPointerUp = (e: PointerEvent) => {
    shiftDrag=null;
    if (mode==="knife") {
      mode="none"; knifeCanvas.style.display="none";
      const ctx=knifeCanvas.getContext("2d"); if (ctx) ctx.clearRect(0,0,knifeCanvas.width,knifeCanvas.height);
      if (knifePath.length>1) {
        for (const conn of editor.getConnections()) { if (knifeHitsConn(knifePath,conn)) editor.removeConnection(conn.id).catch(()=>{}); }
      }
      knifePath=[];
      try { container.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      return;
    }
    if (mode!=="box"||!boxStart) return;
    mode="none";
    const sel=boxEl.getBoundingClientRect(); boxStart=null; boxEl.style.display="none";
    try { container.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (sel.width<4&&sel.height<4) return;
    const hits:string[]=[];
    for (const [id,view] of area.nodeViews) {
      const nr=(view.element as HTMLElement).getBoundingClientRect();
      if (nr.left<sel.right&&nr.right>sel.left&&nr.top<sel.bottom&&nr.bottom>sel.top) hits.push(id);
    }
    hits.forEach((id,i)=>selectNode(id,e.ctrlKey||i>0));
  };
  container.addEventListener("pointerdown", onPointerDown, true);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", onPointerUp);

  // T0e: пользовательская правка связей = правка РЁБЕР дока. Валидация только типов;
  // одиночные входы авторитетно чистит withEdge (App), редактор пересоберётся от рёбер.
  const dtypeOf = (nodeId: string, key: string, side: "in" | "out"): DType | undefined => {
    const n = editor.getNode(nodeId) as unknown as {
      inputs: Record<string, { socket?: { dtype?: DType } } | undefined>;
      outputs: Record<string, { socket?: { dtype?: DType } } | undefined>;
    } | undefined;
    const s = side === "in" ? n?.inputs?.[key]?.socket : n?.outputs?.[key]?.socket;
    return s?.dtype;
  };
  // rete-connection id -> канонический ключ ребра дока (для connectionremoved).
  const edgeKeyOfConn = new Map<string, string>();
  const docEndsOf = (c: { source: string; sourceOutput: string; target: string; targetInput: string }) => {
    const fromEnt = entityOfNode.get(c.source);
    const toEnt = entityOfNode.get(c.target);
    if (!fromEnt || !toEnt) return null;
    return { from: { node: fromEnt, out: c.sourceOutput }, to: { node: toEnt, in: c.targetInput } };
  };
  const keyOfEnds = (e: { from: { node: string; out: string }; to: { node: string; in: string } }) =>
    `${e.from.node}.${e.from.out}>${e.to.node}.${e.to.in}`;
  editor.addPipe((ctx) => {
    if (building || ctx.type !== "connectioncreated") return ctx;
    const c = ctx.data;
    // типы концов должны совпадать (голубое к голубому, … жёлтое к жёлтому)
    const st = dtypeOf(c.source, c.sourceOutput, "out");
    const tt = dtypeOf(c.target, c.targetInput, "in");
    if (st && tt && st !== tt) { setTimeout(() => editor.removeConnection(c.id).catch(() => {}), 0); return ctx; }
    const ends = docEndsOf(c);
    if (!ends) return ctx;
    // визуал до пересборки: field-связь — пунктирная ссылка
    (c as unknown as { dtype?: DType; ref?: boolean }).dtype = st ?? "points";
    if (st === "field") {
      (c as unknown as { ref: boolean }).ref = true;
      setTimeout(() => (area as unknown as { update: (t: string, id: string) => Promise<void> }).update("connection", c.id).catch(() => {}), 0);
    }
    edgeKeyOfConn.set(c.id, keyOfEnds(ends));
    onAddEdge(ends.from, ends.to); // дальше док -> компилятор -> пересборка от рёбер
    return ctx;
  });
  editor.addPipe((ctx) => {
    if (building || ctx.type !== "connectionremoved") return ctx;
    const c = ctx.data as unknown as { id: string; source: string; sourceOutput: string; target: string; targetInput: string };
    const ends = docEndsOf(c);
    const key = edgeKeyOfConn.get(c.id) ?? (ends ? keyOfEnds(ends) : null);
    edgeKeyOfConn.delete(c.id);
    if (key) onRemoveEdge(key);
    return ctx;
  });

  // Колонки: ВИДЕО (x=-340) -> детект (x=0) -> рисовалки (x=320) -> ЭКРАН (x=640).
  // Сверху (y=-300) — горизонтальная цепочка 2D-FX нод (B5). Экран — сток: вход `видео` (финал
  // 2D-FX цепочки) + вход `оверлеи` (рисовалки lines/splat); композит происходит в рендере.
  // T3 Composite: 3D-ветка активна, если включена глубина-облако ИЛИ любой 3D-слой (то же условие
  // any3D, что в resolveConfig). Тогда появляется нода Композит + вход «3D/композит» у Экрана.
  const any3D = config.depthEnabled || config.layers.some((l) => l.enabled && LAYER_DEFS[l.kind]?.group === "3D");

  const out = new ClassicPreset.Node("Экран");
  out.addInput("video", new ClassicPreset.Input(sMap, "видео"));   // финал цепочки 2D-FX
  out.addInput("in", new ClassicPreset.Input(sMap, "оверлеи"));    // рисовалки (lines/splat)
  if (any3D) out.addInput("cloud", new ClassicPreset.Input(sMap, "3D/композит")); // T3: выход ноды Композит
  await editor.addNode(out);
  await placeNode(out.id, SCREEN_NODE, 640, 40);
  screenNodeId = out.id;
  entityOfNode.set(out.id, SCREEN_NODE); nodeOfEntity.set(SCREEN_NODE, out);

  // Нода-источник «Видео» (корень графа, §3.5): видео/глубина/облако. Детект-ноды берут отсюда
  // `видео`. Пока провод структурный (топология); авторитетным станет в A4 (наличие ребра = детектор вкл).
  const videoNode = new ClassicPreset.Node("Видео");
  videoNode.addOutput("video", new ClassicPreset.Output(sMap, "видео"));
  videoNode.addOutput("depth", new ClassicPreset.Output(sMap, "глубина"));
  videoNode.addOutput("cloud", new ClassicPreset.Output(sPoints, "облако"));
  await editor.addNode(videoNode);
  await placeNode(videoNode.id, VIDEO_NODE, -340, 40);
  videoNodeId = videoNode.id;
  entityOfNode.set(videoNode.id, VIDEO_NODE); nodeOfEntity.set(VIDEO_NODE, videoNode);

  // T3 Composite: нода «Композит» (singleton, появляется при any3D) — задаёт порядок (что-над-чем)
  // и режим смешивания flat↔cloud (закрывает жалобу #3 «облако всегда сверху»). НЕ сущность графа:
  // в entityOfNode НЕ регистрируется → docEndsOf вернёт null для любых её рёбер (пользовательский
  // провод к ней НЕ запишется в док). Рёбра ниже — декоративные, добавляются при building=true
  // (пайпы connectioncreated/removed их игнорируют). Авторитет — её контрол → ГЛОБАЛЫ конфига.
  if (any3D) {
    const comp = new ClassicPreset.Node("Композит");
    comp.addInput("video", new ClassicPreset.Input(sMap, "2D"));      // 2D-сцена (flat)
    comp.addInput("cloud", new ClassicPreset.Input(sPoints, "3D"));   // облако точек
    comp.addOutput("out", new ClassicPreset.Output(sMap, "выход"));
    comp.addControl("composite", new CompositeControl(
      config.compositeOrder ?? "cloudOver",
      config.compositeBlend ?? "normal",
      onSetComposite,
    ));
    await editor.addNode(comp);
    await area.translate(comp.id, { x: 470, y: -150 }); // фикс. позиция, НЕ персистим (не сущность)
    // декоративные рёбра: Видео.видео/облако → Композит → Экран.3D (building=true → не пишут док)
    const wire = async (s: typeof comp, so: string, t: typeof comp, ti: string, dt: DType) => {
      const cn = new ClassicPreset.Connection(s, so, t, ti);
      (cn as unknown as { dtype: DType }).dtype = dt;
      await editor.addConnection(cn);
    };
    await wire(videoNode, "video", comp, "video", "map");
    await wire(videoNode, "cloud", comp, "cloud", "points");
    await wire(comp, "out", out, "cloud", "map");
  }

  // B5/B-edge: каждый 2D-шейдер-FX — ОТДЕЛЬНАЯ map→map нода (= проход движка FlatView, B1–B4). Чейнятся
  // Видео.видео → FX → … → Экран.видео в порядке config.shaderFxOrder (рёбра АВТОРИТЕТНЫ: перевязал
  // провод → пересчёт порядка проходов в рендере, см. computeFxOrder/writeFxOrder). ⏻ вкл/выкл слоя;
  // ✕ = убрать из цепочки; клик по ноде → её крутилки в инспекторе (onSelectShaderFx).
  // T0c: каждый shader-СЛОЙ (инстанс) — отдельная map→map нода. Мультиэкземпляр: два thermal-слоя =
  // две ноды в цепочке. Порядок — config.shaderFxOrder (id слоёв), недостающие — в хвост (порядок layers).
  const shaderLayers = config.layers.filter((l) => LAYER_DEFS[l.kind]?.domain === "shader");
  const fxById = new Map(shaderLayers.map((l) => [l.id, l] as const));
  const orderedFx: typeof shaderLayers = [];
  {
    const seen = new Set<string>();
    for (const id of config.shaderFxOrder ?? []) {
      const l = fxById.get(id);
      if (l && !seen.has(id)) { orderedFx.push(l); seen.add(id); }
    }
    for (const l of shaderLayers) if (!seen.has(l.id)) orderedFx.push(l);
  }
  // T0e: рёбра цепочки НЕ рисуем здесь — ВСЕ рёбра графа рисуются одним проходом из дока ниже.
  // Порядок orderedFx остаётся только для дефолтной раскладки колонкой.
  let fxX = -180;
  for (const l of orderedFx) {
    const fxNode = new ClassicPreset.Node(LAYER_DEFS[l.kind].label);
    fxNode.addInput("in", new ClassicPreset.Input(sMap, "вход"));
    // direction A: ref-входы биндабельных числовых params (жёлтые, Field) — провод от сигнала/Math
    // драйвит параметр shader-FX (паритет с эффект-нодами; рёбра резолвит applyGraph -> layer.bindings).
    for (const f of layerBindable(l.kind)) {
      fxNode.addInput(f, new ClassicPreset.Input(sField, "↳ " + (PARAM_SHORT[f] ?? f)));
    }
    fxNode.addOutput("out", new ClassicPreset.Output(sMap, "выход"));
    fxNode.addControl("actions", new NodeActions(
      l.enabled,
      (en) => onSetLayerEnabled(l.id, en),     // ⏻ вкл/выкл ЭТОГО инстанса
      () => onRemoveLayer(l.id),                // ✕ = убрать слой-инстанс из цепочки
    ));
    await editor.addNode(fxNode);
    await placeNode(fxNode.id, l.id, fxX, -300); // новый инстанс — у курсора (pendingPos), иначе колонкой
    fxX += 175;
    nodeToShaderFx.set(fxNode.id, l.id);
    nodeToLayer.set(fxNode.id, l.id); // клик/Delete идут по слою (как у продюсеров)
    entityOfNode.set(fxNode.id, l.id); nodeOfEntity.set(l.id, fxNode);
  }

  // A1b: сигналы-драйверы — это field-выходы ДЕТЕКТ-нод (не отдельные ноды). Группа драйверов
  // принадлежит своему продюсеру: раскрытие/…→hands, энергия→motion, центроид→faceBoxes, число→peopleBox.
  const groupByKind = new Map<LayerKind, (typeof DRIVER_GROUPS)[number]>();
  for (const grp of DRIVER_GROUPS) groupByKind.set(driverProducer(grp.signals[0]), grp);

  // Проход 1: ноды-продюсеры (детект). Берут `видео` от ноды «Видео», отдают `точки` + свои сигналы.
  const prodByKind = new Map<LayerKind, ClassicPreset.Node>();
  let prodY = 0;
  for (const l of config.layers) {
    if (!isPointProducer(l.kind)) continue;
    // U2-b: "force" — ДВОЙНОЙ домен (isPointProducer И domain "particle"). Строится в particle-проходе
    // ниже (там же points-сокеты CPU-ветки) — здесь ПРОПУСКАЕМ, иначе дубль-нода на один l.id
    // (две rete-ноды дерутся за placeNode/nodeOfEntity → призрак, сломанные клик/Delete/рёбра).
    if (LAYER_DEFS[l.kind]?.domain === "particle") continue;
    const grp = groupByKind.get(l.kind); // сигналы этой детект-ноды (если есть)
    const pnode = new ClassicPreset.Node(PRODUCER_LABEL[l.kind] ?? l.name);
    // T2-3: points-входы конвертера — data-driven по convertInputs (sample/setAttr/transform/merge/sort).
    const convIns = LAYER_DEFS[l.kind]?.convertInputs ?? [];
    for (const ci of convIns) {
      // U2: socket-aware — вход "particles" (Particles→Points) тянется от Render-ноды (оранжевый),
      // прочие — точечные продюсеры (голубой). Дефолт "points" — back-compat.
      const sock = ci.socket === "particles" ? sParticles : sPoints;
      const label = ci.socket === "particles" ? "частицы" : ci.in === "b" ? "точки B" : "точки";
      pnode.addInput(ci.in, new ClassicPreset.Input(sock, label));
    }
    // Карта/видео от ноды «Видео» — data-driven по producerMapIn (единый источник правды с
    // graphDoc/applyGraph: какой вход гейтит активность, такой и рисуем; генератор grid — без входа).
    const mapIn = producerMapIn(l.kind);
    if (mapIn === "depth") pnode.addInput("depth", new ClassicPreset.Input(sMap, "глубина"));
    else if (mapIn === "video") pnode.addInput("video", new ClassicPreset.Input(sMap, "видео"));
    for (const fi of LAYER_DEFS[l.kind]?.fieldInputs ?? []) {
      pnode.addInput(fi.in, new ClassicPreset.Input(sField, "↳ " + (fi.label ?? fi.in)));
    }
    pnode.addOutput("points", new ClassicPreset.Output(sPoints, "точки"));
    if (grp) {
      for (const sig of grp.signals) pnode.addOutput(sig, new ClassicPreset.Output(sField, DRIVER_SHORT[sig]));
      pnode.addControl("meters", new SignalMeters(grp.signals, getDrivers)); // живой CHOP-вьюер
    }
    pnode.addControl("stats", new PointMeters(l.id, getStats)); // T-Debug: live кол-во точек/атрибутов
    // действия на детект-ноде: ⏻ вкл/выкл слоя + ✕ удалить (A2-пробел; l.id -> замыкания).
    pnode.addControl("actions", new NodeActions(
      l.enabled,
      (en) => onSetLayerEnabled(l.id, en),
      () => onRemoveLayer(l.id),
    ));
    await editor.addNode(pnode);
    await placeNode(pnode.id, l.id, 0, prodY);
    prodY += (grp ? 100 + grp.signals.length * 46 : 140) + 34; // +строка действий
    nodeToLayer.set(pnode.id, l.id);
    nodeToKind.set(pnode.id, l.kind);
    if (grp) signalNodeIds.add(pnode.id); // нода также источник ссылок-драйверов
    entityOfNode.set(pnode.id, l.id); nodeOfEntity.set(l.id, pnode);
    if (!prodByKind.has(l.kind)) prodByKind.set(l.kind, pnode); // back-compat: первый инстанс вида
  }

  // Фолбэк: группы, чей продюсер ОТСУТСТВУЕТ в графе (слой не добавлен) — отдельной нодой-сигналом
  // со СТАБИЛЬНЫМ entity-id "sig:<kind>" (T0e: рёбра дока адресуют её по этому id). Напр. «Аудио».
  let drvY = prodY + 40;
  for (const grp of DRIVER_GROUPS) {
    const prodKind = driverProducer(grp.signals[0]);
    if (prodByKind.has(prodKind)) continue;
    const dn = new ClassicPreset.Node(grp.label);
    for (const sig of grp.signals) dn.addOutput(sig, new ClassicPreset.Output(sField, DRIVER_SHORT[sig]));
    dn.addControl("meters", new SignalMeters(grp.signals, getDrivers));
    await editor.addNode(dn);
    await placeNode(dn.id, sigNodeId(prodKind), 0, drvY);
    drvY += 80 + grp.signals.length * 46;
    signalNodeIds.add(dn.id);
    entityOfNode.set(dn.id, sigNodeId(prodKind)); nodeOfEntity.set(sigNodeId(prodKind), dn);
  }

  // T5 v2: particle-ноды (domain "particle") — отдельная GPU-цепочка (сокет particles, оранжевый).
  // Emitter (входы points+map, выход particles) → Force/ParticleColor (particles→particles) →
  // Render (particles, терминал — без выхода). Клик → инспектор слоя; ⏻/✕ — NodeActions; рёбра —
  // единый проход ниже (dtype="particles" → оранжевый сплошной провод). Pull: рисуется только
  // цепочка до Render (resolveConfig.buildParticleSystems).
  let partY = 520;
  for (const l of config.layers) {
    if (LAYER_DEFS[l.kind]?.domain !== "particle") continue;
    const node = new ClassicPreset.Node(LAYER_DEFS[l.kind].label);
    if (l.kind === "emitter") {
      node.addInput("points", new ClassicPreset.Input(sPoints, "точки"));
      node.addInput("map", new ClassicPreset.Input(sMap, "карта"));
      node.addOutput("particles", new ClassicPreset.Output(sParticles, "частицы"));
    } else if (l.kind === "particleRender") {
      node.addInput("particles", new ClassicPreset.Input(sParticles, "частицы"));
      // U2: «отвод» терминала на CPU-конвертер Particles→Points (рендер остаётся; readback ≤N точек
      // на низкой частоте). Без этого выхода провод Render→particlesToPoints нарисовать нельзя.
      node.addOutput("particles", new ClassicPreset.Output(sParticles, "частицы"));
    } else { // force / particleColor
      node.addInput("particles", new ClassicPreset.Input(sParticles, "частицы"));
      node.addOutput("particles", new ClassicPreset.Output(sParticles, "частицы"));
      // U2-b: ЕДИНАЯ нода «Force» — доп. points-сокеты (CPU-резидентность). Воткнул points → CPU-солвер
      // (pointForceSource→points-out в Lines/Splat); particles → GPU-цепочка (выше). Диспатч по входу.
      if (l.kind === "force") {
        node.addInput("points", new ClassicPreset.Input(sPoints, "точки"));
        node.addOutput("points", new ClassicPreset.Output(sPoints, "точки"));
      }
    }
    node.addControl("actions", new NodeActions(
      l.enabled,
      (en) => onSetLayerEnabled(l.id, en),
      () => onRemoveLayer(l.id),
    ));
    await editor.addNode(node);
    const colX = l.kind === "emitter" ? 0 : l.kind === "particleRender" ? 640 : 320;
    await placeNode(node.id, l.id, colX, partY);
    partY += 150;
    nodeToLayer.set(node.id, l.id); // клик → инспектор слоя; Delete → слой
    nodeToKind.set(node.id, l.kind);
    entityOfNode.set(node.id, l.id); nodeOfEntity.set(l.id, node);
  }

  // T5 v2 Phase B: Map2D-ноды (domain "map2d") — CPU-карты (сокет `map`-розовый). noise2d (генератор,
  // выход `map`); mapCombine (входы `a`,`b` из mapInputs + выход `map`). Клик → инспектор; ⏻/✕ —
  // NodeActions; рёбра — единый проход (dtype `map` → розовый). Резолвятся mapSources.mapForRef.
  let mapY = 200;
  for (const l of config.layers) {
    if (LAYER_DEFS[l.kind]?.domain !== "map2d") continue;
    const node = new ClassicPreset.Node(LAYER_DEFS[l.kind].label);
    for (const mi of LAYER_DEFS[l.kind]?.mapInputs ?? []) {
      node.addInput(mi.in, new ClassicPreset.Input(sMap, "карта " + mi.in.toUpperCase()));
    }
    node.addOutput("map", new ClassicPreset.Output(sMap, "карта"));
    node.addControl("preview", new MapPreview(l.id, getMapPreview)); // ЧБ-превью карты (T-Debug(б))
    node.addControl("actions", new NodeActions(
      l.enabled,
      (en) => onSetLayerEnabled(l.id, en),
      () => onRemoveLayer(l.id),
    ));
    await editor.addNode(node);
    await placeNode(node.id, l.id, -180, mapY);
    mapY += 140;
    nodeToLayer.set(node.id, l.id);
    nodeToKind.set(node.id, l.kind);
    entityOfNode.set(node.id, l.id); nodeOfEntity.set(l.id, node);
  }

  // Проход 2: top-level эффекты (любой ModifierKind). Потоки (points->эффект->экран) + ССЫЛКИ.
  let fxY = 0;
  for (const e of config.effects) {
    const def = MODIFIER_DEFS[e.kind];
    if (!def) continue;
    const bindable = def.bindable;
    const fx = new ClassicPreset.Node(def.label);
    fx.addInput("points", new ClassicPreset.Input(sPoints, "точки")); // поток (голубой)
    for (const f of bindable) {                                       // ref-входы параметров (жёлтые)
      fx.addInput(f, new ClassicPreset.Input(sField, "↳ " + (PARAM_SHORT[f] ?? f)));
    }
    fx.addOutput("out", new ClassicPreset.Output(sMap, "выход"));
    // действия на ноде: дизейбл/удаление (захватываем e.id в замыкания колбэков).
    fx.addControl("actions", new NodeActions(
      e.enabled,
      (enabled) => onSetEnabled(e.id, enabled),
      () => onRemoveEffect(e.id),
    ));
    await editor.addNode(fx);
    await placeNode(fx.id, e.id, 320, fxY);
    fxY += 230; // выше из-за ref-входов параметров + строки действий
    nodeToEffect.set(fx.id, e.id);      // клик/Delete/перевязка -> top-level эффект
    nodeToEffectKind.set(fx.id, e.kind); // для bindableField (какие входы — ссылки)
    entityOfNode.set(fx.id, e.id); nodeOfEntity.set(e.id, fx);
    // T0e: все провода (поток точек / out->Экран / ссылки-биндинги) рисуются из дока ниже.
  }

  // T1 Field-алгебра: оп-ноды (Field→Field) data-driven по OP_DEFS. Вход `in`(field) — только у
  // нод с inputs>0 (Math/MapRange/Compare/Mix/Ramp/Noise); 0-входные (Constant/LFO/Random/Noise) — источники.
  // Mix имеет 2 входа (A="in", B="b"). Выход `out`(field) — на ref-параметр эффекта (binding.signal).
  let mathY = -160;
  for (const op of config.opNodes ?? []) {
    const def = OP_DEFS[op.op] ?? OP_DEFS.math;
    const mnode = new ClassicPreset.Node(def.label);
    if (def.inputs > 0) mnode.addInput("in", new ClassicPreset.Input(sField, def.inputs > 1 ? "A" : "сигнал"));
    if (def.inputs > 1) mnode.addInput("b", new ClassicPreset.Input(sField, "B"));   // Mix: второй вход
    mnode.addOutput("out", new ClassicPreset.Output(sField, "→"));
    const params: OpParams = {};
    for (const fs of def.fields) params[fs.field] = (op as unknown as OpParams)[fs.field] ?? def.defaults[fs.field];
    // Ramp: кривая хранится в op.stops (не в params); передаём отдельно в OpControl.
    const initStops = op.op === "ramp" ? (op.stops ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }]) : undefined;
    const onStops = op.op === "ramp"
      ? (stops: RampStop[]) => onSetOpNodeParams(op.id, { stops } as unknown as OpParams)
      : undefined;
    mnode.addControl("op", new OpControl(
      op.op, params,
      (p) => onSetOpNodeParams(op.id, p),
      () => onRemoveOpNode(op.id),
      initStops,
      onStops,
    ));
    await editor.addNode(mnode);
    await placeNode(mnode.id, op.id, 320, mathY);
    mathY -= 200;
    nodeToOpNode.set(mnode.id, op.id);
    entityOfNode.set(mnode.id, op.id); nodeOfEntity.set(op.id, mnode);
  }

  // === T0e: ЕДИНСТВЕННЫЙ проход отрисовки связей — рёбра дока 1:1. ===
  // Стиль из типа выходного сокета (field -> пунктирная ссылка). Ребро на отсутствующую
  // ноду/сокет молча пропускается (sanitizeGraph чистит при загрузке).
  for (const ed of doc.edges) {
    const src = nodeOfEntity.get(ed.from.node);
    const tgt = nodeOfEntity.get(ed.to.node);
    if (!src || !tgt) continue;
    const sOut = (src as unknown as { outputs: Record<string, { socket?: { dtype?: DType } } | undefined> }).outputs?.[ed.from.out];
    const tIn = (tgt as unknown as { inputs: Record<string, unknown> }).inputs?.[ed.to.in];
    if (!sOut || !tIn) continue;
    const conn = new ClassicPreset.Connection(src, ed.from.out, tgt, ed.to.in);
    const dt = sOut.socket?.dtype ?? "points";
    (conn as unknown as { dtype: DType }).dtype = dt;
    if (dt === "field") (conn as unknown as { ref: boolean }).ref = true;
    await editor.addConnection(conn);
    edgeKeyOfConn.set(conn.id, keyOfEnds({ from: ed.from, to: ed.to }));
  }

  // Транс-форм: при пересборке (правка рёбер дёргает structSig) сохраняем зум/пан — граф не прыгает.
  const savedT = savedTransform.current;
  if (savedT) {
    const a2 = area.area as unknown as { zoom: (k: number) => Promise<unknown>; translate: (x: number, y: number) => Promise<unknown> };
    await a2.zoom(savedT.k);
    await a2.translate(savedT.x, savedT.y);
  } else {
    AreaExtensions.zoomAt(area, editor.getNodes());
  }
  building = false; // дальше реагируем на связи, созданные пользователем
  if (import.meta.env.DEV) {
    (window as unknown as { __graph?: unknown }).__graph = {
      editor, area, selector, selectNode, removeNodeById,
      nodeToKind, nodeToEffect, nodeToEffectKind, nodeToShaderFx, nodeToLayer, nodeToOpNode,
      signalNodeIds, entityOfNode, nodeOfEntity,
    };
  }
  return () => {
    // T0e: запомнить зум/пан для следующей пересборки (правка рёбер пересобирает граф).
    const t = (area as unknown as { area?: { transform?: { k: number; x: number; y: number } } }).area?.transform;
    if (t) savedTransform.current = { k: t.k, x: t.x, y: t.y };
    for (const tm of posTimers.values()) clearTimeout(tm);
    container.removeEventListener("keydown", onKey);
    container.removeEventListener("pointerdown", onPointerDown, true);
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("pointerup", onPointerUp);
    container.removeEventListener("mousemove", onMouseMoveCursor);
    document.removeEventListener("keydown", onYKey);
    document.removeEventListener("keyup", onYKey);
    boxEl.remove(); knifeCanvas.remove();
    area.destroy();
  };
}

// Легенда графа: типы сокетов (цвет) + поток vs ссылка (сплошной/пунктир). Левый нижний угол.
function GraphLegend() {
  const dot = (c: string) => ({ width: 9, height: 9, borderRadius: "50%", background: c, boxShadow: `0 0 5px ${c}`, display: "inline-block" });
  return (
    <div style={{
      position: "absolute", left: 12, bottom: 12, zIndex: 21,
      background: "rgba(8,10,16,0.72)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8,
      padding: "8px 10px", fontSize: 11, color: "#cdd3df", lineHeight: 1.7, pointerEvents: "none",
    }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <span><i style={dot(SOCKET_COLORS.points)} /> точки</span>
        <span><i style={dot(SOCKET_COLORS.map)} /> карта</span>
        <span><i style={dot(SOCKET_COLORS.field)} /> сигнал</span>
        <span><i style={dot(SOCKET_COLORS.particles)} /> частицы</span>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 2 }}>
        <span><svg width="22" height="6" style={{ verticalAlign: "middle" }}><line x1="0" y1="3" x2="22" y2="3" stroke="#9aa3b2" strokeWidth="3" /></svg> поток</span>
        <span><svg width="22" height="6" style={{ verticalAlign: "middle" }}><line x1="0" y1="3" x2="22" y2="3" stroke={SOCKET_COLORS.field} strokeWidth="2.5" strokeDasharray="5 3" /></svg> ссылка (драйвер→параметр)</span>
      </div>
    </div>
  );
}

// Палитра добавления нод (Tab, §3.6.4 — ГЛАВНЫЙ UX-рычаг). Категории по контексту (§3.6.3) +
// фуззи-поиск-по-набору (печатаешь «ramp» → фильтр) + ЦВЕТ по типу ВЫХОДА ноды (Map2D-розовый /
// PointSet-голубой / Field-жёлтый). Сейчас в палитре — только реально существующие ноды (клик
// добавляет ноду в граф); новые виды каталога §3.6.3 (Ramp/Noise/Composite/частицы/…) подключаются
// добавлением записи СЮДА по мере реализации (T1–T6) — категории/цвет/поиск уже готовы их принять.
type AddKind = "layer" | "effect" | "opnode"; // как нода добавляется в конфиг
type PaletteItem = {
  kind: string;        // LayerKind | ModifierKind | "math"
  add: AddKind;
  out: DType;          // тип выхода -> цвет чипа
  label: string;       // готовая подпись (из реестра / явная)
  keywords?: string;   // доп. термины для фуззи-поиска (англ/синонимы)
};
type PaletteCat = { cat: string; items: PaletteItem[] };

const layerItem = (kind: LayerKind, out: DType, keywords?: string): PaletteItem =>
  ({ kind, add: "layer", out, label: LAYER_DEFS[kind]?.label ?? kind, keywords });
const effectItem = (kind: ModifierKind, out: DType, keywords?: string): PaletteItem =>
  ({ kind, add: "effect", out, label: MODIFIER_DEFS[kind]?.label ?? kind, keywords });
const opItem = (kind: OpKind, keywords?: string): PaletteItem =>
  ({ kind, add: "opnode", out: "field", label: OP_DEFS[kind]?.label ?? kind, keywords });

// Категории по §3.6.3. Цвет out = настоящий тип выхода ноды (детект отдают точки; маски — карту;
// Math — сигнал; рисовалки/оверлеи/3D композятся в карту-экран). T0c: шейдер-FX (thermal/sobel/…)
// теперь МУЛЬТИЭКЗЕМПЛЯРНЫ → в палитре (можно добавить вторую thermal-ноду в цепочку).
const NODE_PALETTE: PaletteCat[] = [
  { cat: "2D-эффекты", items: [
    layerItem("thermal", "map", "thermal тепловизор ик infrared heat жар"),
    layerItem("sobel", "map", "sobel обводка контур edge outline края"),
    layerItem("scanlines", "map", "scanlines сканлайны retro развёртка"),
    layerItem("pixelate", "map", "pixelate пикселизация глубина depth блоки"),
    layerItem("pixelArt", "map", "pixel art ascii пиксели символы палитра"),
    layerItem("lookup", "map", "lookup колоризация градиент рампа люма цвет colorize tint ramp"),
    layerItem("feedback", "map", "feedback петля шлейф trail эхо обратная связь память кадра motion blur"),
    layerItem("mirror", "map", "mirror kaleidoscope калейдоскоп зеркало мандала секторы симметрия"),
    layerItem("displace", "map", "displace глитч жидкость warp смещение uv distort noise self"),
    layerItem("chromAb", "map", "chromatic aberration хроматика фринжинг radial linear rgb shift"),
    layerItem("grain", "map", "grain зерно плёнка film noise шум аналог texture"),
  ] },
  { cat: "Источники", items: [
    layerItem("grid", "points", "grid сетка решётка генератор точки uv ramp стартовые позиции процедурный"),
    layerItem("hands", "points", "hands mediapipe руки кисть жесты"),
    layerItem("faceMesh", "points", "face mesh лицо сетка landmarks 468"),
    layerItem("faceBoxes", "points", "face boxes лицо боксы рамки"),
    layerItem("motion", "points", "motion движение vision энергия"),
    layerItem("peopleBox", "points", "people boxes люди боксы yolo"),
    layerItem("peopleMask", "map", "people mask yolo маска сегментация инстансы"),
    layerItem("selfie", "map", "selfie segmentation гладкая маска deeplab"),
    layerItem("audio", "field", "audio аудио звук музыка fft бас kick кик спектр частоты"),
  ] },
  { cat: "Поле / Сигнал", items: [ // T1 Field-алгебра: каждая оп-нода = отдельный вид (OP_DEFS), цвет field
    opItem("math", "math gain offset curve усиление кривая op"),
    opItem("const", "constant константа значение knob число"),
    opItem("mapRange", "map range remap ремап диапазон масштаб"),
    opItem("compare", "compare порог threshold gate гейт сравнить шаг"),
    opItem("lfo", "lfo время time осциллятор синус пила пульс анимация animate"),
    opItem("random", "random случайный рандом генератор jumpy"),
    opItem("mix", "mix blend lerp смешать микс интерполяция A B"),
    opItem("noise", "noise simplex шум перлин плавный fbm"),
    opItem("ramp", "ramp кривая curve gradient lookup таблица"),
    opItem("lag", "lag лаг сглаживание attack release атака спад фильтр smooth темп"),
    // T1-3 per-element источники (значение НА ТОЧКУ — вычисляется потребителем над его PointSet)
    opItem("position", "position позиция точка координата x y z per-element поле"),
    opItem("index", "index индекс градиент порядок точка per-element поле"),
    opItem("readAttr", "attribute атрибут named чтение pscale cd id per-element поле"),
    opItem("randomPt", "random точка per-point id стабильный случайный seed per-element поле"),
  ] },
  { cat: "Точки / Геометрия", items: [
    effectItem("lines", "map", "lines connect линии соединить constellation цепь"),
  ] },
  { cat: "Конвертеры", items: [
    layerItem("scatter", "points", "scatter глубина точки depth скаттер"),
    layerItem("sample", "points", "sample точки карта атрибут глубина значение"),
    layerItem("setAttr", "points", "setattr set attribute атрибут pscale размер цвет cd присвоить значение"),
    layerItem("transform", "points", "transform трансформ сдвиг масштаб поворот move scale rotate точки"),
    layerItem("merge", "points", "merge объединить слить точки A B combine join"),
    layerItem("sort", "points", "sort сортировка переупорядочить порядок order по атрибуту"),
    layerItem("trail", "points", "trail шлейф хвост след история trail motion инерция по id"),
    layerItem("split", "points", "split group группа разрез фильтр маска по полю порог select selection"),
    layerItem("particlesToPoints", "points", "particles points частицы точки readback gpu cpu downsample переезд граница split lines спредшит"),
    effectItem("splat", "map", "splat растеризация форма маска rasterize спрайт"),
  ] },
  { cat: "Частицы", items: [ // T5 v2: GPU-частицы (сокет particles); Emitter→[Force]→[Color]→Render
    layerItem("emitter", "particles", "emitter эмиттер частицы particles рождение spawn источник points map"),
    layerItem("force", "particles", "force сила гравитация шум curl turbulence drag вихрь поле gravity noise точки points cpu облако солвер физика силы единая unified pointforce"),
    layerItem("particleColor", "particles", "color цвет частиц age velocity возраст скорость constant"),
    layerItem("particleLight", "particles", "light свет светильник прожектор тень shadow самозатенение spot конус spread интенсивность"),
    layerItem("particleRender", "particles", "render рендер вывод out терминал точки sprite размер opacity blend"),
  ] },
  { cat: "Карты 2D", items: [ // T5 v2 Phase B: CPU-карты (сокет map) для эмиттера/scatter
    layerItem("noise2d", "map", "noise шум карта map fbm перлин simplex плотность процедурный"),
    layerItem("mapCombine", "map", "combine multiply умножить сложить screen min max комбинировать карты глубина нойз"),
  ] },
  { cat: "Оверлеи", items: [
    layerItem("constellation2D", "map", "constellation созвездие точки 2d сетка"),
    layerItem("hud", "map", "hud текст text надпись"),
  ] },
  { cat: "3D", items: [
    layerItem("scan", "map", "scan сканер глубина 3d"),
    layerItem("scanAscii", "map", "scan ascii символы сканер 3d"),
    layerItem("constellation3D", "map", "constellation 3d созвездие облако глубина"),
  ] },
];

// Фуззи-матч: символы запроса встречаются в строке по порядку (подпоследовательность). Возвращает
// score (меньше = лучше: штраф за разрывы, бонус за совпадение подряд) или null (нет совпадения).
function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  let ti = 0, score = 0, prev = -1;
  for (const ch of q) {
    if (ch === " ") continue;
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return null;
    score += idx - (prev + 1);          // штраф за разрыв
    if (idx === prev + 1) score -= 1;    // бонус за подряд
    prev = idx; ti = idx + 1;
  }
  return score + ti * 0.01;
}

function NodePalette({ existing, onPick, onClose, pos }: {
  existing: Set<string>;
  onPick: (it: PaletteItem) => void;
  onClose: () => void;
  pos?: { x: number; y: number }; // экранные координаты курсора; если нет — по центру
}) {
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0); // индекс подсветки в плоском отфильтрованном списке
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const isUsed = (it: PaletteItem) =>
    it.add === "layer" && !!LAYER_DEFS[it.kind as LayerKind]?.singleton && existing.has(it.kind);

  // фильтр + сортировка по score (пустой запрос -> всё в исходном порядке); пустые группы убираем.
  const groups = useMemo(() => NODE_PALETTE
    .map((g) => ({
      cat: g.cat,
      items: g.items
        .map((it) => ({ it, s: fuzzyScore(q, `${it.label} ${it.keywords ?? ""} ${g.cat}`) }))
        .filter((x) => x.s !== null)
        .sort((a, b) => (a.s as number) - (b.s as number))
        .map((x) => x.it),
    }))
    .filter((g) => g.items.length > 0), [q]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  useEffect(() => { setHi(0); }, [q]);

  const pick = (it: PaletteItem) => { if (!isUsed(it)) { onPick(it); onClose(); } };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(flat.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const it = flat[hi]; if (it) pick(it); }
  };

  // Позиция панели: у курсора или по центру (Tab без мыши)
  const panelPos = pos
    ? { left: Math.min(pos.x, window.innerWidth - 500), top: Math.min(pos.y, window.innerHeight - 420), transform: "none" as const }
    : { left: "50%" as const, top: "12%" as const, transform: "translateX(-50%)" as const };

  let fi = -1; // сквозной индекс по плоскому списку (для подсветки клавиатурой)
  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 30, background: "rgba(4,6,10,0.35)" }}>
      <div onClick={(e) => e.stopPropagation()} onKeyDown={onKey} style={{
        position: "absolute", ...panelPos,
        background: "rgba(12,15,22,0.97)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 10,
        padding: 12, minWidth: 380, maxWidth: 480, maxHeight: "74%", overflowY: "auto", boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
      }}>
        <input
          ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="поиск ноды…  (Tab/Esc, ↑↓ + Enter)"
          style={{
            width: "100%", boxSizing: "border-box", marginBottom: 10, padding: "7px 10px", fontSize: 13,
            borderRadius: 7, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.35)", color: "#eef2f8",
          }}
        />
        {flat.length === 0 && <div style={{ fontSize: 12, color: "#6c7686", padding: "4px 2px" }}>ничего не найдено</div>}
        {groups.map((grp) => (
          <div key={grp.cat} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: "#6c7686", margin: "4px 0" }}>{grp.cat}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {grp.items.map((it) => {
                fi += 1;
                const used = isUsed(it);
                const active = fi === hi;
                const c = SOCKET_COLORS[it.out];
                return (
                  <button key={`${it.add}:${it.kind}`} disabled={used} onClick={() => pick(it)}
                    title={`выход: ${it.out}`}
                    style={{
                      display: "flex", alignItems: "center", gap: 7,
                      fontSize: 12, padding: "5px 10px 5px 9px", borderRadius: 7, cursor: used ? "default" : "pointer",
                      borderLeft: `3px solid ${used ? "rgba(255,255,255,0.12)" : c}`,
                      border: "1px solid rgba(255,255,255,0.18)", borderLeftWidth: 3, borderLeftColor: used ? "rgba(255,255,255,0.12)" : c,
                      background: used ? "rgba(255,255,255,0.04)" : active ? "rgba(60,160,255,0.28)" : "rgba(60,160,255,0.12)",
                      color: used ? "#6c7686" : "#dbe2ee", outline: active ? "1px solid rgba(120,200,255,0.7)" : "none",
                    }}>
                    <i style={{ width: 8, height: 8, borderRadius: "50%", background: used ? "#3a3f49" : c, boxShadow: used ? "none" : `0 0 5px ${c}` }} />
                    {it.label}{used ? " ·✓" : ""}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// T0d: Settings — панель настроек (вкладка «Хоткеи»).
const HOTKEYS: [string, string][] = [
  ["Alt + drag", "панорамирование вьюпорта"],
  ["Drag по фону", "выделение рамкой (box-select)"],
  ["Ctrl + click", "добавить ноду к выделению"],
  ["Delete", "удалить выделенные ноды"],
  ["Tab / ПКМ по фону", "палитра нод у курсора"],
  ["Ctrl+C", "копировать выделенные"],
  ["Ctrl+V", "вставить у курсора"],
  ["Ctrl+D", "дублировать у курсора"],
  ["Shift + drag за ноду", "дублировать → клон у курсора"],
  ["Y + drag по проводу", "разрезать провод (knife)"],
  ["Ctrl+Z", "отменить (undo)"],
  ["Ctrl+Y / Ctrl+Shift+Z", "повторить (redo)"],
];
function SettingsPanel({ onClose }: { onClose: () => void }) {
  const cell: React.CSSProperties = { padding: "5px 10px 5px 0", verticalAlign:"top" };
  return (
    <div onClick={onClose} style={{ position:"absolute", inset:0, zIndex:35, background:"rgba(4,6,10,0.45)" }}>
      <div onClick={(e)=>e.stopPropagation()} style={{
        position:"absolute", left:"50%", top:"50%", transform:"translate(-50%,-50%)",
        background:"rgba(12,15,22,0.97)", border:"1px solid rgba(255,255,255,0.14)", borderRadius:10,
        padding:20, minWidth:400, boxShadow:"0 12px 40px rgba(0,0,0,0.5)",
      }}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <span style={{fontSize:14,fontWeight:600,color:"#dbe2ee"}}>⚙ Настройки — Хоткеи</span>
          <button onClick={onClose} style={{fontSize:14,color:"#9aa3b2",background:"none",border:"none",cursor:"pointer"}}>✕</button>
        </div>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <tbody>
            {HOTKEYS.map(([k,d])=>(
              <tr key={k} style={{borderBottom:"1px solid rgba(255,255,255,0.07)"}}>
                <td style={{...cell,color:"#ffd23f",fontFamily:"monospace",whiteSpace:"nowrap",minWidth:200}}>{k}</td>
                <td style={{...cell,color:"#cdd3df"}}>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{marginTop:12,fontSize:10,color:"#6c7686"}}>Хоткеи будут редактируемыми в будущих версиях.</div>
      </div>
    </div>
  );
}

// Сигнатура СТРУКТУРЫ графа: набор продюсеров + эффектов (без параметров/source).
// Меняется только при добавлении/удалении нод -> граф пересобирается, а правки крутилок и
// перевязка проводов внутри графа НЕ дёргают пересборку (нет мельтешения).
function structSig(config: LayeredConfig): string {
  const prod = config.layers.filter((l) => isPointProducer(l.kind)).map((l) => `${l.id}:${l.kind}`).join(",");
  const fx = config.effects.map((e) => e.id).join(",");
  const ops = (config.opNodes ?? []).map((o) => o.id).join(","); // C-Math: add/remove Math -> пересборка
  // T0c: shader-слои (инстансы) теперь = ноды графа -> add/remove дёргает пересборку.
  const sfx = config.layers.filter((l) => LAYER_DEFS[l.kind]?.domain === "shader").map((l) => l.id).join(",");
  // T0e: РЁБРА в сигнатуре — любая правка проводов (в т.ч. undo/redo) пересобирает граф от дока
  // (двусторонняя синхронизация). Позиции НЕ в сигнатуре (драг не дёргает пересборку).
  const edges = (config.graph?.edges ?? []).map(edgeKey).sort().join(";");
  // T3 Composite: появление/исчезновение ноды Композит зависит от any3D (глубина-облако ИЛИ 3D-слой) —
  // в сигнатуре, иначе тоггл глубины не пересоберёт граф и нода не появится/не исчезнет.
  const any3D = config.depthEnabled || config.layers.some((l) => l.enabled && LAYER_DEFS[l.kind]?.group === "3D");
  return `${prod}|${fx}|${ops}|${sfx}|${edges}|${any3D}`;
}

export function GraphView({
  config, onSelectLayer, onSelectEffect, onSetEnabled, onAddEffect, onAddLayer, onRemoveEffect,
  onSetLayerEnabled, onRemoveLayer,
  onAddOpNode, onSetOpNodeParams, onRemoveOpNode, onDuplicateNodes,
  onAddEdge, onRemoveEdge, onSetNodePos, onSetComposite, onUndo, onRedo, onClose,
  handsRef, motionRef, facesRef, peopleRef, audioRef, producers, depth, mapNodes,
}: {
  config: LayeredConfig;
  onSelectLayer: (layerId: string) => void;
  onSelectEffect: (effectId: string) => void;
  onSetEnabled: (effectId: string, enabled: boolean) => void;
  onAddEffect: (kind: ModifierKind) => void;
  onAddLayer: (kind: LayerKind) => void;
  onRemoveEffect: (effectId: string) => void;
  onSetLayerEnabled: (layerId: string, enabled: boolean) => void;
  onRemoveLayer: (layerId: string) => void;
  onAddOpNode: (kind: OpKind) => void;                                    // T1: палитра -> новая оп-нода вида kind
  onSetOpNodeParams: (opId: string, p: OpParams) => void;                 // T1: крутилки оп-ноды
  onRemoveOpNode: (opId: string) => void;
  onDuplicateNodes: (effectIds: string[], opIds: string[]) => void; // T0b: copy/paste/duplicate
  // T0e: рёбра авторитетны — единственный канал записи топологии из графа.
  onAddEdge: (from: { node: string; out: string }, to: { node: string; in: string }) => void;
  onRemoveEdge: (key: string) => void;
  onSetNodePos: (entityId: string, pos: { x: number; y: number }) => void;
  onSetComposite: (p: { compositeOrder?: CompositeOrder; compositeBlend?: CompositeBlend }) => void; // T3 Composite
  onUndo: () => void;  // T0b: undo (Ctrl+Z)
  onRedo: () => void;  // T0b: redo (Ctrl+Y / Ctrl+Shift+Z)
  onClose: () => void;
  handsRef: React.MutableRefObject<HandResult>;
  motionRef: React.MutableRefObject<VisionResult>;
  facesRef: React.MutableRefObject<FaceResult>;
  peopleRef: React.MutableRefObject<PeopleFrame | null>;
  audioRef?: { current: AudioBands | null };  // аудио-сигналы (T-Beauty)
  producers?: ResolvedProducer[];             // T-Debug: резолвнутые продюсеры точек (id+kind+params)
  depth?: DepthApi;                           // T-Debug: Map2D-вход для scatter/sample-статистики
  mapNodes?: ResolvedMapNode[];               // Phase B: резолвнутые Map2D-ноды (для ЧБ-превью)
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState(false);
  const [palettePos, setPalettePos] = useState<{x:number;y:number}|null>(null); // экранная позиция курсора при открытии
  const [settings, setSettings] = useState(false);
  // T0d: transient pos + area ref для позиционирования новых нод у курсора
  const pendingPosRef = useRef<{x:number;y:number}|null>(null);
  const seenConfigIdsRef = useRef<Set<string>>(new Set());
  const areaRef = useRef<unknown>(null);
  const cursorPosRef = useRef<{x:number;y:number}>({x:0,y:0}); // screen coords (window-absolute)
  const screenToGraph = (sx:number, sy:number) => {
    const el = ref.current; if (!el) return {x:0,y:0};
    const r = el.getBoundingClientRect();
    const t = (areaRef.current as {area?:{transform?:{k:number;x:number;y:number}}})?.area?.transform ?? {k:1,x:0,y:0};
    return { x:(sx-r.left-t.x)/t.k, y:(sy-r.top-t.y)/t.k };
  };
  // Живые драйверы для CHOP-вьюера нод-сигналов. Рефы стабильны -> один замкнутый геттер читает
  // актуальные значения каждый кадр (computeDrivers — тот же Reduce, что в ModifierOverlay).
  const getDriversRef = useRef<() => DriverValues>(() => computeDrivers({}));
  const audioRefForGraph = audioRef; // stable ref captured by value each render
  getDriversRef.current = () => computeDrivers({
    hands: handsRef.current, motion: motionRef.current,
    faces: facesRef.current, people: peopleRef.current,
    audio: audioRefForGraph?.current ?? undefined,
  });
  // T-Debug: статистика точек/атрибутов на PointSet-нодах. Считаем ВСЕ продюсеры ОДИН раз за тик
  // (throttle ~150мс, чтобы не гонять scatter/sort каждый кадр) в общий кеш; PointMeters читает кеш по
  // id (как SignalMeters читает getDrivers). Тот же DataBus, что у ModifierOverlay (рефы+depth+producers).
  const producersRef = useRef<ResolvedProducer[] | undefined>(producers);
  producersRef.current = producers;
  const depthRef = useRef<DepthApi | undefined>(depth);
  depthRef.current = depth;
  const configRef = useRef(config); // T1-3: opNodes для компиляции field-входов в statsRef-тике
  configRef.current = config;
  const statsRef = useRef<Map<string, PointStats>>(new Map());
  const getStatsRef = useRef<(id: string) => PointStats | null>(() => null);
  getStatsRef.current = (id) => statsRef.current.get(id) ?? null;
  // Phase B: ЧБ-превью карт — резолв mapForRef в кеш на том же throttle-тике; MapPreview читает по id.
  const mapNodesRef = useRef<ResolvedMapNode[] | undefined>(mapNodes);
  mapNodesRef.current = mapNodes;
  const mapPreviewRef = useRef<Map<string, MapPreviewData>>(new Map());
  const getMapPreviewRef = useRef<(id: string) => MapPreviewData>(() => null);
  getMapPreviewRef.current = (id) => mapPreviewRef.current.get(id) ?? null;
  useEffect(() => {
    let raf = 0, last = -1e9;
    const tick = (t: number) => {
      if (t - last > 150) {
        last = t;
        const prods = producersRef.current ?? [];
        const needDepth = prods.some((p) => p.kind === "scatter" || p.kind === "sample");
        const dApi = depthRef.current;
        const sources: PointResultRefs = {
          motion: motionRef.current, hands: handsRef.current,
          faces: facesRef.current, people: peopleRef.current,
          depth: needDepth ? (dApi?.smoothedRef.current ?? dApi?.latestRef.current ?? null) : null,
          producers: prods,
        };
        // T1-3: компилируем field-входы конвертеров (сигнал/selection; скаляр | FieldFn) — спредшит
        // PointMeters показывает РЕАЛЬНЫЕ per-element значения. data-driven по fieldInputs.
        const drv = getDriversRef.current();
        const lff: NonNullable<PointResultRefs["layerFieldFns"]> = {};
        for (const p of prods) {
          for (const fi of LAYER_DEFS[p.kind]?.fieldInputs ?? []) {
            const sig = p.params[fi.param];
            if (!sig || sig === "none") continue;
            const cf = compileFieldFn(sig as string, drv, configRef.current.opNodes);
            (lff[p.id] ??= {})[fi.param] = cf.perElement ? cf.fn! : cf.value;
          }
        }
        sources.layerFieldFns = lff;
        // B-раунд-2: Map2D-источники Scatter → кадры-карты (PointMeters считает РЕАЛЬНЫЕ точки по карте).
        sources.layerMaps = resolveProducerMaps(prods, { depth: sources.depth, mapNodes: mapNodesRef.current, time: t / 1000 });
        const m = statsRef.current;
        const alive = new Set<string>();
        const SAMPLE_CAP = 12; // T-Debug(c): сколько строк точек кешировать на спредшит
        const f2 = (v: number) => (Math.round(v * 100) / 100).toString();
        for (const p of prods) {
          alive.add(p.id);
          const f = fieldForLayerId(p.id, sources);
          if (!f) { m.set(p.id, { count: 0, groups: 0, attrs: [], sample: [] }); continue; }
          let count = 0; const attrSet = new Set<string>(); const sample: SamplePt[] = [];
          for (const g of f.groups) {
            count += g.points.length;
            if (g.values) attrSet.add("pscale");
            for (const a of g.attrs ?? []) attrSet.add(a.name);
            for (let i = 0; i < g.points.length && sample.length < SAMPLE_CAP; i++) {
              const pt = g.points[i]; const a: Record<string, string> = {};
              for (const at of g.attrs ?? []) {
                const c = at.comps ?? 1; const b = i * c;
                a[at.name] = c === 3 ? `${f2(at.data[b])},${f2(at.data[b + 1])},${f2(at.data[b + 2])}` : f2(at.data[i]);
              }
              if (g.values && !("pscale" in a)) a.pscale = f2(g.values[i] ?? 0);
              sample.push({ x: pt.x, y: pt.y, a });
            }
          }
          m.set(p.id, { count, groups: f.groups.length, attrs: [...attrSet], sample });
        }
        for (const id of [...m.keys()]) if (!alive.has(id)) m.delete(id); // свип осиротевших

        // Phase B: ЧБ-превью Map2D-нод — резолв цепочки в кадр, downsample PREVIEW×PREVIEW (серый RGBA).
        const mNodes = mapNodesRef.current ?? [];
        const depthFrame = dApi?.smoothedRef.current ?? dApi?.latestRef.current ?? null;
        const mp = mapPreviewRef.current;
        const mAlive = new Set<string>();
        for (const mn of mNodes) {
          mAlive.add(mn.id);
          const frame = mapForRef(mn.id, { depth: depthFrame, mapNodes: mNodes, time: t / 1000 });
          if (!frame) { mp.set(mn.id, null); continue; }
          const rgba = new Uint8ClampedArray(PREVIEW * PREVIEW * 4);
          for (let y = 0; y < PREVIEW; y++) {
            const sy = Math.min(frame.height - 1, ((y * frame.height / PREVIEW) | 0));
            for (let x = 0; x < PREVIEW; x++) {
              const sx = Math.min(frame.width - 1, ((x * frame.width / PREVIEW) | 0));
              const v = frame.data[sy * frame.width + sx];
              const o = (y * PREVIEW + x) * 4;
              rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
            }
          }
          mp.set(mn.id, { rgba });
        }
        for (const id of [...mp.keys()]) if (!mAlive.has(id)) mp.delete(id);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const selRef = useRef(onSelectLayer);
  selRef.current = onSelectLayer;
  const selFxRef = useRef(onSelectEffect);
  selFxRef.current = onSelectEffect;
  const enRef = useRef(onSetEnabled);
  enRef.current = onSetEnabled;
  const rmRef = useRef(onRemoveEffect);
  rmRef.current = onRemoveEffect;
  const setLayerEnRef = useRef(onSetLayerEnabled);
  setLayerEnRef.current = onSetLayerEnabled;
  const rmLayerRef = useRef(onRemoveLayer);
  rmLayerRef.current = onRemoveLayer;
  const opParamsRef = useRef(onSetOpNodeParams);
  opParamsRef.current = onSetOpNodeParams;
  const rmOpRef = useRef(onRemoveOpNode);
  rmOpRef.current = onRemoveOpNode;
  const dupRef = useRef(onDuplicateNodes);
  dupRef.current = onDuplicateNodes;
  // T0e: правка рёбер/позиций
  const addEdgeRef = useRef(onAddEdge);
  addEdgeRef.current = onAddEdge;
  const removeEdgeRef = useRef(onRemoveEdge);
  removeEdgeRef.current = onRemoveEdge;
  const setPosRef = useRef(onSetNodePos);
  setPosRef.current = onSetNodePos;
  const setCompositeRef = useRef(onSetComposite);
  setCompositeRef.current = onSetComposite;
  // зум/пан переживает пересборку (рёбра в structSig -> каждый провод пересобирает граф)
  const savedTransformRef = useRef<{ k: number; x: number; y: number } | null>(null);
  const cfgRef = useRef(config);
  cfgRef.current = config;
  // пересобираем граф только при изменении СТРУКТУРЫ (добавили/убрали ноду), не на каждый рендер.
  const sig = useMemo(() => structSig(config), [config]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let destroy = () => {};
    let cancelled = false;
    buildEditor(
      el, cfgRef.current,
      (id) => selRef.current(id),
      (id) => selFxRef.current(id),
      (effectId) => rmRef.current(effectId),
      (effectId, enabled) => enRef.current(effectId, enabled),
      () => getDriversRef.current(),
      (id) => getStatsRef.current(id),
      (id) => getMapPreviewRef.current(id),
      (layerId, enabled) => setLayerEnRef.current(layerId, enabled),
      (layerId) => rmLayerRef.current(layerId),
      (opId, p) => opParamsRef.current(opId, p),
      (opId) => rmOpRef.current(opId),
      (effectIds, opIds) => dupRef.current(effectIds, opIds),
      (from, to) => addEdgeRef.current(from, to),
      (key) => removeEdgeRef.current(key),
      (entityId, pos) => setPosRef.current(entityId, pos),
      (p) => setCompositeRef.current(p),
      pendingPosRef, seenConfigIdsRef, areaRef, savedTransformRef,
    ).then((d) => { if (cancelled) d(); else destroy = d; });
    return () => { cancelled = true; destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // onPick: запомнить pendingPos (нода появится у курсора), затем добавить в конфиг
  const handlePick = (it: PaletteItem) => {
    pendingPosRef.current = screenToGraph(cursorPosRef.current.x, cursorPosRef.current.y);
    if (it.add === "opnode") onAddOpNode(it.kind as OpKind);
    else if (it.add === "effect") onAddEffect(it.kind as ModifierKind);
    else onAddLayer(it.kind as LayerKind);
  };

  // Полупрозрачный скрим: ноды читаемы, но живое видео с эффектами видно на фоне (как в TD).
  return (
    <div
      style={{ position: "absolute", inset: 0, zIndex: 20, background: "rgba(8,10,16,0.45)" }}
      onMouseMove={(e) => { cursorPosRef.current = {x:e.clientX,y:e.clientY}; }}
      onContextMenu={(e) => {
        // ПКМ по ФОНУ (не по ноде) → палитра у курсора (T0d §3.6.9)
        if ((e.target as HTMLElement).closest?.('[data-testid="node"]')) return;
        e.preventDefault();
        setPalettePos({x:e.clientX,y:e.clientY});
        cursorPosRef.current = {x:e.clientX,y:e.clientY};
        setPalette(true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Tab") { e.preventDefault(); setPalettePos(null); setPalette((p) => !p); }
        else if (e.key === "Escape") { e.preventDefault(); if (palette) { setPalette(false); setPalettePos(null); } else if (settings) setSettings(false); }
      }}
    >
      <div style={{ position: "absolute", top: 10, right: 12, zIndex: 21, display: "flex", gap: 8 }}>
        <button onClick={onUndo} className="mode" title="отменить (Ctrl+Z)">↶</button>
        <button onClick={onRedo} className="mode" title="повторить (Ctrl+Y / Ctrl+Shift+Z)">↷</button>
        <button onClick={() => { setPalettePos(null); setPalette(true); }} className="mode" title="добавить ноду (Tab / ПКМ)">＋ нода ⎀</button>
        <button onClick={() => setSettings(true)} className="mode" title="настройки и хоткеи">⚙</button>
        <button onClick={onClose} className="mode">✕ закрыть граф</button>
      </div>
      <GraphLegend />
      <div ref={ref} style={{ position: "absolute", inset: 0 }} tabIndex={0} />
      {palette && (
        <NodePalette
          existing={new Set(config.layers.map((l) => l.kind))}
          onPick={handlePick}
          onClose={() => { setPalette(false); setPalettePos(null); }}
          pos={palettePos ?? undefined}
        />
      )}
      {settings && <SettingsPanel onClose={() => setSettings(false)} />}
    </div>
  );
}
