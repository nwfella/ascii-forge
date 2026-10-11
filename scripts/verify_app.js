#!/usr/bin/env node
/*
 * verify_app.js — gate for ascii-forge.
 *
 *   1. static checks on index.html (self-contained, no external requests, DOM ids resolve)
 *   2. extracts the CORE block out of index.html and exercises it in Node
 *   3. end-to-end assertions on the actual product claim:
 *      boosting a dim photo expands local contrast and ink at the cost of tonal fidelity
 *
 * Zero dependencies. Exit code 0 = green.
 *
 *   node scripts/verify_app.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HTML_PATH = path.join(ROOT, "index.html");

let pass = 0;
const failures = [];
let group = "";

function section(name) {
  group = name;
  console.log("\n\x1b[1m" + name + "\x1b[0m");
}
function ok(name, detail) {
  pass++;
  console.log("  \x1b[32m✓\x1b[0m " + name + (detail ? "  \x1b[90m" + detail + "\x1b[0m" : ""));
}
function bad(name, detail) {
  failures.push(group + " → " + name + (detail ? " (" + detail + ")" : ""));
  console.log("  \x1b[31m✗ " + name + "\x1b[0m" + (detail ? "  \x1b[31m" + detail + "\x1b[0m" : ""));
}
function check(name, cond, detail) {
  cond ? ok(name, detail) : bad(name, detail);
}
function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

/* ------------------------------------------------------------------ *
 * 1. static checks
 * ------------------------------------------------------------------ */
