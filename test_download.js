"use strict";
// Test: send DOWNLOAD to the native host, watch PROGRESS, print DONE path.
const { spawn } = require("child_process");
const path = require("path");

const url = process.argv[2];
const fmt = process.argv[3] || "bestvideo*+bestaudio/best";
if (!url) {
  console.log("usage: node test_download.js <video-url> [format]");
  process.exit(1);
}

const bat = path.join(__dirname, "host", "run_host.bat");
const p = spawn('"' + bat + '"', [], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: true,
  windowsVerbatimArguments: true,
});

function send(obj) {
  const msg = Buffer.from(JSON.stringify(obj));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(msg.length, 0);
  p.stdin.write(Buffer.concat([len, msg]));
}

send({ command: "DOWNLOAD", url, ytFormat: fmt, pageTitle: "test_download", pageUrl: url });

let out = Buffer.alloc(0);
let progressCount = 0;
let done = false;
p.stdout.on("data", (d) => {
  out = Buffer.concat([out, d]);
  try {
    drain();
  } catch (_) {}
});
p.stderr.on("data", (d) => process.stderr.write("STDERR: " + d));

function drain() {
  while (out.length >= 4) {
    const n = out.readUInt32LE(0);
    if (out.length < 4 + n) break;
    const body = JSON.parse(out.subarray(4, 4 + n).toString("utf8"));
    if (body.type === "PROGRESS") {
      progressCount++;
      if (progressCount % 5 === 1) console.log("  PROGRESS", body.percent, body.speed, body.eta);
    } else if (body.type === "DONE" && !done) {
      done = true;
      console.log("PROGRESS messages received:", progressCount);
      console.log("DONE path:", body.path);
      const fs = require("fs");
      console.log("File exists:", fs.existsSync(body.path));
      console.log(
        "Local timestamp in name:",
        /T\d{2}-\d{2}-\d{2} - test_download/.test(body.path) ? "OK" : "CHECK: " + body.path,
      );
      p.kill();
      process.exit(0);
    } else if (body.type === "ERROR" && !done) {
      done = true;
      console.log("PROGRESS messages received:", progressCount);
      console.log("ERROR:", (body.message || "").slice(0, 400));
      p.kill();
      process.exit(1);
    }
    out = out.subarray(4 + n);
  }
}
setTimeout(() => {
  if (!done) {
    console.log("TIMEOUT after 120s; progress so far:", progressCount);
    p.kill();
    process.exit(2);
  }
}, 120000);
