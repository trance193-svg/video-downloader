"use strict";
// Smoke test: send a framed PING to the native host via run_host.bat and print the answer.
const { spawn } = require("child_process");
const path = require("path");

const bat = path.join(__dirname, "host", "run_host.bat");
const p = spawn('"' + bat + '"', [], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: true,
  windowsVerbatimArguments: true,
});

const msg = Buffer.from(JSON.stringify({ command: "PING" }));
const len = Buffer.alloc(4);
len.writeUInt32LE(msg.length, 0);
p.stdin.write(Buffer.concat([len, msg]));

let out = Buffer.alloc(0);
p.stdout.on("data", (d) => {
  out = Buffer.concat([out, d]);
});
p.stderr.on("data", (d) => process.stderr.write("STDERR: " + d + "\n"));
p.on("error", (e) => {
  console.log("SPAWN ERROR:", e.message);
  process.exit(1);
});

setTimeout(() => {
  if (out.length >= 4) {
    const n = out.readUInt32LE(0);
    console.log("HOST ANSWER:", out.subarray(4, 4 + n).toString("utf8"));
  } else {
    console.log("NO ANSWER, bytes:", out.length);
  }
  p.kill();
  process.exit(0);
}, 4000);
