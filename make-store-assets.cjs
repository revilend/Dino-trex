/* Generates the Google Play listing artwork for Pixel Dino: Parkour Run — the 1024x500 feature
   graphic and four 1920x1080 landscape screenshots — with no dependencies at
   all, using the same PNG encoder as the app icons.

   node make-store-assets.cjs

   The screenshots are not mock-ups.  The whole game is drawn with exactly two
   canvas calls — fillRect and fillText (see the ctx.* census in index.html) —
   with no alpha and no gradients, because every fade is a colour mix rather
   than a globalAlpha.  That means a frame can be rasterised exactly by
   implementing those two calls, and the four screenshots below are the real
   game, at a real 1920x1080, with the real HUD, the real boss and the real
   DINO PRO panel in them.

   Text needs a font, and there is no font file to load, so this ships its own
   5x7 pixel face.  Its advance is set to 0.6em — exactly Courier New's — so
   every label lands on the same pixel the real game puts it on, and the panel
   layouts in the screenshots are the real ones rather than an approximation. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { encodePNG, canvas, rect, px, hex } = require("./png.cjs");

/* ------------------------------- the font --------------------------------- */
/* Five cells wide, seven tall, one extra cell of side bearing — six cells of
   advance, which at 0.6em means one cell per 0.1em.  Courier's metrics, our
   own outlines. */
const GW = 5, GH = 7, CELL = 6;
const GLYPHS = {};
{
  const def = {
    "A": "01110 10001 10001 11111 10001 10001 10001",
    "B": "11110 10001 10001 11110 10001 10001 11110",
    "C": "01110 10001 10000 10000 10000 10001 01110",
    "D": "11110 10001 10001 10001 10001 10001 11110",
    "E": "11111 10000 10000 11110 10000 10000 11111",
    "F": "11111 10000 10000 11110 10000 10000 10000",
    "G": "01110 10001 10000 10111 10001 10001 01111",
    "H": "10001 10001 10001 11111 10001 10001 10001",
    "I": "11111 00100 00100 00100 00100 00100 11111",
    "J": "00111 00010 00010 00010 00010 10010 01100",
    "K": "10001 10010 10100 11000 10100 10010 10001",
    "L": "10000 10000 10000 10000 10000 10000 11111",
    "M": "10001 11011 10101 10101 10001 10001 10001",
    "N": "10001 11001 10101 10011 10001 10001 10001",
    "O": "01110 10001 10001 10001 10001 10001 01110",
    "P": "11110 10001 10001 11110 10000 10000 10000",
    "Q": "01110 10001 10001 10001 10101 10010 01101",
    "R": "11110 10001 10001 11110 10100 10010 10001",
    "S": "01111 10000 10000 01110 00001 00001 11110",
    "T": "11111 00100 00100 00100 00100 00100 00100",
    "U": "10001 10001 10001 10001 10001 10001 01110",
    "V": "10001 10001 10001 10001 10001 01010 00100",
    "W": "10001 10001 10001 10101 10101 11011 10001",
    "X": "10001 10001 01010 00100 01010 10001 10001",
    "Y": "10001 10001 01010 00100 00100 00100 00100",
    "Z": "11111 00001 00010 00100 01000 10000 11111",
    "0": "01110 10001 10011 10101 11001 10001 01110",
    "1": "00100 01100 00100 00100 00100 00100 01110",
    "2": "01110 10001 00001 00010 00100 01000 11111",
    "3": "11111 00010 00100 00010 00001 10001 01110",
    "4": "00010 00110 01010 10010 11111 00010 00010",
    "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "00110 01000 10000 11110 10001 10001 01110",
    "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110",
    "9": "01110 10001 10001 01111 00001 00010 01100",
    " ": "00000 00000 00000 00000 00000 00000 00000",
    ".": "00000 00000 00000 00000 00000 01100 01100",
    ",": "00000 00000 00000 00000 01100 00100 01000",
    ":": "00000 01100 01100 00000 01100 01100 00000",
    "-": "00000 00000 00000 11111 00000 00000 00000",
    "_": "00000 00000 00000 00000 00000 00000 11111",
    "/": "00001 00010 00010 00100 01000 01000 10000",
    "!": "00100 00100 00100 00100 00100 00000 00100",
    "?": "01110 10001 00001 00010 00100 00000 00100",
    "'": "00100 00100 01000 00000 00000 00000 00000",
    "(": "00010 00100 01000 01000 01000 00100 00010",
    ")": "01000 00100 00010 00010 00010 00100 01000",
    "<": "00010 00100 01000 10000 01000 00100 00010",
    ">": "01000 00100 00010 00001 00010 00100 01000",
    "=": "00000 00000 11111 00000 11111 00000 00000",
    "+": "00000 00100 00100 11111 00100 00100 00000",
    "*": "00000 10101 01110 11111 01110 10101 00000",
    "#": "01010 01010 11111 01010 11111 01010 01010",
    "%": "11001 11010 00010 00100 01000 01011 10011",
    "·": "00000 00000 00000 01100 00000 00000 00000",   /* middot, the game's list separator */
    "×": "00000 10001 01010 00100 01010 10001 00000",
    /* the two pictographs the game actually prints, drawn rather than skipped */
    "👑": "00000 01110 11111 11111 10001 10101 11011",
    "📶": "00010 00010 00110 00110 01110 01110 11110",
    "⚠": "00000 00100 01110 01110 11111 01010 01010"
  };
  for (const ch in def) GLYPHS[ch] = def[ch].split(" ");
}
/* Characters outside this face fall back to a filled cell, so an unmapped glyph
   is visible as a block rather than silently collapsing the whole line. */
