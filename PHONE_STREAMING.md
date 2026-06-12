# Стрим с айфона в VIDEO_HUD (WebRTC по локальному WiFi)

Камера телефона становится источником видео вместо файла и идёт через весь пайплайн
(flat-шейдеры, vision, глубина, маски людей, лица, constellation).

## Архитектура

- **Телефон = отправитель** (`phone.html` + `src/phone/main.ts`): `getUserMedia` → WebRTC offer.
- **Десктоп = приёмник** (`src/net/useCameraStream.ts`): WebRTC answer → `MediaStream`
  → `VideoSource.loadStream()` → дальше всё как с файлом (rVFC, `videoWidth/Height`).
- **Сигналинг** (`signaling.ts`): мини-WS-сервер прямо на vite-dev (`wss /signal`),
  релеит SDP/ICE между двумя пирами одной комнаты. На одной LAN ICE идёт по host-кандидатам
  напрямую — STUN/TURN не нужны.

## Почему HTTPS

iOS Safari разрешает `getUserMedia` только в secure context (HTTPS), кроме localhost.
Десктоп по LAN-IP идёт по сети → нужен HTTPS. Сертификат — mkcert (доверенный локальный CA).

HTTPS включается **только** в режиме телефона: `npm run dev:phone` (= `vite --mode phone`).
Обычный `npm run dev` остаётся на HTTP (preview/повседневная работа на localhost).

## Разовая настройка (уже сделано в этой машине)

1. mkcert: `tools/mkcert.exe` (бинарь), CA установлен (`mkcert -install`).
2. Сертификат на localhost + LAN-IP: `certs/dev-cert.pem`, `certs/dev-key.pem`.
   Перевыпуск при смене IP:
   `tools/mkcert.exe -cert-file certs/dev-cert.pem -key-file certs/dev-key.pem localhost 127.0.0.1 ::1 <НОВЫЙ-LAN-IP>`
3. **На айфоне один раз** доверить CA mkcert, иначе Safari заблокирует HTTPS/камеру:
   - Отправь `certs/rootCA.pem` на телефон (AirDrop / почта).
   - Открой файл → Настройки → Профиль загружен → Установить.
   - **Настройки → Основные → Об этом устройстве → Доверие сертификатам** → включи доверие mkcert.

## Запуск

1. Десктоп: `npm run dev:phone` → откроется `https://localhost:5173`.
2. В панели справа: **источник → 📱 камера телефона**. Появятся QR и ссылка
   `https://<LAN-IP>:5173/phone.html?room=hud`, статус «ждём телефон…».
3. На айфоне (тот же WiFi): отсканируй QR / открой ссылку, разреши камеру.
   Кнопка «🔄 камера» переключает фронт/тыл.
4. Десктоп показывает поток, статус «поток идёт ✓». Дальше работают все эффекты/маски.

## Заметки

- Латентность ~50–150 мс (аппаратный H.264/VP8, адаптивный битрейт).
- Реконнект телефона/вкладки — пересоздаёт peer автоматически (новый offer).
- LAN-IP десктопа десктоп узнаёт от сигналинг-сервера (`hello.ips`, 192.168.* вперёд).
- Если IP сменился — перевыпусти сертификат (шаг 2) и перезайди с телефона.
