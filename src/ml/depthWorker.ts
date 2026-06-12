/// <reference lib="webworker" />
// Воркер инференса глубины. Живёт в отдельном потоке, чтобы тяжёлая сеть
// не роняла FPS рендера. Получает ImageBitmap, отдаёт grayscale depth map.
//
// Шлёт статусы наружу, чтобы UI показывал реальное состояние (загрузка/ошибка/девайс),
// а не молчал. WebGPU -> при провале фолбэк на WASM.

import { pipeline, env, RawImage, type DepthEstimationPipeline } from "@huggingface/transformers";

env.allowLocalModels = false;

let estimator: DepthEstimationPipeline | null = null;
let loading: Promise<void> | null = null;

const MODEL = "onnx-community/depth-anything-v2-small";

async function create(device: "webgpu" | "wasm"): Promise<DepthEstimationPipeline> {
  return (await (pipeline as any)("depth-estimation", MODEL, {
    device,
    dtype: "fp16",
    progress_callback: (p: any) => {
      if (p?.status === "progress" && p?.file) {
        postMessage({ type: "status", text: `загрузка ${Math.round(p.progress ?? 0)}%` });
      } else if (p?.status === "ready") {
        postMessage({ type: "status", text: "инициализация…" });
      }
    },
  })) as DepthEstimationPipeline;
}

async function ensureModel(): Promise<void> {
  if (estimator) return;
  if (!loading) {
    loading = (async () => {
      const wantGpu = !!(navigator as any).gpu;
      try {
        postMessage({ type: "status", text: wantGpu ? "запуск webgpu…" : "запуск wasm…" });
        estimator = await create(wantGpu ? "webgpu" : "wasm");
        postMessage({ type: "ready", device: wantGpu ? "webgpu" : "wasm" });
      } catch (e1) {
        if (wantGpu) {
          // WebGPU не завёлся — пробуем WASM, чтобы хоть как-то работало.
          postMessage({ type: "status", text: "webgpu не завёлся, пробую wasm…" });
          try {
            estimator = await create("wasm");
            postMessage({ type: "ready", device: "wasm" });
          } catch (e2) {
            postMessage({ type: "error", message: "load wasm: " + String(e2) });
            loading = null;
            throw e2;
          }
        } else {
          postMessage({ type: "error", message: "load wasm: " + String(e1) });
          loading = null;
          throw e1;
        }
      }
    })();
  }
  await loading;
}

self.onmessage = async (e: MessageEvent) => {
  const { type } = e.data;

  if (type === "init") {
    try {
      await ensureModel();
    } catch {
      /* ошибка уже отправлена статусом */
    }
    return;
  }

  if (type === "frame") {
    try {
      await ensureModel();
      // transformers.js не принимает ImageBitmap напрямую -> собираем RawImage из RGBA-пикселей.
      const { data, width, height } = e.data as {
        data: Uint8ClampedArray; width: number; height: number;
      };
      const img = new RawImage(new Uint8ClampedArray(data), width, height, 4).rgb();
      const t0 = performance.now();
      const out: any = await estimator!(img);
      const infMs = performance.now() - t0; // время инференса (включая GPU-ожидание)
      const depth = out.depth; // RawImage: { data: Uint8, width, height }
      const d = new Uint8Array(depth.data);
      postMessage(
        { type: "depth", data: d, width: depth.width, height: depth.height, infMs },
        [d.buffer]
      );
    } catch (err) {
      postMessage({ type: "error", message: String(err) });
    }
  }
};

// Любая необработанная ошибка в воркере -> наружу, чтобы не молчало.
self.addEventListener("error", (ev) => {
  postMessage({ type: "error", message: "worker: " + ev.message });
});
self.addEventListener("unhandledrejection", (ev: any) => {
  postMessage({ type: "error", message: "reject: " + String(ev?.reason) });
});
