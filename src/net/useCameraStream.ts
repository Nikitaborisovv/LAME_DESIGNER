// Приёмник видеопотока с телефона по WebRTC. Десктоп = answerer: телефон
// (phone.html) шлёт offer, мы отвечаем answer и получаем MediaStream в ontrack.
// Сигналинг — локальный wss /signal (см. signaling.ts). На одной LAN ICE проходит
// по host-кандидатам напрямую, STUN/TURN не нужны.
//
// Возвращает поток (для VideoSource.loadStream), статус и ссылку для телефона
// (LAN-IP десктопа приходит от сигналинг-сервера в hello).

import { useEffect, useRef, useState } from "react";

export type StreamStatus =
  | "idle"
  | "connecting" // открываем ws
  | "waiting"    // ждём телефон в комнате
  | "connected"  // дорожка пошла
  | "error";

interface CameraStream {
  stream: MediaStream | null;
  status: StreamStatus;
  phoneUrl: string | null; // https://<LAN-IP>:<port>/phone.html?room=hud
  error: string | null;
}

const ROOM = "hud";

export function useCameraStream(active: boolean): CameraStream {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [phoneUrl, setPhoneUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Живые объекты держим в ref — переживают ре-рендеры, чистим в teardown.
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  useEffect(() => {
    if (!active) return;

    let closed = false;
    setStatus("connecting");
    setError(null);

    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/signal?room=${ROOM}&role=receiver`);
    wsRef.current = ws;

    const sendSig = (m: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };

    // Свежий peer на каждый offer (реконнект телефона = новый pc на той стороне).
    const makePeer = () => {
      pcRef.current?.close();
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.ontrack = (e) => {
        if (closed) return;
        setStream(e.streams[0] || new MediaStream([e.track]));
        setStatus("connected");
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) sendSig({ t: "ice", candidate: e.candidate });
      };
      pc.onconnectionstatechange = () => {
        if (closed) return;
        const s = pc.connectionState;
        if (s === "failed" || s === "disconnected") setStatus("waiting");
      };
      return pc;
    };

    ws.onopen = () => { if (!closed) setStatus("waiting"); };
    ws.onerror = () => { if (!closed) { setStatus("error"); setError("сигналинг недоступен"); } };
    ws.onclose = () => { if (!closed) setStatus("idle"); };

    ws.onmessage = async (ev) => {
      if (closed) return;
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.t === "hello") {
        // Строим ссылку для телефона из LAN-IP десктопа (или текущего host как фолбэк).
        const ip = (msg.ips && msg.ips[0]) || location.hostname;
        const proto = location.protocol === "https:" ? "https" : "http";
        setPhoneUrl(`${proto}://${ip}:${msg.port}/phone.html?room=${msg.room}`);
        return;
      }
      if (msg.t === "ready") { setStatus((s) => (s === "connected" ? s : "waiting")); return; }
      if (msg.t === "peer-left") { setStatus("waiting"); setStream(null); return; }

      if (msg.t === "sdp" && msg.sdp?.type === "offer") {
        const pc = makePeer();
        try {
          await pc.setRemoteDescription(msg.sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSig({ t: "sdp", sdp: pc.localDescription });
        } catch (e) {
          setStatus("error");
          setError(String(e));
        }
        return;
      }
      if (msg.t === "ice" && msg.candidate && pcRef.current) {
        try { await pcRef.current.addIceCandidate(msg.candidate); } catch { /* гонка ICE — ок */ }
      }
    };

    return () => {
      closed = true;
      pcRef.current?.close();
      pcRef.current = null;
      ws.close();
      wsRef.current = null;
      setStream(null);
      setStatus("idle");
    };
  }, [active]);

  return { stream, status, phoneUrl, error };
}
