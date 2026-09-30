/* Dev-only: renders the real game in a VM with an instrumented canvas and prints
   any frame as ANSI true-colour ASCII, so the layout can be eyeballed from a
   terminal.  Usage: node shoot.cjs [setup expression]                    */
const fs = require("fs"), vm = require("vm");
const html = fs.readFileSync(__dirname + "/index.html", "utf8");
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];

const reg = new Map();
const addTo = (b, t, f) => { (b[t] = b[t] || []).push(f); };
const els = {};
function mkEl(id) {
  const bag = {}; reg.set(id, bag);
  return { id, style: { setProperty() {}, removeProperty() {} }, textContent: "", clientWidth: 1200, clientHeight: 675,
    classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); },
      contains(c) { return this.s.has(c); }, toggle(c, on) { if (on === undefined) on = !this.s.has(c); on ? this.s.add(c) : this.s.delete(c); } },
    closest: () => null, setPointerCapture() {}, addEventListener(t, f) { addTo(bag, t, f); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 675, right: 1200, bottom: 675 }) };
}
["wrap", "shell", "game", "pad", "topbar", "bGrind", "bSlow", "bParry", "bRocket", "bHook", "bRide", "bPause", "bSound", "bPro", "bInstall", "metaTheme", "body", "documentElement"]
  .forEach(i => { els[i] = mkEl(i); });

const W = 1200, H = 675, CWp = 768, CHp = 432;
const grid = new Array(H).fill(null).map(() => new Array(W).fill("#ffffff"));
let cur = "#535353";
const ctx2d = new Proxy({
  canvas: { width: CWp, height: CHp },
  measureText: s => ({ width: s.length * 7 }),
  fillRect(x, y, w, h) {
    for (let j = Math.max(0, Math.round(y)); j < Math.min(H, Math.round(y + h)); j++)
      for (let i = Math.max(0, Math.round(x)); i < Math.min(W, Math.round(x + w)); i++) grid[j][i] = cur;
  },
  fillText() {}, setTransform() {}, save() {}, restore() {}, translate() {}, rotate() {}
}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });

let rafCb = null; const CLOCK = { t: 0 };
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
  innerWidth: 1200, innerHeight: 675, devicePixelRatio: 1,
  addEventListener: (t, f) => addTo(bagOf("__win"), t, f), setTimeout, clearTimeout, ResizeObserver: undefined };
sb.window = sb; sb.globalThis = sb; sb.window.AudioContext = AC;
els.game.getContext = () => new Proxy(ctx2d, { get: (t, k) => (k === "fillStyle" ? cur : t[k]), set: (t, k, v) => { if (k === "fillStyle") cur = v; t[k] = v; return true; } });

const box = vm.createContext(sb);
const read = e => vm.runInContext(e, box);
vm.runInContext(src, box, { filename: "dino.js" });
let clock = 0;
const step = n => { for (let i = 0; i < n; i++) { clock += 1000 / 60; CLOCK.t = clock; const c = rafCb; rafCb = null; if (c) c(clock); } };
const key = code => { const f = (reg.get("__win") || {}).keydown || []; f.forEach(g => g({ code, repeat: false, preventDefault() {}, stopPropagation() {} })); };

if (process.argv[2]) read(process.argv[2]);
const frames = +(process.argv[3] || 1);
step(frames);
/* optional 4th arg: an expression evaluated after the frames, printed as JSON */
if (process.argv[4]) console.error(JSON.stringify(read(process.argv[4])));

const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const out = [];
for (let y = 0; y < H; y += 8) {
  let line = "";
  for (let x = 0; x < W; x += 4) line += "\x1b[38;2;" + rgb(grid[y][x]).join(";") + "m" + (grid[y][x] === "#ffffff" ? "." : "#");
  out.push(line + "\x1b[0m");
}
console.log(out.join("\n"));
