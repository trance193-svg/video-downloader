// ===========================================================================
// Popup logic — Video Downloader.
//
// Talks to the background service worker via chrome.runtime.sendMessage and
// listens for broadcast messages (host events). Renders:
//   - host connection status
//   - the current page URL + an "Analyse" button (runs yt-dlp via host)
//   - the list of formats yt-dlp found, each with a download button
//   - streams detected on the page by webRequest / content script
//   - download progress + cancel
//
// All user-facing strings come from _locales/<lang>/messages.json via
// chrome.i18n; elements opt in with data-i18n / data-i18n-placeholder /
// data-i18n-aria attributes.
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
  progressBar: $("progressBar"),
  barFill: $("barFill"),
  progressText: $("progressText"),
  cancelBtn: $("cancelBtn"),
  doneBox: $("doneBox"),
  doneText: $("doneText"),
  errorBox: $("errorBox"),
  errorText: $("errorText"),
  manualUrl: $("manualUrl"),
  manualBtn: $("manualBtn"),
  optionsBtn: $("optionsBtn"),
  setupBox: $("setupBox"),
  setupDownloadBtn: $("setupDownloadBtn"),
  setupVerifyBtn: $("setupVerifyBtn"),
};

// Where the "one button" host package lives (GitHub Releases asset produced
// by tools/build.js). If the release is missing, the wizard explains the
// package is not published yet.
const HOST_PACKAGE_URL =
  "https://github.com/trance193-svg/video-downloader/releases/latest/download/VideoDownloader-host-win64.zip";

let currentPageUrl = "";
let currentPageTitle = ""; // active tab <title> — used as the download filename
let currentAnalysedUrl = ""; // the URL actually passed to yt-dlp (may differ from page URL)
let currentStreamUrl = ""; // best detected stream (freshest master) — preferred over page URL

// ---------------------------------------------------------------------------
// i18n.
// ---------------------------------------------------------------------------
function msg(key, params) {
  return params === undefined
    ? chrome.i18n.getMessage(key)
    : chrome.i18n.getMessage(key, params.map ? params.map(String) : [String(params)]);
}

// Host/background messages may carry a translation key + params; the raw
// text is the fallback (e.g. yt-dlp stderr passthrough).
function translateMsg(m) {
  if (m && m.key) {
    const t = m.params
      ? chrome.i18n.getMessage(m.key, m.params.map(String))
      : chrome.i18n.getMessage(m.key);
    if (t) return t;
  }
  return (m && m.message) || "";
}

function applyI18n() {
  document.documentElement.lang = (chrome.i18n.getUILanguage() || "ru").slice(0, 2);
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = msg(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = msg(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", msg(el.dataset.i18nAria));
  });
}

// ---------------------------------------------------------------------------
function send(toSend) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(toSend, (resp) => resolve(resp || {}));
  });
}

function setHost(status, cls) {
  els.hostStatus.textContent = status;
  els.hostStatus.className = "status " + (cls || "");
  els.hostStatus.title = status;
}

function show(el) {
  el.classList.remove("hidden");
}
function hide(el) {
  el.classList.add("hidden");
}

function setError(text) {
  if (!text) {
    hide(els.errorBox);
    return;
  }
  els.errorText.textContent = text;
  show(els.errorBox);
}

function resetAnalyseBtn() {
  els.analyseBtn.disabled = false;
  els.analyseBtn.textContent = msg("findVideoBtn");
}

// yt-dlp reports "Unknown"/"NA" when it can't estimate — don't show that.
function prettyEta(eta) {
  const e = String(eta || "").trim();
  if (!e || /^(unknown|na|n\/a)$/i.test(e)) return "";
  return msg("etaPrefix", [e]);
}

// ---------------------------------------------------------------------------
// First-run setup wizard (shown when the native host is not reachable).
// ---------------------------------------------------------------------------
function showSetup() {
  show(els.setupBox);
}

function hideSetup() {
  hide(els.setupBox);
}

