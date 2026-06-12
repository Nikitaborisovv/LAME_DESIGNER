// Левая панель: всё «общее» — источник (файл/стрим), глобальные настройки сцены,
// depth-ресурс, кеш глубины, пресеты. Правая панель (Controls) — только слои + инспектор.

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { LayeredConfig } from "../core/types";
import type { StreamStatus } from "../net/useCameraStream";
import type { KinectDepthOpts } from "../net/useKinect";
import { Field, R, C, SEL } from "./controlField";

interface PresetsApi {
  names: string[];
  save: (name: string) => void;
  load: (name: string) => void;
  del: (name: string) => void;
  export: () => void;
  import: (file: File) => void;
  reset: () => void;
}

interface CacheApi {
  names: string[];
  bake: () => void;
  save: (name: string) => void;
  load: (name: string) => void;
  del: (name: string) => void;
}

interface StreamApi {
  mode: "file" | "stream" | "kinect";
  status: StreamStatus;
  phoneUrl: string | null;
  error: string | null;
  start: () => void;
  stop: () => void;
}

interface KinectApi {
  status: string;
  error: string | null;
  mock: boolean;
  setMock: (v: boolean) => void;
  host: string;
  setHost: (v: string) => void;
  port: number;
  setPort: (v: number) => void;
  start: () => void;
  depth: KinectDepthOpts;
  setDepth: (p: Partial<KinectDepthOpts>) => void;
  neuralDepth: boolean;
  setNeuralDepth: (v: boolean) => void;
}

interface Props {
  config: LayeredConfig;
  onChange: (patch: Partial<LayeredConfig>) => void;
  onLoadFile: (file: File) => void;
  device: string;
  presets: PresetsApi;
  cache: CacheApi;
  particleBackend: "webgpu" | "webgl2" | null; // T5-спайк: активный бэкенд частиц (диагностика)
  stream: StreamApi;
  kinect: KinectApi;
  onCollapse: () => void;
}

const STREAM_STATUS_TEXT: Record<StreamStatus, string> = {
  idle: "не активно",
  connecting: "подключаем сигналинг…",
  waiting: "ждём телефон…",
  connected: "поток идёт ✓",
  error: "ошибка",
};

function PhoneLink({ url }: { url: string }) {
  const [qr, setQr] = useState<string>("");
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, { margin: 1, width: 220 })
      .then((d) => { if (alive) setQr(d); })
      .catch(() => { if (alive) setQr(""); });
    return () => { alive = false; };
  }, [url]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
      {qr && <img src={qr} alt="QR" style={{ width: 160, height: 160, borderRadius: 6, background: "#fff" }} />}
      <a href={url} style={{ fontSize: 11, color: "var(--muted)", wordBreak: "break-all", textAlign: "center" }}>{url}</a>
    </div>
  );
}

