// Тонкая обёртка над <video>: грузит файл, отдаёт элемент и покадровый колбэк.
// requestVideoFrameCallback даёт кадрово-точную синхронизацию (точнее rAF).

import { perf } from "./perf";

export class VideoSource {
  readonly el: HTMLVideoElement;
  private rvfcHandle = 0;

  constructor() {
    const v = document.createElement("video");
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.crossOrigin = "anonymous";
    this.el = v;
  }

  async load(url: string): Promise<void> {
    this.el.removeAttribute("srcObject");
    (this.el as any).srcObject = null;
    this.el.src = url;
    await this.el.play().catch(() => {
      /* автоплей может потребовать жеста пользователя — кнопка в UI это решает */
    });
  }

  // Живой поток (WebRTC с телефона / локальная камера) как источник. rVFC и
  // videoWidth/Height работают так же, как для файла, поэтому весь пайплайн ниже
  // не меняется — просто видео тикает с частотой потока.
  async loadStream(stream: MediaStream): Promise<void> {
    this.el.removeAttribute("src");
    this.el.srcObject = stream;
    await this.el.play().catch(() => {});
  }

  // Колбэк на каждый показанный кадр видео. Возвращает функцию отписки.
  onFrame(cb: (now: number, meta: any) => void): () => void {
    const anyVideo = this.el as any;
    if (typeof anyVideo.requestVideoFrameCallback === "function") {
      const loop = (now: number, meta: any) => {
        perf.tick("video.fps");
        cb(now, meta);
        this.rvfcHandle = anyVideo.requestVideoFrameCallback(loop);
      };
      this.rvfcHandle = anyVideo.requestVideoFrameCallback(loop);
      return () => anyVideo.cancelVideoFrameCallback?.(this.rvfcHandle);
    }
    // Фолбэк, если rVFC недоступен.
    let raf = 0;
    const loop = (t: number) => {
      cb(t, null);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }

  dispose() {
    this.el.pause();
    this.el.removeAttribute("src");
    (this.el as any).srcObject = null;
    this.el.load();
  }
}
