/// <reference lib="webworker" />
// Воркер instance-сегментации людей (YOLOv8n-seg, onnxruntime-web/WebGPU).
// Получает уже letterbox'нутый квадратный кадр INPUT×INPUT (RGBA) с основного потока,
// гоняет сеть, фильтрует класс person -> NMS -> собирает маски, и отдаёт ОДНУ
// RGBA-текстуру в proto-разрешении (цвет инстанса в RGB, покрытие в alpha).
// Композитинг (заливка/контур + обратный letterbox) делает flatShader. См. CLAUDE-people-masks.md.
//
// Модель грузится локально из public/yolov8n-seg.onnx (экспорт ultralytics).
// ort wasm/jsep лежат в public/ort (same-origin, COEP не мешает).

import * as ort from "onnxruntime-web/webgpu";
// ort wasm/jsep грузим как vite-ассеты (?url) — иначе vite в dev мнёт .mjs через ?import.
import ortWasmUrl from "../ort-assets/ort-wasm-simd-threaded.jsep.wasm?url";
import ortMjsUrl from "../ort-assets/ort-wasm-simd-threaded.jsep.mjs?url";

ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
ort.env.wasm.numThreads = Math.min(4, (navigator as any).hardwareConcurrency || 2);

const NM = 32; // коэффициентов маски (фиксировано для yolov8-seg)
// Модель лежит локально в public. Класс берём 0: для стоковой COCO-модели это person
// (-> маски людей), для одноклассовой модели — её единственный класс. NC выводим из
// формы тензора. Положи COCO-экспорт сюда: public/yolov8n-seg.onnx
//   pip install ultralytics && yolo export model=yolov8n-seg.pt format=onnx
const MODEL_URL = `${self.location.origin}/yolov8n-seg.onnx`;

// палитра по инстансам (циклически)
const PALETTE: [number, number, number][] = [
  [255, 77, 77], [54, 230, 255], [60, 255, 139], [255, 226, 60],
  [192, 107, 255], [255, 138, 60], [60, 160, 255], [255, 90, 200],
];

let session: ort.InferenceSession | null = null;
let loading: Promise<void> | null = null;

async function ensureModel(): Promise<void> {
  if (session) return;
  if (!loading) {
    loading = (async () => {
      const wantGpu = !!(navigator as any).gpu;
      const eps = wantGpu ? ["webgpu", "wasm"] : ["wasm"];
      postMessage({ type: "status", text: wantGpu ? "запуск webgpu…" : "запуск wasm…" });
      try {
        session = await ort.InferenceSession.create(MODEL_URL, {
          executionProviders: eps as any,
          graphOptimizationLevel: "all",
        });
        postMessage({ type: "ready", device: wantGpu ? "webgpu" : "wasm" });
      } catch (e) {
        loading = null;
        postMessage({ type: "error", message: "load: " + String(e) });
        throw e;
      }
    })();
  }
  await loading;
}

interface Det { x1: number; y1: number; x2: number; y2: number; score: number; coeffs: Float32Array; }

