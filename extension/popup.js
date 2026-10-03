// ===========================================================================
// Popup logic — Video Downloader.
//
// Talks to the background service worker via chrome.runtime.sendMessage and
// listens for broadcast messages (host events). Renders:
//   - host connection status
//   - the current page URL + an "Analyse" button (runs yt-dlp via host)
//   - the list of formats yt-dlp found, each with a "Download with audio" btn
//   - streams detected on the page by webRequest / content script
//   - download progress + cancel
// ===========================================================================

const $ = (id) => document.getElementById(id);

const els = {
  hostStatus: $("hostStatus"),
  pageUrl: $("pageUrl"),
  analyseBtn: $("analyseBtn"),
  hint: $("hint"),
  resultBox: $("resultBox"),
  thumb: $("thumb"),
  videoTitle: $("videoTitle"),
  videoMeta: $("videoMeta"),
  videos: $("videos"),
  detectedBox: $("detectedBox"),
  detectedList: $("detectedList"),
  progressBox: $("progressBox"),
  barFill: $("barFill"),
  progressText: $("progressText"),
  cancelBtn: $("cancelBtn"),
  doneBox: $("doneBox"),
  doneText: $("doneText"),
  errorBox: $("errorBox"),
  errorText: $("errorText"),
  manualUrl: $("manualUrl"),
  manualBtn: $("manualBtn"),
};

let currentPageUrl = "";
let currentPageTitle = ""; // active tab <title> — used as the download filename
let currentAnalysedUrl = ""; // the URL actually passed to yt-dlp (may differ from page URL)
let currentMasterUrl = ""; // master m3u8 if detected — preferred over page URL

// ---------------------------------------------------------------------------
function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp || {}));
  });
}

function setHost(status, cls) {
  els.hostStatus.textContent = status;
  els.hostStatus.className = "status " + (cls || "");
}

function show(el) {
  el.classList.remove("hidden");
}
function hide(el) {
  el.classList.add("hidden");
}

function setError(msg) {
  if (!msg) {
    hide(els.errorBox);
    return;
  }
  els.errorText.textContent = msg;
  show(els.errorBox);
}

function resetAnalyseBtn() {
  els.analyseBtn.disabled = false;
  els.analyseBtn.textContent = "Найти видео (yt-dlp)";
}