const UNKNOWN = "11111 11111 11111 11111 11111 11111 11111";
const glyphOf = ch => GLYPHS[ch] || GLYPHS[ch.toUpperCase()] || UNKNOWN.split(" ");

/* ------------------------------ 2D surface -------------------------------- */
/* A pixel buffer with just enough of the canvas 2D context to run the game:
   an affine transform, opaque fillRect, and Courier-metric fillText. */
const IDENT = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
];
const xf = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/* scanline fill of a convex quad — the one primitive that covers fillRect and,
   with a rotation in the matrix, the one rotated draw the game ever does */
function quad(cv, p, col) {
  let lo = Infinity, hi = -Infinity;
  for (const q of p) { lo = Math.min(lo, q[1]); hi = Math.max(hi, q[1]); }
  const y0 = Math.max(0, Math.ceil(lo - 0.5)), y1 = Math.min(cv.h - 1, Math.floor(hi - 0.5));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    let a = Infinity, b = -Infinity;
    for (let i = 0; i < 4; i++) {
      const u = p[i], v = p[(i + 1) % 4];
      if ((u[1] <= yc && v[1] > yc) || (v[1] <= yc && u[1] > yc)) {
        const t = (yc - u[1]) / (v[1] - u[1]);
        const x = u[0] + (v[0] - u[0]) * t;
        a = Math.min(a, x); b = Math.max(b, x);
      }
    }
    if (a === Infinity) continue;
    for (let x = Math.max(0, Math.round(a)); x <= Math.min(cv.w - 1, Math.round(b) - 1); x++) px(cv, x, y, col);
  }
}
const rq = (cv, m, x, y, w, h, col) =>
  quad(cv, [xf(m, x, y), xf(m, x + w, y), xf(m, x + w, y + h), xf(m, x, y + h)], col);

const textWidth = (s, size) => s.length * size * 0.6;

/* Draw one line with its baseline at (x, y).  The glyph cell is size/10, so a
   five-wide glyph plus its side bearing is exactly 0.6em — Courier's advance —
   and a seven-tall glyph sits in the same ink box the test suite measures. */