function staticChecks(html) {
  section("index.html — static");

  check("file is present and decodes as UTF-8", html.length > 1000, html.length + " bytes");
  check("has an html5 doctype", /^<!doctype html>/i.test(html.trim()));
  check("declares a viewport (responsive)", /name="viewport"/.test(html));
  check(
    "is a single file with no <script src>",
    !/<script[^>]+\ssrc=/i.test(html),
    "all JS is inline"
  );
  check("no stylesheet links fetched", !/<link[^>]+rel="stylesheet"/i.test(html));
  check("no @import", !/@import/.test(html));

  const externalRefs = [
    [/fetch\s*\(/, "fetch("],
    [/XMLHttpRequest/, "XMLHttpRequest"],
    [/sendBeacon/, "sendBeacon"],
    [/\bnew WebSocket\b/, "WebSocket"],
    [/\bFormData\b/, "FormData"],
    [/importScripts/, "importScripts"],
    [/\bcdn\./i, "cdn."],
    [/unpkg\.com|jsdelivr|cdnjs|googleapis/i, "a CDN hostname"],
  ];
  let clean = true, why = "";
  for (const [re, label] of externalRefs) {
    if (re.test(html)) { clean = false; why = label; break; }
  }
  check("makes no network calls at runtime", clean, why || "no fetch/XHR/CDN references");

  const srcs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const offsite = srcs.filter((s) => /^https?:/i.test(s) && !s.startsWith("data:"));
  check(
    "no offsite subresources",
    offsite.every((s) => /github\.com\/nwfella\/ascii-forge/.test(s)),
    offsite.length ? offsite.join(", ") : "only the repo link"
  );

  check("core markers are present", /\/\* CORE-START/.test(html) && /\/\* CORE-END \*\//.test(html));

  /* every literal getElementById must resolve to an element in the markup */
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...html.matchAll(/\$\("([A-Za-z][\w-]*)"\)/g)].map((m) => m[1]));
  const missing = [...used].filter((u) => !ids.has(u));
  check(
    "every $(\"id\") resolves to real markup",
    missing.length === 0,
    missing.length ? "missing: " + missing.join(", ") : used.size + " ids referenced, all present"
  );

  /* the built-in demo must not be a network asset */
  check("demo image is synthesised, not fetched", /function demoSource\(\)/.test(html) && /toDataURL/.test(html));

  /* ---- webcam ---- */
  check("a webcam button exists under Source and is wired up",
    /id="camBtn"/.test(html) && /\$\("camBtn"\)\.addEventListener/.test(html),
    "button present in the Source card");
  check("the camera stream comes only from getUserMedia",
    /navigator\.mediaDevices\.getUserMedia/.test(html) && /audio: false/.test(html),
    "video only — the microphone is never requested");
  check("captured frames are read through a canvas, never uploaded",
    /drawImage\(v, 0, 0, w, h\)/.test(html) && /toDataURL\("image\/png"\)/.test(html) && !/enctype|multipart/.test(html));
  check("the camera is released on every exit path",
    /for \(const t of cam\.stream\.getTracks\(\)\) t\.stop\(\)/.test(html) &&
    (html.match(/camStop\(/g) || []).length >= 4,
    "stop on capture, on the stop button, on clear and on pagehide");
  check("permission failures are handled by name",
    /NotAllowedError/.test(html) && /NotFoundError/.test(html) && /NotReadableError/.test(html) &&
    /isSecureContext/.test(html),
    "denied / no camera / camera busy / insecure context");
  check("the live preview is mirrored to match the capture",
    /transform:scaleX\(-1\)/.test(html) && /x\.translate\(w, 0\); x\.scale\(-1, 1\)/.test(html),
    "what you see is what gets captured");
}

/* ------------------------------------------------------------------ *
 * 2. extract the core
 * ------------------------------------------------------------------ */
function extractCore(html) {
  const m = html.match(/\/\* CORE-START[\s\S]*?\*\/([\s\S]*?)\/\* CORE-END \*\//);
  if (!m) throw new Error("CORE block not found between the CORE-START / CORE-END markers");
  const body = m[1];
  const fn = new Function(body + "\nreturn Core;");
  return fn();
}

/* ------------------------------------------------------------------ *
 * synthetic "dim photo": a noisy near-black frame with a low-contrast subject
 * in it — the same class of input the whole project exists to handle.
 *
 * It deliberately contains the things that make a real dim photo hard, matching the
 * measured profile of the reference low-light portrait (frame mean ~54/255, subject
 * only slightly brighter than the wall it sits against, one blown highlight):
 *   - a wall with recoverable low contrast detail (24..52 grey)
 *   - a subject that OVERLAPS the wall's range (46..75 grey), so crushing the floor
 *     is what makes it stand out
 *   - a highlight that is already clipped
 * The pipeline trades some of the wall's detail for subject legibility; the gate
 * measures that trade rather than assuming it.
 * ------------------------------------------------------------------ */
function makeDimPortrait(w, h) {
  const g = new Uint8ClampedArray(w * h);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const cx = w * 0.48, cy = h * 0.46, rx = w * 0.21, ry = h * 0.25;
  const face = [], bg = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, u = x / w, v = y / h;
      /* back wall: dim vertical gradient carrying its own faint detail */
      let val = 30 + 16 * v + 6 * Math.sin(u * 11.0) * Math.sin(v * 7.0);
      const nx = (x - cx) / rx, ny = (y - cy) / ry;
      const inside = nx * nx + ny * ny <= 1;
      if (inside) {
        val = 46 + 22 * (1 - (nx * nx + ny * ny)) + 7 * (nx < 0 ? 1 : 0);
        const dex = Math.abs(nx) - 0.42, dey = ny + 0.25;
        if (dex * dex + dey * dey < 0.02) val -= 15;                 /* eye sockets */
        if (Math.abs(nx) < 0.11 && Math.abs(ny) < 0.22) val += 11;   /* nose ridge */
        if (ny > 0.5 && Math.abs(nx) < 0.3) val -= 8;                /* mouth shadow */
      }
      const window = u > 0.80 && v < 0.14;
      if (window) val = 150 + 120 * (u - 0.80) / 0.20 - 60 * v;      /* already blown */
      g[i] = Math.max(0, Math.min(255, val + (rnd() - 0.5) * 12));
      if (inside) face.push(i); else if (!window) bg.push(i);
    }
  }
  return { gray: { data: g, w, h, ch: 1 }, face, bg };
}

/* region-aware readout used by both the assertions and --probe */
function regions(Core, src, out) {
  const { w, h } = src.gray;
  const face = [], back = [];
  for (let y = 0; y < out.rows; y++) {
    for (let x = 0; x < out.cols; x++) {
      const sx = Math.floor(x * w / out.cols), sy = Math.floor(y * h / out.rows);
      const u = sx / w, v = sy / h;
      const inFace = u > 0.27 && u < 0.69 && v > 0.21 && v < 0.71;
      const inWindow = u > 0.78 && v < 0.16;
      if (inFace) face.push(out.levels[y * out.cols + x]);
      else if (!inWindow) back.push(out.levels[y * out.cols + x]);
    }
  }
  return {
    face: stats(face),
    back: stats(back),
    faceChars: new Set(face).size,
    backBlank: back.filter((v) => v === 0).length / back.length,
  };
}

