// ===========================================================================
// Content script — Video Downloader.
//
// Runs on every page (all_frames). Scans the DOM for <video>, <source>,
// <iframe>, and <object>/<embed> elements, extracts candidate video URLs,
// and reports them to the background worker so they show up in the popup
// alongside the streams caught by webRequest.
//
// Also patches HTMLMediaElement.prototype to capture src assignments made
// in JS (many custom players set video.src programmatically rather than in
// the markup) — this catches Vimeo's player.vimeo.com URLs, blob: URLs, etc.
// ===========================================================================

(function () {
  "use strict";

  const MEDIA_EXT_RE = /\.(m3u8|mpd|mp4|webm|m4v|ts|mov|mkv|flv|avi|m4a|mp3|ogg)(\?|$)/i;

  function report(url, source) {
    if (!url || url === "about:blank") return;
    // Skip data: URIs that are tiny — not downloadable streams.
    if (url.startsWith("data:") && url.length < 1024) return;
    try {
      chrome.runtime.sendMessage({
        type: "CONTENT_FOUND",
        url,
        source,
        pageUrl: location.href,
        frameUrl: location.href,
      });
    } catch (_) {
      // service worker may be asleep; ignore.
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
      if (f.src && /player\.(vimeo|youtube)\.com|youtube\.com\/embed|dailymotion\.com\/embed|vk\.com\/video_ext|rutube\.ru\/play/i.test(f.src)) {
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

  // --- Patch HTMLMediaElement to catch JS-set src / blob URLs ---------
  const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
  if (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, "src");
    try {
      Object.defineProperty(proto, "src", {
        configurable: true,
        enumerable: desc ? desc.enumerable : true,
        get: desc ? desc.get : function () { return this.getAttribute("src"); },
        set: function (v) {
          if (typeof v === "string" && v && !v.startsWith("blob:")) {
            report(v, "mediaElement.src.set");
          } else if (typeof v === "string" && v.startsWith("blob:")) {
            // blob: URLs aren't directly downloadable, but record them so
            // the user sees *something* was detected. Real stream URL is
            // usually caught by webRequest on the underlying requests.
            report(v, "mediaElement.blob");
          }
          if (desc && desc.set) desc.set.call(this, v);
          else this.setAttribute("src", v);
        },
      });
    } catch (_) {}

    // Also capture load() calls with an argument-less approach: patch
    // srcObject for MediaSource usage.
    const srcObjDesc = Object.getOwnPropertyDescriptor(proto, "srcObject");
    if (srcObjDesc) {
      try {
        Object.defineProperty(proto, "srcObject", {
          configurable: true,
          enumerable: srcObjDesc.enumerable,
          get: srcObjDesc.get,
          set: function (v) {
            if (v) report("media-source://" + (location.href), "mediaElement.srcObject");
            srcObjDesc.set.call(this, v);
          },
        });
      } catch (_) {}
    }
  }

  // --- Listen for dynamically inserted video elements ----------------
  const obs = new MutationObserver(() => scanDOM());
  try {
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  // Run scans: immediately, after idle, and periodically for lazy players.
  scanDOM();
  setTimeout(scanDOM, 1500);
  setTimeout(scanDOM, 4000);
  setInterval(scanDOM, 8000);
})();
