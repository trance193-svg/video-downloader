#!/usr/bin/env node
"use strict";

// ===========================================================================
// Native messaging host for the Video Downloader extension.
//
// Protocol (Chrome Native Messaging):
//   - Chrome sends a message: 4-byte little-endian length + UTF-8 JSON
//   - We reply the same way.
//
// Commands received from the extension:
//   { command: "PING" }
//   { command: "LIST", url, pageUrl }
//   { command: "DOWNLOAD", url, pageUrl, format, outdir }
//   { command: "KILL" }
//
// Messages sent to the extension:
//   { type: "PONG", version }
//   { type: "LIST_RESULT", videos: [...] }
//   { type: "LOG", level, message }
//   { type: "PROGRESS", percent, speed, eta, title }
//   { type: "DONE", path }
//   { type: "ERROR", message }
//   { type: "KILLED" }           — current job was cancelled/replaced
//
// When the browser closes stdin while a job runs, the job is allowed to
// finish (the file is kept) and the host exits afterwards.
// ===========================================================================

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

// ---------------------------------------------------------------------------
// Locate yt-dlp and ffmpeg executables.
// Preference: <project>/bin/{yt-dlp.exe, ffmpeg.exe}  (bundled binaries)
//             else: system PATH (yt-dlp / ffmpeg)
// ---------------------------------------------------------------------------
const BIN_DIR = path.join(__dirname, "bin");
function resolveExe(name) {
  const local = path.join(BIN_DIR, name + ".exe");
  try {
    if (fs.existsSync(local)) return local;
  } catch (_) {}
  return name; // fall back to PATH
}
const YT_DLP = resolveExe("yt-dlp");
const FFMPEG = resolveExe("ffmpeg");
const HOST_VERSION = "1.2.0";

// Optional simple logging to a file for debugging (not required for operation).
const LOG_FILE = process.env.VD_LOG ? path.join(__dirname, "host.log") : null;
function logToFile(msg) {
  if (!LOG_FILE) return;
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Native messaging I/O: read length-prefixed messages from stdin, write the
// same framing to stdout. NOTE: stdout MUST be reserved for framed protocol
// messages only — any stray writes corrupt the stream.
// ---------------------------------------------------------------------------
function sendMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function readMessages(handler) {
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Pull every complete frame currently buffered.
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const payload = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      try {
        const msg = JSON.parse(payload.toString("utf8"));
        handler(msg);
      } catch (e) {
        logToFile("Bad JSON from extension: " + e.message);
      }
    }
  });
  // NOTE: no exit-on-end here — the bootstrap section owns stdin-close
  // behavior so a running download can finish instead of being killed.
}

// ---------------------------------------------------------------------------
// Job control.
// ---------------------------------------------------------------------------
let currentJob = null; // { proc, kind }
// Set while we SIGKILL a job on purpose (user cancel, or a new command
// replacing it). The process "close" handler checks this to avoid reporting
// an intentional kill as a mysterious "exited with code null" error.
let jobKilledIntentionally = false;
// Set when the browser side closed our stdin (port death / popup gone).
let stdinClosed = false;

function killCurrentJob() {
  if (!currentJob || !currentJob.proc) {
    sendMessage({ type: "KILLED" });
    return;
  }
  jobKilledIntentionally = true;
  try {
    currentJob.proc.kill("SIGKILL");
  } catch (_) {}
  currentJob = null;
  sendMessage({ type: "KILLED" });
}

// After any job ends: if the browser already closed our stdin, there is no
// one to talk to — exit instead of lingering as an orphan process.
function maybeExitAfterJob() {
  if (stdinClosed) process.exit(0);
}