function stats(arr) {
  const n = arr.length;
  let m = 0;
  for (const v of arr) m += v;
  m /= n;
  let s = 0;
  for (const v of arr) s += (v - m) * (v - m);
  return { mean: m, sd: Math.sqrt(s / n) };
}

const RAMP70 = " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@";

/* filled from the extracted core so the gate tests the presets that actually ship */
let SHIPPED = null;

function baseOpts(over) {
  return Object.assign(
    {
      cols: 120, cell: 0.52, ramp: RAMP70, invert: false, dither: false,
      denoise: true, blackPoint: 20, whitePoint: 2, contrast: 6, gamma: 0.42, sharpen: 110,
    },
    SHIPPED || {},
    over || {}
  );
}

/* ------------------------------------------------------------------ *
 * 3. core assertions
 * ------------------------------------------------------------------ */
function coreChecks(Core) {
  section("Core — primitives");

  check("lanczos is a valid reconstruction kernel",
    near(Core.lanczos(0, 3), 1, 1e-12) &&
    Core.lanczos(3, 3) === 0 && Core.lanczos(4, 3) === 0 &&
    near(Core.lanczos(-0.5, 3), Core.lanczos(0.5, 3), 1e-12) &&
    Core.lanczos(1.5, 3) < 0,
    "unit at 0, zero at ±3, symmetric, negative lobe");

  let sumsOk = true;
  for (const [s, d] of [[100, 20], [640, 320], [37, 200], [10, 1], [500, 499]]) {
    for (const t of Core.weightTable(s, d, 3)) {
      let sum = 0;
      for (let i = 0; i < t.n; i++) sum += t.w[i];
      if (!near(sum, 1, 1e-9)) sumsOk = false;
      if (t.left < 0 || t.left + t.n > s) sumsOk = false;
    }
  }
  check("resampling weights always sum to 1 and stay in bounds", sumsOk, "5 source/dest ratios");

  const g1 = Core.makeImage(64, 64, 1);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) g1.data[y * 64 + x] = x * 4;
  const idn = Core.resample(g1, 64, 64, 3);
  let maxErr = 0;
  for (let i = 0; i < g1.data.length; i++) maxErr = Math.max(maxErr, Math.abs(idn.data[i] - g1.data[i]));
  check("resample at 1:1 is effectively the identity", maxErr <= 2, "max error " + maxErr);

  const down = Core.resample(g1, 16, 16, 3);
  let mono = true;
  for (let x = 0; x < 16; x++) {
    const first = down.data[x];
    for (let y = 0; y < 16; y++) if (Math.abs(down.data[y * 16 + x] - first) > 3) mono = false;
    if (x > 0 && down.data[x] < down.data[x - 1] - 3) mono = false;
  }
  check("downsampling a horizontal gradient keeps it flat per column and monotonic", mono);

  section("Core — tone");

  const hist = new Uint32Array(256);
  for (let i = 0; i < 1000; i++) hist[10 + (i % 40)]++;
  const lev = Core.levelLut(hist, 1000, 20, 0);
  check("black-point crush moves the black level up", lev.lo > 10 && lev.lo < 30, "lo=" + lev.lo);
  let monoLut = true;
  for (let i = 1; i < 256; i++) if (lev.lut[i] < lev.lut[i - 1]) monoLut = false;
  check("level LUT is monotonic", monoLut);
  check("level LUT maps the clipped floor to 0 and the ceiling to 255",
    lev.lut[lev.lo] === 0 && lev.lut[lev.hi] === 255, "hi=" + lev.hi);

  const sig = Core.sigmoidLut(6);
  let monoSig = true;
  for (let i = 1; i < 256; i++) if (sig[i] < sig[i - 1]) monoSig = false;
  check("sigmoid LUT is monotonic, centred, and compresses both ends",
    monoSig && sig[0] < 20 && sig[255] > 235 && near(sig[128], 128, 3),
    "0→" + sig[0] + " 128→" + sig[128] + " 255→" + sig[255]);

  const rampEdge = Core.makeImage(16, 16, 1);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) rampEdge.data[y * 16 + x] = x * 17;
  const sigged = Core.applyLut(rampEdge, sig);
  const stretched = Core.stretchLut(Core.histogram(sigged));
  check("stretchLut puts the compressed sigmoid range back to 0..255",
    stretched !== null && stretched[sigged.data[0]] === 0 && stretched[sigged.data[255]] === 255,
    sigged.data[0] + "→" + (stretched ? stretched[sigged.data[0]] : "n/a") +
    " " + sigged.data[255] + "→" + (stretched ? stretched[sigged.data[255]] : "n/a"));
  check("stretchLut refuses a flat image instead of dividing by zero",
    Core.stretchLut(Core.histogram(Core.makeImage(4, 4, 1, 77))) === null);

  const gam = Core.gammaLut(0.8);
  check("gamma < 1 brightens the midtones", gam[128] > 130 && gam[0] === 0 && gam[255] === 255,
    "128→" + gam[128]);

  const dark = Core.makeImage(20, 20, 1, 40);
  const tune = Core.autoTune(dark);
  check("autoTune returns usable settings for a flat dark frame",
    tune.blackPoint >= 0 && tune.whitePoint >= 0 && tune.gamma >= 0.35 && tune.gamma <= 1.8,
    JSON.stringify(tune));

  const dim = makeDimPortrait(160, 200);
  const tune2 = Core.autoTune(dim.gray);
  check("autoTune brightens a genuinely dark frame", tune2.gamma < 1, "gamma=" + tune2.gamma);
  check("medianLuma reports the dark frame as dark", Core.medianLuma(dim.gray) < 90,
    "median=" + Core.medianLuma(dim.gray));

  section("Core — filters");

  const imp = Core.makeImage(9, 9, 1, 100);
  imp.data[4 * 9 + 4] = 255;
  const den = Core.median3(imp);
  check("3x3 median removes a single-pixel impulse", den.data[4 * 9 + 4] === 100,
    "spike 255 → " + den.data[4 * 9 + 4]);
  check("3x3 median leaves a flat field untouched", den.data[0] === 100);
  check("median3 preserves dimensions", den.w === 9 && den.h === 9);

  const flat = Core.makeImage(16, 16, 1, 137);
  const blurred = Core.blur(flat, 1.2);
  let blurErr = 0;
  for (const v of blurred.data) blurErr = Math.max(blurErr, Math.abs(v - 137));
  check("blur is edge-safe on a constant field", blurErr <= 1, "max drift " + blurErr);

  const noSharpen = Core.unsharp(imp, 1.2, 0, 4);
  check("unsharp with amount 0 is a passthrough", noSharpen.data[4 * 9 + 4] === 255);

  section("Core — quantisation");

  const qs = Core.makeImage(4, 1, 1);
  qs.data.set([0, 100, 200, 255]);
  const q = Core.quantize(qs, 9);
  check("quantize spans the ramp exactly", q[0] === 0 && q[3] === 9, Array.from(q).join(","));

  const half = Core.makeImage(32, 32, 1, 128);
  const dh = Core.ditherFS(half, 3);
  const used = new Set(dh);
  let sum = 0;
  for (const v of dh) sum += v;
  check("dither uses more than one level on a flat mid-grey", used.size >= 2, "levels: " + [...used].sort().join(","));
  check("dither preserves the mean tone", near(sum / dh.length, 128 * 3 / 255, 0.15),
    "mean level " + (sum / dh.length).toFixed(3) + " vs ideal " + (128 * 3 / 255).toFixed(3));
  let inRange = true;
  for (const v of dh) if (v < 0 || v > 3) inRange = false;
  check("dither never escapes the ramp range", inRange);

  const txt = Core.levelsToText(new Int16Array([0, 3, 9]), 3, 1, RAMP70);
  check("levelsToText indexes the ramp literally", txt[0] === RAMP70[0] + RAMP70[3] + RAMP70[9] && txt.length === 1);

  section("Core — measurement");

  const a1 = new Float64Array([10, 20, 30, 40, 50]);
  const a2 = new Float64Array([12, 22, 32, 42, 52]);
  const a3 = new Float64Array([110, 100, 90, 80, 70]);
  check("pearson: identical arrays score 1", near(Core.pearson(a1, a1), 1, 1e-12));
  check("pearson: correlated arrays score ~1", Core.pearson(a1, a2) > 0.999, Core.pearson(a1, a2).toFixed(4));
  check("pearson: inverted arrays score -1", near(Core.pearson(a1, a3), -1, 1e-12));
  check("pearson: a flat array cannot divide by zero",
    Core.pearson(new Float64Array([5, 5, 5]), a1.slice(0, 3)) === 0);
}