// yt-dlp reports "Unknown"/"NA" when it can't estimate — don't show that.
function prettyEta(eta) {
  const e = String(eta || "").trim();
  if (!e || /^(unknown|na|n\/a)$/i.test(e)) return "";
  return "осталось " + e;
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
async function init() {
  // First, ping the host.
  setHost("host: проверка…", "");
  const ping = await send({ type: "PING_HOST" });
  if (ping.ok) {
    setHost("host: подключён", "ok");
  } else {
    setHost("host: нет", "err");
    setError(ping.error || "Native host не установлен или не отвечает.");
  }

  // Pull current state (active tab + detected streams + any prior result).
  const state = await send({ type: "GET_STATE" });
  if (state.tab) {
    currentPageUrl = state.tab.url || "";
    currentPageTitle = state.tab.title || "";
    els.pageUrl.textContent = currentPageUrl;
    els.pageUrl.title = currentPageUrl;
  }
  // Restore the URL that produced the last analysis — without this, "Скачать"
  // after a popup reopen falls back to the page URL (which yt-dlp can't handle
  // for sites without an extractor, e.g. edu.cyberyozh.com).
  if (state.lastListResultUrl) currentAnalysedUrl = state.lastListResultUrl;
  if (state.streams) renderDetected(state.streams);
  if (state.lastListResult) renderListResult(state.lastListResult);
  if (state.lastProgress) renderProgress(state.lastProgress);
  if (state.lastDone) renderDone(state.lastDone);
  if (state.lastError) setError(state.lastError.message);
}

// ---------------------------------------------------------------------------
// Detected streams (from webRequest + content script).
// ---------------------------------------------------------------------------
function renderDetected(streams) {
  els.detectedList.innerHTML = "";
  if (!streams || streams.length === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "Пока ничего не перехвачено. Запустите воспроизведение видео на странице.";
    els.detectedList.appendChild(e);
    return;
  }
  // Dedupe and prefer manifests first; masters above sub-playlists.
  // media-source:// is a fake scheme this extension used to report for
  // MediaStream sources — it is not a downloadable URL, so drop it along
  // with blob:/data:.
  const seen = new Set();
  const ordered = streams
    .filter((s) => !/^(blob:|data:|media-source:)/i.test(s.url))
    .sort((a, b) => {
      const rank = (s) => (s.master ? 0 : s.type === "playlist" ? 1 : 2);
      return rank(a) - rank(b);
    });
  for (const s of ordered) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);

    const item = document.createElement("div");
    item.className = "detected-item";

    const url = document.createElement("span");
    url.className = "durl";
    url.textContent = prettyUrl(s.url);
    url.title = s.url;

    const tag = document.createElement("span");
    tag.className = "dtype " + (s.master ? "master" : s.type === "playlist" ? "playlist" : "");
    tag.textContent = s.master ? "HLS мастер" : s.type === "playlist" ? "HLS/DASH" : "media";

    const open = document.createElement("a");
    open.className = "open";
    open.textContent = "анализ";
    open.title = "Анализировать этот URL через yt-dlp";
    open.addEventListener("click", (ev) => {
      ev.preventDefault();
      analyse(s.url);
    });

    item.appendChild(url);
    item.appendChild(tag);
    item.appendChild(open);
    els.detectedList.appendChild(item);
  }
  // Remember the first master so the big button auto-uses it.
  const master = ordered.find((s) => s.master);
  currentMasterUrl = master ? master.url : "";
}

function prettyUrl(u) {
  try {
    const x = new URL(u);
    let p = x.pathname;
    if (p.length > 40) p = p.slice(0, 20) + "…" + p.slice(-12);
    return x.host + p + (x.search ? "?…" : "");
  } catch (_) {
    return u;
  }
}

// ---------------------------------------------------------------------------
// Trigger yt-dlp analysis on a URL (default: the page URL).
// ---------------------------------------------------------------------------
async function analyse(url) {
  setError("");
  hide(els.doneBox);
  hide(els.progressBox);
  els.videos.innerHTML = "";
  els.analyseBtn.disabled = true;
  els.analyseBtn.textContent = "Анализ…";
  const target = url || currentPageUrl;
  if (!target) {
    setError("Нет активной вкладки с URL.");
    resetAnalyseBtn();
    return;
  }
  currentAnalysedUrl = target;
  const resp = await send({ type: "ANALYSE_URL", url: target, pageUrl: currentPageUrl });
  if (!resp.ok) {
    setError(resp.error || "Не удалось запустить анализ.");
    resetAnalyseBtn();
  }
}

// ---------------------------------------------------------------------------
// Render yt-dlp format list.
// ---------------------------------------------------------------------------
function renderListResult(result) {
  resetAnalyseBtn();
  if (!result || !result.videos || result.videos.length === 0) {
    setError(
      "Видео не найдено. Возможно, сайт не поддерживается yt-dlp напрямую — попробуйте проанализировать перехваченный поток выше.",
    );
    hide(els.resultBox);
    return;
  }
  setError("");
  els.videoTitle.textContent = result.title || "Без названия";
  els.videoMeta.textContent = result.videos.length + " вариантов";
  if (result.thumb) {
    els.thumb.src = result.thumb;
    show(els.thumb);
  } else {
    hide(els.thumb);
  }
  els.videos.innerHTML = "";
  for (const v of result.videos) {
    const item = document.createElement("div");
    item.className = "video-item";

    const label = document.createElement("div");
    label.className = "vlabel";
    const res = document.createElement("div");
    res.className = "vres";
    res.textContent = v.label;
    const sub = document.createElement("div");
    sub.className = "vsub";
    sub.textContent = v.hasAudio ? "видео + звук" : "только видео";
    label.appendChild(res);
    label.appendChild(sub);

    const btn = document.createElement("button");
    btn.className = "vdload small primary";
    btn.textContent = "Скачать";
    btn.addEventListener("click", () => {
      doDownload(v);
    });

    item.appendChild(label);
    item.appendChild(btn);
    els.videos.appendChild(item);
  }
  show(els.resultBox);
}

