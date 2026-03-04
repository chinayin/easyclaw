/**
 * Startup timing preload script.
 *
 * Injected via NODE_OPTIONS="--require .../startup-timer.cjs" by the launcher.
 * Logs timestamps for key startup phases so we can see where time is spent.
 *
 * Output goes to stderr so it doesn't interfere with stdout protocol messages.
 */
"use strict";

const t0 = performance.now();
let requireCount = 0;
let requireTotalMs = 0;

// Filesystem operation counters
let fsOpCount = 0;
let fsOpTotalMs = 0;
let fsSlowOps = []; // Collect slow ops for summary

function logPhase(label) {
  const elapsed = (performance.now() - t0).toFixed(0);
  process.stderr.write(`[startup-timer] +${elapsed}ms ${label}\n`);
}

logPhase("preload executing");

// ── Hook CJS Module._load ──
const Module = require("module");
const origLoad = Module._load;

Module._load = function timedLoad(request, parent, isMain) {
  requireCount++;
  const start = performance.now();
  const result = origLoad.call(this, request, parent, isMain);
  const dur = performance.now() - start;
  requireTotalMs += dur;
  if (dur > 100) {
    const shortReq =
      request.length > 60 ? "..." + request.slice(-57) : request;
    logPhase(`require("${shortReq}") took ${dur.toFixed(0)}ms`);
  }
  return result;
};

// ── Hook sync filesystem operations (Defender scanning shows up here) ──
const fs = require("fs");
const path = require("path");

function wrapFsSync(name) {
  const orig = fs[name];
  if (typeof orig !== "function") return;
  fs[name] = function () {
    fsOpCount++;
    const start = performance.now();
    const result = orig.apply(this, arguments);
    const dur = performance.now() - start;
    fsOpTotalMs += dur;
    if (dur > 50) {
      const arg0 = arguments[0];
      const p = typeof arg0 === "string" ? arg0 : String(arg0);
      const shortPath = p.length > 60 ? "..." + p.slice(-57) : p;
      fsSlowOps.push({ name, path: shortPath, dur });
      // Log individually if very slow
      if (dur > 200) {
        logPhase(`fs.${name}("${shortPath}") took ${dur.toFixed(0)}ms`);
      }
    }
    return result;
  };
}

// Hook all commonly used sync fs operations
[
  "openSync",
  "readFileSync",
  "existsSync",
  "statSync",
  "lstatSync",
  "realpathSync",
  "readdirSync",
  "accessSync",
  "closeSync",
].forEach(wrapFsSync);

// ── Hook Module._compile (jiti code compilation) ──
const origCompile = Module.prototype._compile;
Module.prototype._compile = function timedCompile(content, filename) {
  const start = performance.now();
  const result = origCompile.call(this, content, filename);
  const dur = performance.now() - start;
  if (dur > 200) {
    const shortName =
      filename.length > 60 ? "..." + filename.slice(-57) : filename;
    const sizeKB = (content.length / 1024).toFixed(0);
    logPhase(
      `compile("${shortName}") took ${dur.toFixed(0)}ms (${sizeKB}KB)`,
    );
  }
  return result;
};

// Log when the event loop starts processing (= all top-level ESM code done).
setImmediate(() => {
  logPhase(
    `event loop started (${requireCount} requires/${requireTotalMs.toFixed(0)}ms, ${fsOpCount} fs ops/${fsOpTotalMs.toFixed(0)}ms)`,
  );

  // Log periodic heartbeats with cumulative stats
  let prevFsOps = fsOpCount;
  let prevFsMs = fsOpTotalMs;
  let heartbeat = 0;
  const iv = setInterval(() => {
    heartbeat++;
    const newOps = fsOpCount - prevFsOps;
    const newMs = (fsOpTotalMs - prevFsMs).toFixed(0);
    logPhase(
      `heartbeat #${heartbeat} (fs: +${newOps} ops/+${newMs}ms, total: ${fsOpCount} ops/${fsOpTotalMs.toFixed(0)}ms)`,
    );
    // Flush slow ops summary at each heartbeat
    if (fsSlowOps.length > 0) {
      const summary = {};
      for (const op of fsSlowOps) {
        const key = op.name;
        summary[key] = (summary[key] || 0) + 1;
      }
      const parts = Object.entries(summary)
        .map(([k, v]) => `${k}:${v}`)
        .join(", ");
      logPhase(`  slow fs ops since last heartbeat: ${parts}`);
      fsSlowOps = [];
    }
    prevFsOps = fsOpCount;
    prevFsMs = fsOpTotalMs;
    if (heartbeat >= 60) clearInterval(iv);
  }, 1000);
  if (iv.unref) iv.unref();
});

// Log when the gateway starts listening (detect via stdout write)
const origStdoutWrite = process.stdout.write;
process.stdout.write = function (chunk, ...args) {
  const str = typeof chunk === "string" ? chunk : chunk.toString();
  if (str.includes("listening on")) {
    logPhase(
      `gateway listening (READY) — ${fsOpCount} fs ops/${fsOpTotalMs.toFixed(0)}ms total`,
    );
  }
  return origStdoutWrite.call(this, chunk, ...args);
};

// Log at process exit for total lifetime
process.on("exit", () => {
  logPhase("process exiting");
});