function fillText(cv, m, s, x, y, size, col, align, ls) {
  const c = typeof col === "string" ? hex(col) : col;   /* px() wants rgb, not "#fff" */
  const cell = size / 10, adv = size * 0.6 + (ls || 0);
  let cx = x;
  if (align === "center") cx -= textWidth(s, size) / 2;
  else if (align === "right") cx -= textWidth(s, size);
  for (const raw of Array.from(s)) {
    const g = glyphOf(raw);
    for (let r = 0; r < GH; r++) {
      const row = g[r];
      for (let k = 0; k < GW; k++) {
        if (row[k] !== "1") continue;
        rq(cv, m, cx + k * cell, y - (GH - r) * cell, cell, cell, c);
      }
    }
    cx += adv;
  }
}

function surface(w, h, bg) {
  const cv = canvas(w, h, bg);
  let m = IDENT.slice();
  const s = {
    fillStyle: "#000000", font: "10px monospace", letterSpacing: "0px",
    textAlign: "left", textBaseline: "alphabetic", imageSmoothingEnabled: false,
    get _m() { return m; },
    setTransform(a, b, c, d, e, f) { m = [a, b, c, d, e, f]; },
    translate(x, y) { m = mul(m, [1, 0, 0, 1, x, y]); },
    rotate(r) { m = mul(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]); },
    save() {}, restore() {},
    scale(x, y) { m = mul(m, [x, 0, 0, y, 0, 0]); },
    fillRect(x, y, w, h) { if (w > 0 && h > 0) rq(cv, m, x, y, w, h, hex(s.fillStyle)); },
    measureText(t) { return { width: textWidth(t, s._size) }; },
    fillText(t, x, y) {
      fillText(cv, m, t, x, y, s._size, hex(s.fillStyle), s.textAlign, parseFloat(s.letterSpacing) || 0);
    }
  };
  Object.defineProperty(s, "_size", {
    get() { const m2 = /(\d+(?:\.\d+)?)px/.exec(s.font || ""); return m2 ? parseFloat(m2[1]) : 10; }
  });
  return { cv, ctx: new Proxy(s, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }) };
}

/* ------------------------- the game, in a sandbox ------------------------- */
const OUT_W = 1920, OUT_H = 1080;
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];

const reg = new Map();
const addTo = (b, t, f) => { (b[t] = b[t] || []).push(f); };
const els = {};
function mkEl(id) {
  const bag = {}; reg.set(id, bag);
  return { id,
    style: { _p: {}, setProperty(k, v) { this._p[k] = v; }, removeProperty(k) { delete this._p[k]; },
             getPropertyValue(k) { return this._p[k] === undefined ? "" : this._p[k]; } },
    textContent: "", clientWidth: OUT_W, clientHeight: OUT_H,
    classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); },
      contains(c) { return this.s.has(c); }, toggle(c, on) { if (on === undefined) on = !this.s.has(c); on ? this.s.add(c) : this.s.delete(c); } },
    closest: () => null, setPointerCapture() {}, addEventListener(t, f) { addTo(bag, t, f); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: OUT_W, height: OUT_H, right: OUT_W, bottom: OUT_H }) };
}
["wrap", "shell", "game", "pad", "topbar", "bGrind", "bSlow", "bParry", "bRocket", "bHook", "bRide",
 "bPause", "bSound", "bPro", "bInstall", "bJump", "metaTheme", "body", "documentElement"]
  .forEach(i => { els[i] = mkEl(i); });

const { cv: frame, ctx: gctx } = surface(OUT_W, OUT_H, "#ffffff");
els.game.width = OUT_W; els.game.height = OUT_H;
els.game.getContext = () => gctx;

/* A blank frame is 2 megapixels of fill, so the buffer is only written once the
   scene is set up: stepping the simulation first and arming the raster for a
   single render() at the end turns a 200-frame scene into one frame of pixels. */
let armed = false;
const realRect = gctx.fillRect, realText = gctx.fillText;
gctx.fillRect = function (x, y, w, h) { if (armed) realRect.call(this, x, y, w, h); };
gctx.fillText = function (t, x, y) { if (armed) realText.call(this, t, x, y); };

