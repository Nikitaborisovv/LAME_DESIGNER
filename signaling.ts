// Локальный WebRTC-сигналинг как vite-плагин: вешается на тот же dev-сервер (wss),
// отдельный процесс не нужен. Релеит SDP/ICE между двумя пирами одной «комнаты»
// (телефон-отправитель ↔ десктоп-приёмник) и сообщает приёмнику LAN-IP десктопа,
// чтобы построить ссылку для телефона.
//
// Лежит ВНЕ src/ (node-код: ws/os/http), поэтому app-tsconfig (include: src) его не
// тайпчекает; vite собирает конфиг через esbuild без строгой проверки типов.

import { WebSocketServer, WebSocket } from "ws";
import { networkInterfaces } from "os";

type Role = "sender" | "receiver";

interface Member {
  ws: WebSocket;
  role: Role;
}

// Список не-внутренних IPv4: настоящие LAN-адреса (192.168/10/172.16-31) вперёд,
// виртуальные адаптеры (docker/wsl) — в хвост.
function lanIPs(): string[] {
  const out: string[] = [];
  const ifs = networkInterfaces();
  for (const name in ifs) {
    for (const a of ifs[name] || []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  const score = (ip: string) =>
    ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : ip.startsWith("172.") ? 3 : 2;
  return out.sort((a, b) => score(a) - score(b));
}

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export function signalingPlugin() {
  // комната -> { sender, receiver }. Для локального сценария хватает фиксированных ролей.
  const rooms = new Map<string, Partial<Record<Role, Member>>>();

  return {
    name: "webrtc-signaling",
    configureServer(server: any) {
      const httpServer = server.httpServer;
      if (!httpServer) return;
      const wss = new WebSocketServer({ noServer: true });

      httpServer.on("upgrade", (req: any, socket: any, head: any) => {
        // Не трогаем HMR-сокет vite и прочие апгрейды — только наш путь.
        const url = new URL(req.url || "/", "http://x");
        if (url.pathname !== "/signal") return;
        wss.handleUpgrade(req, socket, head, (ws) => {
          const room = url.searchParams.get("room") || "hud";
          const role = (url.searchParams.get("role") as Role) || "receiver";
          const port = (httpServer.address() && httpServer.address().port) || 5173;

          const peers = rooms.get(room) || {};
          // Заменяем предыдущего участника той же роли (реконнект телефона/вкладки).
          peers[role]?.ws.close();
          peers[role] = { ws, role };
          rooms.set(room, peers);

          send(ws, { t: "hello", ips: lanIPs(), port, room, role });

          const other: Role = role === "sender" ? "receiver" : "sender";
          // Если второй пир уже в комнате — оба готовы начинать обмен SDP.
          if (peers[other]) {
            send(ws, { t: "ready" });
            send(peers[other]!.ws, { t: "ready" });
          }

          ws.on("message", (data) => {
            // Чистый релей SDP/ICE второму участнику комнаты.
            const target = rooms.get(room)?.[other];
            if (target) target.ws.send(data.toString());
          });

          ws.on("close", () => {
            const r = rooms.get(room);
            if (r && r[role]?.ws === ws) {
              delete r[role];
              if (r[other]) send(r[other]!.ws, { t: "peer-left" });
              if (!r.sender && !r.receiver) rooms.delete(room);
            }
          });
        });
      });
    },
  };
}
