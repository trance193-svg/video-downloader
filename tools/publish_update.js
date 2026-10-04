#!/usr/bin/env node
"use strict";

// ===========================================================================
// publish_update.js — generate updates/manifest.json for the host's
// controlled yt-dlp update channel.
//
// Usage:
//   node tools/publish_update.js <path-to-yt-dlp.exe> <version>
//     e.g. node tools/publish_update.js host/bin/yt-dlp.exe 2026.08.19
//
// The script prints the manifest; commit it to the repository so the raw
// GitHub URL (host UPDATE_MANIFEST_URL) serves it. Raising "version" in the
// committed manifest is what ships an update to users; setting
// "disabled": true is the kill switch.
// ===========================================================================

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const exePath = process.argv[2];
const version = process.argv[3];
if (!exePath || !version) {
  console.log("usage: node tools/publish_update.js <yt-dlp.exe> <version>");
  process.exit(1);
}
if (!/^\d{4}\.\d{2}\.\d{2}/.test(version)) {
  console.log("warning: version does not look like a yt-dlp date (YYYY.MM.DD)");
}
const exe = fs.readFileSync(exePath);
const sha256 = crypto.createHash("sha256").update(exe).digest("hex");
const size = exe.length;

const manifest = {
  schema: 1,
  disabled: false,
  ytDlp: {
    version,
    sha256,
    size,
    url: `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/yt-dlp.exe`,
  },
};

const outPath = path.join(__dirname, "..", "updates", "manifest.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("Wrote " + outPath);
console.log(JSON.stringify(manifest, null, 2));
console.log("\nNext steps:");
console.log("  1. Review updates/manifest.json");
console.log("  2. git add updates/manifest.json && git commit && git push");
console.log("  3. Hosts pick it up within 24 h (or on next host start).");
console.log('  Kill switch: set "disabled": true and push.');