// ---------------------------------------------------------------------------
// Parse yt-dlp --print / -J output into a lightweight list of formats.
// We use -J (dump-single-json) which returns one JSON object with a
// "formats" array. Each format entry has: format_id, ext, vcodec, acodec,
// resolution (e.g. "1920x1080"), height, width, filesize, fps, tbr, etc.
// ---------------------------------------------------------------------------
function listFormats(url, pageUrl) {
  return new Promise((resolve) => {
    // --no-update: yt-dlp must not self-update or nag about it — updates are
    // our controlled channel's job (see maybeUpdateYtDlp).
    const args = ["-J", "--no-playlist", "--no-warnings", "--no-update"];
    if (pageUrl) args.push("--referer", pageUrl);
    args.push(url);
    const proc = spawn(YT_DLP, args, { windowsHide: true });
    currentJob = { proc, kind: "LIST" };
    let outBuf = Buffer.alloc(0);
    let errBuf = "";

    proc.stdout.on("data", (d) => (outBuf = Buffer.concat([outBuf, d])));
    proc.stderr.on("data", (d) => (errBuf += d.toString("utf8")));

    proc.on("error", (e) => {
      currentJob = null;
      resolve({
        errorKey: "mLaunchFail",
        error:
          "Не удалось запустить yt-dlp. Проверьте, что yt-dlp.exe находится в папке host/bin. " +
          e.message,
      });
    });

    proc.on("close", (code) => {
      currentJob = null;
      if (code !== 0) {
        resolve({ errorKey: null, error: trim(errBuf) || "yt-dlp code " + code });
        return;
      }
      try {
        const info = JSON.parse(outBuf.toString("utf8"));
        resolve({ info });
      } catch (e) {
        resolve({
          errorKey: "mParseFail",
          error: "Не удалось разобрать ответ yt-dlp: " + e.message,
        });
      }
    });
  });
}

function buildVideoList(info) {
  const videos = [];
  const title = info.title || "Без названия";
  const thumb = info.thumbnail || null;

  // Build merged "best with audio" best option + per-resolution entries.
  const formats = Array.isArray(info.formats) ? info.formats : [];

  // Collect progressive (video+audio in one) and separate video-only formats.
  const progressive = formats.filter(
    (f) => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none",
  );
  const videoOnly = formats.filter(
    (f) => f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none"),
  );

  // Helper: pick a human-readable label.
  function label(f) {
    const h = f.height ? f.height + "p" : "?";
    const ext = f.ext || "?";
    const fps = f.fps ? "@" + Math.round(f.fps) : "";
    return `${h}${fps} · ${ext}`;
  }

  // "Best with audio" merged option (yt-dlp picks bestvideo+bestaudio+ffmpeg merge).
  const bestHeight =
    Math.max(0, ...videoOnly.map((f) => f.height || 0)) ||
    Math.max(0, ...progressive.map((f) => f.height || 0));
  videos.push({
    id: "best",
    kind: "best",
    label: bestHeight ? `Наилучшее со звуком (${bestHeight}p)` : "Наилучшее со звуком",
    height: bestHeight,
    hasAudio: true,
    ytFormat: "bestvideo*+bestaudio/best", // yt-dlp format selector
    filesize: null,
  });

  // Video-only (will be merged with best audio by yt-dlp when selected).
  const seen = new Set();
  for (const f of videoOnly.sort((a, b) => (b.height || 0) - (a.height || 0))) {
    const key = f.height + "_" + (f.fps || 0) + "_" + f.ext;
    if (seen.has(key)) continue;
    seen.add(key);
    videos.push({
      id: f.format_id,
      kind: "video-only",
      label: label(f) + " (видео+звук)",
      height: f.height || 0,
      fps: f.fps ? Math.round(f.fps) : null,
      ext: f.ext || null,
      hasAudio: true, // we will merge with audio on download
      ytFormat: f.format_id + "+bestaudio/best",
      filesize: f.filesize || f.filesize_approx || null,
      vcodec: f.vcodec,
    });
  }

  // Progressive (single file, already has audio) — good fallback if no ffmpeg.
  for (const f of progressive.sort((a, b) => (b.height || 0) - (a.height || 0))) {
    const key = f.height + "_" + (f.fps || 0) + "_" + f.ext;
    if (seen.has(key)) continue;
    seen.add(key);
    videos.push({
      id: f.format_id,
      kind: "progressive",
      label: label(f) + " (один файл)",
      height: f.height || 0,
      fps: f.fps ? Math.round(f.fps) : null,
      ext: f.ext || null,
      hasAudio: true,
      ytFormat: f.format_id,
      filesize: f.filesize || f.filesize_approx || null,
      vcodec: f.vcodec,
    });
  }

  return { title, thumb, videos };
}

