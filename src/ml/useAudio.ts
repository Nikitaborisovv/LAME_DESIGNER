// Аудио-анализ (T-Beauty): WebAudio AnalyserNode -> FFT-полосы (low/mid/high) + kick-транзиент.
// Дёшево (AnalyserNode — нативный DSP браузера); свой rAF-цикл, не тот, что у рендера.
// Результат в ref (без React-ререндера на кадр) — конвенция §0: оверлей читает из ref на rAF.
//
// AudioContext — модульный синглтон (один на страницу: создаётся лениво при первом включении).
// MediaElementSource: ОДИН на HTMLMediaElement за жизнь страницы — кешируется в WeakMap.
// Mic: getUserMedia -> MediaStreamAudioSourceNode; подключается ТОЛЬКО к analyser (не к destination).
//
// computeAudioBands: ЭКСПОРТИРУЕТСЯ ОТДЕЛЬНО для юнит-тестов (граница бина = idx * sr / fftSize).

import { useEffect, useRef } from "react";
import type { AudioBands } from "../core/drivers";

// Переиспользуем экспортируемый тип
export type { AudioBands };

// ===== Модульные синглтоны (вне React, на весь lifetime страницы) =====

// Один AudioContext на приложение. Создаётся лениво при первом enabled=true.
let _ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!_ctx) {
    _ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }
  return _ctx;
}

// Одноразовый pointerdown-листенер для resume по первому жесту (autoplay-политика браузера).
let _resumeListenerAttached = false;
function ensureResumeOnGesture(ctx: AudioContext) {
  if (_resumeListenerAttached) return;
  _resumeListenerAttached = true;
  const handler = () => {
    if (ctx.state === "suspended") ctx.resume().catch(() => { /* ignore */ });
    window.removeEventListener("pointerdown", handler);
  };
  window.addEventListener("pointerdown", handler, { once: true });
}

// Кеш MediaElementAudioSourceNode: createMediaElementSource можно вызвать ТОЛЬКО ОДИН РАЗ на элемент.
const _srcNodeCache = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

// ===== Чистая функция вычисления полос (экспортируется для тестов) =====
// freq: Uint8Array из getByteFrequencyData (значения 0..255).
// sampleRate: AudioContext.sampleRate (обычно 44100 или 48000).
// fftSize: AnalyserNode.fftSize (вдвое больше frequencyBinCount).
// gain: усиление результата.
// Возвращает raw (до clamp01 и до kick), чтобы хук мог применить gain и считать EMA.
export function computeAudioBands(
  freq: Uint8Array,
  sampleRate: number,
  fftSize: number,
  gain: number,
): { low: number; mid: number; high: number } {
  const binHz = sampleRate / fftSize; // Гц на 1 бин
  const n = freq.length;

  // Границы полос (Гц)
  const LOW_HI = 250;
  const MID_HI = 2000;
  const HIGH_HI = 8000;

  let lowSum = 0, lowN = 0;
  let midSum = 0, midN = 0;
  let highSum = 0, highN = 0;

  for (let i = 0; i < n; i++) {
    const hz = i * binHz;
    if (hz < 20) continue; // ниже 20 Гц — инфразвук, пропускаем
    const v = freq[i]; // 0..255
    if (hz < LOW_HI) {
      lowSum += v; lowN++;
    } else if (hz < MID_HI) {
      midSum += v; midN++;
    } else if (hz < HIGH_HI) {
      highSum += v; highN++;
    } else {
      break; // выше 8 кГц не нужно
    }
  }

  const raw = (sum: number, cnt: number) => cnt > 0 ? (sum / cnt / 255) * gain : 0;
  return { low: raw(lowSum, lowN), mid: raw(midSum, midN), high: raw(highSum, highN) };
}

// ===== Хук =====