export function ScenePanel({ config: c, onChange, onLoadFile, device, presets, cache, particleBackend, stream, kinect, onCollapse }: Props) {
  const [presetName, setPresetName] = useState("");
  const [cacheName, setCacheName] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  // глобальная крутилка (поле SceneConfig из набора глобальных) -> пишет в LayeredConfig
  const G = (spec: ReturnType<typeof R>) => (
    <Field
      key={spec.field as string}
      spec={spec}
      value={(c as Record<string, unknown>)[spec.field as string]}
      onChange={(v) => onChange({ [spec.field]: v } as Partial<LayeredConfig>)}
    />
  );

  return (
    <aside className="panel left">
      <div className="panel-head">
        <h1>СЦЕНА</h1>
        <span className="device">gpu: {device}</span>
        <button className="panel-collapse" title="свернуть" onClick={onCollapse}>«</button>
      </div>

      {/* ---- источник ---- */}
      <section>
        <span className="legend">источник</span>
        <div className="modes">
          <button className={stream.mode === "file" ? "mode on" : "mode"} onClick={stream.stop}>📁 файл</button>
          <button className={stream.mode === "stream" ? "mode on" : "mode"} onClick={stream.start}>📱 телефон</button>
          <button className={stream.mode === "kinect" ? "mode on" : "mode"} onClick={kinect.start}>🎮 Kinect</button>
        </div>
        {stream.mode === "file" && (
          <input type="file" accept="video/*" onChange={(e) => e.target.files?.[0] && onLoadFile(e.target.files[0])} />
        )}
        {stream.mode === "kinect" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
              <input type="checkbox" checked={kinect.mock} onChange={(e) => kinect.setMock(e.target.checked)} />
              мок (синтетика без железа)
            </label>
            {!kinect.mock && (
              <div className="modes">
                <input type="text" value={kinect.host} placeholder="host моста" style={{ flex: 2 }}
                  onChange={(e) => kinect.setHost(e.target.value)} />
                <input type="number" value={kinect.port} placeholder="порт" style={{ flex: 1, minWidth: 0 }}
                  onChange={(e) => kinect.setPort(Number(e.target.value) || 0)} />
              </div>
            )}
            <small style={{ fontSize: 11, color: kinect.status === "connected" || kinect.status === "mock" ? "var(--accent)" : "var(--muted)" }}>
              статус: {kinect.status}{kinect.error ? ` · ${kinect.error}` : ""}
            </small>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
              <input type="checkbox" checked={kinect.neuralDepth} onChange={(e) => kinect.setNeuralDepth(e.target.checked)} />
              только видео (глубину считать нейросетью)
            </label>
            {!kinect.neuralDepth && (
            <div style={{ borderTop: "1px solid var(--line, #ffffff14)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="legend" style={{ fontSize: 10 }}>обработка глубины</span>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                <input type="checkbox" checked={kinect.depth.auto} onChange={(e) => kinect.setDepth({ auto: e.target.checked })} />
                авто-нормализация (растягивать объём)
              </label>
              {!kinect.depth.auto && <>
                <label style={{ fontSize: 11, color: "var(--muted)" }}>
                  ближе, мм · {kinect.depth.nearMm}
                  <input type="range" min={300} max={3000} step={50} value={kinect.depth.nearMm}
                    onChange={(e) => kinect.setDepth({ nearMm: Number(e.target.value) })} style={{ width: "100%" }} />
                </label>
                <label style={{ fontSize: 11, color: "var(--muted)" }}>
                  дальше, мм · {kinect.depth.farMm}
                  <input type="range" min={800} max={6000} step={50} value={kinect.depth.farMm}
                    onChange={(e) => kinect.setDepth({ farMm: Number(e.target.value) })} style={{ width: "100%" }} />
                </label>
              </>}
              <label style={{ fontSize: 11, color: "var(--muted)" }}>
                сглаживание · {kinect.depth.smooth.toFixed(2)}
                <input type="range" min={0} max={0.95} step={0.05} value={kinect.depth.smooth}
                  onChange={(e) => kinect.setDepth({ smooth: Number(e.target.value) })} style={{ width: "100%" }} />
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                <input type="checkbox" checked={kinect.depth.holeFill} onChange={(e) => kinect.setDepth({ holeFill: e.target.checked })} />
                заполнять дыры (темпорально)
              </label>
            </div>
            )}
            <small style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.4 }}>
              Kinect — третий вход: RGB + аппаратная глубина с моста (C#/.NET, Kinect SDK 1.8).
              Без железа держи «мок». Глубина следует за входом (Kinect → железо).
            </small>
          </div>
        )}
        {stream.mode === "stream" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
            <small style={{ fontSize: 11, color: stream.status === "connected" ? "var(--accent)" : "var(--muted)" }}>
              статус: {STREAM_STATUS_TEXT[stream.status]}{stream.error ? ` · ${stream.error}` : ""}
            </small>
            {stream.phoneUrl
              ? <PhoneLink url={stream.phoneUrl} />
              : <small style={{ fontSize: 11, color: "var(--muted)" }}>получаем LAN-адрес десктопа…</small>}
            <small style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.4 }}>
              айфон и десктоп в одной WiFi. На айфоне открой ссылку/QR, доверься сертификату
              (один раз поставь certs/rootCA.pem) и разреши камеру.
            </small>
          </div>
        )}
        {G(C("hideVideo", "скрыть видео (фон → чёрный)"))}
      </section>

      {/* ---- рендер / сцена ---- */}
      <section>
        <span className="legend">сцена</span>
        {G(R("fpsCap", "потолок FPS", 10, 60, 1))}
        {G(C("frontLock", "фронтальный вид (3D)"))}
      </section>

      {/* ---- глубина (ресурс) ---- */}
      <section>
        <span className="legend">глубина (ресурс)</span>
        {G(R("depthScale", "масштаб Z", 0.2, 3, 0.05))}
        {G(R("depthResolution", "разрешение (скорость)", 128, 512, 32))}
        {G(R("depthEveryNthFrame", "каждый N-й кадр", 1, 6, 1))}
        {G(SEL("depthSmoothMode", "сглаживание", [["off", "выкл"], ["ema", "EMA (адаптивн.)"], ["median", "медиана ×3"]]))}
        {c.depthSmoothMode === "ema" && G(R("depthSmoothAlpha", "α (инертность)", 0.05, 0.6, 0.01))}
        {c.depthSmoothMode === "ema" && G(R("depthMotionBoost", "анти-гост", 0, 4, 0.1))}
        {c.depthSmoothMode === "ema" && G(R("depthDeadband", "мёртвая зона", 0, 0.1, 0.005))}
      </section>

      {/* ---- 3D · облако точек (всегда доступно, можно отключить) ---- */}
      <section>
        <span className="legend">3D · облако точек</span>
        {G(C("depthEnabled", "показывать облако (3D)"))}
        {G(R("pointSize", "размер точки", 0.5, 30, 0.5))}
        {G(C("pointSquare", "квадратные точки"))}
        <small style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.4 }}>
          включает 3D-сцену из глубины. Сканер/ASCII/Constellation 3D — добавляются слоями справа.
        </small>
        {/* T3 Composite: порядок и режим смешивания 2D↔3D (когда активны ОБА — облако + 2D-слои).
            Дублируется нодой Композит в графе. Закрывает «облако всегда сверху». */}
        {G(SEL("compositeOrder", "композит: порядок", [["cloudOver", "облако над 2D"], ["flatOver", "2D над облаком"]]))}
        {G(SEL("compositeBlend", "композит: смешивание", [["normal", "обычное"], ["screen", "экран (add)"], ["multiply", "умножение"], ["lighten", "осветление"], ["difference", "разница"], ["overlay", "перекрытие"]]))}
        {c.compositeOrder === "flatOver" && c.compositeBlend === "normal" && (
          <small style={{ fontSize: 10, color: "#e0a85a", lineHeight: 1.4 }}>
            ⚠ «2D над облаком» + «обычное» — непрозрачное видео скроет облако. Выбери режим смешивания
            (экран/разница…), чтобы облако просвечивало.
          </small>
        )}
      </section>

      {/* ---- ⚛ частицы (T5-спайк) ---- */}
      <section>
        <span className="legend">⚛ частицы (спайк)</span>
        {G(C("particlesEnabled", "GPU-частицы (three/webgpu + TSL)"))}
        {c.particlesEnabled && (
          <small style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.4 }}>
            бэкенд: <b style={{ color: particleBackend === "webgpu" ? "#5fd3a8" : "#e0a85a" }}>
              {particleBackend ?? "инициализация…"}
            </b>{particleBackend === "webgl2" ? " (фолбэк)" : ""}
            <br />
            изолированный прототип: curl-noise + age-recycle, отдельный канвас поверх flat.
          </small>
        )}
      </section>

      {/* ---- кеш глубины ---- */}
      <section>
        <span className="legend">кеш глубины</span>
        <button className="mode" style={{ width: "100%" }} onClick={cache.bake}>⚙ запечь глубину видео</button>
        {G(C("cacheEnabled", "брать из кеша"))}
        {G(R("cacheResolution", "разрешение кеша", 256, 1024, 64))}
        {G(R("cacheFps", "кадров/сек кеша", 4, 30, 1))}
        <div className="modes">
          <input type="text" value={cacheName} placeholder="имя кеша" style={{ flex: 1 }}
            onChange={(e) => setCacheName(e.target.value)} />
          <button className="mode" disabled={!cacheName}
            onClick={() => { cache.save(cacheName); setCacheName(""); }}>💾</button>
        </div>
        {cache.names.length > 0 && (
          <div className="presets-list">
            {cache.names.map((n) => (
              <div key={n} className="preset-row">
                <button className="preset-load" onClick={() => cache.load(n)}>{n}</button>
                <button className="preset-del" title="удалить" onClick={() => cache.del(n)}>✕</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---- пресеты ---- */}
      <section>
        <span className="legend">пресеты</span>
        <div className="modes">
          <input type="text" value={presetName} placeholder="имя пресета" style={{ flex: 1 }}
            onChange={(e) => setPresetName(e.target.value)} />
          <button className="mode" disabled={!presetName}
            onClick={() => { presets.save(presetName); setPresetName(""); }}>💾</button>
        </div>
        {presets.names.length > 0 && (
          <div className="presets-list">
            {presets.names.map((n) => (
              <div key={n} className="preset-row">
                <button className="preset-load" onClick={() => presets.load(n)}>{n}</button>
                <button className="preset-del" title="удалить" onClick={() => presets.del(n)}>✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="modes">
          <button className="mode" onClick={presets.export}>⬇ экспорт</button>
          <button className="mode" onClick={() => importRef.current?.click()}>⬆ импорт</button>
          <button className="mode" onClick={presets.reset}>сброс</button>
        </div>
        <input ref={importRef} type="file" accept="application/json" style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && presets.import(e.target.files[0])} />
      </section>
    </aside>
  );
}
