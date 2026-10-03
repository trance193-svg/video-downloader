// ===========================================================================
// Background service worker — Video Downloader.
//
// Responsibilities:
//   1. Intercept media requests on every tab and remember candidate video
//      stream URLs (.m3u8/.mpd/.mp4/.ts/.webm) keyed by tabId.
//   2. Maintain a persistent connection to the native messaging host and
//      route messages between popup <-> host.
//   3. Answer popup queries: list detected streams for the active tab, let
//      the user trigger LIST (ask host to analyse URL via yt-dlp) or
//      DOWNLOAD, and show progress.
//
// Notes:
//   - MV3 service workers can be killed; we persist detected streams in
//     chrome.storage.session so state survives worker restarts.
//   - webRequest is used for observation only (we do NOT block).
// ===========================================================================

const HOST_NAME = "com.videodownloader.host";

// Media-ish URL patterns we care about.
const MEDIA_RE = /\.(m3u8|mpd|mp4|webm|m4v|ts|mov|mkv|flv|avi|m4a|mp3|ogg)(\?|$)/i;
// These look like HLS/DASH manifests specifically.
const PLAYLIST_RE = /\.(m3u8|mpd)(\?|$)/i;

// Native messaging port to the local host. Spawned lazily by ensureHost().
let hostPort = null;

// Resolver for the PING_HOST round-trip (see pingHostWithTimeout below).
let pingWaiter = null;

// ---------------------------------------------------------------------------
// Stream detection via webRequest (observer only).
// ---------------------------------------------------------------------------
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!details || details.tabId < 0) return;
    const url = details.url;
    if (!MEDIA_RE.test(url)) return;
    const isPlaylist = PLAYLIST_RE.test(url);
    const stream = {
      url,
      type: isPlaylist ? "playlist" : "media",
      // A master m3u8 (e.g. Vimeo "playlist.m3u8") lists video variants AND
      // the audio track; a sub-playlist like "media.m3u8" is video-only.
      // Marking masters lets the popup prefer them — downloading a sub gives
      // a silent file.
      master: isPlaylist && /\/(playlist|master)\.m3u8(\?|$)/i.test(url),
      contentType: details.type || null,
      frameUrl: details.initiator || null,
      ts: Date.now(),
    };
    addStreamToTab(details.tabId, stream).catch(() => {});
    // Update badge count.
    updateBadge(details.tabId);
  },
  { urls: ["<all_urls>"] },
  []
);

async function addStreamToTab(tabId, stream) {
  const key = "tab_" + tabId;
  const data = await chrome.storage.session.get(key);
  const list = data[key] || [];
  // Dedupe by URL.
  if (list.some((s) => s.url === stream.url)) return;
  list.push(stream);
  // Keep manifests (m3u8/mpd) — they're the master playlists yt-dlp needs —
  // but drop the flood of per-segment .ts/.mp4 fragment requests that would
  // otherwise evict the manifest from the capped window. Then cap to 50,
  // always preserving every manifest at the top.
  const playlists = list.filter((s) => s.type === "playlist");
  const media = list
    .filter((s) => s.type !== "playlist")
    .filter((s) => /\.(mp4|webm|mkv|mov|flv|avi)/i.test(s.url));
  // Cap playlists too — some sites emit a unique manifest URL per quality or
  // per expiring token, which would otherwise grow without bound.
  const kept = [...playlists.slice(-20), ...media.slice(-50)];
  await chrome.storage.session.set({ [key]: kept });
}

async function updateBadge(tabId) {
  try {
    const key = "tab_" + tabId;
    const data = await chrome.storage.session.get(key);
    const list = data[key] || [];
    // Count only "interesting" streams (manifests + direct media), not every .ts.
    const count = list.filter(
      (s) => s.type === "playlist" || /\.(mp4|webm|mkv|mov|flv|avi)/i.test(s.url)
    ).length;
    const text = count > 0 ? String(count) : "";
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d92e2e" });
  } catch (_) {}
}

// Clean up when a tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove("tab_" + tabId).catch(() => {});
});

// Reset detection on navigation to a new document. Update the badge only
// after the stored list is actually gone, otherwise it can read stale data.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    chrome.storage.session
      .remove("tab_" + tabId)
      .then(() => updateBadge(tabId))
      .catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Native host connection management.
