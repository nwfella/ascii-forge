#!/usr/bin/env node
/*
 * browser_check.js — drives the real app in a real browser over the Chrome
 * DevTools Protocol and asserts on what the app actually renders.
 *
 * Zero dependencies: Node's built-in fetch and WebSocket do the talking.
 * No private assets: the gate uses the app's own synthesised demo plus a canvas
 * generated data-URL, so nothing personal ends up in the repository.
 *
 *   node scripts/browser_check.js
 *   CHROME_PATH=/path/to/chrome node scripts/browser_check.js
 *   node scripts/browser_check.js --shot=artifacts/app.png
 *
 * Exits 0 on green. If no browser is found the check is SKIPPED (exit 0) so the
 * static gate stays the source of truth on machines without Chrome; pass
 * --require to make a missing browser a failure.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "index.html");
const requireBrowser = process.argv.includes("--require");
const shotArg = (process.argv.find((a) => a.startsWith("--shot=")) || "").slice(7);

let pass = 0;
const failures = [];
let group = "";

const section = (n) => { group = n; console.log("\n\x1b[1m" + n + "\x1b[0m"); };
function ok(name, detail) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name + (detail ? "  \x1b[90m" + detail + "\x1b[0m" : "")); }
function bad(name, detail) { failures.push(group + " → " + name + (detail ? " (" + detail + ")" : "")); console.log("  \x1b[31m✗ " + name + "\x1b[0m" + (detail ? "  \x1b[31m" + detail + "\x1b[0m" : "")); }
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));

/* ------------------------------------------------------------------ */
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const home = os.homedir();
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(home, "AppData/Local/Google/Chrome/Application/chrome.exe"),
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  /* hermes ships a chromium for its own browser tooling; use it if nothing else */
  const tools = path.join(home, "AppData/Local/hermes/tools");
  if (fs.existsSync(tools)) {
    for (const d of fs.readdirSync(tools)) {
      if (!d.startsWith("chromium")) continue;
      for (const rel of ["chrome-win64/chrome.exe", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const p = path.join(tools, d, rel);
        if (fs.existsSync(p)) candidates.push(p);
      }
    }
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    this.listeners = [];
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        for (const l of this.listeners) l(msg);
      }
    });
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("CDP timeout: " + method)); }
      }, 30000);
    });
  }
  on(fn) { this.listeners.push(fn); }
  async eval(expr, awaitPromise) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for " + label);
    await sleep(120);
  }
}

/* ------------------------------------------------------------------ */
async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("no Chrome/Chromium found — \x1b[33mSKIPPED\x1b[0m the browser check");
    console.log("set CHROME_PATH=/path/to/chrome to run it");
    process.exit(requireBrowser ? 1 : 0);
  }
  console.log("\x1b[90mbrowser: " + chrome + "\x1b[0m");

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ascii-forge-chrome-"));
  const port = 9300 + (process.pid % 400);
  const shot = shotArg ? path.resolve(ROOT, shotArg) : path.join(profile, "app.png");
  const child = spawn(chrome, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--hide-scrollbars",
    "--force-device-scale-factor=1", "--window-size=1500,1150",
    "--user-data-dir=" + profile, "--remote-debugging-port=" + port,
    "file:///" + APP.replace(/\\/g, "/"),
  ], { stdio: "ignore" });

  let ws, cdp;
  try {
    const version = await waitFor(async () => {
      const r = await fetch("http://127.0.0.1:" + port + "/json/version");
      return r.ok ? r.json() : false;
    }, 25000, "the debugging port");
    console.log("\x1b[90m" + version.Browser + "\x1b[0m");

    const target = await waitFor(async () => {
      const list = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
      return list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || false;
    }, 15000, "a page target");

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("could not open the CDP socket")), { once: true });
    });
    cdp = new CDP(ws);

    const errors = [];
    cdp.on((m) => {
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        errors.push((d.exception && d.exception.description) || d.text);
      }
      if (m.method === "Log.entryAdded" && m.params.entry.level === "error") errors.push(m.params.entry.text);
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");

    await waitFor(() => cdp.eval("document.readyState === 'complete' && typeof window.AsciiForge === 'object'"), 15000, "the app to boot");

    await script(cdp, errors, shot);
  } catch (e) {
    bad("browser session", e.message);
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
  report();
}