export function useAudio(
  enabled: boolean,
  source: string,        // "video" | "mic"
  gain: number,
  videoEl: HTMLVideoElement | null,
): { current: AudioBands | null } {
  const audioRef = useRef<AudioBands | null>(null);
  // gain читается каждый кадр через gainRef — не требует перезапуска эффекта
  const gainRef = useRef(gain);
  gainRef.current = gain;

  // EMA-состояние kick-детектора (персистентно между кадрами, не сбрасывается при ре-рендере)
  const kickEmaRef = useRef<number>(0);
  const rafRef = useRef<number>(0);
  const micStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!enabled) {
      audioRef.current = null;
      return;
    }

    const ctx = getCtx();
    ensureResumeOnGesture(ctx);
    if (ctx.state === "suspended") ctx.resume().catch(() => { /* ignore */ });

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.5;
    // Преаллоцированный буфер — НЕТ аллокаций в горячем цикле
    const freqBuf = new Uint8Array(analyser.frequencyBinCount);

    let connected = false;
    // Гард отмены: если эффект размонтировался до резолва getUserMedia (быстрый disable,
    // смена источника, StrictMode-двойной маунт) — стрим глушим сразу, узлы не создаём.
    let cancelled = false;
    // Узел-источник этого запуска эффекта — чтобы cleanup рвал ИМЕННО ребро source→analyser
    // (analyser.disconnect() рвёт только исходящие связи самого analyser, которых нет).
    let feedNode: AudioNode | null = null;
    // Сброс kick-огибающей при (ре)старте анализа — иначе stale-EMA даёт ложный кик первые ~0.15с.
    kickEmaRef.current = 0;

    const connectVideo = () => {
      if (!videoEl) return;
      let srcNode = _srcNodeCache.get(videoEl);
      if (!srcNode) {
        srcNode = ctx.createMediaElementSource(videoEl);
        _srcNodeCache.set(videoEl, srcNode);
      }
      srcNode.connect(ctx.destination); // восстанавливаем звук (иначе видео онемеет); дубль-connect — no-op
      srcNode.connect(analyser);
      feedNode = srcNode;
      connected = true;
    };

    const connectMic = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        micStreamRef.current = stream;
        const micNode = ctx.createMediaStreamSource(stream);
        micNode.connect(analyser); // НЕ подключаем к destination (иначе фидбек)
        feedNode = micNode;
        connected = true;
      } catch (err) {
        console.warn("[useAudio] mic access denied:", err);
      }
    };

    if (source === "mic") {
      connectMic();
    } else {
      connectVideo();
    }

    // rAF-цикл анализа: getByteFrequencyData + вычисление полос + EMA kick.
    // Kick = clamp01((low - slowEMA(low)) * 4); tau EMA ≈ 0.15 с.
    const EMA_TAU = 0.15; // секунды
    let lastT = 0;

    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);
      if (!connected) return;

      analyser.getByteFrequencyData(freqBuf);

      const sampleRate = ctx.sampleRate;
      const fftSize = analyser.fftSize;
      const bands = computeAudioBands(freqBuf, sampleRate, fftSize, gainRef.current);

      // clamp01
      const low = bands.low < 0 ? 0 : bands.low > 1 ? 1 : bands.low;
      const mid = bands.mid < 0 ? 0 : bands.mid > 1 ? 1 : bands.mid;
      const high = bands.high < 0 ? 0 : bands.high > 1 ? 1 : bands.high;

      // Kick: транзиент НЧ — резкий рост low над медленной EMA-огибающей.
      // clamp01((low - slowEMA(low)) * 4) — на ударе вспышка, на ровном гуле → 0.
      const dt = lastT > 0 ? Math.min((now - lastT) / 1000, 0.1) : 1 / 60;
      lastT = now;
      const alpha = dt / (EMA_TAU + dt); // кадронезависимый коэффициент EMA
      kickEmaRef.current += alpha * (low - kickEmaRef.current);
      const rawKick = (low - kickEmaRef.current) * 4;
      const kick = rawKick < 0 ? 0 : rawKick > 1 ? 1 : rawKick;

      // Мутируем стабильный объект (без аллокаций в rAF-цикле).
      let out = audioRef.current;
      if (!out) { out = { low: 0, mid: 0, high: 0, kick: 0 }; audioRef.current = out; }
      out.low = low; out.mid = mid; out.high = high; out.kick = kick;
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      // Рвём ребро source→analyser (иначе на кешированном srcNode копятся мёртвые анализаторы).
      // Ребро srcNode→destination НЕ рвём: после createMediaElementSource звук видео живёт только через ctx.
      try { feedNode?.disconnect(analyser); } catch { /* ignore */ }
      // Останавливаем mic-стрим при смене источника/disable
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
      }
      audioRef.current = null;
    };
  }, [enabled, source, videoEl]); // gain меняется через gainRef без перезапуска

  return audioRef;
}