/* ------------------------------------------------------------------ *
 * 4. the product claim, measured
 * ------------------------------------------------------------------ */
function endToEnd(Core) {
  section("End-to-end — forge a dim photo");

  const { gray } = makeDimPortrait(240, 300);
  const src = { gray, rgb: null };

  const faithful = Core.forge(src, baseOpts({ blackPoint: 0, whitePoint: 0, contrast: 0, gamma: 1, sharpen: 0 }));
  const boosted = Core.forge(src, baseOpts());
  const dithered = Core.forge(src, baseOpts({ dither: true, ramp: Core.RAMPS.standard, cols: 100 }));

  const auto = Core.forge(src, baseOpts(Core.autoTune(gray)));
  const fR = regions(Core, src, faithful);
  const bR = regions(Core, src, boosted);
  const aR = regions(Core, src, auto);

  const row = (n, o, r) => console.log("    \x1b[90m" + n.padEnd(9) + " \u2192 tonal " + o.tonalMatch.toFixed(3) +
    " · subject sd " + r.face.sd.toFixed(2) + " · subject chars " + r.faceChars +
    " · background blank " + (r.backBlank * 100).toFixed(0) + "%\x1b[0m");
  row("faithful", faithful, fR);
  row("boosted", boosted, bR);
  row("auto", auto, aR);

  check("grid matches the requested columns", boosted.cols === 120 && faithful.cols === 120);
  check("row count follows the source aspect and cell ratio",
    boosted.rows === Math.round(gray.h / gray.w * 120 * 0.52),
    boosted.rows + " rows for 300x240 at 120 cols");

  const shaped = [
    [faithful, Core.RAMPS.classic],
    [boosted, Core.RAMPS.classic],
    [dithered, Core.RAMPS.standard],
  ];
  let shapeOk = true, why = "";
  for (const [out, allowed] of shaped) {
    if (out.lines.length !== out.rows) { shapeOk = false; why = "line count"; break; }
    for (const line of out.lines) {
      if (line.length !== out.cols) { shapeOk = false; why = "ragged line of length " + line.length; break; }
      for (const ch of line) if (allowed.indexOf(ch) < 0) { shapeOk = false; why = "stray char " + JSON.stringify(ch); break; }
    }
  }
  check("every line is exactly cols wide and uses only ramp characters", shapeOk, why);

  /* ---- the product claim, measured ---- */

  check("the dim preset expands contrast inside the subject",
    bR.face.sd > fR.face.sd * 1.15,
    "subject level sd " + fR.face.sd.toFixed(2) + " → " + bR.face.sd.toFixed(2));
  check("the auto-tune default expands contrast inside the subject",
    aR.face.sd > fR.face.sd * 1.15,
    "subject level sd " + fR.face.sd.toFixed(2) + " → " + aR.face.sd.toFixed(2));
  check("the auto-tune default is no worse than the hand-tuned preset",
    aR.face.sd >= bR.face.sd * 0.95,
    "auto " + aR.face.sd.toFixed(2) + " vs dim preset " + bR.face.sd.toFixed(2));
  check("both resolve more distinct characters on the subject",
    bR.faceChars >= fR.faceChars + 8 && aR.faceChars >= fR.faceChars + 8,
    "faithful " + fR.faceChars + " → boost " + bR.faceChars + " / auto " + aR.faceChars);
  check("both drive the background to blank space",
    bR.backBlank > 0.2 && aR.backBlank > 0.2 && fR.backBlank < 0.05,
    "background blank " + (fR.backBlank * 100).toFixed(0) + "% → boost " +
    (bR.backBlank * 100).toFixed(0) + "% / auto " + (aR.backBlank * 100).toFixed(0) + "%");
  check("shaping the tones costs tonal fidelity — and the app reports the cost",
    boosted.tonalMatch < faithful.tonalMatch - 0.01 && auto.tonalMatch < faithful.tonalMatch,
    "tonal match " + faithful.tonalMatch.toFixed(3) + " → boost " + boosted.tonalMatch.toFixed(3) +
    " / auto " + auto.tonalMatch.toFixed(3));
  check("the faithful preset really is faithful", faithful.tonalMatch > 0.9,
    "tonal match " + faithful.tonalMatch.toFixed(3));
  check("the shaped renders are still recognisably the same image",
    boosted.tonalMatch > 0.5 && auto.tonalMatch > 0.5,
    "boost " + boosted.tonalMatch.toFixed(3) + " / auto " + auto.tonalMatch.toFixed(3));
  check("an inverted render is reported as not matching the photo at all",
    Core.forge(src, baseOpts({ invert: true })).tonalMatch < 0,
    "tonal match " + Core.forge(src, baseOpts({ invert: true })).tonalMatch.toFixed(3));
  check("the final stretch adds blanking on top of the crush",
    Core.forge(src, baseOpts({ stretch: false })).ink > boosted.ink + 0.1,
    "ink without stretch " + (Core.forge(src, baseOpts({ stretch: false })).ink * 100).toFixed(0) +
    "% vs " + (boosted.ink * 100).toFixed(0) + "%");

  section("End-to-end — determinism and edges");

  const again = Core.forge(src, baseOpts());
  check("identical options give byte-identical output",
    again.lines.join("\n") === boosted.lines.join("\n"));

  const inverted = Core.forge(src, baseOpts({ invert: true }));
  const n = Core.RAMPS.classic.length - 1;
  let invOk = true;
  for (let i = 0; i < boosted.levels.length; i++) if (boosted.levels[i] + inverted.levels[i] !== n) invOk = false;
  check("invert mirrors every cell across the ramp", invOk);

  for (const [w, h, cols, cell] of [[1, 500, 30, 0.52], [500, 1, 30, 0.52], [300, 300, 320, 0.75], [64, 64, 30, 0.35]]) {
    const im = Core.makeImage(w, h, 1, 90);
    for (let i = 0; i < im.data.length; i++) im.data[i] = (i * 7) % 256;
    const o = Core.forge({ gray: im, rgb: null }, baseOpts({ cols, cell }));
    check("extreme geometry " + w + "x" + h + " @ " + cols + " cols survives",
      o.lines.length === o.rows && o.rows >= 1 && o.lines.every((l) => l.length === cols),
      o.cols + "x" + o.rows);
  }

  const flatSrc = { gray: Core.makeImage(200, 200, 1, 0), rgb: null };
  const flatOut = Core.forge(flatSrc, baseOpts());
  check("an all-black image does not produce NaN or crash",
    flatOut.lines.length === flatOut.rows && Number.isFinite(flatOut.tonalMatch),
    "tonal match " + flatOut.tonalMatch.toFixed(3));

  const colorGrid = Core.makeImage(8, 8, 4);
  for (let i = 0; i < colorGrid.data.length; i += 4) {
    colorGrid.data[i] = 200; colorGrid.data[i + 1] = 60; colorGrid.data[i + 2] = 90; colorGrid.data[i + 3] = 255;
  }
  const colorOut = Core.forge({ gray: Core.toGray(colorGrid.data, 8, 8), rgb: colorGrid }, baseOpts({ cols: 8, cell: 1 }));
  check("colour grid is returned at exactly the character grid size",
    colorOut.rgb && colorOut.rgb.w === colorOut.cols && colorOut.rgb.h === colorOut.rows && colorOut.rgb.ch === 4,
    colorOut.rgb ? colorOut.rgb.w + "x" + colorOut.rgb.h + " ch" + colorOut.rgb.ch : "none");

  check("toGray uses Rec.709 luma",
    Core.toGray(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1).data[0] === 54,
    "pure red → " + Core.toGray(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1).data[0]);

  section("Core — ramps");

  const levels = Object.keys(Core.RAMPS).map((k) => [k, Core.RAMPS[k].length]);
  for (const [k, len] of levels) {
    const r = Core.RAMPS[k];
    check("ramp '" + k + "' is usable", len >= 2 && r[0] === " " && r[len - 1] !== " ",
      len + " levels, starts blank");
  }
  check("the classic ramp is long enough for fine tonal work",
    Core.RAMPS.classic.length >= 60, Core.RAMPS.classic.length + " levels");
  check("the shipped classic ramp still matches this gate's golden copy",
    Core.RAMPS.classic === RAMP70,
    "an edit to the ramp must be a deliberate, mirrored change");
}