const CLOCK = { t: 0 };
let rafCb = null;
const audio = { notes: [], cuts: [], count: 0 };
const param = v => ({ value: v, _v: v, setValueAtTime(x) { this._v = x; return this; },
  exponentialRampToValueAtTime(x) { this._v = x; return this; }, linearRampToValueAtTime(x) { this._v = x; return this; } });
function AC() { this.sampleRate = 44100; this.state = "running"; this.destination = { connect() {} };
  Object.defineProperty(this, "currentTime", { get: () => CLOCK.t / 1000 }); this.resume = () => {};
  this.createGain = () => ({ gain: param(1), connect() {} });
  this.createBiquadFilter = () => ({ type: "", frequency: param(3500), Q: param(1), connect() {} });
  this.createOscillator = () => ({ type: "", frequency: param(0), connect() {}, stop() {}, start() {} });
  this.createBuffer = (c, l) => ({ getChannelData: () => new Float32Array(10) });
  this.createBufferSource = () => ({ buffer: null, connect() {}, start() {}, stop() {} }); }
const bagOf = id => { if (!reg.has(id)) reg.set(id, {}); return reg.get(id); };
const sb = { console, Math, JSON, Date, Object, Array, String, Number, Boolean, Error, Set, Map, isNaN, parseInt, parseFloat,
  document: { getElementById: id => els[id] || null, addEventListener: (t, f) => addTo(bagOf("__doc"), t, f),
    hidden: false, body: els.body, documentElement: els.documentElement },
  localStorage: { d: {}, getItem(k) { return this.d[k] === undefined ? null : this.d[k]; }, setItem(k, v) { this.d[k] = v; } },
  performance: { now: () => Date.now() }, navigator: { maxTouchPoints: 0, vibrate: () => true },
  requestAnimationFrame: cb => { rafCb = cb; return 1; }, matchMedia: () => ({ matches: false }),
  innerWidth: OUT_W, innerHeight: OUT_H, devicePixelRatio: 1,
  addEventListener: (t, f) => addTo(bagOf("__win"), t, f), setTimeout, clearTimeout, ResizeObserver: undefined };
sb.window = sb; sb.globalThis = sb; sb.window.AudioContext = AC;

const box = vm.createContext(sb);
const read = e => vm.runInContext(e, box);
vm.runInContext(src, box, { filename: "dino.js" });

let clock = 0;
const step = (n, each) => {
  for (let i = 0; i < n; i++) {
    clock += 1000 / 60; CLOCK.t = clock;
    if (each) each(i);
    if (rafCb) { const cb = rafCb; rafCb = null; cb(clock); }
  }
};
/* run the scene forward with the raster disarmed, then paint exactly one frame */
const shoot = (n, each) => { armed = false; step(n, each); armed = true; read("render()"); armed = false; };

/* ------------------------------- the palette ------------------------------ */
const INK = read("DAYC.ink"), PAPER = read("DAYC.paper"), SOFT = read("DAYC.soft");
const GOLD = read("ACCENT[1]"), CYAN = read("ACCENT[2]"), RED = read("ACCENT[3]");

/* ------------------------------- composition ------------------------------ */
/* Title-cased copy for the listing, drawn in the game's own ink on its own
   paper so a screenshot reads as a screenshot and not as a poster. */
function caption(cv, kicker, headline) {
  const barH = 168, y = cv.h - barH;
  rect(cv, 0, y, cv.w, barH, INK);
  rect(cv, 0, y, cv.w, 4, GOLD);
  fillText(cv, IDENT, kicker, 72, y + 62, 22, GOLD, "left", 3);
  fillText(cv, IDENT, headline, 72, y + 128, 44, PAPER, "left", 5);
}

/* A dino, straight out of the sprite table, on an integer scale — the same
   raster make-icons.cjs uses, so the listing and the app icon cannot drift. */
function dino(cv, key, frame_, x, footY, scale, col) {
  const fr = read(`SPR[${JSON.stringify(key)}].f[${frame_ % read(`SPR[${JSON.stringify(key)}].f.length`)}]`);
  const w = read(`SPR[${JSON.stringify(key)}].w`) * scale;
  const h = read(`SPR[${JSON.stringify(key)}].h`) * scale;
  for (const r of fr) rect(cv, x + r[0] * scale, footY - h + r[1] * scale, r[2] * scale, r[3] * scale, col);
  return { w, h };
}