async function pingHost() {
  setHost(msg("hostChecking"), "");
  const ping = await send({ type: "PING_HOST" });
  if (ping.ok) {
    setHost(msg("hostOk"), "ok");
    hideSetup();
    setError("");
  } else {
    setHost(msg("hostDown"), "err");
    showSetup();
    setError(ping.error || msg("hostConnFailed"));
  }
  return ping.ok;
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
async function init() {
  applyI18n();

  // First, ping the host — a failed ping opens the setup wizard.
  await pingHost();

  // Pull current state (active tab + detected streams + any prior result).
  const state = await send({ type: "GET_STATE" });
  if (state.tab) {
    currentPageUrl = state.tab.url || "";
    currentPageTitle = state.tab.title || "";
    els.pageUrl.textContent = currentPageUrl;
    els.pageUrl.title = currentPageUrl;
  }
  renderDetected(state.streams || []);

  // A saved analysis belongs to the video it was made on. Restoring it on a
  // different page made "Скачать" silently reuse the previous video's URL —
  // the "it downloads the same video again" report. Restore it only when it
  // was produced from the URL we would analyse right now.
  const candidate = currentStreamUrl || currentPageUrl;
  const resultFresh = !!state.lastListResultUrl && state.lastListResultUrl === candidate;
  if (resultFresh) {
    currentAnalysedUrl = state.lastListResultUrl;
    if (state.lastListResult) renderListResult(state.lastListResult);
    if (state.lastDone) renderDone(state.lastDone);
    if (state.lastError) setError(translateMsg(state.lastError));
  }
  // Live job feedback stays regardless of the page — a running download can
  // (and should) be visible so it can be cancelled.
  if (state.lastProgress) renderProgress(state.lastProgress);
}

// ---------------------------------------------------------------------------
// Detected streams (from webRequest + content script).
// ---------------------------------------------------------------------------
// The list itself is not shown: pages often produce several look-alike master
// playlists, and picking among near-identical rows only confuses. The main
// "Найти видео" button analyses the single best candidate — the most recently
// requested master playlist (falling back to any manifest, then a media
// file). The section appears only to say nothing was detected yet.
function bestDetectedStream(streams) {
  return (
    (streams || [])
      .filter((s) => !/^(blob:|data:|media-source:)/i.test(s.url))
      .sort((a, b) => {
        const rank = (s) => (s.master ? 0 : s.type === "playlist" ? 1 : 2);
        return rank(a) - rank(b) || (b.ts || 0) - (a.ts || 0);
      })[0] || null
  );
}

function renderDetected(streams) {
  const best = bestDetectedStream(streams);
  if (!best) {
    currentStreamUrl = "";
    els.detectedList.innerHTML = "";
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = msg("emptyDetected");
    els.detectedList.appendChild(e);
    show(els.detectedBox);
    return;
  }
  currentStreamUrl = best.url;
  hide(els.detectedBox);
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
  els.analyseBtn.textContent = msg("analysingBtn");
  const target = url || currentPageUrl;
  if (!target) {
    setError(msg("noActiveTab"));
    resetAnalyseBtn();
    return;
  }
  currentAnalysedUrl = target;
  const resp = await send({ type: "ANALYSE_URL", url: target, pageUrl: currentPageUrl });
  if (!resp.ok) {
    setError(resp.error || msg("analyseFailed"));
    resetAnalyseBtn();
  }
}

// ---------------------------------------------------------------------------
// Render yt-dlp format list.
// ---------------------------------------------------------------------------
// Label is composed from structured fields the host now sends (kind/height/
// fps/ext) so it can be localized; the host's own label is the fallback.
function formatLabel(v) {
  if (v.kind === "best" || v.id === "best" || v.ytFormat === "bestvideo*+bestaudio/best") {
    return v.height > 0 ? msg("bestWithAudioH", [v.height]) : msg("bestWithAudio");
  }
  const h = v.height ? v.height + "p" : "?";
  const fps = v.fps ? "@" + v.fps : "";
  const ext = v.ext ? " · " + v.ext : "";
  return `${h}${fps}${ext}`;
}

function formatSub(v) {
  const kind =
    v.kind || (String(v.ytFormat || "").includes("+bestaudio") ? "video-only" : "progressive");
  if (kind === "best") return "";
  return kind === "video-only" ? msg("subMerged") : msg("subSingle");
}

function renderListResult(result) {
  resetAnalyseBtn();
  if (!result || !result.videos || result.videos.length === 0) {
    setError(msg("notFound"));
    hide(els.resultBox);
    return;
  }
  setError("");
  els.videoTitle.textContent = result.title || msg("noTitle");
  els.videoMeta.textContent = msg("variants", [result.videos.length]);
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
    res.textContent = formatLabel(v);
    const sub = document.createElement("div");
    sub.className = "vsub";
    sub.textContent = formatSub(v);
    label.appendChild(res);
    if (sub.textContent) label.appendChild(sub);

    const btn = document.createElement("button");
    btn.className = "vdload small primary";
    btn.textContent = msg("downloadBtn");
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
  els.progressBar.setAttribute("aria-valuenow", "0");
  els.progressText.textContent = msg("starting");
  show(els.progressBox);
  // Honor the "maximum quality" preference for the generic "best" entry.
  let ytFormat = v.ytFormat;
  if ((v.kind === "best" || v.id === "best") && prefs.maxHeight > 0) {
    const h = prefs.maxHeight;
    ytFormat = `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
  }
  const target = currentAnalysedUrl || currentPageUrl;
  const resp = await send({
    type: "DOWNLOAD",
    url: target,
    pageUrl: currentPageUrl,
    pageTitle: currentPageTitle,
    ytFormat,
  });
  if (!resp.ok) {
    setError(resp.error || msg("downloadFailed"));
    hide(els.progressBox);
  }
}

// User preferences loaded once per popup open (options page edits them).
let prefs = { maxHeight: 0, frag: 4, outdirName: "VideoDownloader" };

function renderProgress(p) {
  if (cancelNoticed) return;
  show(els.progressBox);
  const pct = parseFloat(String(p.percent).replace("%", "").trim()) || 0;
  els.barFill.style.width = pct + "%";
  els.progressBar.setAttribute("aria-valuenow", String(Math.round(pct)));
  els.progressText.textContent = [p.percent, p.speed, prettyEta(p.eta)].filter(Boolean).join(" · ");
}

function renderDone(d) {
  hide(els.progressBox);
  cancelNoticed = false;
  els.doneText.textContent = msg("donePrefix", [d.path || msg("doneFolder")]);
  els.doneText.classList.remove("neutral");
  show(els.doneBox);
}

// ---------------------------------------------------------------------------
// Live host events (broadcast by the worker).
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((m) => {
  if (!m || !m.type) return;
  switch (m.type) {
    case "PONG":
      setHost(msg("hostOk"), "ok");
      break;
    case "HOST_DISCONNECTED":
      setHost(msg("hostOff"), "err");
      setError(msg("hostDisconnectedMsg"));
      break;
    case "LOG":
      // informational hint — currently surfaced via progress text only
      break;
    case "LIST_RESULT":
      if (m.url) currentAnalysedUrl = m.url;
      renderListResult(m);
      break;
    case "PROGRESS":
      renderProgress(m);
      break;
    case "DONE":
      renderDone(m);
      break;
    case "ERROR":
      setError(translateMsg(m));
      resetAnalyseBtn();
      hide(els.progressBox);
      break;
    case "KILLED":
      // Cancellation is intentional — surface it as a normal notice, not as
      // an error, and keep it visible (writing into a hidden element would
      // give the user no feedback at all).
      cancelNoticed = true;
      hide(els.progressBox);
      els.doneText.textContent = msg("cancelled");
      els.doneText.classList.add("neutral");
      show(els.doneBox);
      break;
  }
});

// Set when the user cancels: late PROGRESS broadcasts (already queued in the
// port when the kill landed) must not re-open the progress bar over the
// "Скачивание отменено" notice.
let cancelNoticed = false;

// ---------------------------------------------------------------------------
// Wire up buttons.
// ---------------------------------------------------------------------------
// Find-video button: prefer a detected master m3u8 (has audio) over the page
// URL (which yt-dlp often can't handle anyway).
els.analyseBtn.addEventListener("click", () => analyse(currentStreamUrl || currentPageUrl));
els.cancelBtn.addEventListener("click", () => send({ type: "KILL" }));
els.optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

// Setup wizard: download the host package, then re-check the connection.
els.setupDownloadBtn.addEventListener("click", () => {
  chrome.downloads.download({ url: HOST_PACKAGE_URL }, () => {
    void chrome.runtime.lastError; // download failures are visible in the shelf
  });
});
els.setupVerifyBtn.addEventListener("click", () => {
  pingHost();
});

// Manual URL entry: analyse an arbitrary URL (e.g. a m3u8 copied from DevTools).
function analyseManual() {
  const url = (els.manualUrl.value || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    setError(msg("badManualUrl"));
    return;
  }
  analyse(url);
}
els.manualBtn.addEventListener("click", analyseManual);
els.manualUrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") analyseManual();
});

chrome.storage.sync.get({ maxHeight: 0, frag: 4, outdirName: "VideoDownloader" }).then((p) => {
  prefs = p;
});

init();
