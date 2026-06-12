// Отправитель: телефон захватывает камеру (getUserMedia) и шлёт её десктопу по
// WebRTC. Телефон = offerer (у него медиа). Сигналинг — wss /signal (см. signaling.ts).
// Лёгкая vanilla-страница: НЕ грузит тяжёлый пайплайн приложения.
//
// ВАЖНО (iOS): getUserMedia работает только в secure context (https), кроме localhost.
// Поэтому десктоп поднят по https с mkcert-сертификатом, и телефон заходит по
// https://<LAN-IP десктопа>:5173/phone.html (один раз доверившись CA mkcert).

const videoEl = document.getElementById("preview") as HTMLVideoElement;
const dotEl = document.getElementById("dot") as HTMLSpanElement;
const msgEl = document.getElementById("msg") as HTMLSpanElement;
const flipBtn = document.getElementById("flip") as HTMLButtonElement;

const room = new URLSearchParams(location.search).get("room") || "hud";
let facing: "environment" | "user" = "environment";

let ws: WebSocket | null = null;
let pc: RTCPeerConnection | null = null;
let stream: MediaStream | null = null;
let videoSender: RTCRtpSender | null = null;
let reconnectTimer: number | undefined;

function setStatus(text: string, state: "wait" | "on" | "err" = "wait") {
  msgEl.textContent = text;
  dotEl.className = "dot" + (state === "on" ? " on" : state === "err" ? " err" : "");
}

function sendSig(m: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

async function getCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
}

function makePeer() {
  pc?.close();
  pc = new RTCPeerConnection();
  for (const track of stream!.getTracks()) {
    videoSender = pc.addTrack(track, stream!);
  }
  pc.onicecandidate = (e) => { if (e.candidate) sendSig({ t: "ice", candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    const s = pc!.connectionState;
    if (s === "connected") setStatus("в эфире → десктоп", "on");
    else if (s === "failed" || s === "disconnected") setStatus("связь потеряна, ждём…", "err");
  };
}

async function startOffer() {
  if (!stream) return;
  makePeer();
  const offer = await pc!.createOffer();
  await pc!.setLocalDescription(offer);
  sendSig({ t: "sdp", sdp: pc!.localDescription });
  setStatus("соединяемся с десктопом…");
}

function connectSignaling() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${scheme}://${location.host}/signal?room=${room}&role=sender`);

  ws.onopen = () => setStatus("ждём десктоп в комнате…");
  ws.onclose = () => {
    setStatus("сигналинг отключён, переподключаемся…", "err");
    reconnectTimer = window.setTimeout(connectSignaling, 1500);
  };
  ws.onerror = () => setStatus("ошибка сигналинга", "err");

  ws.onmessage = async (ev) => {
    let msg: any;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.t === "ready") { await startOffer(); return; }
    if (msg.t === "peer-left") { setStatus("десктоп вышел, ждём…"); return; }
    if (msg.t === "sdp" && msg.sdp?.type === "answer") {
      try { await pc?.setRemoteDescription(msg.sdp); } catch (e) { setStatus(String(e), "err"); }
      return;
    }
    if (msg.t === "ice" && msg.candidate && pc) {
      try { await pc.addIceCandidate(msg.candidate); } catch { /* гонка ICE — ок */ }
    }
  };
}

// Переключение фронт/тыл без переустановки соединения: заменяем дорожку у sender.
flipBtn.onclick = async () => {
  facing = facing === "environment" ? "user" : "environment";
  try {
    const next = await getCamera();
    const newTrack = next.getVideoTracks()[0];
    stream?.getTracks().forEach((t) => t.stop());
    stream = next;
    videoEl.srcObject = stream;
    if (videoSender) await videoSender.replaceTrack(newTrack);
  } catch (e) {
    setStatus("не удалось переключить камеру", "err");
  }
};

async function init() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("getUserMedia недоступен — нужен https (secure context)", "err");
    return;
  }
  try {
    stream = await getCamera();
  } catch (e: any) {
    setStatus("нет доступа к камере: " + (e?.name || e), "err");
    return;
  }
  videoEl.srcObject = stream;
  connectSignaling();
}

window.addEventListener("beforeunload", () => {
  clearTimeout(reconnectTimer);
  pc?.close();
  ws?.close();
  stream?.getTracks().forEach((t) => t.stop());
});

init();