// ---------------------------------------------------------------------------
function ensureHost() {
  if (hostPort) return hostPort;
  try {
    hostPort = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    hostPort = null;
    return null;
  }
  hostPort.onMessage.addListener((msg) => {
    // Broadcast to any listening popup; also stash last LIST_RESULT.
    if (msg && msg.type) {
      handleHostMessage(msg);
    }
  });
  hostPort.onDisconnect.addListener(() => {
    hostPort = null;
    stopKeepAlive();
    // Resolve a pending PING as failed so the popup doesn't hang for the
    // full timeout when the host process dies immediately.
    if (pingWaiter) {
      pingWaiter({ ok: false, error: "host отключился сразу после запуска" });
      pingWaiter = null;
    }
    // Notify popup if open.
    broadcastToPopups({ type: "HOST_DISCONNECTED" });
  });
  return hostPort;
}

// ---------------------------------------------------------------------------
// UI state (last analysis result / progress / error) — mirrored into
// chrome.storage.session so a freshly restarted service worker can answer
// GET_STATE with the previous job's outcome instead of an empty screen.
// ---------------------------------------------------------------------------
let lastListResult = null; // { title, thumb, videos, source }
let lastListResultUrl = null; // URL that produced lastListResult (so download uses it after popup reopen)
let lastProgress = null;
let lastLog = null;
let lastError = null;
let lastDone = null;

const UI_STATE_KEYS = [
  "lastListResult",
  "lastListResultUrl",
  "lastProgress",
  "lastLog",
  "lastError",
  "lastDone",
];
let uiStateLoaded = null;

function loadUiState() {
  if (!uiStateLoaded) {
    uiStateLoaded = (async () => {
      try {
        const data = await chrome.storage.session.get(
          UI_STATE_KEYS.map((k) => "ui_" + k)
        );
        for (const k of UI_STATE_KEYS) {
          const v = data["ui_" + k];
          if (v === undefined) continue;
          if (k === "lastListResult") lastListResult = v;
          else if (k === "lastListResultUrl") lastListResultUrl = v;
          else if (k === "lastProgress") lastProgress = v;
          else if (k === "lastLog") lastLog = v;
          else if (k === "lastError") lastError = v;
          else if (k === "lastDone") lastDone = v;
        }
      } catch (_) {}
    })();
  }
  return uiStateLoaded;
}

function saveUiState(key, value) {
  chrome.storage.session.set({ ["ui_" + key]: value }).catch(() => {});
}

function handleHostMessage(msg) {
  switch (msg.type) {
    case "PONG":
      if (pingWaiter) {
        pingWaiter({ ok: true, version: msg.version });
        pingWaiter = null;
      }
      broadcastToPopups({ type: "PONG", version: msg.version });
      break;
    case "LOG":
      lastLog = msg;
      saveUiState("lastLog", msg);
      // "Начинаю скачивание…" / "Анализирую ссылку…" from the host marks the
      // start of a long-running job — arm the keep-alive so the SW survives.
      if (msg.level === "info") startKeepAlive();
      broadcastToPopups({ type: "LOG", message: msg.message, level: msg.level });
      break;
    case "LIST_RESULT":
      lastListResult = msg;
      saveUiState("lastListResult", msg);
      broadcastToPopups({ type: "LIST_RESULT", title: msg.title, thumb: msg.thumb, videos: msg.videos, url: lastListResultUrl });
      break;
    case "PROGRESS":
      lastProgress = msg;
      saveUiState("lastProgress", msg);
      broadcastToPopups({ type: "PROGRESS", percent: msg.percent, speed: msg.speed, eta: msg.eta });
      break;
    case "DONE":
      lastDone = msg;
      saveUiState("lastDone", msg);
      stopKeepAlive();
      broadcastToPopups({ type: "DONE", path: msg.path });
      break;
    case "ERROR":
      lastError = msg;
      saveUiState("lastError", msg);
      stopKeepAlive();
      broadcastToPopups({ type: "ERROR", message: msg.message });
      break;
    case "KILLED":
      stopKeepAlive();
      broadcastToPopups({ type: "KILLED" });
      break;
  }
}

