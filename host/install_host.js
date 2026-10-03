#!/usr/bin/env node
"use strict";

// ===========================================================================
// Installer for the Video Downloader native messaging host (Windows).
//
// What it does:
//   1. Writes a launcher .bat next to host.js that calls:
//        "<node.exe>" "<host.js>"
//      The launcher is what Chrome executes (native messaging requires a
//      runnable path; pointing straight at host.js needs a .cmd shim).
//   2. Renders the manifest JSON (com.videodownloader.host.json) with the
//      real launcher path and the extension's allowed_origin.
//   3. Registers the manifest under
//        HKCU\Software\Google\Chrome\NativeMessagingHosts\com.videodownloader.host
//      (and Edge, Brave variants too) so Chrome can find & launch the host.
//
// The extension ID is NOT known until the extension is loaded as unpacked.
// So this installer accepts the ID via --extension-id=xxxxxxxx and rewrites
// allowed_origins. Re-run it after you load the extension and read its ID.
// ===========================================================================

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const HOST_NAME = "com.videodownloader.host";
const HERE = __dirname;
const HOST_JS = path.join(HERE, "host.js");
const MANIFEST_TEMPLATE = path.join(HERE, HOST_NAME + ".json");
const LAUNCHER = path.join(HERE, "run_host.bat");

function findNode() {
  // 1) node on PATH
  const which = spawnSync("where", ["node"], { encoding: "utf8" });
  if (which.status === 0) {
    const first = which.stdout.split(/\r?\n/)[0].trim();
    if (first && fs.existsSync(first)) return first;
  }
  // 2) common install locations
  const progFiles = process.env.ProgramFiles || "C:\\Program Files";
  const candidates = [
    path.join(progFiles, "nodejs", "node.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "node", "node.exe"),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

function writeLauncher(nodePath) {
  // Quote paths; use forward-safe quoting for Windows.
  // %~dp0 resolves to the launcher's own directory at runtime, keeping the
  // .bat content pure ASCII: cmd reads batch files in the legacy OEM code
  // page, so a literal non-ASCII project path (e.g. C:\Разработка\) written
  // in UTF-8 would be mangled into a nonexistent path.
  const bat =
    "@echo off\r\n" +
    `"${nodePath}" "%~dp0host.js"\r\n`;
  fs.writeFileSync(LAUNCHER, bat, "utf8");
  return LAUNCHER;
}

function renderManifest(launcherPath, extensionOrigin) {
  const tmpl = JSON.parse(fs.readFileSync(MANIFEST_TEMPLATE, "utf8"));
  tmpl.path = launcherPath;
  tmpl.allowed_origins = extensionOrigin ? [extensionOrigin] : ["chrome-extension://PLACEHOLDER/"];
  const outPath = path.join(HERE, HOST_NAME + ".json");
  fs.writeFileSync(outPath, JSON.stringify(tmpl, null, 2), "utf8");
  return outPath;
}

function registerInRegistry(manifestPath) {
  // Register under HKCU for Chrome, Edge, Brave (all read the same key path
  // pattern; Chrome's is the canonical one most engines honor).
  const targets = [
    "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME,
    "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\" + HOST_NAME,
    "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\" + HOST_NAME,
  ];
  const results = [];
  for (const key of targets) {
    const r = spawnSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], {
      encoding: "utf8",
    });
    results.push({ key, ok: r.status === 0, err: r.stderr });
  }
  return results;
}

function extensionIdToOrigin(id) {
  if (!id) return null;
  id = id.trim();
  // accept either raw ID or full origin
  if (id.startsWith("chrome-extension://")) return id.replace(/\/$/, "");
  return "chrome-extension://" + id + "/";
}

function main() {
  const args = process.argv.slice(2);
  let extensionId = null;
  for (const a of args) {
    if (a.startsWith("--extension-id=")) extensionId = a.slice("--extension-id=".length);
    if (a === "--help" || a === "-h") {
      console.log("Usage: node install_host.js [--extension-id=XXXXXXXX]");
      console.log("  The extension ID is shown on chrome://extensions after loading");
      console.log("  the unpacked extension. Re-run with the ID to allow the extension");
      console.log("  to talk to this host.");
      process.exit(0);
    }
  }

  console.log("=== Video Downloader: установка native host ===\n");

  const nodePath = findNode();
  if (!nodePath) {
    console.error("ОШИБКА: Node.js не найден. Установите Node.js (https://nodejs.org) и повторите.");
    process.exit(1);
  }
  console.log("Node.js:        " + nodePath);

  if (!fs.existsSync(HOST_JS)) {
    console.error("ОШИБКА: host.js не найден рядом с установщиком: " + HOST_JS);
    process.exit(1);
  }

  const launcherPath = writeLauncher(nodePath);
  console.log("Launcher:       " + launcherPath);

  const origin = extensionIdToOrigin(extensionId);
  const manifestPath = renderManifest(launcherPath, origin);
  console.log("Манифест:       " + manifestPath);
  console.log("Allowed origin: " + (origin || "(НЕ ЗАДАН — укажите --extension-id после загрузки расширения!)"));

  console.log("\nРегистрация в реестре Windows (HKCU)…");
  const reg = registerInRegistry(manifestPath);
  for (const r of reg) {
    console.log((r.ok ? "  OK   " : "  FAIL ") + r.key);
    if (!r.ok && r.err) console.log("        " + r.err.trim());
  }

  console.log("\nГотово.");
  if (!origin) {
    console.log("\nВАЖНО: сейчас allowed_origins заполнен заглушкой.");
    console.log("1) Загрузите распакованное расширение в chrome://extensions");
    console.log("2) Скопируйте его ID (32 символа)");
    console.log("3) Перезапустите установщик:");
    console.log("     node install_host.js --extension-id=ВАШ_ID");
  }
  console.log("\nЗатем перезапустите Chrome/Edge. Расширение сможет связываться с хостом.");
}

main();