function iou(a: Det, b: Det): number {
  const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter + 1e-6);
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "init") {
    try { await ensureModel(); } catch { /* статус уже отправлен */ }
    return;
  }
  if (m.type !== "frame") return;

  try {
    await ensureModel();
    const { data, input, conf, maskThreshold, iouThr } = m as {
      data: Uint8ClampedArray; input: number;
      conf: number; maskThreshold: number; iouThr: number;
    };
    const INPUT = input;
    const HW = INPUT * INPUT;

    // RGBA -> CHW float32 /255
    const chw = new Float32Array(3 * HW);
    for (let i = 0; i < HW; i++) {
      const j = i * 4;
      chw[i] = data[j] / 255;
      chw[HW + i] = data[j + 1] / 255;
      chw[2 * HW + i] = data[j + 2] / 255;
    }
    const tensor = new ort.Tensor("float32", chw, [1, 3, INPUT, INPUT]);
    const feeds: Record<string, ort.Tensor> = { [session!.inputNames[0]]: tensor };
    const tRun = performance.now();
    const out = await session!.run(feeds);
    const runMs = performance.now() - tRun; // инференс сети (вкл. GPU-ожидание)
    const tPost = performance.now(); // далее — CPU-постобработка (argmax/NMS/сборка маски)

    // выходы различаем по форме: 4D -> proto, 3D -> det
    let det: ort.Tensor | null = null, proto: ort.Tensor | null = null;
    for (const name of session!.outputNames) {
      const t = out[name];
      if (t.dims.length === 4) proto = t;
      else if (t.dims.length === 3) det = t;
    }
    if (!det || !proto) throw new Error("неожиданная форма выходов модели");

    const A = det.dims[2];
    const C = det.dims[1]; // 4 + NC + NM
    const NC = C - 4 - NM; // число классов выводим из формы (COCO=80, одноклассовый=1)
    const dd = det.data as Float32Array;
    const protoH = proto.dims[2], protoW = proto.dims[3];
    const pdata = proto.data as Float32Array;
    const maskScale = INPUT / protoW; // proto -> input

    // фильтр по классу 0 + сбор детекций
    const dets: Det[] = [];
    for (let a = 0; a < A; a++) {
      // argmax по NC классам
      let best = 0, bestC = 0;
      for (let c = 0; c < NC; c++) {
        const s = dd[(4 + c) * A + a];
        if (s > best) { best = s; bestC = c; }
      }
      if (bestC !== 0 || best < conf) continue; // только люди
      const cx = dd[a], cy = dd[A + a], w = dd[2 * A + a], h = dd[3 * A + a];
      const coeffs = new Float32Array(NM);
      for (let k = 0; k < NM; k++) coeffs[k] = dd[(4 + NC + k) * A + a];
      dets.push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, score: best, coeffs });
    }

    // NMS
    dets.sort((p, q) => q.score - p.score);
    const keep: Det[] = [];
    for (const d of dets) {
      let ok = true;
      for (const k of keep) if (iou(d, k) > iouThr) { ok = false; break; }
      if (ok) keep.push(d);
      if (keep.length >= 24) break;
    }

    // сборка масок -> единый RGBA-буфер proto-разрешения
    const mask = new Uint8Array(protoW * protoH * 4);
    for (let idx = 0; idx < keep.length; idx++) {
      const d = keep[idx];
      const [cr, cg, cb] = PALETTE[idx % PALETTE.length];
      // бокс в proto-координатах, клампим
      const bx1 = Math.max(0, Math.floor(d.x1 / maskScale));
      const by1 = Math.max(0, Math.floor(d.y1 / maskScale));
      const bx2 = Math.min(protoW, Math.ceil(d.x2 / maskScale));
      const by2 = Math.min(protoH, Math.ceil(d.y2 / maskScale));
      const co = d.coeffs;
      for (let py = by1; py < by2; py++) {
        const row = py * protoW;
        for (let px = bx1; px < bx2; px++) {
          let s = 0;
          const base = row + px;
          for (let k = 0; k < NM; k++) s += co[k] * pdata[k * protoH * protoW + base];
          const v = 1 / (1 + Math.exp(-s)); // sigmoid
          if (v > maskThreshold) {
            const o = base * 4;
            mask[o] = cr; mask[o + 1] = cg; mask[o + 2] = cb; mask[o + 3] = 255;
          }
        }
      }
    }

    // боксы людей (в координатах INPUT-квадрата) — хук переведёт в нормированные видео-координаты
    const boxes = keep.map((d) => ({ x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, score: d.score }));

    postMessage(
      {
        type: "people", data: mask, width: protoW, height: protoH, count: keep.length,
        boxes, runMs, postMs: performance.now() - tPost,
      },
      [mask.buffer]
    );
  } catch (err) {
    const msg = String(err);
    // самолечение: модель ждёт фиксированный вход — вытащим его из ошибки и подскажем хуку
    const mm = msg.match(/Expected:\s*(\d+)/);
    if (mm) postMessage({ type: "inputHint", input: parseInt(mm[1], 10) });
    postMessage({ type: "error", message: msg });
  }
};

self.addEventListener("error", (ev) => {
  postMessage({ type: "error", message: "worker: " + ev.message });
});
self.addEventListener("unhandledrejection", (ev: any) => {
  postMessage({ type: "error", message: "reject: " + String(ev?.reason) });
});
