#!/usr/bin/env node
"use strict";

// ===========================================================================
// build.js — assemble the self-contained Windows host package into dist/.
//
// The package is a single zip a user can unzip anywhere and install by
// running Установить.bat — no Node.js, no Python, no admin rights needed:
//
//   VideoDownloader-host-win64/
//   ├── node.exe                        (portable, bundled)
//   ├── host.js                         (native messaging host)
//   ├── install_host.js                 (registration: manifest + registry)
//   ├── com.videodownloader.host.json   (host manifest template)
//   ├── bin/yt-dlp.exe, ffmpeg.exe, ffprobe.exe
//   ├── LICENSES.txt
//   ├── Установить.bat                  (install: register host)
//   └── Удалить.bat                     (uninstall: unregister)
//
// Usage:  node tools/build.js
// The bundled node.exe is fetched once into build-cache/ (cached).
// ===========================================================================

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const CACHE = path.join(ROOT, "build-cache");
const HOST_DIR = path.join(ROOT, "host");
const NODE_VERSION = process.env.VD_NODE_VERSION || "22.23.3";

const INSTALL_BAT = [
  "@echo off",
  "setlocal",
  'set "HERE=%~dp0"',
  "echo === Video Downloader: installing local downloader... ===",
  '"%HERE%node.exe" "%HERE%install_host.js"',
  "if errorlevel 1 (",
  "  echo.",
  "  echo Installation FAILED. See messages above.",
  "  pause",
  "  exit /b 1",
  ")",
  "echo.",
  "echo Installed. Restart your browser, then click the extension icon.",
  "pause",
  "",
].join("\r\n");

const UNINSTALL_BAT = [
  "@echo off",
  "echo === Video Downloader: removing host registration... ===",
  'reg delete "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.videodownloader.host" /f >nul 2>&1',
  'reg delete "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.videodownloader.host" /f >nul 2>&1',
  'reg delete "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.videodownloader.host" /f >nul 2>&1',
  "echo Done. You can now delete this folder.",
  "pause",
  "",
].join("\r\n");

const LICENSES = `Bundled third-party components
==============================

yt-dlp (bin/yt-dlp.exe)
  License: The Unlicense (public domain). https://github.com/yt-dlp/yt-dlp

ffmpeg / ffprobe (bin/ffmpeg.exe, bin/ffprobe.exe)
  Static build from https://www.gyan.dev/ffmpeg/builds/ (ffmpeg-release-essentials).
  FFmpeg is licensed under the GNU General Public License v3 or later.
  Source code: https://ffmpeg.org/download.html
  This product includes software developed by the FFmpeg project
  (http://www.ffmpeg.org). FFmpeg includes code by numerous developers; see
  the source repository for full authorship and license texts.

Node.js (node.exe)
  Official binary distribution from https://nodejs.org — MIT license,
  copyright Node.js contributors. Includes third-party components listed in
  the official repository (https://github.com/nodejs/node).

Update channel
==============
The bundled yt-dlp binary is updated only through this project's own signed
version manifest; yt-dlp's built-in self-updater is disabled.
`;

function log(s) {
  console.log(s);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const request = (u, redirects) => {
      if (redirects > 5) return reject(new Error("too many redirects"));
      https
        .get(u, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return request(new URL(res.headers.location, u).href, redirects + 1);
          }
          if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on("finish", () => out.close(resolve));
          out.on("error", reject);
        })
        .on("error", reject);
    };
    request(url, 0);
  });
}

async function ensureBundledNode() {
  const exe = path.join(CACHE, "node.exe");
  if (fs.existsSync(exe) && fs.statSync(exe).size > 10 * 1024 * 1024) return exe;
  fs.mkdirSync(CACHE, { recursive: true });
  const zip = path.join(CACHE, `node-v${NODE_VERSION}-win-x64.zip`);
  if (!fs.existsSync(zip)) {
    log(`[build] downloading node v${NODE_VERSION} (once, cached)…`);
    await download(
      `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
      zip,
    );
  }
  log("[build] extracting node.exe…");
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${CACHE}' -Force`,
  ]);
  const inner = path.join(CACHE, `node-v${NODE_VERSION}-win-x64`, "node.exe");
  fs.copyFileSync(inner, exe);
  return exe;
}

async function main() {
  const hostVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const pkgName = `VideoDownloader-host-win64`;
  const stageDir = path.join(DIST, pkgName);
  const zipPath = path.join(DIST, `${pkgName}.zip`);

  log("=== Video Downloader: build host package ===");
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.mkdirSync(path.join(stageDir, "bin"), { recursive: true });

  // node.exe
  const nodeExe = await ensureBundledNode();
  fs.copyFileSync(nodeExe, path.join(stageDir, "node.exe"));

  // host code + manifest template + installer
  for (const f of ["host.js", "install_host.js", "com.videodownloader.host.json"]) {
    fs.copyFileSync(path.join(HOST_DIR, f), path.join(stageDir, f));
  }

  // binaries
  for (const f of ["yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe"]) {
    const src = path.join(HOST_DIR, "bin", f);
    if (!fs.existsSync(src)) {
      throw new Error(`missing ${f} — run "node tools/fetch_deps.js" first`);
    }
    fs.copyFileSync(src, path.join(stageDir, "bin", f));
  }

  // launcher-independent extras
  fs.writeFileSync(path.join(stageDir, "Установить.bat"), INSTALL_BAT);
  fs.writeFileSync(path.join(stageDir, "Удалить.bat"), UNINSTALL_BAT);
  fs.writeFileSync(path.join(stageDir, "LICENSES.txt"), LICENSES);

  // zip it (PowerShell Compress-Archive, no external deps)
  log("[build] compressing…");
  fs.rmSync(zipPath, { force: true });
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -LiteralPath '${stageDir}' -DestinationPath '${zipPath}' -Force`,
  ]);

  const mb = (p) => (fs.statSync(p).size / 1048576).toFixed(1) + " MB";
  log(`[build] done:`);
  log(`  folder: ${stageDir}`);
  log(`  zip:    ${zipPath} (${mb(zipPath)})`);
  log(`  version: host ${hostVersion}, node v${NODE_VERSION}`);
}

main().catch((e) => {
  console.error("BUILD FAILED:", e.message);
  process.exit(1);
});
