#!/usr/bin/env node
"use strict";

// ===========================================================================
// fetch_deps.js — downloads standalone yt-dlp.exe and ffmpeg into host/bin
// so the native host works with NO Python and NO system-wide installs.
//
// Strategy:
//   yt-dlp: grab the latest release .exe from the yt-dlp GitHub releases
//           (asset: yt-dlp.exe). We resolve "latest" via the GitHub API.
//   ffmpeg: grab a small static build. We use the well-known
//           "BtbN/FFmpeg-Builds" win64 gpl shared zip... but to keep it
//           simple and dependency-free we instead fetch ffmpeg from the
//           gyan.dev static essentials zip and extract only ffmpeg.exe.
//
// If the downloads fail (network, mirror change), the script prints clear
// instructions on where to get the binaries manually and where to put them.
//
// Run:  node fetch_deps.js
// ===========================================================================

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const HERE = path.join(__dirname, "..", "host");
const BIN = path.join(HERE, "bin");
fs.mkdirSync(BIN, { recursive: true });

function httpGet(url, { headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error("too many redirects"));
    const u = new URL(url);
    const opts = {
      method: "GET",
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { "User-Agent": "video-downloader-setup", ...headers },
    };
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(httpGet(next, { headers, redirects: redirects + 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode + " for " + url));
      }
      resolve(res);
    });
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("timeout " + url)));
    req.end();
  });
}

function downloadTo(url, dest) {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await httpGet(url);
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let got = 0;
      const tmp = dest + ".part";
      const out = fs.createWriteStream(tmp);
      res.on("data", (d) => {
        got += d.length;
        if (total) process.stdout.write(`\r  ${path.basename(dest)}: ${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB`);
      });
      res.pipe(out);
      out.on("finish", () => {
        out.close(() => {
          fs.renameSync(tmp, dest);
          process.stdout.write("\n");
          resolve(dest);
        });
      });
      out.on("error", reject);
    } catch (e) { reject(e); }
  });
}

function getJSON(url) {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await httpGet(url, { headers: { Accept: "application/vnd.github+json" } });
      let data = "";
      for await (const chunk of res) data += chunk;
      resolve(JSON.parse(data));
    } catch (e) { reject(e); }
  });
}

// --- Minimal ZIP reader (stored + deflate) for extracting ffmpeg.exe ----
// We avoid a zip dependency by implementing enough of the ZIP format to
// extract a single file. PKZIP entries use either stored (0) or deflate (8)
// compression; gyan.dev essentials builds use deflate. We implement inflate
// via Node's built-in zlib (require('zlib').inflateRawSync).
function extractFromZip(zipPath, entryName, destPath) {
  const zlib = require("zlib");
  const buf = fs.readFileSync(zipPath);
  // Find central directory via EOCD signature 0x06054b50
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65557; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("EOCD not found in zip");
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdCount = buf.readUInt16LE(eocd + 10);
  let off = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central dir entry");
    const compMethod = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    // Match by basename
    const base = name.split("/").pop();
    if (base.toLowerCase() === entryName.toLowerCase()) {
      // Read local file header
      const lhNameLen = buf.readUInt16LE(localOff + 26);
      const lhExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
      const compData = buf.subarray(dataStart, dataStart + compSize);
      let raw;
      if (compMethod === 0) raw = compData;
      else if (compMethod === 8) raw = zlib.inflateRawSync(compData);
      else throw new Error("Unsupported zip compression method: " + compMethod);
      fs.writeFileSync(destPath, raw);
      return uncompSize;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("Entry " + entryName + " not found in zip");
}

async function fetchYtDlp() {
  const dest = path.join(BIN, "yt-dlp.exe");
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000000) {
    console.log("yt-dlp.exe уже есть, пропускаю. (удалите, чтобы обновить)");
    return;
  }
  console.log("\n[1/2] Скачиваю yt-dlp.exe (последний релиз)…");
  try {
    const rel = await getJSON("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest");
    const asset = (rel.assets || []).find((a) => a.name.toLowerCase() === "yt-dlp.exe");
    if (!asset) throw new Error("yt-dlp.exe asset not found in latest release");
    console.log("  Версия: " + rel.tag_name);
    await downloadTo(asset.browser_download_url, dest);
    console.log("  -> " + dest);
  } catch (e) {
    console.error("\n  Не удалось скачать yt-dlp автоматически: " + e.message);
    console.error("  Скачайте вручную: https://github.com/yt-dlp/yt-dlp/releases/latest");
    console.error("  Положите yt-dlp.exe в: " + BIN);
  }
}

async function fetchFfmpeg() {
  const dest = path.join(BIN, "ffmpeg.exe");
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000000) {
    console.log("ffmpeg.exe уже есть, пропускаю. (удалите, чтобы обновить)");
    return;
  }
  console.log("\n[2/2] Скачиваю ffmpeg (static build)…");
  // gyan.dev essentials static build. We fetch the latest "ffmpeg-release-essentials.zip".
  try {
    const zipDest = path.join(BIN, "_ffmpeg.zip");
    await downloadTo("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip", zipDest);
    console.log("  Распаковываю ffmpeg.exe из архива…");
    try {
      extractFromZip(zipDest, "ffmpeg.exe", dest);
      console.log("  -> " + dest);
    } catch (e) {
      throw new Error("не удалось извлечь ffmpeg.exe из zip: " + e.message);
    }
    try { fs.unlinkSync(zipDest); } catch (_) {}
  } catch (e) {
    console.error("\n  Не удалось скачать ffmpeg автоматически: " + e.message);
    console.error("  Скачайте static build: https://www.gyan.dev/ffmpeg/builds/");
    console.error("  (ffmpeg-release-essentials.zip), распакуйте и положите");
    console.error("  ffmpeg.exe в: " + BIN);
  }
}

(async () => {
  console.log("=== Video Downloader: загрузка зависимостей ===");
  console.log("Папка bin: " + BIN);
  await fetchYtDlp();
  await fetchFfmpeg();
  console.log("\n=== Готово ===");
  const ytd = fs.existsSync(path.join(BIN, "yt-dlp.exe"));
  const ff = fs.existsSync(path.join(BIN, "ffmpeg.exe"));
  console.log("yt-dlp.exe: " + (ytd ? "OK" : "ОТСУТСТВУЕТ"));
  console.log("ffmpeg.exe: " + (ff ? "OK" : "ОТСУТСТВУЕТ"));
  if (!ytd || !ff) {
    console.log("\nНе все бинарники на месте — см. инструкции выше.");
  }
})();
