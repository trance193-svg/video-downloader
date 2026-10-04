# Материалы для Chrome Web Store (v1.2.0)

Черновик для ручного ввода в Console Developer Dashboard.
Запрещено политикой CWS упоминать YouTube и другие бренды — нигде не упоминаем.

## Загружаемый пакет

- `dist\VideoDownloader-cws-v1.2.0.zip` — zip папки `extension/` (манифест в корне архива).

## Языковые локали

- Основная: русский (`ru`) — default_locale
- Добавить локаль: английский (`en`)

## Название (≤ 75 символов)

- ru: `Video Downloader — скачивание видео и HLS`
- en: `Video Downloader — download videos and HLS`

## Краткое описание (≤ 132 символов)

- ru: `Скачивает видео и HLS/DASH-потоки в MP4 через локальный движок yt-dlp/ffmpeg. Без сбора данных — всё работает локально.`
- en: `Download videos and HLS/DASH streams as MP4 with a local yt-dlp/ffmpeg engine. No data collection — everything stays local.`

## Подробное описание

### ru

```markdown
Video Downloader — универсальный загрузчик видео для браузера.

КАК ЭТО РАБОТАЕТ
• Откройте страницу с видео и включите воспроизведение — расширение само обнаружит прямые MP4-ссылки и HLS/DASH-потоки (включая мастер-плейлисты с выбором качества).
• Нажмите «Найти видео» — расширение покажет доступные варианты с качеством, частотой кадров и размером.
• Выберите вариант — файл будет сохранён в «Загрузки» в подпапку VideoDownloader.

ВОЗМОЖНОСТИ
• Поддержка MP4, WebM, HLS (m3u8) и DASH (mpd).
• Мастер-плейлисты: список всех качеств от 240p до 1080p и выше.
• Ограничение максимального качества по умолчанию (например, 720p).
• Параллельная загрузка фрагментов HLS — скорость до 16×.
• Отмена загрузки в любой момент.
• Интерфейс на русском и английском.

ТЕХНИЧЕСКИ
• Скачивание выполняет локальный native-хост (Node.js + yt-dlp + ffmpeg) — тот же открытый движок, которым пользуются профессионалы.
• Хост устанавливается в два клика из визарда при первом запуске (пакет с GitHub Releases) и сам обновляет yt-dlp с проверкой SHA-256.
• Всё выполняется на вашем компьютере. Расширение не собирает и не отправляет никакие данные (см. политику конфиденциальности).

Расширение распространяется «как есть», для скачивания контента, на который у вас есть права.
```

### en

```markdown
Video Downloader is a universal video downloader for your browser.

HOW IT WORKS
• Open a page with a video and start playback — the extension automatically detects direct MP4 links and HLS/DASH streams (including master playlists with quality options).
• Click "Find video" — you get the list of available variants with quality, frame rate and size.
• Pick one — the file is saved to your Downloads folder, in the VideoDownloader subfolder.

FEATURES
• MP4, WebM, HLS (m3u8) and DASH (mpd) support.
• Master playlists: every quality from 240p to 1080p and beyond.
• Default maximum quality cap (e.g. 720p).
• Parallel HLS fragment downloads — up to 16× faster.
• Cancel a download at any time.
• Russian and English interface.

UNDER THE HOOD
• Downloads are performed by a local native host (Node.js + yt-dlp + ffmpeg) — the same open-source engine the pros use.
• The host installs in two clicks from the first-run wizard (package from GitHub Releases) and keeps yt-dlp up to date with SHA-256 verification.
• Everything runs on your computer. The extension collects and sends no data (see the privacy policy).

Provided as-is, for downloading content you have the rights to.
```

## Категория

- `Инструменты` (Tools)

## Язык (single language field)

- русский (ru)

## Политика конфиденциальности (обязательное поле-URL)

- `https://github.com/trance193-svg/video-downloader/blob/main/PRIVACY.md`

## Скриншоты (1280×800, в папке store-shots/)

Порядок для листинга:

1. `1-detected.png` — обнаруженные потоки на странице
2. `2-formats.png` — список форматов с качествами
3. `3-progress.png` — загрузка с прогрессом и скоростью
4. `4-done.png` — завершённая загрузка
5. `5-options.png` — настройки

(На всех кадрах — реальный интерфейс на тестовом HLS-потоке; «Страница» и путь
файла обезличены.)

## Обоснования разрешений (поля justifications в Dashboard)

| Разрешение | Обоснование (вставлять в Dashboard) |
|---|---|
| `tabs` | Расширение показывает заголовок и URL активной вкладки: заголовок используется как имя файла, URL — для анализа ссылки через движок yt-dlp. Также используется для открытия страницы настроек. |
| `webRequest` | Пассивное наблюдение запросов активной вкладки — единственный способ обнаружить ссылки на видеопотоки (m3u8/mpd/mp4), которые страница загружает в фоновом режиме. Запросы только читаются, никак не изменяются. |
| `host_permissions: <all_urls>` | Видео встраивается на сайты любых категорий; чтобы обнаружение работало везде, где пользователь решит сохранить видео, наблюдение запросов включено для всех сайтов. Расширение не отправляет содержимое запросов никуда. |
| `nativeMessaging` | Связь с локальным native-хостом (Node.js + yt-dlp + ffmpeg), который выполняет скачивание файлов на машину пользователя. Без этого разрешения скачивание невозможно. |
| `downloads` | Используется только в визарде первого запуска: скачать установочный пакет native-хоста с официального GitHub Releases проекта. |
| `storage` | Хранение настроек пользователя (подпапка, качество, параллелизм) во встроенном хранилище браузера и временного списка обнаруженных потоков (session storage, очищается при закрытии браузера). |
| `alarms` | Периодический wake-up service worker, чтобы длительные загрузки не прерывались при засыпании воркера. |
| `content_scripts: <all_urls>` | Скрипт ищет элементы `<video>` и их источники в DOM активной вкладки (дополнительный к webRequest способ обнаружения). Ничего не изменяет и не отправляет. |

## Что ещё подготовить в Dashboard

- Значок 128×128 уже в пакете (`icons/icon128.png`); для tiles CWS берёт его же.
- Один раз заполнить «Centralized Privacy Policy» форму: данные не собираются
  (требуется и для доступ к `webRequest`/`<all_urls>` — ответ «No, I do not
  collect any of the data types»).
- При ревью CWS может запросить демонстрацию: подготовить ссылку на тестовую
  страницу с видео (test-videos.co.uk) и video-съёмку работы.