// ---------------------------------------------------------------------------
// Popup <-> worker messaging.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages from content scripts arrive with a sender.tab.
  if (msg && msg.type === "CONTENT_FOUND" && sender && sender.tab) {
    const stream = {
      url: msg.url,
      type: PLAYLIST_RE.test(msg.url) ? "playlist" : "media",
      master: PLAYLIST_RE.test(msg.url) && /\/(playlist|master)\.m3u8(\?|$)/i.test(msg.url),
      contentType: null,
      frameUrl: msg.frameUrl || null,
      source: msg.source || "content",
      ts: Date.now(),
    };
    addStreamToTab(sender.tab.id, stream).then(() => updateBadge(sender.tab.id));
    return; // no response needed
  }

  (async () => {
    switch (msg && msg.type) {
      case "PING_HOST": {
        const port = ensureHost();
        if (!port) {
          sendResponse({ ok: false, error: "Не удалось подключиться к native host. Установите его (host/install_host.js)." });
          return;
        }
        // Honest round-trip: reply only after the host actually answers PONG
        // (or on timeout/disconnect). connectNative() alone does not fail
        // synchronously when the host is missing — the error arrives via
        // onDisconnect, which resolves the waiter below.
        const result = await new Promise((resolve) => {
          pingWaiter = resolve;
          port.postMessage({ command: "PING" });
          setTimeout(() => {
            if (pingWaiter === resolve) {
              pingWaiter = null;
              resolve({ ok: false, error: "host не отвечает (не установлен или не запускается)" });
            }
          }, 3000);
        });
        sendResponse(result);
        return;
      }
      case "GET_STATE": {
        await loadUiState();
        const tab = await getActiveTab();
        const streams = tab ? await getStreams(tab.id) : [];
        sendResponse({
          ok: true,
          tab,
          streams,
          lastListResult,
          lastListResultUrl,
          lastProgress,
          lastLog,
          lastError,
          lastDone,
        });
        return;
      }
      case "ANALYSE_URL": {
        // Ask host to run yt-dlp -J on the URL.
        const port = ensureHost();
        if (!port) {
          sendResponse({ ok: false, error: "native host недоступен" });
          return;
        }
        lastError = null;
        lastListResult = null;
        lastListResultUrl = msg.url;
        saveUiState("lastError", null);
        saveUiState("lastListResult", null);
        saveUiState("lastListResultUrl", msg.url);
        port.postMessage({
          command: "LIST",
          url: msg.url,
          pageUrl: msg.pageUrl || "",
        });
        sendResponse({ ok: true });
        return;
      }
      case "DOWNLOAD": {
        const port = ensureHost();
        if (!port) {
          sendResponse({ ok: false, error: "native host недоступен" });
          return;
        }
        lastError = null;
        lastDone = null;
        lastProgress = null;
        saveUiState("lastError", null);
        saveUiState("lastDone", null);
        saveUiState("lastProgress", null);
        port.postMessage({
          command: "DOWNLOAD",
          url: msg.url,
          pageUrl: msg.pageUrl || "",
          pageTitle: msg.pageTitle || "",
          ytFormat: msg.ytFormat || "bestvideo*+bestaudio/best",
          outdir: msg.outdir || "",
        });
        sendResponse({ ok: true });
        return;
      }
      case "KILL": {
        const port = ensureHost();
        if (port) port.postMessage({ command: "KILL" });
        sendResponse({ ok: true });
        return;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async
});

// Broadcast to any popup listening (popup uses runtime.onMessage).
function broadcastToPopups(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // No popup open — ignore.
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getStreams(tabId) {
  const data = await chrome.storage.session.get("tab_" + tabId);
  return data["tab_" + tabId] || [];
}

// ---------------------------------------------------------------------------
// Service-worker keep-alive (MV3 workers are killed after ~30 s of inactivity).
// We use a repeating alarm that fires every 20 s while a download/analysis is
// in progress, calling a cheap API to reset Chrome's idle timer.
// ---------------------------------------------------------------------------
let _keepAliveRunning = false;

function startKeepAlive() {
  if (_keepAliveRunning) return;
  _keepAliveRunning = true;
  // Chrome clamps alarm periods below 30 s up to 30 s — ask for 30 s directly.
  chrome.alarms.create("swKeepAlive", { periodInMinutes: 0.5 });
}

function stopKeepAlive() {
  if (!_keepAliveRunning) return;
  _keepAliveRunning = false;
  chrome.alarms.clear("swKeepAlive");
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "swKeepAlive") {
    chrome.runtime.getPlatformInfo(() => {});
  }
});

// On install/startup, try to ping host so disconnects surface early.
chrome.runtime.onInstalled.addListener(() => {
  // nothing heavy; host connects on demand.
});
