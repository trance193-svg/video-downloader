// ===========================================================================
// Content script — Video Downloader.
//
// Runs on every page (all_frames). Scans the DOM for <video>, <source>,
// <iframe>, and <object>/<embed> elements, extracts candidate video URLs,
// and reports them to the background worker so they show up in the popup
// alongside the streams caught by webRequest.
//
// NOTE: this script intentionally does NOT patch HTMLMediaElement. Content
// scripts run in an isolated world, so redefining prototype properties here
// only intercepts assignments made by the content script itself — page JS
// (custom players setting video.src, blob: URLs) is unaffected. Real stream
// URLs are captured by the background worker's webRequest observer anyway.
//
// PERFORMANCE: MutationObserver callbacks are debounced and the periodic
// rescan is short — a full querySelectorAll sweep on every DOM mutation
// would burn CPU on heavy SPA pages.
// ===========================================================================

(function () {
  "use strict";

  // Keep in sync with MEDIA_RE in background.js.
  const MEDIA_EXT_RE = /\.(m3u8|mpd|mp4|webm|m4v|ts|mov|mkv|flv|avi|m4a|mp3|ogg)(\?|$)/i;

  function report(url, source) {
    if (!url || url === "about:blank") return;
    // Skip data: URIs that are tiny — not downloadable streams.
    if (url.startsWith("data:") && url.length < 1024) return;
    try {
      const p = chrome.runtime.sendMessage({
        type: "CONTENT_FOUND",
        url,
        source,
        pageUrl: location.href,
        frameUrl: location.href,
      });
      if (p && p.catch) p.catch(() => {}); // service worker may be asleep
    } catch (_) {
      // extension context gone (e.g. after update) — ignore.
    }
  }

  function scanDOM() {
    // <video src> and <video><source>
    document.querySelectorAll("video").forEach((v) => {
      if (v.src) report(v.src, "video.src");
      if (v.currentSrc) report(v.currentSrc, "video.currentSrc");
      v.querySelectorAll("source").forEach((s) => {
        if (s.src) report(s.src, "source.src");
      });
    });
    // <audio> too (podcasts etc.)
    document.querySelectorAll("audio").forEach((a) => {
      if (a.src) report(a.src, "audio.src");
      a.querySelectorAll("source").forEach((s) => {
        if (s.src) report(s.src, "source.src");
      });
    });
    // iframes — Vimeo embeds live here; the background will catch their
    // network requests anyway, but we surface the embed URL as a hint.
    document.querySelectorAll("iframe").forEach((f) => {
      if (
        f.src &&
        /player\.(vimeo|youtube)\.com|youtube\.com\/embed|dailymotion\.com\/embed|vk\.com\/video_ext|rutube\.ru\/play/i.test(
          f.src,
        )
      ) {
        report(f.src, "iframe.embed");
      }
    });
    // <object>/<embed>
    document.querySelectorAll("object[data], embed[src]").forEach((e) => {
      const u = e.getAttribute("data") || e.getAttribute("src");
      if (u) report(u, "object/embed");
    });
    // <a href> pointing directly at media
    document.querySelectorAll("a[href]").forEach((a) => {
      if (MEDIA_EXT_RE.test(a.href)) report(a.href, "a.href");
    });
  }

  // --- Listen for dynamically inserted video elements ----------------
  // Debounce: coalesce bursts of mutations (SPA renders mutate the DOM
  // hundreds of times) into one scan per 500 ms window.
  let scanTimer = 0;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scanDOM();
    }, 500);
  }
  const obs = new MutationObserver(scheduleScan);
  try {
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  // Run scans: immediately, after idle, then periodically for lazy players.
  scanDOM();
  setTimeout(scanDOM, 1500);
  setTimeout(scanDOM, 4000);
  setInterval(scanDOM, 8000);
})();