// ---------------------------------------------------------------------------
// Download a selected format. yt-dlp handles merging video+audio via ffmpeg
// when the format selector requires it (bestvideo+bestaudio). We parse
// progress from stderr progress lines.
// ---------------------------------------------------------------------------
function startDownload(url, pageUrl, ytFormat, outdir, pageTitle, concurrent) {
  // Relative outdir = subfolder inside the user's Downloads folder (the
  // options page sends a subfolder name; an absolute path is used as-is).
  // Resolved against the Downloads ROOT, not the default dir, so a pref of
  // "VideoDownloader" doesn't nest into Downloads\VideoDownloader twice.
  let dir = getDefaultOutdir();
  if (outdir) {
    dir = path.isAbsolute(outdir) ? outdir : path.join(getDownloadsRoot(), outdir);
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    sendMessage({
      type: "ERROR",
      key: "mOutdirFail",
      message: "Не удалось создать папку вывода: " + e.message,
    });
    return;
  }
  const fragCount = Math.min(16, Math.max(1, parseInt(concurrent, 10) || 4));

  // Prefer the lesson page's <title> as the filename — yt-dlp can't extract a
  // title/id from a bare Vimeo m3u8, so without this every download would
  // collapse onto the same empty filename. Fall back to yt-dlp's own title/id
  // extraction when the page title is missing.
  let baseName = "";
  if (pageTitle) {
    baseName = pageTitle
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_")
      .slice(0, 180);
  }
  // Local time (not UTC) so the prefix matches what the user sees on the clock.
  const p2 = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(
    now.getDate(),
  )}T${p2(now.getHours())}-${p2(now.getMinutes())}-${p2(now.getSeconds())}`;
  const nameTpl = baseName
    ? `${stamp} - ${baseName}.%(ext)s`
    : `${stamp} - %(title).200B [%(id)s].%(ext)s`;

  const args = [
    "-f",
    ytFormat,
    "--merge-output-format",
    "mp4",
    "--no-overwrites",
    // Updates are our controlled channel's job (see maybeUpdateYtDlp).
    "--no-update",
    "--concurrent-fragments",
    String(fragCount),
    // Keep .part files: a cancelled/killed download then leaves a clearly
    // incomplete *.part instead of a truncated file that looks finished.
    "-o",
    path.join(dir, nameTpl),
    "--no-playlist",
    "--newline",
    // Keep --progress explicitly: --print implies --quiet otherwise and our
    // PROGRESS lines would disappear.
    "--progress",
    "--print",
    "after_move:FINAL_PATH %(filepath)s",
    "--progress-template",
    "PROGRESS %(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s",
  ];
  if (pageUrl) args.push("--referer", pageUrl);
  args.push(url);

  const proc = spawn(YT_DLP, args, { windowsHide: true });
  currentJob = { proc, kind: "DOWNLOAD" };
  let stderrBuf = "";
  let finalPath = null;
  // yt-dlp emits PROGRESS lines as a \r-separated stream; chunks can split a
  // line in half, so accumulate and only parse complete lines.
  let lineBuf = "";

  proc.stderr.on("data", (d) => {
    // stderr is warnings/errors only; accumulate for error reporting.
    stderrBuf += d.toString("utf8");
  });

  proc.stdout.on("data", (d) => {
    lineBuf += d.toString("utf8");
    const lines = lineBuf.split(/\r?\n/);
    lineBuf = lines.pop(); // keep the incomplete tail buffered
    for (const line of lines) {
      const fp = line.match(/^FINAL_PATH\s+(.+)\s*$/);
      if (fp) {
        finalPath = fp[1].trim();
        continue;
      }
      const m = line.match(/PROGRESS\s+(\S+)\s+(\S+)\s+(\S+)/);
      if (m) {
        sendMessage({
          type: "PROGRESS",
          percent: m[1],
          speed: m[2],
          eta: m[3],
        });
      }
    }
  });

  proc.on("error", (e) => {
    currentJob = null;
    sendMessage({
      type: "ERROR",
      message: "Не удалось запустить yt-dlp: " + e.message,
    });
  });

  proc.on("close", (code) => {
    const killedOnPurpose = jobKilledIntentionally;
    jobKilledIntentionally = false;
    currentJob = null;
    if (killedOnPurpose) {
      // User cancel or replaced by a newer command — KILLED is sent by the
      // killer; nothing to report here.
      maybeExitAfterJob();
      return;
    }
    if (code === 0) {
      // Prefer the exact path yt-dlp reported; fall back to a directory scan.
      const final = finalPath || findNewestFile(dir);
      sendMessage({ type: "DONE", path: final || dir });
    } else {
      sendMessage({
        type: "ERROR",
        key: trim(stderrBuf) ? null : "mYtdlpCode",
        params: trim(stderrBuf) ? null : [String(code)],
        message: trim(stderrBuf) || "yt-dlp завершился с кодом " + code,
      });
    }
    maybeExitAfterJob();
  });
}

function getDownloadsRoot() {
  const home = process.env.USERPROFILE || process.env.HOME || __dirname;
  return path.join(home, "Downloads");
}

function getDefaultOutdir() {
  // Standalone default (no extension prefs): Downloads\VideoDownloader.
  return path.join(getDownloadsRoot(), "VideoDownloader");
}

function findNewestFile(dir) {
  try {
    const entries = fs.readdirSync(dir).map((name) => {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      return { p, mtime: st.mtimeMs };
    });
    entries.sort((a, b) => b.mtime - a.mtime);
    return entries.length ? entries[0].p : null;
  } catch (_) {
    return null;
  }
}

function trim(s) {
  return (s || "").trim().replace(/\s+/g, " ").slice(-2000);
}

// Only http(s) URLs are meaningful to yt-dlp; anything else (media-source://
// junk, "javascript:", "-flag-looking" strings that yt-dlp would parse as
// options) is rejected before it reaches the command line.
function isValidUrl(u) {
  return typeof u === "string" && /^https?:\/\/\S+/i.test(u) && !u.startsWith("-");
}

// ---------------------------------------------------------------------------
// yt-dlp update channel (controlled by the project maintainer).
//
// We do NOT use `yt-dlp -U`: that would let an upstream release reach user
// machines without our review. Instead the host reads OUR version manifest
// (a small JSON in the project's GitHub repository) and only applies an
// update when the manifest explicitly lists a newer version:
//
//   {
//     "schema": 1,
//     "disabled": false,                       <- kill switch
//     "ytDlp": {
//       "version": "2026.08.19",               <- lexicographic date compare
//       "sha256": "<hex digest of the exe>",
//       "url": "https://github.com/yt-dlp/yt-dlp/releases/download/..."
//     }
//   }
//
// Pipeline: fetch manifest -> newer? -> download -> sha256 -> verify the
// binary actually runs (--version) -> backup old exe -> atomic swap -> state
// file. Any failure keeps the old binary. Checks are throttled to once per
// 24 h and never run while a job is active.
// ---------------------------------------------------------------------------
const UPDATE_MANIFEST_URL =
  process.env.VD_UPDATE_URL ||
  "https://raw.githubusercontent.com/trance193-svg/video-downloader/main/updates/manifest.json";
const UPDATE_STATE_FILE = path.join(__dirname, "update-state.json");
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const EXE_MAX_BYTES = 80 * 1024 * 1024;

function readUpdateState() {
  try {
    return JSON.parse(fs.readFileSync(UPDATE_STATE_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}

function writeUpdateState(state) {
  try {
    fs.writeFileSync(UPDATE_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (_) {}
}

function httpsGetFollow(url, { maxBytes, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    // http:// support is for local test harnesses / mirrors; the production
    // update manifest URL is https.
    const transport = url.startsWith("http://") ? require("http") : https;
    const request = (u, redirects) => {
      if (redirects > 5) return reject(new Error("too many redirects"));
      let size = 0;
      const req = transport.get(
        u,
        { headers: { "User-Agent": "video-downloader-host", ...headers }, timeout: 20000 },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return request(new URL(res.headers.location, u).href, redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error("HTTP " + res.statusCode));
          }
          const chunks = [];
          res.on("data", (d) => {
            size += d.length;
            if (maxBytes && size > maxBytes) {
              req.destroy();
              reject(new Error("response exceeds size limit"));
              return;
            }
            chunks.push(d);
          });
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
    };
    request(url, 0);
  });
}

function runVersionProbe(exePath) {
  return new Promise((resolve) => {
    try {
      const proc = spawn(exePath, ["--version"], { windowsHide: true, timeout: 20000 });
      let out = "";
      proc.stdout.on("data", (d) => (out += d.toString("utf8")));
      proc.on("error", () => resolve(null));
      proc.on("close", (code) => {
        const v = out.trim().split(/\r?\n/)[0] || "";
        resolve(code === 0 && /^\d{4}\.\d{2}\.\d{2}/.test(v) ? v : null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function maybeUpdateYtDlp() {
  if (currentJob) return; // never touch the binary mid-download
  const state = readUpdateState();
  const now = Date.now();
  if (state.lastCheck && now - state.lastCheck < UPDATE_CHECK_INTERVAL_MS) return;

  const markChecked = (extra) => writeUpdateState({ ...state, lastCheck: now, ...(extra || {}) });

  let manifest;
  try {
    const buf = await httpsGetFollow(UPDATE_MANIFEST_URL, { maxBytes: MANIFEST_MAX_BYTES });
    manifest = JSON.parse(buf.toString("utf8"));
  } catch (e) {
    logToFile("update: manifest unavailable (" + e.message + ")");
    markChecked();
    return;
  }
  if (!manifest || manifest.schema !== 1 || manifest.disabled) {
    logToFile("update: manifest disabled or unknown schema — skipping");
    markChecked();
    return;
  }
  const target = manifest.ytDlp;
  if (!target || !target.version || !target.sha256 || !isValidUrl(target.url)) {
    logToFile("update: malformed manifest entry — skipping");
    markChecked();
    return;
  }

  // Local version: trusted recorded state first, else probe the binary.
  let localVersion = state.installedVersion || null;
  if (!localVersion) {
    localVersion = await runVersionProbe(YT_DLP);
    if (!localVersion) {
      logToFile("update: cannot determine local yt-dlp version — skipping");
      markChecked();
      return;
    }
  }
  if (target.version <= localVersion) {
    markChecked({ installedVersion: localVersion });
    return; // up to date
  }

  logToFile("update: downloading yt-dlp " + target.version + " (local " + localVersion + ")");
  let newExe;
  try {
    newExe = await httpsGetFollow(target.url, { maxBytes: EXE_MAX_BYTES });
  } catch (e) {
    logToFile("update: download failed (" + e.message + ")");
    markChecked();
    return;
  }
  const digest = crypto.createHash("sha256").update(newExe).digest("hex");
  if (digest !== String(target.sha256).toLowerCase()) {
    logToFile("update: SHA-256 mismatch — keeping current binary");
    markChecked();
    return;
  }

  // Verify the new binary actually runs before touching the old one.
  const probePath = YT_DLP + ".new";
  try {
    fs.writeFileSync(probePath, newExe);
  } catch (e) {
    logToFile("update: cannot write temp file (" + e.message + ")");
    markChecked();
    return;
  }
  const probed = await runVersionProbe(probePath);
  if (!probed) {
    logToFile("update: new binary failed --version probe — discarding");
    try {
      fs.unlinkSync(probePath);
    } catch (_) {}
    markChecked();
    return;
  }

  // Backup → swap → state. Restore the backup if the swap goes wrong.
  const backupPath = YT_DLP + ".bak";
  try {
    if (fs.existsSync(YT_DLP)) fs.copyFileSync(YT_DLP, backupPath);
    fs.renameSync(probePath, YT_DLP);
    writeUpdateState({ lastCheck: now, installedVersion: target.version });
    logToFile("update: yt-dlp updated to " + target.version);
  } catch (e) {
    logToFile("update: swap failed (" + e.message + ") — restoring backup");
    try {
      if (fs.existsSync(backupPath)) fs.copyFileSync(backupPath, YT_DLP);
    } catch (_) {}
    markChecked();
  }
}

// ---------------------------------------------------------------------------
// Command dispatcher.
// ---------------------------------------------------------------------------
async function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  const cmd = msg.command;

  if (cmd === "PING") {
    sendMessage({ type: "PONG", version: HOST_VERSION, ytDlp: YT_DLP, ffmpeg: FFMPEG });
    return;
  }

  if (cmd === "KILL") {
    killCurrentJob();
    return;
  }

  if (cmd === "LIST" || cmd === "DOWNLOAD") {
    if (!isValidUrl(msg.url)) {
      sendMessage({
        type: "ERROR",
        key: "mBadUrl",
        params: [String(msg.url).slice(0, 80)],
        message:
          "Некорректная ссылка: ожидается http(s):// URL, получено: " +
          String(msg.url).slice(0, 80),
      });
      return;
    }
    if (currentJob) {
      // Replace the running job on purpose; its "close" handler will see the
      // intentional-kill flag and stay quiet.
      jobKilledIntentionally = true;
      try {
        currentJob.proc.kill("SIGKILL");
      } catch (_) {}
      currentJob = null;
      sendMessage({
        type: "LOG",
        level: "info",
        key: cmd === "LIST" ? "mReplacedList" : "mReplacedDownload",
        message:
          cmd === "LIST"
            ? "Предыдущая задача прервана — выполняю анализ."
            : "Предыдущая задача прервана — начинаю новое скачивание.",
      });
    }
  }

  if (cmd === "LIST") {
    sendMessage({ type: "LOG", level: "info", key: "mAnalysing", message: "Анализирую ссылку…" });
    const res = await listFormats(msg.url, msg.pageUrl);
    if (res.error) {
      sendMessage({ type: "ERROR", key: res.errorKey || null, message: res.error });
      maybeExitAfterJob();
      return;
    }
    const list = buildVideoList(res.info);
    sendMessage({ type: "LIST_RESULT", ...list });
    maybeExitAfterJob();
    return;
  }

  if (cmd === "DOWNLOAD") {
    sendMessage({
      type: "LOG",
      level: "info",
      key: "mDownloading",
      message: "Начинаю скачивание…",
    });
    startDownload(msg.url, msg.pageUrl, msg.ytFormat, msg.outdir, msg.pageTitle, msg.concurrent);
    return;
  }

  sendMessage({ type: "ERROR", message: "Неизвестная команда: " + cmd });
}

// ---------------------------------------------------------------------------
// Bootstrap.
// ---------------------------------------------------------------------------
readMessages(handle);
logToFile("Host started. YT_DLP=" + YT_DLP + " FFMPEG=" + FFMPEG);

// Update check runs in the background shortly after startup so it never
// delays the first PING; it is throttled to once per 24 h internally.
setTimeout(() => {
  maybeUpdateYtDlp().catch((e) => logToFile("update: unexpected error " + e.message));
}, 5000);

// When the browser closes the port (service worker death, popup gone) stdin
// ends. If a job is running we let it finish — killing it would silently
// lose the user's download; maybeExitAfterJob() exits once it completes.
process.stdin.on("end", () => {
  stdinClosed = true;
  logToFile("stdin closed by browser");
  if (!currentJob) process.exit(0);
});
