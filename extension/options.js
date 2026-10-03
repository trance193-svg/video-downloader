// Options page — Video Downloader.
// Stores user preferences in chrome.storage.sync:
//   outdirName — subfolder inside the user's Downloads folder
//   maxHeight  — 0 = best available, else cap in pixels (1080, 720, …)
//   frag       — yt-dlp --concurrent-fragments for HLS downloads

const QUALITY_CHOICES = [0, 2160, 1440, 1080, 720, 480, 360];

function msg(key, param) {
  return param === undefined
    ? chrome.i18n.getMessage(key)
    : chrome.i18n.getMessage(key, [String(param)]);
}

function applyI18n() {
  document.documentElement.lang = chrome.i18n.getUILanguage().slice(0, 2);
  document.title = msg("optTitle");
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = msg(el.dataset.i18n);
  });
}

function fillQualitySelect(current) {
  const sel = document.getElementById("maxHeight");
  sel.innerHTML = "";
  for (const h of QUALITY_CHOICES) {
    const o = document.createElement("option");
    o.value = String(h);
    o.textContent = h === 0 ? msg("optQualityBest") : msg("optQualityH", h);
    if (h === current) o.selected = true;
    sel.appendChild(o);
  }
}

async function load() {
  applyI18n();
  const prefs = await chrome.storage.sync.get({
    outdirName: "VideoDownloader",
    maxHeight: 0,
    frag: 4,
  });
  document.getElementById("outdirName").value = prefs.outdirName || "";
  fillQualitySelect(Number(prefs.maxHeight) || 0);
  document.getElementById("frag").value = prefs.frag || 4;
}

async function save() {
  const outdirName = document.getElementById("outdirName").value.trim();
  const maxHeight = Number(document.getElementById("maxHeight").value) || 0;
  const frag = Math.min(16, Math.max(1, Number(document.getElementById("frag").value) || 4));
  await chrome.storage.sync.set({ outdirName, maxHeight, frag });
  const note = document.getElementById("savedNote");
  note.classList.remove("hidden");
  setTimeout(() => note.classList.add("hidden"), 2000);
}

document.getElementById("saveBtn").addEventListener("click", save);
load();
