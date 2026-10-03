"use strict";
// Test: send a LIST command to the native host and print formats.
const { spawn } = require("child_process");
const path = require("path");

const url = process.argv[2];
if (!url) { console.log("usage: node test_list.js <video-url>"); process.exit(1); }

const bat = path.join(__dirname, "host", "run_host.bat");
const p = spawn('"' + bat + '"', [], { stdio: ["pipe", "pipe", "pipe"], shell: true, windowsVerbatimArguments: true });

function send(obj) {
  const msg = Buffer.from(JSON.stringify(obj));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(msg.length, 0);
  p.stdin.write(Buffer.concat([len, msg]));
}

send({ command: "LIST", url, pageTitle: "test_list.js" });

let out = Buffer.alloc(0);
p.stdout.on("data", (d) => { out = Buffer.concat([out, d]); try { drain(); } catch (_) {} });
p.stderr.on("data", (d) => process.stderr.write("STDERR: " + d));
let done = false;
function drain() {
  while (out.length >= 4) {
    const n = out.readUInt32LE(0);
    if (out.length < 4 + n) break;
    const body = JSON.parse(out.subarray(4, 4 + n).toString("utf8"));
    if (body.type === "LIST_RESULT" && !done) {
      done = true;
      console.log("TITLE:", body.title);
      for (const f of body.videos || []) console.log(`  ${f.label}  [yt: ${f.ytFormat}]`);
      console.log("OK: got " + (body.videos || []).length + " options");
      p.kill();
      process.exit(0);
    } else if (body.type === "ERROR" && !done) {
      done = true;
      console.log("ERROR:", body.message || JSON.stringify(body).slice(0, 300));
      p.kill();
      process.exit(1);
    }
    out = out.subarray(4 + n);
  }
}
setTimeout(() => { if (!done) { console.log("TIMEOUT: no LIST_RESULT in 60s, bytes:", out.length); p.kill(); process.exit(2); } }, 60000);
