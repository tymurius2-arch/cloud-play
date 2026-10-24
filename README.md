# ☁️ Cloud Play

Свой облачный гейминг: игры запускаются на твоём компьютере со Steam, а играть можно на телефоне, планшете, ноутбуке или телевизоре прямо в браузере.

**Сайт:** https://tymurius2-arch.github.io/cloud-play/

## Как запустить

1. Установи [Node.js](https://nodejs.org/) (версия LTS).
2. [Скачай архив](https://github.com/tymurius2-arch/cloud-play/archive/refs/heads/main.zip) и распакуй.
3. Дважды нажми `start.bat`. В окне появятся PIN-код и адрес, например `https://192.168.1.5:8443`.
4. Открой адрес на телефоне в той же сети Wi-Fi, введи PIN и играй.

## Как это устроено

```
 ПК с Windows                                     Телефон / планшет / ТВ
┌───────────────────────────────┐                ┌────────────────────────┐
│ host/server.js (Node.js)      │◄── WebSocket ──│ приложение в браузере   │
│  • библиотека Steam           │   (PIN, игры,  │  • библиотека игр       │
│  • запуск игр steam://        │    управление) │  • видео + звук         │
│  • мышь/клавиатура (SendInput)│                │  • геймпад на экране,   │
│                               │                │    тачпад, клавиатура   │
│ host.html в Chrome/Edge       │──── WebRTC ───►│                         │
│  • захват экрана и звука      │   (H.264, 60   │                         │
│  • аппаратное кодирование     │    кадров/с)   │                         │
└───────────────────────────────┘                └────────────────────────┘
```

| Файл | Что делает |
|---|---|
| `start.bat` | Запуск в Windows: проверяет Node.js, ставит зависимости, запускает сервер |
| `host/server.js` | HTTPS-сервер, PIN-код, связь между окном трансляции и клиентом |
| `host/steam.js` | Читает библиотеку Steam (`libraryfolders.vdf`, `appmanifest_*.acf`), запускает игры |
| `host/input.js`, `host/input-win.ps1` | Нажатия клавиш и мышь через WinAPI `SendInput` (скан-коды, работает в играх) |
| `host/public/host.html` | Окно трансляции: захват экрана, WebRTC-отправитель |
| `host/public/index.html`, `app.js` | Клиент: библиотека, плеер, управление |
| `index.html` | Сайт на GitHub Pages |

## Для разработчика

```bash
cd host
npm install
# тестовая картинка вместо экрана, без открытия браузера:
TEST_SOURCE=1 NO_BROWSER=1 PIN=123456 node server.js
# затем открыть https://localhost:8443/host.html?test=1 и https://localhost:8443/
```

Переменные окружения: `PIN`, `HTTPS_PORT` (8443), `HTTP_PORT` (8080), `STEAM_PATH`, `BROWSER_PATH`, `NO_BROWSER`, `TEST_SOURCE`, `INPUT_DEBUG`.

## Планы

- Эмуляция настоящего Xbox-геймпада (ViGEmBus)
- Игра через интернет без Tailscale
- Выбор монитора, если их несколько
