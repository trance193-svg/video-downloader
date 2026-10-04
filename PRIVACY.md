# Политика конфиденциальности / Privacy Policy

**Video Downloader** (расширение Chrome + локальный native host)

_Последнее обновление: 2026-10-04_

## Русский

Расширение **Video Downloader** не собирает, не хранит и не передаёт никаких
персональных данных ни авторам расширения, ни третьим сторонам.

Что происходит при использовании:

- **Обнаружение видео.** Расширение пассивно наблюдает сетевые запросы и DOM
  активной вкладки, чтобы найти видеопотоки (m3u8/mpd/mp4 и т.п.). Список
  найденных ссылок хранится только в оперативной памяти браузера
  (`chrome.storage.session`) и исчезает при закрытии браузера. Он не покидает
  ваш компьютер.
- **Скачивание.** Ссылки на видео обрабатываются **локальной** программой
  (native host: Node.js + yt-dlp/ffmpeg), установленной на вашем компьютере.
  Файлы сохраняются в вашу папку «Загрузки». Никакие данные об этих загрузках
  никуда не отправляются.
- **Настройки** (подпапка, максимальное качество, число потоков) хранятся
  локально в `chrome.storage.sync` — это стандартное синхронизируемое
  хранилище вашего браузера, привязанное к вашему аккаунту Google; авторы
  расширения к нему доступа не имеют.
- **Обновление yt-dlp.** Локальный host раз в сутки проверяет специальный
  манифест на GitHub (`raw.githubusercontent.com`), чтобы обновить движок
  yt-dlp. Проверка — это обычный анонимный GET-запрос; данные о вас в нём
  отсутствуют.
- **Аналитики, телеметрии, рекламы, куки-трекеров нет.** Расширение не делает
  никаких запросов к серверам автора.

Контакты: вопросы о конфиденциальности — через
[issue-трекер репозитория](https://github.com/trance193-svg/video-downloader/issues).

## English

The **Video Downloader** extension does not collect, store, or transmit any
personal data — neither to the extension's authors nor to third parties.

What happens when you use it:

- **Video detection.** The extension passively observes network requests and
  the DOM of the active tab to find video streams (m3u8/mpd/mp4, etc.). The
  list of detected links is kept only in the browser's in-memory session
  storage (`chrome.storage.session`) and is gone when the browser closes. It
  never leaves your computer.
- **Downloading.** Video URLs are handled by a **local** program (native
  messaging host: Node.js + yt-dlp/ffmpeg) installed on your machine. Files
  are saved to your Downloads folder. No information about these downloads is
  sent anywhere.
- **Settings** (subfolder, max quality, fragment parallelism) are stored
  locally in `chrome.storage.sync` — your browser's standard sync storage
  bound to your own Google account; the extension's authors have no access to
  it.
- **yt-dlp updates.** The local host checks a manifest on GitHub
  (`raw.githubusercontent.com`) once a day to keep the yt-dlp engine current.
  The check is a plain anonymous GET request containing no data about you.
- **No analytics, telemetry, ads, or tracker cookies.** The extension makes no
  requests to the author's servers.

Contact: privacy questions via the
[repository issue tracker](https://github.com/trance193-svg/video-downloader/issues).
