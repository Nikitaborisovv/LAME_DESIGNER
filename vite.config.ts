import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signalingPlugin } from "./signaling";

// HTTPS включаем ТОЛЬКО в режиме телефона (`vite --mode phone`, скрипт npm run dev:phone)
// и только если есть mkcert-сертификаты в certs/. Обычный `npm run dev` идёт по HTTP —
// так не ломается preview/повседневная работа на localhost. HTTPS нужен лишь чтобы iOS
// разрешил getUserMedia (камеру) по LAN-IP: secure context обязателен везде, кроме localhost.
// Выпуск: tools/mkcert.exe -cert-file certs/dev-cert.pem -key-file certs/dev-key.pem localhost 127.0.0.1 <LAN-IP>
const certDir = fileURLToPath(new URL("./certs", import.meta.url));
const keyPath = `${certDir}/dev-key.pem`;
const certPath = `${certDir}/dev-cert.pem`;
function httpsFor(mode: string) {
  if (mode !== "phone") return undefined;
  if (!existsSync(keyPath) || !existsSync(certPath)) return undefined;
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

// COOP/COEP включают cross-origin isolation -> SharedArrayBuffer и многопоточный
// onnxruntime-web. COEP=credentialless (а не require-corp): так же даёт SAB, но НЕ
// требует CORP-заголовка на кросс-доменных ресурсах -> не блокирует загрузку модели
// глубины с HF hub. Локальные ассеты (MediaPipe в /public) работают в любом случае.
const coiHeaders = (_req: any, res: any, next: any) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  next();
};
const crossOriginIsolation = {
  name: "cross-origin-isolation",
  // dev и preview: без этих заголовков нет SharedArrayBuffer / многопоточного onnxruntime.
  configureServer(server: any) { server.middlewares.use(coiHeaders); },
  configurePreviewServer(server: any) { server.middlewares.use(coiHeaders); },
};

export default defineConfig(({ mode }) => ({
  plugins: [react(), crossOriginIsolation, signalingPlugin()],
  // host: true -> слушаем на всех интерфейсах (0.0.0.0), чтобы телефон достучался
  // по LAN-IP. https — только в режиме phone (см. httpsFor) -> secure context -> камера на iOS.
  server: {
    host: true,
    port: 5173,
    https: httpsFor(mode),
  },
  build: {
    // Две точки входа: основной app (index.html) и лёгкая страница-отправитель для
    // телефона (phone.html) — она не тянет тяжёлый пайплайн, только getUserMedia+WebRTC.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        phone: fileURLToPath(new URL("./phone.html", import.meta.url)),
      },
    },
  },
  optimizeDeps: {
    // transformers.js и onnxruntime-web тянут wasm/onnx — не трогаем их пре-бандлером.
    exclude: ["@huggingface/transformers", "onnxruntime-web"],
  },
  worker: {
    format: "es",
  },
}));