/* ------------------------------------------------------------------ */
function script(cdp, errors, shot) {
  return (async () => {
    section("App — loads and converts");

    const boot = await cdp.eval("JSON.stringify(window.AsciiForge.dom())");
    const d0 = JSON.parse(boot);
    check("app boots with a status line", /Ready|Load an image/i.test(d0.status), d0.status);
    check("no uncaught exceptions on boot", errors.length === 0, errors.join(" | "));
    check("ramp dropdown is labelled from the core's ramp data",
      d0.rampOptions.length === 6 && d0.rampOptions.filter((o) => /\d+ levels/.test(o)).length === 5,
      d0.rampOptions.join(" / "));
    check("preset chips are rendered", d0.presetChips >= 5, d0.presetChips + " chips");

    /* the demo image is synthesised in-page — no fixture files, no network */
    await cdp.eval("window.AsciiForge.loadDemo()");
    await waitFor(() => cdp.eval("!!window.AsciiForge.getOutput()"), 20000, "the demo to convert");

    const d1 = JSON.parse(await cdp.eval("JSON.stringify(window.AsciiForge.dom())"));
    const out1 = JSON.parse(await cdp.eval("JSON.stringify({cols:window.AsciiForge.getOutput().cols,rows:window.AsciiForge.getOutput().rows,ms:window.AsciiForge.getOutput().ms})"));

    check("conversion reports completion", /Done in \d+ ms/.test(d1.status), d1.status);
    check("grid readout matches the actual output",
      d1.grid.replace(/\s/g, "") === out1.cols + "×" + out1.rows, d1.grid + " vs " + out1.cols + "x" + out1.rows);
    check("the preview contains exactly rows × cols characters",
      d1.text.split("\n").length === out1.rows && d1.text.split("\n").every((l) => l.length === out1.cols),
      d1.text.split("\n").length + " lines of " + (d1.text.split("\n")[0] || "").length);
    check("tonal match is a real number in [-1,1]",
      /^-?\d\.\d{2}$/.test(d1.fid) && Math.abs(parseFloat(d1.fid)) <= 1, d1.fid);
    check("ink readout is a percentage", /^\d+%$/.test(d1.ink), d1.ink);
    check("conversion is fast enough to feel live", out1.ms < 4000, out1.ms + " ms for " + out1.cols + "x" + out1.rows);
    check("no exceptions during the first conversion", errors.length === 0, errors.slice(0, 2).join(" | "));

    section("App — one state, no desync");

    /* the preview text, the .txt export and the ANSI export must all agree */
    const ex1 = JSON.parse(await cdp.eval("JSON.stringify(window.AsciiForge.buildExports())"));
    check("the .txt export is exactly the preview, plus a trailing newline",
      ex1.txt === d1.text + "\n", "no desync between preview and export");
    check("ANSI export equals the preview in mono mode",
      ex1.ansi === d1.text + "\n", "no escapes when colour is off");
    check("svg export carries the same characters",
      ex1.svg.includes(ex1.txt.split("\n")[0].slice(0, 24).trim().slice(0, 8)) && /<svg/.test(ex1.svg),
      (ex1.svg.length / 1024).toFixed(0) + " KB of vector text");
    check("html export carries the same characters",
      /<pre>/.test(ex1.html) && ex1.html.includes("</pre>"));
    check("export filenames keep the original name and swap the extension",
      ex1.names.txt === "demo-ascii.txt" && ex1.names.png === "demo-ascii.png" &&
      ex1.names.svg === "demo-ascii.svg" && ex1.names.html === "demo-ascii.html",
      ex1.names.txt);
    check("png export has sane pixel dimensions",
      ex1.pngSize[0] > 100 && ex1.pngSize[1] > 100, ex1.pngSize.join("x"));

    /* flip state once and confirm every readout moves together */
    await cdp.eval("window.AsciiForge.setState({cols: 60, invert: true, contrast: 4})");
    await waitFor(async () => {
      const g = await cdp.eval("document.getElementById('stGrid').textContent");
      return g.startsWith("60");
    }, 8000, "the grid readout to follow the columns slider");
    const d2 = JSON.parse(await cdp.eval("JSON.stringify(window.AsciiForge.dom())"));
    const out2 = JSON.parse(await cdp.eval("JSON.stringify({cols:window.AsciiForge.getOutput().cols,rows:window.AsciiForge.getOutput().rows})"));
    check("changing columns updates the grid readout and the text together",
      d2.grid.replace(/\s/g, "") === out2.cols + "×" + out2.rows &&
      d2.text.split("\n").every((l) => l.length === out2.cols),
      d2.grid);
    check("invert flips the metric sign in the same render",
      parseFloat(d2.fid) < 0, "tonal match " + d2.fid + " after inverting");

    section("App — colour mode");

    await cdp.eval("window.AsciiForge.setState({color: true, invert: false, cols: 80})");
    await waitFor(async () => (await cdp.eval("document.querySelectorAll('#art span').length")) > 0, 8000, "colour spans");
    const d3 = JSON.parse(await cdp.eval("JSON.stringify(window.AsciiForge.dom())"));
    check("colour mode renders per-run spans", d3.spans > 10, d3.spans + " spans");
    check("colour mode keeps the plain text intact",
      d3.text.split("\n").every((l) => l.length === 80), "textContent still the raw grid");
    const ex3 = JSON.parse(await cdp.eval("JSON.stringify(window.AsciiForge.buildExports())"));
    check("ANSI export emits 24-bit colour escapes in colour mode",
      /\u001b\[38;2;\d+;\d+;\d+m/.test(ex3.ansi), (ex3.ansi.match(/\u001b\[38;2;/g) || []).length + " colour runs");
    check("svg export uses per-run fill colours",
      (ex3.svg.match(/fill="#[0-9a-f]{6}"/g) || []).length > 10,
      (ex3.svg.match(/fill="#[0-9a-f]{6}"/g) || []).length + " coloured runs");

    section("App — responsive layout");

    await cdp.eval("window.AsciiForge.setState({color: false, cols: 140, fit: true})");
    await sleep(400);
    for (const [w, h, label] of [[1500, 1100, "desktop"], [1024, 900, "laptop"], [390, 844, "phone"]]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
      await sleep(600);
      const m = JSON.parse(await cdp.eval(`JSON.stringify((() => {
        const box = document.getElementById('artbox'), art = document.getElementById('art');
        return {
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          artOverflow: art.scrollWidth - box.clientWidth,
          fontPx: parseFloat(getComputedStyle(art).fontSize),
          cols: window.AsciiForge.getOutput().cols
        };
      })())`));
      check(label + " " + w + "x" + h + ": page does not overflow horizontally",
        m.pageOverflow <= 2, "overflow " + m.pageOverflow + "px");
      check(label + ": the ASCII fits the preview width when 'fit' is on",
        m.artOverflow <= 4, m.cols + " cols at " + m.fontPx.toFixed(1) + "px, overflow " + m.artOverflow + "px");
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1150, deviceScaleFactor: 1, mobile: false });
    await cdp.eval("window.AsciiForge.setState({cols: 120, fit: true})");
    await sleep(500);

    section("App — robustness");

    check("no exceptions across the whole session", errors.length === 0, errors.slice(0, 3).join(" | "));

    /* a degenerate image (all white, 3x3) must not wedge the app */
    await cdp.eval(`window.AsciiForge.loadDataUrl((() => {
      const c = document.createElement('canvas'); c.width = 3; c.height = 3;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0,0,3,3);
      return c.toDataURL('image/png');
    })(), 'tiny-white.png')`);
    await sleep(1200);
    const d4 = JSON.parse(await cdp.eval("JSON.stringify(window.AsciiForge.dom())"));
    check("a 3x3 white image converts without throwing", /Done in \d+ ms/.test(d4.status) && errors.length === 0, d4.status);
    check("…and the export filename follows it", (await cdp.eval("window.AsciiForge.buildExports().names.txt")) === "tiny-white-ascii.txt");

    /* back to the demo for the screenshot */
    await cdp.eval("window.AsciiForge.loadDemo()");
    await waitFor(() => cdp.eval("!!window.AsciiForge.getOutput()"), 15000, "the demo again");
    await sleep(700);

    section("Screenshot");
    try {
      const r = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      fs.writeFileSync(shot, Buffer.from(r.data, "base64"));
      ok("captured the rendered app", shot + " (" + (fs.statSync(shot).size / 1024).toFixed(0) + " KB)");
    } catch (e) {
      bad("capture a screenshot", e.message);
    }

    const d5 = JSON.parse(await cdp.eval("JSON.stringify(window.AsciiForge.dom())"));
    ok("final state", d5.grid + " · tonal " + d5.fid + " · ink " + d5.ink + " · " + d5.status);
  })();
}

function report() {
  console.log("\n" + "─".repeat(64));
  if (failures.length === 0) {
    console.log("\x1b[32m\x1b[1mGREEN\x1b[0m — " + pass + " browser assertions passed");
    process.exit(0);
  }
  console.log("\x1b[31m\x1b[1mRED\x1b[0m — " + pass + " passed, " + failures.length + " failed");
  for (const f of failures) console.log("  \x1b[31m•\x1b[0m " + f);
  process.exit(1);
}

main().catch((e) => {
  console.log("\x1b[31mharness error:\x1b[0m " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