const storeDir = path.join(__dirname, "store");
fs.mkdirSync(storeDir, { recursive: true });
const wrote = [];
const save = (name, cv) => {
  fs.writeFileSync(path.join(storeDir, name), encodePNG(cv.w, cv.h, cv.d));
  wrote.push(name + "  " + cv.w + "x" + cv.h);
};

/* ------------------------- 1. the feature graphic ------------------------- */
/* Play shows this in the top strip of the listing, so it has to read at 1024
   wide and survive being cropped to a banner: the title carries it, the dino
   is the only illustration, and there is exactly one accent colour. */
{
  const cv = canvas(1024, 500, INK);
  /* the game's own road, at the feature graphic's own scale */
  const groundY = 388;
  for (let x = 0; x < 1024; x += 32) rect(cv, x, groundY, 18, 4, mix(GOLD, INK, 0.55));
  rect(cv, 0, groundY - 84, 1024, 1, mix(PAPER, INK, 0.86));

  dino(cv, "classic_run1", 0, 742, groundY, 7, PAPER);
  /* the signal bar under the feet, the same gold the icon uses */
  rect(cv, 742, groundY + 14, 44 * 7, 6, GOLD);

  fillText(cv, IDENT, "PIXEL DINO", 64, 176, 68, PAPER, "left", 6);
  rect(cv, 64, 208, 300, 5, GOLD);
  fillText(cv, IDENT, "PARKOUR RUN", 64, 262, 30, GOLD, "left", 7);
  fillText(cv, IDENT, "100,000 METRES · 5 BOSS GATES", 64, 320, 20, SOFT, "left", 3);

  /* a small progress bar along the bottom, dino marker included: the one
     graphic that shows what the game actually is before you read a word */
  const bx = 64, bw = 620, by = 424;
  rect(cv, bx, by, bw, 8, mix(PAPER, INK, 0.78));
  rect(cv, bx, by, bw * 0.42, 8, GOLD);
  for (let i = 1; i < 10; i++) rect(cv, bx + (bw * i) / 10, by - 4, 2, 16, mix(PAPER, INK, 0.7));
  rect(cv, bx + bw * 0.42 - 2, by - 9, 12, 26, PAPER);
  fillText(cv, IDENT, "CHECKPOINT 40,000M", bx, by + 46, 15, SOFT, "left", 2);
  save("feature-graphic-1024x500.png", cv);
}

/* a blend of the two palette entries, so the extra art above is made of the
   same colours the game already uses rather than new ones */
function mix(a, b, t) {
  const A = hex(a), B = hex(b);
  const h = v => Math.round(v).toString(16).padStart(2, "0");
  return "#" + h(A[0] + (B[0] - A[0]) * t) + h(A[1] + (B[1] - A[1]) * t) + h(A[2] + (B[2] - A[2]) * t);
}

/* ----------------------------- 2. screenshots ----------------------------- */
/* Every one of these is the real renderer, the real HUD and the real panels. */

const startRun = `(function () {
  start();
  G.speed = 7.2; G.distance = 16800; G.score = 420;
  save.coins = 1480; save.best = 9820; save.bestM = 74600; save.title = "CERTIFIED LEGEND";
  save.owned = SKINS.map(function (s) { return s.id; }); save.skin = "gold"; save.pro = true;
  G.ammo = 3; G.coinN = 2; G.itemN = 2; G.beamCd = 0; G.slowCd = 0; G.revive = 1;
  G.obs.length = 0;
  return null;
})()`;