/* ------------------------------------------------------------------ *
 * every shipped preset must be usable, in range, and convert cleanly
 * ------------------------------------------------------------------ */
function presetChecks(Core) {
  section("Shipped presets");

  const { gray } = makeDimPortrait(240, 300);
  const src = { gray, rgb: null };
  const keys = Object.keys(Core.PRESETS);
  check("there is a preset set to choose from", keys.length >= 4, keys.join(", "));

  const RANGES = { blackPoint: [0, 60], whitePoint: [0, 20], contrast: [0, 16], gamma: [0.3, 1.8], sharpen: [0, 300] };
  let ran = 0, inRange = true, rampOk = true, why = "";

  for (const k of keys) {
    const p = Core.PRESETS[k];
    if (!p.label || !p.tip || !p.s) { inRange = false; why = k + " is missing label / tip / s"; continue; }
    if (!Core.RAMPS[p.s.ramp]) { rampOk = false; why = k + " points at unknown ramp '" + p.s.ramp + "'"; }
    for (const f of Object.keys(RANGES)) {
      const v = p.s[f];
      if (typeof v !== "number" || v < RANGES[f][0] || v > RANGES[f][1]) {
        inRange = false;
        why = k + "." + f + " = " + v + " is outside the slider range " + RANGES[f].join("..");
      }
    }
    const out = Core.forge(src, baseOpts(Object.assign({}, p.s, { ramp: Core.RAMPS[p.s.ramp], cols: 100 })));
    if (out.lines.length !== out.rows || !out.lines.every((l) => l.length === out.cols) || !Number.isFinite(out.tonalMatch)) {
      inRange = false; why = k + " produced an invalid grid";
    }
    ran++;
  }
  check("every preset names a ramp that exists in Core.RAMPS", rampOk,
    why || keys.length + " presets checked");
  check("every preset's numbers sit inside the sliders' ranges", inRange,
    why || "so the UI can never display a value the slider cannot hold");
  check("every preset converts cleanly", ran === keys.length, ran + " presets ran through forge");

  const dim = Core.PRESETS.dim.s;
  check("the dim preset brightens and crushes, as its name promises",
    dim.gamma < 1 && dim.blackPoint > 0 && dim.contrast > 0,
    "black " + dim.blackPoint + "% · white " + dim.whitePoint + "% · gamma " + dim.gamma + " · sigmoid " + dim.contrast);
}

/* ------------------------------------------------------------------ */
function main() {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  staticChecks(html);

  let Core;
  try {
    Core = extractCore(html);
  } catch (e) {
    bad("extract CORE from index.html", e.message);
    report();
    return;
  }
  ok("extracted the CORE block from index.html", Object.keys(Core).length + " exported functions");

  SHIPPED = (function () {
    const p = Core.PRESETS.dim.s;
    return { denoise: p.denoise, blackPoint: p.blackPoint, whitePoint: p.whitePoint,
             contrast: p.contrast, gamma: p.gamma, sharpen: p.sharpen };
  })();

  coreChecks(Core);
  endToEnd(Core);
  presetChecks(Core);
  report();
}

function report() {
  console.log("\n" + "─".repeat(64));
  if (failures.length === 0) {
    console.log("\x1b[32m\x1b[1mGREEN\x1b[0m — " + pass + " assertions passed");
    process.exit(0);
  }
  console.log("\x1b[31m\x1b[1mRED\x1b[0m — " + pass + " passed, " + failures.length + " failed");
  for (const f of failures) console.log("  \x1b[31m•\x1b[0m " + f);
  process.exit(1);
}

main();