// ---------------------------------------------------------------------------
// Download a chosen format.
// ---------------------------------------------------------------------------
async function doDownload(v) {
  setError("");
  hide(els.doneBox);
  cancelNoticed = false;
  els.barFill.style.width = "0%";
  els.progressText.textContent = "Запуск…";
  show(els.progressBox);
  const target = currentAnalysedUrl || currentPageUrl;
  const resp = await send({
    type: "DOWNLOAD",
    url: target,
    pageUrl: currentPageUrl,
    pageTitle: currentPageTitle,
    ytFormat: v.ytFormat,
  });
  if (!resp.ok) {
    setError(resp.error || "Не удалось начать скачивание.");
    hide(els.progressBox);
  }
}

// Set when the user cancels: late PROGRESS broadcasts (already queued in the
// port when the kill landed) must not re-open the progress bar over the
// "Скачивание отменено" notice.
let cancelNoticed = false;

function renderProgress(p) {
  if (cancelNoticed) return;
  show(els.progressBox);
  const pct = parseFloat(String(p.percent).replace("%", "").trim()) || 0;
  els.barFill.style.width = pct + "%";
  els.progressText.textContent = [p.percent, p.speed, prettyEta(p.eta)].filter(Boolean).join(" · ");
}

function renderDone(d) {
  hide(els.progressBox);
  cancelNoticed = false;
  els.doneText.textContent = "Готово! Файл сохранён: " + (d.path || "папка загрузок");
  els.doneText.classList.remove("neutral");
  show(els.doneBox);
}

// ---------------------------------------------------------------------------
// Live host events (broadcast by the worker).
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case "PONG":
      setHost("host: подключён", "ok");
      break;
    case "HOST_DISCONNECTED":
      setHost("host: отключён", "err");
      setError(
        "Соединение с native host разорвано. Перезапустите браузер или переустановите хост.",
      );
      break;
    case "LOG":
      // could surface as hint
      break;
    case "LIST_RESULT":
      if (msg.url) currentAnalysedUrl = msg.url;
      renderListResult(msg);
      break;
    case "PROGRESS":
      renderProgress(msg);
      break;
    case "DONE":
      renderDone(msg);
      break;
    case "ERROR":
      setError(msg.message);
      resetAnalyseBtn();
      hide(els.progressBox);
      break;
    case "KILLED":
      // Cancellation is intentional — surface it as a normal notice, not as
      // an error, and keep it visible (writing into a hidden element would
      // give the user no feedback at all).
      cancelNoticed = true;
      hide(els.progressBox);
      els.doneText.textContent = "Скачивание отменено.";
      els.doneText.classList.add("neutral");
      show(els.doneBox);
      break;
  }
});

// ---------------------------------------------------------------------------
// Wire up buttons.
// ---------------------------------------------------------------------------
// Find-video button: prefer a detected master m3u8 (has audio) over the page
// URL (which yt-dlp often can't handle anyway).
els.analyseBtn.addEventListener("click", () => analyse(currentMasterUrl || currentPageUrl));
els.cancelBtn.addEventListener("click", () => send({ type: "KILL" }));

// Manual URL entry: analyse an arbitrary URL (e.g. a m3u8 copied from DevTools).
function analyseManual() {
  const url = (els.manualUrl.value || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    setError("Введите полный URL, начиная с http(s)://");
    return;
  }
  analyse(url);
}
els.manualBtn.addEventListener("click", analyseManual);
els.manualUrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") analyseManual();
});

init();