/* Screenshot 1 — the road itself, mid-jump, in the daylight */
{
  read(startRun);
  read(`(function () {
    const put = function (k, x, y, n) {
      const t = OBST[k], count = n || 1;
      for (let i = 0; i < count; i++) G.obs.push({ k: k, n: 1, x: x + i * (t.w + 6),
        y: y === undefined ? GROUND - t.h : y, w: t.w, h: t.h, box: t.box, fly: !!t.fly,
        f: 0, fanim: 0, gap: 400, dead: false, vx: 0, vy: 0, ridden: false });
    };
    const coin = function (x, y, n) { for (let i = 0; i < (n || 1); i++) G.items.push({ k: "coin", x: x + i * 19, y: y, w: 11, h: 8 }); };
    put("cactus1", 300); put("cactus2", 620, GROUND - 48); put("cactus1", 980, GROUND - 33, 2);
    put("cactus2", 1520, GROUND - 48);
    coin(1180, GROUND - 74, 5);
    for (let i = 0; i < 3; i++) G.items.push({ k: "rocket", x: 2300 + i * 40, y: GROUND - 30, w: 13, h: 9 });
    P.y = 52; P.vy = 1.2; P.air = 1;
    return null;
  })()`);
  shoot(30);
  caption(frame, "100,000 METRES · CHECKPOINTS EVERY 10,000M", "THE OFFLINE RUNNER, REBUILT");
  save("screenshot-1-the-road-1920x1080.png", frame);
}

/* Screenshot 2 — a boss gate, at night, with the laser wave in the air */
{
  read(startRun);
  read(`(function () {
    G.distance = 75000; G.score = 1875; G.nightPhase = 0.72; G.meters = 75000;
    G.bosses = BOSSES.map(function () { return false; });
    for (let k = 0; k < 3; k++) G.bosses[k] = true;
    G.bossIdx = 3;
    G.boss = { d: BOSSES[3], i: 3, x: 250, y: BOSSES[3].y, hp: 7, max: 12, t: 90, fire: 30,
      hurt: 0, phase: 0, dive: 0, dash: 0, vx: 0, vy: 0, n: 0 };
    G.obs.length = 0;
    for (let i = 0; i < 3; i++) G.waves.push({ x: 150 - i * 60, y: GROUND - 30 - i * 26, w: 26, h: 5,
      kind: "laser", dead: false, vx: 0, vy: 0 });
    for (let i = 0; i < 5; i++) G.items.push({ k: "coin", x: 520 + i * 19, y: GROUND - 66, w: 11, h: 8 });
    P.y = 40; P.vy = 0.6; P.air = 1;
    return null;
  })()`);
  shoot(20);
  caption(frame, "5 BOSS GATES · 10,000M · 25,000M · 50,000M · 75,000M · 99,000M", "CYBER MECHA-REX IS WAITING AT 75,000M");
  save("screenshot-2-boss-gate-1920x1080.png", frame);
}

/* Screenshot 3 — the DINO PRO panel, which is also the free one */
{
  read(startRun);
  read("G.state = 'pro'; G.shopSel = 0; G.proMsgT = 0; save.pro = true;");
  shoot(20);
  caption(frame, "NO ACCOUNT · NO PAYMENT · NO ADS", "DINO PRO UNLOCKS EVERYTHING, FREE");
  save("screenshot-3-dino-pro-1920x1080.png", frame);
}

/* Screenshot 4 — the wardrobe, which is where the coins go */
{
  read(startRun);
  read("G.state = 'shop'; G.shopSel = 3; save.coins = 1480;");
  shoot(20);
  caption(frame, "12 SKINS · EARN WI-FI COINS ON THE ROAD", "SPEND YOUR COINS IN THE WARDROBE");
  save("screenshot-4-wardrobe-1920x1080.png", frame);
}

/* --------------------------------- report --------------------------------- */
for (const w of wrote) console.log("wrote store/" + w);
console.log("\n" + wrote.length + " store assets, rendered from the real game in index.html");
console.log("Play Console needs: feature graphic 1024x500 (JPEG or 24-bit PNG, no alpha),");
console.log("app icon 512x512 (icons/icon-512.png), and 2-8 screenshots, 320-3840px on the long");
console.log("edge. These four are 1920x1080, which is the 16:9 the game is actually locked to.");
