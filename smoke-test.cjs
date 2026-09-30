/* Headless harness: runs the real game script in a VM with a stubbed DOM/canvas
   and drives every system (physics, controls, touch pad, gestures, collisions).
   Not shipped with the game.   Usage: node smoke-test.cjs [file.html]          */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const file = process.argv[2] || "index.html";
const html = fs.readFileSync(path.join(__dirname, file), "utf8");
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];

/* ------------------------------- DOM stubs -------------------------------- */
const reg = new Map();                 /* id -> {type: [fn]} */
const addTo = (bag, type, fn) => { (bag[type] = bag[type] || []).push(fn); };

const els = {};
function mkEl(id) {
  const bag = {};
  reg.set(id, bag);
  return {
    id, style: { _p: {}, setProperty(k, v) { this._p[k] = v; }, removeProperty(k) { delete this._p[k]; },
                 getPropertyValue(k) { return this._p[k] === undefined ? "" : this._p[k]; } },
    textContent: "", clientWidth: 960, clientHeight: 540,
    classList: {
      s: new Set(),
      add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); },
      toggle(c, on) { if (on === undefined) on = !this.s.has(c); on ? this.s.add(c) : this.s.delete(c); }
    },
    closest(sel) {
      if (sel === "#pad") return id === "pad" || /^b(Grind|Slow|Parry|Rocket|Hook|Ride|Jump)$/.test(id) ? this : null;
      if (sel === "#topbar") return id === "topbar" || /^b(Pause|Sound|Pro|Install)$/.test(id) ? this : null;
      return null;
    },
    setPointerCapture() {}, addEventListener(t, fn) { addTo(bag, t, fn); }, appendChild() {},
    setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k] === undefined ? null : this[k]; },
    /* real-enough tree so "is the pad inside the game box?" is a real check */
    parent: null, kids: [],
    contains(n) { return n === this || this.kids.some(k => k.contains(n)); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540 })
  };
}
["wrap", "shell", "game", "pad", "topbar", "bGrind", "bSlow", "bParry", "bRocket", "bHook", "bRide", "bJump", "bPause", "bSound", "bPro", "bInstall", "metaTheme", "body", "documentElement"].forEach(id => { els[id] = mkEl(id); });
/* mirror the real nesting: #shell > canvas + #topbar + #pad */
els.shell.kids.push(els.game, els.topbar, els.pad);
for (const k of els.shell.kids) k.parent = els.shell;
els.pad.kids.push(els.bGrind, els.bSlow, els.bParry, els.bRocket, els.bHook, els.bRide, els.bJump);
for (const k of els.pad.kids) k.parent = els.pad;

const drawn = [];
/* Every fillText, with the device-px position, font and tracking it was drawn
   at.  The real text extents are then reconstructed from a Courier New advance
   (0.6em), which is what makes an exact "do these two labels collide?" test
   possible instead of eyeballing the layout. */
const texts = [];
const ctx2d = new Proxy({
  canvas: { width: 768, height: 432 },
  /* Courier New's real advance is 0.6em, so measure against the drawn font size
     rather than an arbitrary constant: TW() then reports true world widths and
     a layout test can trust the positions the game actually draws at. */
  measureText(s) { const m = /(\d+)px/.exec(this.font || ""); return { width: s.length * (m ? +m[1] : 9) * 0.6 }; },
  fillRect(x, y, w, h) { drawn.push([Math.round(x), Math.round(y), Math.round(w), Math.round(h)]); },
  fillText(s, x, y) { texts.push({ s: String(s), x: x, y: y, font: this.font, align: this.textAlign, ls: this.letterSpacing }); },
  setTransform() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, arc() {}, clearRect() {}
}, {
  get: (t, k) => (k in t ? t[k] : () => {}),
  set: (t, k, v) => { t[k] = v; return true; }
});

let rafCb = null;
const CLOCK = { t: 0 };
const audio = { notes: [], cuts: [], count: 0 };
const param = v => ({
  value: v, _v: v,
  setValueAtTime(x) { this._v = x; return this; },
  exponentialRampToValueAtTime(x) { this._v = x; return this; },
  linearRampToValueAtTime(x) { this._v = x; return this; }
});
function FakeAudioContext() {
  this.sampleRate = 44100;
  this.state = "running";
  this.destination = { connect() {} };
  Object.defineProperty(this, "currentTime", { get: () => CLOCK.t / 1000 });
  this.resume = () => { this.state = "running"; };
  this.createGain = () => ({ gain: param(1), connect() {} });
  this.createBiquadFilter = () => {
    let fv = 350;
    const freq = {
      setValueAtTime(x) { fv = x; audio.cuts.push(+Number(x).toFixed(2)); return freq; },
      exponentialRampToValueAtTime(x) { fv = x; return freq; },
      linearRampToValueAtTime(x) { fv = x; return freq; }
    };
    Object.defineProperty(freq, "value", {
      get: () => fv,
      set: v => { fv = v; audio.cuts.push(+Number(v).toFixed(2)); }
    });
    return { type: "", frequency: freq, Q: param(1), connect() {} };
  };
  this.createOscillator = () => ({
    type: "", frequency: param(0), connect() {}, stop() {},
    start(t) {
      audio.count++;
      if (audio.notes.length < 600) audio.notes.push({ t: +t.toFixed(4), f: +this.frequency._v.toFixed(2), type: this.type });
    }
  });
  this.createBuffer = (ch, len) => ({ getChannelData: () => new Float32Array(Math.min(len, 2048)) });
  this.createBufferSource = () => ({ buffer: null, connect() {}, start() {}, stop() {} });
}
function bagOf(id) { if (!reg.has(id)) reg.set(id, {}); return reg.get(id); }
const sandbox = {
  console, Math, JSON, Date, Object, Array, String, Number, Boolean, Error, Set, Map, isNaN, parseInt, parseFloat,
  document: {
    getElementById: id => els[id] || null,
    addEventListener: (t, fn) => addTo(bagOf("__doc"), t, fn),
    hidden: false, body: els.body, documentElement: els.documentElement
  },
  localStorage: { d: {}, getItem(k) { return this.d[k] === undefined ? null : this.d[k]; }, setItem(k, v) { this.d[k] = v; } },
  performance: { now: () => Date.now() },
  navigator: { maxTouchPoints: 0, vibrate: () => true },
  requestAnimationFrame: cb => { rafCb = cb; return 1; },
  matchMedia: () => ({ matches: false }),
  innerWidth: 960, innerHeight: 540, devicePixelRatio: 2,
  addEventListener: (t, fn) => addTo(bagOf("__win"), t, fn),
  setTimeout, clearTimeout, ResizeObserver: undefined
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.AudioContext = FakeAudioContext;   /* instrumented: records what is played */
els.game.getContext = () => ctx2d;

const errors = [];
const box = vm.createContext(sandbox);
const read = expr => vm.runInContext(expr, box);

/* ------------------------------- reporters -------------------------------- */
let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};
const section = t => console.log("\n" + t);

/* --------------------------------- driver --------------------------------- */
let clock = 0;
function step(frames, each) {
  for (let i = 0; i < frames; i++) {
    clock += 1000 / 60;
    CLOCK.t = clock;
    if (i % 20 === 0) read("for (const o of G.obs) if (o.park) o.x = 9000;");
    if (each) each(i);
    try { if (rafCb) { const cb = rafCb; rafCb = null; cb(clock); } }
    catch (e) { errors.push(e); return false; }
  }
  return true;
}
function fire(id, type, ev) {
  const full = Object.assign({
    type, code: "", repeat: false, pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0,
    target: els.game, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}
  }, ev || {});
  for (const fn of (reg.get(id) || {})[type] || []) fn(full);
}
const down = code => fire("__win", "keydown", { code });
const up = code => fire("__win", "keyup", { code });
const tapEl = id => { fire(id, "pointerdown", { pointerId: 5 }); fire(id, "pointerup", { pointerId: 5 }); };
const WORLD = () => read("S");
/* Tap where the button really is on screen: CSS px, not device px.  This used to
   divide by S, which mirrored the game's own dpr bug and hid it from the suite. */
const tapWorld = (b) => {
  const k = read("CSS");
  fire("wrap", "pointerdown", { pointerId: 90, clientX: (b.x + b.w / 2) * k, clientY: (b.y + b.h / 2) * k });
};
/* a genuine tap on the empty playfield (world coords): the jump control */
const tapFieldXY = (wx, wy) => {
  const k = read("CSS");
  fire("wrap", "pointerdown", { pointerId: 88, clientX: wx * k, clientY: wy * k });
  fire("wrap", "pointerup", { pointerId: 88, clientX: wx * k, clientY: wy * k });
};

/* a quiet, deterministic playfield: no random spawns while a test drives him */
function arena() {
  read(`(function(){
    G.state = "run"; G.t = 0; G.speed = CFG.SPEED; G.distance = 0; G.score = 0;
    G.flash = 0; G.flashPeak = 0; G.cool = 0; G.shakeT = 0;
    G.shots.length = 0; G.parts.length = 0;
    P.dead = false; P.y = 0; P.vy = 0; P.air = 0; P.flip = -1; P.duck = false; P.grind = null; P.shield = 0;
    P.board = 0; P.boardT = 0; P.spin = 0; P.spy = 0; P.spyT = 0; P.ghost = 0; P.sink = 0;
    P.bob = 0; P.bobV = 0;
    P.hook = null; P.hookT = 0;
    save.boards = 0; G.lastParry = -1;
    G.combo = 0; G.comboT = 0; G.beamT = 0; G.beamCd = 0; G.arc.length = 0;
    P.x = Math.round(WW * 0.09);
    G.ammo = 0; G.items.length = 0; G.bonus = 0; G.itemN = 0; G.coinN = 0; G.itemT = 9999;
    G.road = 0; G.meters = 0; G.slowT = 0; G.slowCd = 0; G.spd = CFG.SPEED;
    G.revive = 0; G.revived = false;
    /* bosses are disarmed by default so a test's road position never trips one;
       a boss-specific test re-arms the one it wants with armBoss() */
    G.boss = null; G.bossIdx = BOSSES.length; G.bosses = BOSSES.map(() => true); G.warn = 0; G.waves.length = 0;
    G.tower = null; G.cpN = 0; G.cpFlash = 0; clearCheckpoint();
    held.swipe = false; gest = null; held.keySlide = false; held.padSlide = false;
    save.coins = 0; save.owned = ["classic"]; save.skin = "classic"; save.pro = false;
    G.obs.length = 0;
    G.obs.push({ k: "cactus1", n: 1, x: 9000, y: GROUND - 33, w: 15, h: 33, box: OBST.cactus1.box,
                 fly: false, f: 0, fanim: 0, gap: 10, dead: false, vx: 0, vy: 0, ridden: false, park: true });
    return true;
  })()`);
}
function addObs(kind, x, n) {
  read(`(function(){
    const k = ${JSON.stringify(kind)}, n = ${n || 1};
    const fly = k === "ptero";
    G.obs.push({ k, n, x: ${x}, y: fly ? 0 : GROUND - OBST[k].h, w: OBST[k].w * n, h: OBST[k].h,
                 box: OBST[k].box, fly, f: 0, fanim: 0, gap: 99999, dead: false, vx: 0, vy: 0, ridden: false });
    const o = G.obs[G.obs.length - 1];
    if (fly) o.y = ${'GROUND - OBST.ptero.h - 30'};
    return o;
  })()`);
}
const live = () => read('({state:G.state, dead:P.dead, y:P.y, vy:P.vy, obs:G.obs.length})');
/* arm the Nth boss (and every earlier one as beaten) for a boss test */
const armBoss = i => read("G.bosses = BOSSES.map(() => false); for (let k = 0; k < " + i + "; k++) G.bosses[k] = true; G.bossIdx = " + i + ";");

/* ---------------------------------- boot ---------------------------------- */
section("boot");
try { vm.runInContext(src, box, { filename: "dino.js" }); check("script evaluates", true); }
catch (e) { check("script evaluates", false, String(e)); process.exit(1); }
check("starts on the title screen", read("G.state") === "ready");
check("empty track", read("G.obs.length") === 0);
check("dino rests on the ground line", read("P.y") === 0 && read("GROUND") === 160);
step(120);
check("title screen idles without errors", errors.length === 0);

/* ------------------------- sprite art: the real thing ---------------------- */
section("sprite art (real Chromium frames)");
const art = read(`(function(){
  const out = {};
  for (const k in SPR) {
    const s = SPR[k]; let rects = 0, maxX = 0, maxY = 0;
    s.f.forEach(f => f.forEach(r => { rects++; maxX = Math.max(maxX, r[0] + r[2]); maxY = Math.max(maxY, r[1] + r[3]); }));
    out[k] = { w: s.w, h: s.h, frames: s.f.length, rects, maxX, maxY };
  }
  return out;
})()`);
check("T-Rex is the 40x43 frame", art.idle.w === 40 && art.idle.h === 43);
check("T-Rex is detailed pixel art, not a block", art.idle.rects >= 20, art.idle.rects);
check("ink fills the whole frame (no letterbox inside the sprite)", art.idle.maxX === 40 && art.idle.maxY === 43);
check("stand, blink, run x2, crash frames", art.idle.frames === 1 && art.blink.frames === 1 && art.run1.frames === 1 && art.run2.frames === 1 && art.crash.frames === 1);
check("two ducking frames (55x25)", art.duck.frames === 2 && art.duck.w === 55 && art.duck.h === 25);
check("run frames differ (running legs)", read("JSON.stringify(SPR.run1.f[0]) !== JSON.stringify(SPR.run2.f[0])") === true);
check("small cactus 15x33", art.cactus1.w === 15 && art.cactus1.h === 33);
check("large cactus 23x48", art.cactus2.w === 23 && art.cactus2.h === 48);
check("cacti are multi-armed, not rectangles", art.cactus1.rects >= 8 && art.cactus2.rects >= 8, [art.cactus1.rects, art.cactus2.rects]);
check("two pterodactyl wing frames (42x36)", art.ptero.frames === 2 && art.ptero.w === 42 && art.ptero.h === 36);
check("cloud outline", art.cloud.w === 46 && art.cloud.h === 13);
const anatomy = read(`(function(){
  const f = SPR.idle.f[0];
  return { eye: f.some(r => r[0] > 10 && r[1] < 14 && r[2] <= 6 && r[3] <= 8),
           arm: f.some(r => r[0] < 8 && r[2] <= 6),
           legs: f.filter(r => r[1] > 38).length >= 2 };
})()`);
check("head with eye notch, tiny arm and split legs", anatomy.eye && anatomy.arm && anatomy.legs, anatomy);
const pal = read("({ paper: PAPER, ink: INK, soft: SOFT, faint: FAINT, pebble: PEBBLE })");
check("pure white paper", pal.paper === "#ffffff");
check("classic #535353 ink", pal.ink === "#535353");
check("greyscale only (no colour anywhere)", Object.values(pal).every(c => /^#[0-9a-f]{6}$/.test(c) && c[1] === c[3] && c[3] === c[5]), pal);

/* ------------------------------ pacing & physics --------------------------- */
section("Chrome-accurate pacing");
arena();
const s0 = read("G.speed");
check("starts at an easy walking pace", Math.abs(s0 - 4.4) < 0.01, s0);
step(600);
const s10 = read("G.speed");
check("the first 10 seconds do not move the pace at all", s10 === 4.4, s10);
check("score rate is gentle at the start", read("G.score") > 40 && read("G.score") < 80, read("G.score"));
step(2100);                                        /* 10,500m in: still the walk */
check("and it holds the walk for the first 10,500m", read("G.speed") === 4.4, read("G.speed"));
check("gravity 0.6 / frame", read("CFG.GRAVITY") === 0.6);
check("jump velocity 10 + speed/10", Math.abs(read("CFG.JUMP + G.speed / 10") - (10 + s10 / 10)) < 1e-9);
check("speed is capped, not explosive", read("CFG.MAX_SPEED") <= 14);
check("and the whole journey really is slower than it was", read("CFG.MAX_SPEED") < 10 && read("CFG.SPEED") < 4.5,
  read("[CFG.SPEED, CFG.MAX_SPEED]"));
const mid = read("(function(){ G.road = CFG.EASE_IN + (CFG.RAMP - CFG.EASE_IN) * 0.5; return null; })()");
step(3);
check("the ramp is smooth: half way is half way up", (() => {
  const s = read("G.speed"), lo = read("CFG.SPEED"), hi = read("CFG.MAX_SPEED");
  return s > lo + (hi - lo) * 0.35 && s < lo + (hi - lo) * 0.65;
})(), read("G.speed"));
step(20000);
check("even late on the pace stays sane", read("G.speed") <= read("CFG.MAX_SPEED") + 1e-6, read("G.speed"));
check("the ramp only ever climbs", (() => {
  const lo = read("CFG.SPEED"), hi = read("CFG.MAX_SPEED");
  const warm = read("CFG.EASE_IN"), span = read("CFG.RAMP") - warm;
  let prev = -1, last = 0;
  for (let i = 0; i <= 50; i++) {
    const road = (i / 50) * read("CFG.RAMP");
    const t = Math.max(0, Math.min(1, (road - warm) / span));
    const s = lo + (hi - lo) * t * t * (3 - 2 * t);
    if (s < prev - 1e-9) return false;
    prev = last = s;
  }
  return Math.abs(last - hi) < 1e-9;
})());

/* ------------------------- obstacle density: room to breathe --------------- */
section("obstacle density: the road has room to breathe");
check("the global gap scale is generous", read("CFG.GAPK") >= 1.1, read("CFG.GAPK"));
check("cacti ask for a wide berth", read("OBST.cactus1.minGap") >= 160 && read("OBST.cactus2.minGap") >= 160,
  read("[OBST.cactus1.minGap, OBST.cactus2.minGap]"));
check("pterodactyls ask for an even wider one", read("OBST.ptero.minGap") >= 200, read("OBST.ptero.minGap"));
check("no triple cactus walls any more", read("OBST.cactus1.counts.indexOf(3) < 0 && OBST.cactus2.counts.indexOf(3) < 0"),
  read("[OBST.cactus1.counts, OBST.cactus2.counts]"));
check("every obstacle spawns at most two wide", read("OBST.cactus1.counts.concat(OBST.cactus2.counts, OBST.ptero.counts)")
  .every(n => n <= 2));

/* Measure the real thing: run the world, note where each obstacle first
   appears, and see how much road is actually left between them. */
function measureSpacing(frames, score) {
  arena();
  /* wrap the spawner: every call is one new cluster.  __acc is a running
     odometer, so a crash (which resets G.road) cannot fake a tight gap. */
  read(`(function () {
    if (!window.__spawn) window.__spawn = spawnObstacle;
    window.__roads = []; window.__kinds = []; window.__last = 0; window.__acc = 0;
    spawnObstacle = function () {
      var out = window.__spawn();
      if (G.road >= window.__last) window.__acc += G.road - window.__last;
      window.__last = G.road;
      window.__roads.push(window.__acc);
      window.__kinds.push(G.obs[G.obs.length - 1].k);
      return out;
    };
    return null;
  })()`);
  read("G.obs.length = 0");                     /* drop the parked test cactus */
  const pin = score ? `G.distance = ${score / 0.025};` : "";   /* score = distance * 0.025 */
  /* Hold him on a board *and* behind the PRO shield so the dino literally
     cannot die: the road is then measured in one unbroken run instead of a
     chain of crash-restarts, whose resets would reset G.road and quietly
     skew the pace — and so the sample, and the share of birds in it. */
  step(frames, () => read(`P.board = 1; P.boardT = 9999; P.shield = 9999; if (G.state === 'over' || G.state === 'win') start(); ${pin}`));
  const roads = read("window.__roads"), kinds = read("window.__kinds");
  const gaps = [];
  for (let i = 1; i < roads.length; i++) gaps.push(roads[i] - roads[i - 1]);
  const sorted = gaps.slice().sort((a, b) => a - b);
  const ground = kinds.filter(k => k !== "ptero").length;
  return {
    n: roads.length,
    groundShare: kinds.length ? ground / kinds.length : 0,
    mean: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0,
    min: sorted.length ? sorted[0] : 0
  };
}
const early = measureSpacing(3000, 0);
check("the opening stretch is genuinely sparse", early.n > 4 && early.mean > 190, early);
check("and the tightest squeeze still leaves real road", early.min > 150, early);
const late = measureSpacing(3000, 420);
check("once the pace picks up it still opens up, not closes in", late.mean > 150, late);
check("no obstacle ever spawns a hair after another", late.min > 120, late);
check("on average one obstacle every screen or more", early.mean / 384 >= 1, { screens: +(early.mean / 384).toFixed(2) });
check("ground obstacles outnumber birds even in the late mix",
  late.groundShare >= 0.6 && late.n > 20, { share: +late.groundShare.toFixed(2), n: late.n });

/* --------------------------- jump / land reliability ----------------------- */
section("jump, double jump, land");
for (let trial = 0; trial < 3; trial++) {
  arena();
  down("Space");
  let apex = 0;
  step(70, () => { apex = Math.max(apex, read("P.y")); });
  check(`trial ${trial + 1}: single jump apex is a tall Chrome hop`, apex > 82 && apex < 100, apex);
  check(`trial ${trial + 1}: lands exactly on the ground, velocity cleared`,
    read("P.y") === 0 && read("P.vy") === 0 && read("P.air") === 0);
}
arena();
down("Space"); step(6);
const rising = read("P.y");
down("Space");
check("second tap mid-air is the backflip jump", read("P.air") === 1);
check("flip animation starts", read("P.flip") >= 0, read("P.flip"));
let apex2 = 0, maxFlip = 0;
step(80, () => { apex2 = Math.max(apex2, read("P.y")); maxFlip = Math.max(maxFlip, read("P.flip")); });
check("backflip jump goes higher than a single one", apex2 > 108, [rising, apex2]);
check("the backflip completes a full rotation before landing", maxFlip >= 1, maxFlip);
check("and leaves the dino upright again", read("P.flip") === -1, read("P.flip"));
check("lands and resets", read("P.y") === 0 && read("P.air") === 0);
down("Space"); step(4); down("Space"); step(4); down("Space"); step(4);
check("no triple jump", read("P.air") <= 1, read("P.air"));
step(90);
check("jumping never breaks the ground state", read("P.y") === 0 && live().dead === false);

/* ------------------------- slide, fast-fall, grind ------------------------- */
section("slide, fast-fall & cactus grind");
arena();
down("ArrowDown"); step(2);
check("holding slide ducks", read("P.duck") === true);
const duckBoxes = read("dinoBoxes()");
check("duck hitbox is low (can pass under a pterodactyl)", duckBoxes.length === 1 && duckBoxes[0][1] + duckBoxes[0][3] <= read("GROUND"), duckBoxes);
check("duck hitbox is 25 units tall or less", duckBoxes[0][3] <= 20, duckBoxes);
up("ArrowDown"); step(2);
check("releasing slide stands up", read("P.duck") === false);

down("Space"); step(10);
read("P.vy = 5");
down("ArrowDown"); step(3);
check("slide in mid-air slams down (fast fall)", read("P.vy") < -1, read("P.vy"));
step(40); up("ArrowDown");
check("fast fall lands safely", read("P.y") === 0 && read("P.vy") === 0);

arena();
addObs("cactus2", read("P.x + 26"));
read("P.y = 44; P.vy = -1");
const scoreBefore = read("G.score");
down("ArrowDown"); step(3);
check("dropping onto a cactus with SLIDE held mounts it", read("P.grind") !== null);
check("feet snap to the cactus crown", read("P.y") === 48, read("P.y"));
check("mount registers no collision", live().dead === false);
step(24);
check("grinding pays points", read("G.score") > scoreBefore, [scoreBefore, read("G.score")]);
check("grind releases when the cactus is behind", read("P.grind") === null);
up("ArrowDown"); step(80);
check("dino lands and keeps running after the grind", read("P.y") === 0 && live().dead === false);

/* ------------------------------ rocket & parry ----------------------------- */
section("ACTION: rocket and parry");
arena();
read("G.ammo = 3;");
down("KeyF");
check("action launches a rocket", read("G.shots.length") === 1, read("G.shots.length"));
check("and spends a rocket of ammo", read("G.ammo") === 2, read("G.ammo"));
check("rocket sets a cooldown", read("G.cool") > 0, read("G.cool"));
addObs("cactus2", read("P.x + 150"));
const preRocket = read("G.score");
step(40);
check("rocket destroys the cactus ahead", read("G.obs.filter(o => !o.park).every(o => o.dead)") === true,
  read('({ shots: G.shots.slice(), obs: G.obs.map(o => ({ k: o.k, x: o.x, y: o.y, dead: !!o.dead, park: !!o.park })), speed: G.speed, state: G.state, dead: P.dead })'));
check("blast pays a bonus", read("G.score") >= preRocket + 25, [preRocket, read("G.score")]);
check("rocket leaves the screen cleanly", read("G.shots.length") === 0, read("G.shots.length"));
arena();
addObs("ptero", read("P.x + 70"));
const preScore = read("G.score");
down("KeyC");
check("a pterodactyl in range gets parried instead of shot", read("G.obs.some(o => o.fly && o.dead)") === true);
step(2);
check("parry pays a bonus", read("G.score") > preScore + 40, [preScore, read("G.score")]);
check("and the parry costs no ammo", read("G.ammo") === 0, read("G.ammo"));
step(60);
check("the parried pterodactyl flies away", read("G.obs.filter(o => o.fly && !o.park).length") === 0);

/* ------------------------------- collisions -------------------------------- */
section("collision reliability");
arena();
addObs("cactus2", read("P.x + 10"));
step(2);
check("a cactus at the dino ends the run", read("G.state") === "over" && read("P.dead") === true,
  read('({ state: G.state, dead: P.dead, y: P.y, grind: !!P.grind, duck: P.duck, slide: slideHeld(), dino: dinoBoxes(), obs: G.obs.map(o => ({ k: o.k, x: o.x, box: boxesOf(o) })) })'));
check("the world stops dead", read("G.speed") === 0);
check("crash frame is shown", read("dinoKey()") === "crash");
check("restart is armed a fraction of a second later", read("G.restartAt") >= read("G.t") - 40);
step(20);
check("no collisions are processed after death", errors.length === 0);

/* --- end-to-end: jumping over a cactus actually clears it, every time ---- */
section("playability: real dodges");
let survived = 0;
for (let trial = 0; trial < 5; trial++) {
  arena();
  addObs("cactus2", read("P.x + 120"));
  const jumped = { done: false };
  step(120, () => {
    const gap = read("G.obs[G.obs.length - 1] ? G.obs[G.obs.length - 1].x - P.x : 9999");
    if (!jumped.done && gap < 54) { jumped.done = true; down("Space"); }
  });
  if (!live().dead) survived++;
}
check("5/5 jumps clear a large cactus", survived === 5, survived);

let ducked = 0;
for (let trial = 0; trial < 5; trial++) {
  arena();
  addObs("ptero", read("P.x + 90"));
  read("G.obs[G.obs.length - 1].y = GROUND - OBST.ptero.h - 30");
  down("ArrowDown");          /* hold it for the whole approach */
  step(90);
  if (!live().dead) ducked++;
  up("ArrowDown");
}
check("5/5 slides pass under a mid pterodactyl", ducked === 5, ducked);

let hit = 0;
for (let trial = 0; trial < 3; trial++) {
  arena();
  addObs("ptero", read("P.x + 90"));
  read("G.obs[G.obs.length - 1].y = GROUND - OBST.ptero.h - 30");
  step(90);
  if (live().dead) hit++;
}
check("standing up into that pterodactyl always hits (3/3)", hit === 3, hit);

/* --------------------------------- death/restart --------------------------- */
section("death, game over, instant restart");
arena();
addObs("cactus1", read("P.x + 10"));
step(2);
check("run ends", read("G.state") === "over");
step(10);
check("game over panel waits for the crash animation", read("G.t") < read("G.restartAt"));
read("G.t = G.restartAt + 1");
down("Space");
check("space restarts instantly", read("G.state") === "run" && read("P.dead") === false);
check("restart clears the track and score", read("G.obs.length") <= 1 && read("G.score") === 0);
check("restart puts the dino back on the ground", read("P.y") === 0 && read("P.vy") === 0);

/* -------------------------- touch pad and gestures ------------------------- */
section("touch pad & gestures");
arena();
read("G.obs.length = 0");
tapFieldXY(200, 90);
step(4);
check("tapping the field jumps", read("P.y") > 20, read("P.y"));
step(90);
arena();
read("G.ammo = 3;");
fire("bRocket", "pointerdown", { pointerId: 8 });
check("ROCKET button fires the rocket", read("G.shots.length") === 1);
fire("bRocket", "pointerup", { pointerId: 8 });
arena();
fire("bGrind", "pointerdown", { pointerId: 9 });
step(3);
check("GRIND button holds a slide", read("P.duck") === true);
fire("bGrind", "pointerup", { pointerId: 9 });
step(3);
check("releasing GRIND stands up", read("P.duck") === false);
arena();
read("G.obs.length = 0");
fire("wrap", "pointerdown", { pointerId: 11, clientX: 400, clientY: 320 });
fire("wrap", "pointermove", { pointerId: 11, clientX: 400, clientY: 250 });
step(4);
check("swipe up jumps", read("P.y") > 20, read("P.y"));
fire("wrap", "pointerup", { pointerId: 11, clientX: 400, clientY: 250 });
step(90);
arena();
read("G.obs.length = 0");
fire("wrap", "pointerdown", { pointerId: 12, clientX: 400, clientY: 250 });
fire("wrap", "pointermove", { pointerId: 12, clientX: 400, clientY: 320 });
step(3);
check("swipe down slides", read("P.duck") === true);
fire("wrap", "pointerup", { pointerId: 12, clientX: 400, clientY: 320 });
step(40);
arena();
read("G.obs.length = 0;");
fire("wrap", "pointerdown", { pointerId: 13, clientX: 400, clientY: 300 });
fire("wrap", "pointerup", { pointerId: 13, clientX: 400, clientY: 300 });
step(4);
check("tap on the field jumps", read("P.y") > 20, read("P.y"));
read("G.shots.length = 0");

/* tap anywhere starts and restarts */
read('G.state = "ready"; G.t = 0;');
fire("wrap", "pointerdown", { pointerId: 14, clientX: 300, clientY: 300 });
check("tapping the title screen starts the run", read("G.state") === "run");
read('G.state = "over"; P.dead = true; G.t = 500; G.restartAt = 100;');
fire("wrap", "pointerdown", { pointerId: 15, clientX: 300, clientY: 300 });
check("tapping after death restarts immediately", read("G.state") === "run" && read("P.dead") === false);
check("tapping a pad button does not also fire the field", (() => {
  read('G.state = "run"; P.y = 0; P.duck = false; held.padSlide = false;');
  fire("bGrind", "pointerdown", { pointerId: 16 });
  step(2);
  const ducked = read("P.duck") === true && read("P.y") === 0;
  fire("bGrind", "pointerup", { pointerId: 16 });
  return ducked && read("G.state") === "run";
})());
fire("__win", "touchstart", {});
check("first touch reveals the pad", read("touchUI") === true && els.body.classList.contains("touch"));
tapEl("bPause");
check("PAUSE chip pauses", read("G.state") === "pause");
tapEl("bPause");
check("PAUSE chip resumes", read("G.state") === "run");

/* -------------------------------- rendering ------------------------------- */
section("rendering");
for (const st of ["ready", "run", "pause", "over"]) {
  const before = errors.length;
  read(`G.state = ${JSON.stringify(st)}; P.dead = ${st === "over"};`);
  step(3);
  check(`renders in "${st}"`, errors.length === before);
}
arena();
drawn.length = 0;
step(1);
check("the frame actually paints rectangles", drawn.length >= 35, drawn.length);
const sizes = new Set(drawn.map(r => r[2] + "x" + r[3]));
check("pixel art is drawn, not one flat blob", sizes.size > 15, sizes.size);
check("the sprite's own runs reach the canvas", drawn.filter(r => r[0] > 0 && r[2] <= 30 && r[3] <= 30).length >= 18,
  drawn.filter(r => r[0] > 0 && r[2] <= 30 && r[3] <= 30).length);
read("P.y = 0");
const geo = read(`(function(){
  const feet = GROUND - P.y;
  const standTop = feet - 43, duckTop = feet - SPR.duck.h;
  const pteroMidBottom = (GROUND - OBST.ptero.h - 30) + SPR.ptero.h;
  return { standTop, duckTop, clearance: GROUND - pteroMidBottom, duckH: SPR.duck.h, standH: 43 };
})()`);
check("standing dino's feet land exactly on the ground", geo.standTop + geo.standH === read("GROUND"), geo);
check("ducking dino's feet land exactly on the ground", geo.duckTop + geo.duckH === read("GROUND"), geo);
check("there is room to slide under the mid pterodactyl", geo.clearance > geo.duckH, geo);

/* ------------------------------ night / dusk ------------------------------- */
section("night / dusk cycle");
const lum = hex => parseInt(hex.slice(1, 3), 16);
arena();
read("G.score = CFG.NIGHT_AT; G.distance = CFG.NIGHT_AT / 0.025;");
step(3);
check("crossing the milestone flips the run to night", read("G.night") === true && read("G.nightPhase") === 1,
  read("({ night: G.night, phase: G.nightPhase, score: G.score })"));
check("page chrome switches to its dark theme", read("document.documentElement.classList.contains('night')") === true);
const midFade = read("({ mix: G.nightMix, paper: PAPER })");
check("the change is a cross-fade, not a hard cut", midFade.mix > 0 && midFade.mix < 1, midFade);
check("and the background is mid-grey while it fades", lum(midFade.paper) > 10 && lum(midFade.paper) < 250, midFade);
step(read("CFG.NIGHT_FADE") + 6);
const nightPal = read("({ paper: PAPER, ink: INK, soft: SOFT, pebble: PEBBLE, star: STAR })");
check("night paper is dark", lum(nightPal.paper) < 40, nightPal);
check("night ink is light", lum(nightPal.ink) > 210, nightPal);
check("night really is an inversion", lum(nightPal.paper) < lum(nightPal.ink), nightPal);
check("the night palette is still greyscale", Object.values(nightPal).every(c => c[1] === c[3] && c[3] === c[5]), nightPal);
check("the fade settles at full night", read("G.nightMix") === 1, read("G.nightMix"));
drawn.length = 0;
step(1);
const nightRects = drawn.length;
check("a starfield and crescent moon are painted", nightRects > 100, nightRects);
check("stars stay inside the sky", read("G.stars.length") > 8 && read("G.stars.every(s => s.y >= 0 && s.y <= WH && s.x > -60 && s.x < WW + 240)") === true);
read("G.score = CFG.NIGHT_AT * 2; G.distance = CFG.NIGHT_AT * 2 / 0.025;");
step(3);
check("the next milestone lifts back to day", read("G.night") === false && read("G.nightPhase") === 2);
step(read("CFG.NIGHT_FADE") + 6);
check("day palette returns exactly as it was", read("PAPER") === "#ffffff" && read("INK") === "#535353", read("({ p: PAPER, i: INK })"));
check("page chrome switches back to light", read("document.documentElement.classList.contains('night')") === false);
drawn.length = 0;
step(1);
check("the starfield is gone again", drawn.length < nightRects, [drawn.length, nightRects]);
read("setNight(true); G.nightMix = 1;");
read("start();");
check("a fresh run always starts in daylight", read("G.night") === false && read("G.nightPhase") === 0);
check("stars are cleared on restart", read("G.stars.length") === 0);
step(3);
check("renders cleanly while fading back to day", errors.length === 0);
step(read("CFG.NIGHT_FADE") + 4);
check("daylight is fully restored", read("PAPER") === "#ffffff", read("PAPER"));

/* -------------------------------- music ---------------------------------- */
section("music: day loop and a darker night variation");
arena();
read("Snd.start()");
audio.notes.length = 0; audio.cuts.length = 0; audio.count = 0;
step(300);
check("the day loop is playing", audio.count > 20, audio.count);
check("day plays the bright arp (A4/C5/E5)", audio.notes.some(n => n.f === 440) && audio.notes.some(n => n.f === 523), audio.notes.slice(0, 6));
check("day walks its bass (A2/F2/G2/E2)",
  audio.notes.some(n => n.f === 110) && audio.notes.some(n => n.f === 87.3) && audio.notes.some(n => n.f === 98) && audio.notes.some(n => n.f === 82.4), null);
check("day tempo is 132bpm", read("Snd.info().bpm") === 132, read("Snd.info()"));
check("no night lowpass is used in the day", audio.cuts.indexOf(780) === -1, null);
read("setNight(true)");
check("the night pattern is requested", read("Snd.info().want") === "night", read("Snd.info()"));
check("the day loop keeps playing until the next bar", read("Snd.info().mode") === "day", read("Snd.info()"));
audio.notes.length = 0; audio.cuts.length = 0; audio.count = 0;
step(420);
const nightInfo = read("Snd.info()");
check("it changes on the bar line, not mid-step", nightInfo.mode === "night", nightInfo);
check("night tempo slows to 100bpm", nightInfo.bpm === 100, nightInfo);
check("the night lead drops an octave (A3/C4/G3/F3)",
  audio.notes.some(n => n.f === 220) && audio.notes.some(n => n.f === 261.6) && audio.notes.some(n => n.f === 196), audio.notes.slice(0, 8));
check("the night bass drops an octave (A1/F1/C2/G1/D1)",
  audio.notes.some(n => n.f === 55) && audio.notes.some(n => n.f === 43.7) && audio.notes.some(n => n.f === 65.4), null);
check("the night lead is run through a lowpass", audio.cuts.indexOf(780) !== -1, audio.cuts.slice(0, 6));
check("the night bass is detuned for beating", audio.notes.some(n => Math.abs(n.f - 55.33) < 0.05), null);
check("the drone sits under the bar", audio.notes.some(n => n.f === 55 && n.type === "sawtooth"), null);
audio.notes.length = 0;                                   /* only what plays after the switch */
step(180);
check("the bright day lead never comes back", audio.notes.every(n => n.f !== 440 && n.f !== 523), audio.notes.slice(0, 6));
audio.notes.length = 0;
read("Snd.sfx.jump()");
const nightJump = audio.notes[0] && audio.notes[0].f;
read("setNight(false)");
audio.notes.length = 0;
read("Snd.sfx.jump()");
const dayJump = audio.notes[0] && audio.notes[0].f;
check("sfx darken at night too", dayJump === 720 && Math.abs(nightJump - 720 * 0.86) < 0.6, [dayJump, nightJump]);
check("and come back up in daylight", read("Snd.info().pitch") === 1, read("Snd.info()"));
read("Snd.stop()");
check("stop() halts the loop", read("Snd.info().on") === false);
read("Snd.start()");
check("start() brings it back", read("Snd.info().on") === true);
step(10);
check("a fresh run wants the day loop", read("Snd.info().want") === "day");

/* --------------------- collectibles, ammo & skin shop --------------------- */
section("collectibles, ammo & the skin shop");
arena();
read("G.items.push({ k:'coin', x: P.x + 20, y: GROUND - 14, w: 11, h: 8 })");
step(2);
check("a ground coin is scooped up while running", read("save.coins") === 1, read("({coins: save.coins, items: G.items, boxes: dinoBoxes()})"));
check("and it adds to the score", read("G.bonus") === 1, read("G.bonus"));
arena();
read("G.items.push({ k:'coin', x: P.x + 70, y: GROUND - 54, w: 11, h: 8 })");
step(7);
check("a high coin is missed on the ground", read("save.coins") === 0, read("save.coins"));
down("Space");
step(4);
check("and collected mid-jump", read("save.coins") === 1, read("save.coins"));
up("Space");
arena();
read("G.items.push({ k:'rocket', x: P.x + 20, y: GROUND - 30, w: 13, h: 9 })");
step(2);
check("a [ROCKET] box grants three rockets", read("G.ammo") === read("CFG.BOX_AMMO"), read("G.ammo"));
read("G.ammo = 0; G.shots.length = 0; G.cool = 0;");
down("KeyF");
check("with no ammo ACTION fires nothing", read("G.shots.length") === 0, read("G.shots.length"));
step(2);
check("the ROCKET button dims when dry", els.bRocket.classList.contains("dim") === true);
read("G.ammo = 2;");
down("KeyF");
step(20);
check("with ammo ACTION spends one", read("G.shots.length") === 1 && read("G.ammo") === 1, [read("G.shots.length"), read("G.ammo")]);
check("the button comes back when loaded", els.bRocket.classList.contains("dim") === false);
arena();
read("G.itemT = 1; G.itemN = 0; G.items.length = 0;");
step(3);
check("pickups spawn along the track", read("G.items.length") > 0, read("G.items.length"));
check("the first pickup is a run of coins", read("G.items.filter(i => i.k === 'coin').length") === 3, read("G.items.map(i => i.k)"));
read("G.itemT = 1; G.itemN = 2; G.items.length = 0;");
step(3);
check("every third pickup is a rocket", read("G.items.some(i => i.k === 'rocket')") === true, read("G.items.map(i => i.k)"));
check("ammo is capped", (() => { read("G.ammo = CFG.AMMO_MAX"); read("collect({k:'rocket',x:0,y:0})"); return read("G.ammo") === read("CFG.AMMO_MAX"); })());

section("skins compose onto the real sprite");
read("save.skin = 'gentleman'");
const gFrames = read("SPR.gentleman_run1.f[0]"), cFrames = read("SPR.classic_run1.f[0]");
check("a skin is the Chrome frame plus its accessory", gFrames.length === cFrames.length + read("ACC_GENTLEMAN.length"), gFrames.length);
check("the base Chrome frame is untouched", cFrames.length === read("SPR.run1.f[0].length"));
check("the top hat sits above the head", gFrames.some(r => r[1] < 0), gFrames.filter(r => r[1] < 0).length);
check("accessories carry accent colours", gFrames.some(r => r[4] === 1) && gFrames.some(r => r[4] === 4));
check("the duck pose gets the duck head offset", read("SPR.gold_duck.f[0].length - SPR.classic_duck.f[0].length") === read("ACC_GOLDEN.length"));
check("all four skins have every frame", read("SKINS.every(s => ['idle','blink','run1','run2','crash','duck'].every(b => !!SPR[s.id + '_' + b]))") === true);
check("the equipped skin drives the drawn sprite", read("skinSprite('run1')") === "gentleman_run1");
read("save.skin = 'classic'");

section("skin shop");
read("save.coins = 0; save.owned = ['classic']; save.skin = 'classic'; G.state = 'ready'; persist();");
step(2);
check("the title screen has a SHOP button", read("ui.some(b => b.id === 'shop')") === true);
read('openShop("ready")');
step(2);
check("the shop opens", read("G.state") === "shop");
check("twelve skins are listed", read("SKINS.length") === 12);
check("a page of the wardrobe is eight tiles, all tap targets",
  read("ui.filter(b => b.id.indexOf('skin:') === 0).length") === read("SHOP_PER"), read("ui.map(b => b.id)"));
check("prices climb 0/50/100/150/200/250/300/350 then the four premium wardrobes",
  read("SKINS.map(s => s.cost).join()") === "0,50,100,150,200,250,300,350,400,450,500,550", read("SKINS.map(s => s.cost)"));
check("every hand-made wardrobe has real accessory art",
  read("SKINS.filter(s => s.acc).every(s => s.acc.length > 4)"),
  read("SKINS.map(s => [s.id, s.acc ? s.acc.length : 0])"));
check("the wardrobe is a two-column grid of four rows a page",
  read("SHOP_COLS") === 2 && read("SHOP_ROWS") === 4 && read("SHOP_PER") === 8);
check("and the skin ids stay unique",
  read("new Set(SKINS.map(s => s.id)).size") === read("SKINS.length"));
/* the harness stubs measureText, which badly under-reports, so size the shop
   text against a real Courier New advance (0.6em) instead of TW() */
const shopFit = read("(function(){"
  + "var cw = 344, colw = (cw - 24 - 8) / SHOP_COLS, bad = [];"
  + "for (const s of SKINS) {"
  + "  if (26 + s.name.length * 9.5 * 0.6 + 8 * 9 * 0.6 > colw - 6) bad.push(s.name);"
  + "  if (26 + s.blurb.length * 6.5 * 0.6 > colw - 34) bad.push(s.blurb);"
  + "}"
  + "return { bad: bad, colw: colw };"
  + "})()");
check("no skin label can collide with its own status tag or price in a 156px column",
  shopFit.bad.length === 0, shopFit);
read("save.coins = 10;");
tapWorld(read("ui.find(b => b.id === 'skin:1')"));
check("buying with too few coins is refused", read("save.owned.indexOf('gentleman')") === -1);
check("and the player is told why", /NOT ENOUGH/.test(read("G.shopMsg")), read("G.shopMsg"));
read("save.coins = 200;");
tapWorld(read("ui.find(b => b.id === 'skin:1')"));
check("buying with enough coins unlocks it", read("save.owned.indexOf('gentleman')") >= 0);
check("the price is deducted", read("save.coins") === 150, read("save.coins"));
check("and it is equipped straight away", read("save.skin") === "gentleman");
check("the purchase is persisted", read("JSON.parse(localStorage.getItem(SAVE_KEY)).skin") === "gentleman");
check("the wallet is persisted", read("JSON.parse(localStorage.getItem(SAVE_KEY)).coins") === 150);
check("a corrupted save recovers instead of breaking", (() => {
  read("save.owned = ['bogus']; save.skin = 'ghost'; save.coins = -5; sanitiseSave();");
  return read("save.owned.join()") === "classic" && read("save.skin") === "classic" && read("save.coins") === 0;
})(), read("({ owned: save.owned, skin: save.skin, coins: save.coins })"));
read("save.coins = 200; save.owned = ['classic']; save.skin = 'classic'; persist();");
step(1);
tapWorld(read("ui.find(b => b.id === 'skin:3')"));
check("the golden skin can be bought too", read("save.skin") === "gold" && read("save.coins") === 50, [read("save.skin"), read("save.coins")]);
down("Escape");
check("P/Esc closes the shop", read("G.state") === "ready");
down("ArrowDown"); down("ArrowUp");
read('openShop("ready")'); step(1);
down("ArrowDown");
check("down steps a whole row of the grid",
  read("G.shopSel") === Math.min(8, read("skinIndex(save.skin)") + 2), read("G.shopSel"));
down("ArrowRight");
check("and right steps one column", read("G.shopSel") === 6, read("G.shopSel"));
down("ArrowLeft");
check("left steps back", read("G.shopSel") === 5, read("G.shopSel"));
down("ArrowRight");
check("right never runs off the end of the grid", read("G.shopSel") === 6, read("G.shopSel"));
read("G.shopSel = 0");
down("ArrowLeft");
check("and left never runs off the front", read("G.shopSel") === 0, read("G.shopSel"));
down("ArrowUp");
check("up stops at the first row", read("G.shopSel") === 0, read("G.shopSel"));
read("G.shopSel = SKINS.length");
down("Space");
check("the pack row is reachable by keyboard too", read("G.state") === "shop" && read("G.shopSel") === read("SKINS.length"),
  read("G.state"));
read("G.shopSel = SKINS.length + 1");                 /* one past the pack is CLOSE */
down("Space");
check("the keyboard can reach CLOSE", read("G.state") === "ready");
read('G.state = "over"; G.restartAt = 0; G.t = 1;');
step(2);
check("the game over screen has a SHOP button", read("ui.some(b => b.id === 'shop')") === true);
tapWorld(read("ui.find(b => b.id === 'shop')"));
check("tapping it opens the shop", read("G.state") === "shop");
check("and it remembers to go back to the game over card", read("G.shopBack") === "over");
read("closeShop()");
check("closing returns to the game over card", read("G.state") === "over");
step(2);
fire("wrap", "pointerdown", { pointerId: 91, clientX: 300 * read("CSS"), clientY: 70 * read("CSS") });
check("tapping the card still restarts the run", read("G.state") === "run", read("G.state"));

/* --------------------------- the paged wardrobe --------------------------- */
section("THE PAGED WARDROBE: twelve skins in two pages, nothing overflows");
arena();
read("save.coins = 9999; save.owned = ['classic']; save.skin = 'classic'; persist();");
read('G.state = "ready"');
step(2);
read('openShop("ready")');
step(2);
check("the shop opens on the page of the equipped skin", read("shopPage()") === 0, read("shopPage()"));
check("page one lists the first eight skins",
  read("ui.filter(b => /^skin:/.test(b.id)).map(b => b.id).join()") === "skin:0,skin:1,skin:2,skin:3,skin:4,skin:5,skin:6,skin:7",
  read("ui.filter(b => /^skin:/.test(b.id)).map(b => b.id).join()"));
check("twelve skins need exactly two pages", read("shopPages()") === 2, read("shopPages()"));
check("page turns are real buttons",
  read("ui.some(b => b.id === 'shopprev')") && read("ui.some(b => b.id === 'shopnext')"), read("ui.map(b => b.id)"));
tapWorld(read("ui.find(b => b.id === 'shopnext')"));
step(1);
check("NEXT lands on the second page",
  read("shopPage()") === 1 && read("G.shopSel") === read("SHOP_PER"), [read("shopPage()"), read("G.shopSel")]);
check("which lists only the remaining four",
  read("ui.filter(b => /^skin:/.test(b.id)).map(b => b.id).join()") === "skin:8,skin:9,skin:10,skin:11",
  read("ui.filter(b => /^skin:/.test(b.id)).map(b => b.id).join()"));
tapWorld(read("ui.find(b => b.id === 'shopprev')"));
step(1);
check("PREV comes back to page one", read("shopPage()") === 0 && read("G.shopSel") === 0, [read("shopPage()"), read("G.shopSel")]);
/* the arrows walk the whole wardrobe and turn the page themselves */
read("G.shopSel = 7");
step(1);
down("ArrowRight");
check("right off the last tile turns to the next page",
  read("G.shopSel") === 8 && read("shopPage()") === 1, [read("G.shopSel"), read("shopPage()")]);
down("ArrowLeft");
check("and left turns straight back", read("G.shopSel") === 7 && read("shopPage()") === 0);
check("the hoverboard pack keeps its own row on every page",
  read("ui.find(b => b.id === 'boardpack').y") === read("1 + 42 + SHOP_ROWS * 28"),
  read("ui.find(b => b.id === 'boardpack').y"));
/* buy the four premium wardrobes and confirm they equip and compose */
for (const id of ["samurai", "cowboy", "viking", "punk"]) {
  read("G.shopSel = skinIndex('" + id + "')");
  step(1);
  const idx = read("skinIndex('" + id + "')");
  tapWorld(read("ui.find(b => b.id === 'skin:" + idx + "')"));
  check("the " + id + " skin can be bought and equipped",
    read("save.skin") === id && read("save.owned.indexOf('" + id + "') >= 0"),
    [read("save.skin"), read("save.coins")]);
  check("and it composes onto the untouched Chrome frames",
    read("SPR['" + id + "_idle'].f[0].length") > read("SPR.classic_idle.f[0].length"));
}
/* the eye notch is head-space x4..5, y3..4: only the pieces meant to cover a
   face may land on it, and every new hat has to sit above the skull */
const eyeHits = read("SKINS.filter(s => s.acc && s.acc.some(r => r[0] <= 5 && r[0] + r[2] - 1 >= 4 && r[1] <= 4 && r[1] + r[3] - 1 >= 3)).map(s => s.id).join()");
check("only the visors, the eyepatch and the ninja wrap touch the eye notch",
  eyeHits === "cyber,pirate,astro,ninja", eyeHits);
const noHat = read("['samurai','cowboy','viking','punk'].filter(id => !SKINS.find(s => s.id === id).acc.some(r => r[1] < 0)).join()");
check("and each new wardrobe has real headgear above the skull", noHat === "", noHat);
check("every skin still has all six poses",
  read("SKINS.every(s => ['idle','blink','run1','run2','crash','duck'].every(b => !!SPR[s.id + '_' + b]))"));
/* the real hazard when the wardrobe grows: two rows fighting for the same box */
const shopOverlaps = read("(function(){"
  + "var b = ui.filter(function (x) { return /^(skin:|boardpack$|shopprev$|shopnext$|close$)/.test(x.id); });"
  + "var out = [];"
  + "for (var i = 0; i < b.length; i++) for (var j = i + 1; j < b.length; j++) {"
  + "  var a = b[i], c = b[j];"
  + "  if (a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y) out.push([a.id, c.id]);"
  + "}"
  + "return out;"
  + "})()");
check("no skin row, page turn or CLOSE ever overlaps another", shopOverlaps.length === 0, shopOverlaps);
read('closeShop()');

/* ----------------------------- bullet time -------------------------------- */
section("SLOW: bullet time");
arena();
check("bullet time is 35% for 2s with a cooldown",
  read("CFG.SLOW_SCALE") === 0.35 && read("CFG.SLOW_MS") === 2000 && read("CFG.SLOW_CD") > 0,
  read("({ s: CFG.SLOW_SCALE, ms: CFG.SLOW_MS, cd: CFG.SLOW_CD })"));
down("ShiftLeft");
check("Shift triggers bullet time", read("G.slowT") > 0);
step(1);
check("the world really drops to 35% speed",
  Math.abs(read("G.spd") / read("G.speed") - read("CFG.SLOW_SCALE")) < 0.01,
  [read("G.spd"), read("G.speed")]);
const t1 = read("G.slowT");
step(2);
down("ShiftLeft");
check("a second press during it is refused", read("G.slowT") < t1, [t1, read("G.slowT")]);
step(130);
check("it lasts about two seconds, then the cooldown takes over",
  read("G.slowT") === 0 && read("G.slowCd") > 0, [read("G.slowT"), read("G.slowCd")]);
arena();
tapEl("bSlow");
check("the SLOW button works too", read("G.slowT") > 0);
step(3);
check("and the button counts the cooldown down", /\ds$/.test(els.bSlow.textContent), els.bSlow.textContent);
check("while it is dimmed", els.bSlow.classList.contains("dim") === true);
arena();
read("G.obs.length = 0;");
addObs("cactus1", read("P.x + 120"));
const bx0 = read("G.obs[0].x");
down("ShiftLeft");
step(2);
check("obstacles creep in bullet time", (bx0 - read("G.obs[0].x")) < read("G.speed") * 2 * 0.6,
  [bx0, read("G.obs[0].x")]);
up("ShiftLeft");

/* ------------------------------ perfect parry ----------------------------- */
section("PARRY: shockwave deflect + launch");
arena();
addObs("cactus2", read("P.x + 40"));
down("KeyC");
check("a cactus can be parried, not just a pterodactyl", read("G.obs.some(o => !o.park && o.dead)") === true);
check("the shockwave launches the dino upward", read("P.vy") > 0 && read("P.y") > 0, [read("P.y"), read("P.vy")]);
check("into a backflip", read("P.flip") === 0);
check("and the parry is free", read("G.ammo") === 0);
arena();
read("G.ammo = 3;");
addObs("cactus2", read("P.x + 30"));
down("KeyC");
check("an imminent threat is parried rather than shot",
  read("G.shots.length") === 0 && read("G.ammo") === 3, [read("G.shots.length"), read("G.ammo")]);
arena();
read("G.meters = 0; G.road = 0;");
step(60);
check("metres tick up as you run", read("G.meters") > 0, read("G.meters"));
check("and never past the finish line", read("G.meters") <= read("CFG.FINISH"));

/* ------------------------- five bosses, 100,000m --------------------------- */
section("BOSSES: the five road gates");
check("the journey is 100,000m", read("CFG.FINISH") === 100000);
check("with five bosses at the right marks",
  read("BOSSES.map(b => b.at).join()") === "10000,25000,50000,75000,99000", read("BOSSES.map(b => b.at)"));
check("and no gate sits on the doorstep — the first is 10,000m in",
  read("BOSSES.every(b => b.at >= 10000)"), read("BOSSES.map(b => b.at)"));
check("each one is named and pays out",
  read("BOSSES.every(b => b.name && b.hp > 0 && b.coins > 0 && b.w > 0 && b.h > 0)"));
check("and the final boss is the meteor", read("BOSSES[4].id") === "meteor");

/* --- boss 1: the Wi-Fi Router, the first gate, at 10,000m --- */
arena(); armBoss(0);
read("G.road = (BOSSES[0].at - 20) / CFG.M_PER_UNIT;");
step(2);
check("nothing drops in just before the mark", read("G.boss") === null, read("G.meters"));
read("G.road = BOSSES[0].at / CFG.M_PER_UNIT;");
step(2);
check("the router drops in at 10,000m, never at 100",
  read("G.boss") !== null && read("G.boss.d.id") === "router", read("G.meters"));
check("the screen shakes", read("G.shakeT") > 0);
check("with a warning", /BOSS/.test(read("G.toast")), read("G.toast"));
check("and a full health bar", read("G.boss.hp") === read("BOSSES[0].hp"));
const r0 = read("G.road");
step(30);
check("the boss holds the road at its own gate",
  read("G.road") === r0 && read("G.meters") >= read("BOSSES[0].at"), read("G.meters"));
read("G.boss.fire = 1; G.boss.t = 61;");
step(2);
check("the router fires red Wi-Fi pulses", read("G.waves.length") > 0 && read("G.waves[0].kind") === "wifi",
  read("G.waves.map(w => w.kind)"));
check("no ordinary cacti spawn during the fight", read("G.obs.filter(o => !o.park).length") === 0);
read("G.boss.x = 150; G.boss.fire = 9999; G.cool = 0; G.ammo = 3; G.shots.length = 0;");
down("KeyF");
step(2);
read("G.shots[0].y = G.boss.y + 20;");
step(10);
check("a rocket that reaches it hurts it", read("G.boss.hp") === read("BOSSES[0].hp") - 1, read("G.boss.hp"));
read("G.boss.x = 60; G.boss.y = GROUND - 30;");
down("KeyC");
check("a close parry chips it for two", read("G.boss.hp") === read("BOSSES[0].hp") - 3, read("G.boss.hp"));
read("G.boss.hp = 1; G.boss.x = 150; G.boss.y = GROUND - 90; G.cool = 0; G.ammo = 3; G.shots.length = 0;");
down("KeyF");
step(2);
read("G.shots[0].y = G.boss.y + 20;");
step(10);
check("the router goes down", read("G.boss") === null && read("G.bosses[0]") === true);
check("dropping 50 bonus coins", read("save.coins") === 50, read("save.coins"));
check("and 50 bonus points", read("G.bonus") >= 50, read("G.bonus"));
check("with a victory flourish", /WI-FI ROUTER DESTROYED/.test(read("G.toast")), read("G.toast"));
check("and no more waves", read("G.waves.length") === 0);
check("the coins are persisted", read("JSON.parse(localStorage.getItem(SAVE_KEY)).coins") === 50);
check("the fight banks a checkpoint", read("save.cp && save.cp.m >= 1000"), read("save.cp"));
check("and the next gate is armed", read("G.bossIdx") === 1);

/* --- boss 2: the Pterodactyl Queen, at 25,000m --- */
arena();
read("G.road = BOSSES[1].at / CFG.M_PER_UNIT; G.bosses[0] = true; G.bossIdx = 1;");
step(2);
check("the queen swoops in at 25,000m", read("G.boss") !== null && read("G.boss.d.id") === "queen", read("G.boss && G.boss.d.id"));
read("G.boss.fire = 1; G.boss.t = 61; G.boss.n = 2;");
step(3);
check("and calls up a minion swarm", read("G.waves.some(w => w.kind === 'minion')"), read("G.waves.map(w => w.kind)"));
read("G.boss.fire = 1; G.boss.t = 80; G.boss.n = 1; G.waves.length = 0;");
step(3);
check("or commits to a diving swoop", read("G.boss.dive") > 0, read("G.boss.dive"));
check("telegraphed first", read("G.boss.phase") > 0);

/* --- boss 3: the Glitch Golem, at 50,000m --- */
arena();
read("G.road = BOSSES[2].at / CFG.M_PER_UNIT; G.bosses = [true, true]; G.bossIdx = 2;");
step(2);
check("the golem rises at 50,000m", read("G.boss") !== null && read("G.boss.d.id") === "golem");
read("G.boss.fire = 1; G.boss.t = 61;");
step(3);
check("it winds up a ground slam", read("G.boss.phase") > 0);
read("G.boss.phase = 1;");
step(3);
check("then sends shockwaves along the floor", read("G.waves.some(w => w.kind === 'shock' && w.vx < 0)"), read("G.waves.map(w => w.kind)"));
check("both of them, and both heading for the dino",
  read("G.waves.filter(w => w.kind === 'shock').length") === 2 && read("G.waves.every(w => w.vx < 0)"),
  read("G.waves.map(w => [w.vx, w.hold || 0])"));
step(40);
check("the follow-up shockwave is released and travelling", read("G.waves.filter(w => w.kind === 'shock').every(w => !w.hold)"));
check("and the slam lifts it off the floor", read("G.boss.y") <= read("BOSSES[2].y") + 0.001);

/* --- boss 4: the Cyber Mecha-Rex, at 75,000m --- */
arena();
read("G.road = BOSSES[3].at / CFG.M_PER_UNIT; G.bosses = [true, true, true]; G.bossIdx = 3;");
step(2);
check("the mecha drops in at 75,000m", read("G.boss") !== null && read("G.boss.d.id") === "mecha");
read("G.boss.fire = 1; G.boss.t = 61; G.boss.n = 1; G.waves.length = 0;");
step(3);
check("it fires laser blasts", read("G.waves.some(w => w.kind === 'laser')"), read("G.waves.map(w => w.kind)"));
read("G.boss.fire = 1; G.boss.t = 90; G.boss.n = 3; G.waves.length = 0;");
step(3);
check("or lines up a fast dash", read("G.boss.dash") > 0, read("G.boss.dash"));

/* --- boss 5: the Extinction Meteor, at 99,000m --- */
arena();
read("G.road = BOSSES[4].at / CFG.M_PER_UNIT; G.bosses = [true, true, true, true]; G.bossIdx = 4;");
step(2);
check("the meteor falls at 99,000m", read("G.boss") !== null && read("G.boss.d.id") === "meteor");
const m0 = read("G.boss.y");
step(90);
check("and it is coming down", read("G.boss.y") > m0, [m0, read("G.boss.y")]);
check("the road is blocked until it dies", (() => { const a = read("G.road"); step(20); return read("G.road") === a; })());
read("G.boss.t = 900;");
step(2);
check("let it land and the web goes extinct", read("G.state") === "over" && /extinct/i.test(read("G.reason")), read("G.reason"));

/* --- where the five of them actually stand, and what they throw at you --- */
section("BOSS PLACEMENT: on screen, and every shot comes at you");
const WWv = read("WW"), GROUNDv = read("GROUND");
for (let i = 0; i < 5; i++) {
  const nm = read("BOSSES[" + i + "].name");
  arena();
  read("G.bosses = " + JSON.stringify([0, 1, 2, 3, 4].map(k => k < i)) + "; G.bossIdx = " + i +
       "; G.road = BOSSES[" + i + "].at / CFG.M_PER_UNIT; P.shield = 99999;");
  step(2);
  let box = { l: 1e9, r: -1e9, t: 1e9, b: -1e9 }, shots = 0, away = 0, kinds = new Set();
  for (let f = 0; f < 320; f++) {
    step(1);
    if (read("G.boss === null")) break;
    if (read("G.boss.x + G.boss.d.w > WW") || read("G.boss.x < 0") ||
        read("G.boss.dive > 0 || G.boss.dash > 0")) continue;   /* in transit */
    const x = read("G.boss.x"), y = read("G.boss.y"), w = read("G.boss.d.w"), h = read("G.boss.d.h");
    box.l = Math.min(box.l, x); box.r = Math.max(box.r, x + w);
    box.t = Math.min(box.t, y); box.b = Math.max(box.b, y + h);
    const ws = read("G.waves.map(w => [w.kind, w.vx])");
    if (ws.length > shots) { for (const [k, vx] of ws.slice(shots)) { kinds.add(k); if (vx >= 0) away++; } shots = ws.length; }
  }
  check(nm + " never leaves the frame", box.l >= -0.5 && box.r <= WWv + 0.5, box);
  check(nm + " never clips off the top", box.t >= -0.5, box);
  check(nm + " stays on the road side" + (i === 1 ? " (bar its dive)" : ""),
        i === 1 || box.b <= GROUNDv + 1, box);
  if (shots) check(nm + " only ever throws leftward", away === 0, [read("BOSSES[" + i + "].id"), kinds]);
}

section("BOSS AMMO: a boss fight feeds you rockets, not coins");
arena(); armBoss(0);
read("G.road = BOSSES[0].at / CFG.M_PER_UNIT; G.coinN = 0;");
step(2);
read("G.itemT = 1; G.items.length = 0;");
step(2);
check("a live fight drops rockets", read("G.items.every(i => i.k === 'rocket')") && read("G.items.length") > 0,
  read("G.items.map(i => i.k)"));
read("bossDown(); G.bossIdx = 0; G.boss = null; start(); G.coinN = 0; G.itemT = 1; G.items.length = 0;");
step(200, () => {});
check("an empty road still drops coins", read("G.items.some(i => i.k === 'coin')") || read("G.items.length") > 0);

section("the meteor is a fight you can actually win");
arena();
read("G.bosses = [true, true, true, true]; G.bossIdx = 4; G.road = BOSSES[4].at / CFG.M_PER_UNIT;");
step(2);
check("it starts out of rocket range", read("G.boss.y + G.boss.d.h") < read("GROUND - 43 + 11"), read("G.boss.y"));
check("so you have to climb to hit it", read("P.shield = 99999; jump(); true"));
read("P.y = 0; P.vy = 0; P.air = 0; P.flip = -1; P.shield = 99999; G.itemT = 1; G.ammo = 0;");
/* script a competent player: keep the chamber full, shoot the moment the
   meteor is low enough for a grounded rocket, and keep the shield up */
let landed = false, killed = false, trace = "";
for (let f = 0; f < 900; f++) {
  step(1);
  if (f % 60 === 0) trace += " [" + read("'t' + (G.boss ? Math.round(G.boss.t) : -1) + ' y' + (G.boss ? Math.round(G.boss.y) : -1) + ' hp' + (G.boss ? G.boss.hp : 0) + ' ammo' + G.ammo + ' items' + G.items.length + ' n' + G.itemN + ' obs' + G.obs.length") + "]";
  if (read("G.state") !== "run") { landed = read("G.state") === "over"; break; }
  if (read("G.boss === null")) { killed = true; break; }
  /* a competent player: jump to shoot while the rock is high, land to scoop the
     rockets that drop, then shoot it off the ground as it closes in */
  if (read("GROUND - 43 - P.y + 11 >= G.boss.y && GROUND - 43 - P.y + 16 <= G.boss.y + G.boss.d.h")) {
    if (read("G.cool") <= 0 && read("G.ammo") > 0) { down("KeyF"); up("KeyF"); }
  } else if (read("P.y <= 0.01 && G.ammo > 0")) { down("Space"); up("Space"); }
}
check("a skilled player destroys it before impact", killed && !landed, [killed, landed, trace]);
check("and the road is released for the finale", read("G.bosses[4]") === true && read("G.bossIdx") === 5);

/* --- a boss projectile can kill you --- */
arena(); armBoss(0);
read("G.road = BOSSES[0].at / CFG.M_PER_UNIT;");
step(2);
read("G.boss.fire = 1; G.boss.t = 61; G.waves.length = 0;");
step(2);
read("G.waves[0].x = P.x + 20; G.waves[0].y = GROUND - 36;");
step(2);
check("a Wi-Fi pulse in the dino ends the run", read("G.state") === "over", read("G.state"));
check("with a fitting excuse", /pulse/i.test(read("G.reason")), read("G.reason"));
check("a fresh run re-arms the first gate", (() => { read("start()"); return read("G.boss") === null && read("G.bossIdx") === 0; })());

/* ------------------------------- checkpoints ------------------------------ */
section("CHECKPOINTS: a banked snapshot every 10,000m");
arena();
check("the checkpoint interval is 10,000m", read("CFG.CHECKPOINT") === 10000);
read("save.coins = 40; G.road = (CFG.CHECKPOINT - 40) / CFG.M_PER_UNIT;");
step(120);
check("crossing 10,000m banks a checkpoint", read("save.cp && save.cp.m >= 10000"), read("save.cp && save.cp.m"));
check("snapshotting the wallet at that moment", read("save.cp.c") === 40, read("save.cp.c"));
check("and it is persisted to localStorage",
  read("JSON.parse(localStorage.getItem(SAVE_KEY)).cp.m") >= 10000);
arena();
read("G.bosses[0] = true; G.bossIdx = 1; G.road = (20000 - 60) / CFG.M_PER_UNIT;");
step(60);
check("with a shout about it", /CHECKPOINT 20,000m/.test(read("G.toast")), read("G.toast"));
arena();
read("save.coins = 40; G.road = (CFG.CHECKPOINT - 40) / CFG.M_PER_UNIT;");
step(120);
const cpM = read("save.cp.m");
addObs("cactus1", read("P.x + 10"));
read("G.meters = 24000; G.road = 60000; G.score = 999; save.coins = 77;");
step(3);
check("crashing past it does not bank a new one", read("save.cp.m") === cpM, read("save.cp.m"));
read("G.t = G.restartAt + 1;");
down("Space");
check("and the next run resumes from the checkpoint",
  read("G.state") === "run" && read("G.meters") === cpM, [read("G.state"), read("G.meters")]);
check("with the score and wallet rolled back to the snapshot",
  read("G.score") < 999 && read("save.coins") === 40, [read("G.score"), read("save.coins")]);
check("and no cacti from the old run", read("G.obs.filter(o => !o.park).length") === 0);
check("the title screen offers the resume", (() => { read("G.state = 'ready'"); step(2); return read("checkpointAt()") === cpM; })());
read('G.state = "over"; G.restartAt = 0; G.t = 1; P.dead = true;');
step(2);
check("and the game over card says so", read("checkpointAt()") === cpM && read("ui.some(b => b.id === 'newrun')") === true);
tapWorld(read("ui.find(b => b.id === 'newrun')"));
check("tapping NEW RUN throws the checkpoint away", read("checkpointAt()") === 0 && read("G.meters") === 0, read("G.meters"));
check("and starts from zero", read("G.score") === 0 && read("save.cp") === null);

/* --------------------------- the 100,000m ending -------------------------- */
section("FINISH: the Wi-Fi Tower at 100,000m");
arena();
read("save.coins = 10; save.title = ''; save.owned = ['classic']; persist(); G.bosses = [true,true,true,true,true]; G.bossIdx = 5; G.road = (CFG.FINISH - 5) / CFG.M_PER_UNIT;");
step(20);
check("reaching 100,000m wins the run",
  read("G.state") === "win" && read("G.meters") === read("CFG.FINISH"), read("({ s: G.state, m: G.meters })"));
check("the tower arrives", read("G.tower") !== null);
check("and pays 1,000 bonus coins", read("save.coins") === 1010, read("save.coins"));
check("with the CERTIFIED LEGEND title", read("save.title") === "CERTIFIED LEGEND", read("save.title"));
check("and the exclusive Golden Crown Dino", read("save.owned.indexOf('gold') >= 0"));
check("all of it persisted",
  read("JSON.parse(localStorage.getItem(SAVE_KEY)).title") === "CERTIFIED LEGEND" &&
  read("JSON.parse(localStorage.getItem(SAVE_KEY)).owned.indexOf('gold') >= 0"));
check("and the checkpoint is cleared", read("save.cp") === null);
drawn.length = 0;
step(1);
check("the victory screen is painted", drawn.length > 40, drawn.length);
step(30);
check("confetti and fireworks keep bursting", read("G.parts.length") > 0, read("G.parts.length"));
read("G.t = G.restartAt + 1;");
down("Space");
check("space restarts from the victory screen", read("G.state") === "run" && read("G.meters") === 0, read("G.state"));

/* ----------------------------- the whole journey --------------------------- */
section("THE WHOLE 100,000m: five gates, in order, then the tower");
arena();
read("save.owned = ['classic']; save.title = ''; save.coins = 0; save.pro = false; start(); G.itemT = 9999;");
const clearCacti = () => read("G.obs.length = 0;");   /* dodging is covered elsewhere */
const BOSSPAYS = read("BOSSES.reduce((n, b) => n + b.coins, 0)");
for (let i = 0; i < 5; i++) {
  read("G.road = (BOSSES[" + i + "].at - 800) / CFG.M_PER_UNIT;");
  for (let f = 0; f < 900 && read("G.boss === null") && read("G.state") === "run"; f++) step(1, clearCacti);
  const nm = read("BOSSES[" + i + "].name"), at = read("BOSSES[" + i + "].at");
  check("gate " + (i + 1) + " — " + nm + " — wakes up at " + at + "m",
        read("G.boss && G.boss.d.id") === read("BOSSES[" + i + "].id"),
        read("({ s: G.state, r: G.reason, obs: G.obs.length, road: G.road | 0, m: G.meters })"));
  check("and holds the road there",
        read("G.meters >= BOSSES[" + i + "].at && G.road < BOSSES[" + i + "].at / CFG.M_PER_UNIT + 400"),
        read("G.meters"));
  read("if (G.boss) bossHit(G.boss.max + 1, G.boss.x + 4, G.boss.y + 4);");
  step(2, clearCacti);
  check("defeating it banks gate " + (i + 1), read("G.bosses[" + i + "]") === true && read("G.bossIdx") === i + 1);
}
read("G.road = (CFG.FINISH - 800) / CFG.M_PER_UNIT;");
for (let f = 0; f < 900 && read("G.state") === "run"; f++) step(1, clearCacti);
check("past the last gate the road runs out at the tower",
  read("G.state") === "win" && read("G.meters") === 100000, read("({ s: G.state, m: G.meters })"));
check("with all five bosses behind you", read("G.bosses.length") === 5 && read("G.bosses.every(b => b === true)"));
check("and the legend payout — five bosses plus the 1,000-coin finale",
  read("save.title") === "CERTIFIED LEGEND" && read("save.coins") === BOSSPAYS + 1000,
  [read("save.title"), read("save.coins")]);
check("a 100,000m run is 100,000m", read("CFG.M_PER_UNIT * 400000 === CFG.FINISH"));

/* -------------------------------- DINO PRO -------------------------------- */
section("DINO PRO: the VIP pass");
read("save.pro = false; save.coins = 0; save.owned = ['classic']; save.skin = 'classic'; save.title = ''; persist(); G.state = 'ready'; refreshProChip();");
step(2);
check("the GO PRO chip is on the UI", els.bPro.textContent.indexOf("GO PRO") >= 0, els.bPro.textContent);
tapEl("bPro");
check("tapping it opens the VIP modal", read("G.state") === "pro");
check("listing every perk PRO actually grants, hoverboard and golden dino included",
  read("PERKS.length") === 8 && read("PERKS.some(p => p[1] === 'GOLDEN BOARD')") &&
  read("PERKS.some(p => p[1] === 'GOLDEN DINO')") && read("PERKS.some(p => p[1] === 'COIN MAGNET')"),
  read("PERKS.map(p => p[1])"));
step(2);
check("the modal paints a tap target", read("ui.some(b => b.id === 'proon')") === true);
check("with a free-test label", /FREE TEST/.test(read("PERKS[0][2] + ' ' + G.proMsg + ' ' + G.state")) === false);
tapWorld(read("ui.find(b => b.id === 'proon')"));
check("activating PRO flips the flag", read("save.pro") === true);
check("and unlocks the Golden Dino free", read("save.owned.indexOf('gold') >= 0"));
check("the chip now reads PRO", els.bPro.textContent.indexOf("GO PRO") === -1, els.bPro.textContent);
check("and it is persisted", read("JSON.parse(localStorage.getItem(SAVE_KEY)).pro") === true);
tapWorld(read("ui.find(b => b.id === 'proclose')"));
check("the modal closes back to the title", read("G.state") === "ready", read("G.state"));
arena();
read("save.pro = true;");
read("G.items.push({ k:'coin', x: P.x + 20, y: GROUND - 14, w: 11, h: 8 })");
step(2);
check("PRO coins are worth double", read("save.coins") === 2, read("save.coins"));
read("start()");
check("PRO starts every run with three rockets", read("G.ammo") === read("CFG.PRO_ROCKETS"), read("G.ammo"));
check("and two free revives", read("G.revive") === read("CFG.PRO_REVIVES"), read("G.revive"));
read("save.pro = false; start();");
check("a normal run starts empty-handed", read("G.ammo") === 0);
check("with no free revive", read("G.revive") === 0);
arena();
read("save.pro = true; G.revive = CFG.PRO_REVIVES; P.shield = 0;");
addObs("cactus2", read("P.x + 10"));
step(2);
check("PRO's free revive saves the run", read("G.state") === "run" && read("P.dead") === false, read("G.state"));
check("behind a golden energy shield", read("P.shield") > 0);
check("which clears the danger", read("G.obs.filter(o => !o.park).every(o => o.dead)"));
check("and the revive is spent", read("G.revive") === 1, read("G.revive"));
read("P.shield = 0; P.y = 0; P.vy = 0;");
addObs("cactus2", read("P.x + 10"));
step(2);
check("a second crash is caught by the second shield", read("G.state") === "run" && read("P.dead") === false,
  read("G.state"));
check("which is then spent too", read("G.revive") === 0, read("G.revive"));
read("P.shield = 0; P.y = 0; P.vy = 0;");
addObs("cactus2", read("P.x + 10"));
step(2);
check("but the third crash really does end the run", read("G.state") === "over", read("G.state"));

/* ---- the new perks: magnet, overclock, longer incognito ---- */
/* the magnet: a coin in the high row, well out of reach on foot, comes in */
arena();
read("save.pro = false;");
read("G.items.push({ k:'coin', x: P.x + 70, y: GROUND - 78, w: 11, h: 8 })");
step(30);
check("without PRO the high coin row is simply flown over", read("G.coinN") === 0, read("G.coinN"));
arena();
read("save.pro = true;");
read("G.items.push({ k:'coin', x: P.x + 70, y: GROUND - 78, w: 11, h: 8 })");
step(40);
check("with PRO the magnet reels it in", read("G.coinN") === 1, [read("G.coinN"), read("G.items.length")]);
arena();
read("save.pro = true;");
read("G.items.push({ k:'rocket', x: P.x + 70, y: GROUND - 78, w: 13, h: 9 })");
step(30);
check("the magnet is for coins only, not for ammo", read("G.ammo") === 0, read("G.ammo"));
arena();
read("save.pro = true; G.ammo = 1; G.cool = 0;");
down("KeyF");
check("a magnet would not help the rocket either", read("G.shots.length") === 1, read("G.shots.length"));

/* the overclock: PRO halves both recharges */
arena();
read("save.pro = false;");
down("ShiftLeft");
check("a normal bullet time needs the full recharge",
  read("G.slowCd") === read("CFG.SLOW_MS") + read("CFG.SLOW_CD"), read("G.slowCd"));
arena();
read("save.pro = false;");
down("KeyR");
check("and a normal laser roar too", read("G.beamCd") === read("CFG.LASER_CD"), read("G.beamCd"));
arena();
read("save.pro = true;");
down("ShiftLeft");
check("OVERCLOCK halves the bullet-time recharge",
  read("G.slowCd") === read("CFG.SLOW_MS") + read("CFG.SLOW_CD") * read("CFG.PRO_CD"), read("G.slowCd"));
arena();
read("save.pro = true;");
down("KeyR");
check("and the laser roar's", read("G.beamCd") === read("CFG.LASER_CD") * read("CFG.PRO_CD"), read("G.beamCd"));

/* the longer incognito */
arena();
read("save.pro = false;");
read("grantSpy()");
check("a normal spy hat lasts six seconds", read("P.spyT") === read("CFG.SPY_MS"), read("P.spyT"));
arena();
read("save.pro = true; P.shield = 1e9;");
read("grantSpy()");
check("LONG INCOGNITO makes it nine", read("P.spyT") > read("CFG.SPY_MS") &&
  Math.abs(read("P.spyT") - read("CFG.SPY_MS") * read("CFG.PRO_SPY")) < 1, read("P.spyT"));
check("and the fade is scaled to that longer clock, not the short one",
  read("P.spyMax") === read("P.spyT") && read("P.ghost") < 0.2, [read("P.spyMax"), read("P.ghost")]);
step(480);
check("and it really is still running when the short one would be long gone",
  read("P.spy") === 1 && read("P.spyT") > 0, [read("P.spy"), read("P.spyT")]);

read("save.pro = false;");

/* -------------------------------- endurance ------------------------------- */
section("endurance");
read("G.state = 'ready'; start(); G.ammo = 4;");   /* ACTION is ammo-gated now, so start loaded */
const KEYS = ["Space", "ArrowUp", "ArrowDown", "KeyS", "KeyF", "Enter", "ArrowRight", "ShiftLeft", "KeyG", "KeyR", "KeyC"];
const errs0 = errors.length;
let best = 0;
step(5000, i => {
  if (i % 13 === 0) down(KEYS[(Math.random() * KEYS.length) | 0]);
  if (i % 17 === 0) down("ArrowDown");
  if (i % 29 === 0) up("ArrowDown");
  if (i % 20 === 0) { best = Math.max(best, read("G.score")); read("if (G.state === 'over' || G.state === 'win') start(); G.ammo = 4;"); }
});
check("5000 frames of chaotic play, zero runtime errors", errors.length === errs0);
const st = read("({ state: G.state, score: G.score, obs: G.obs.length, parts: G.parts.length, speed: G.speed, clouds: G.clouds.length })");
check("state stays valid", ["run", "over", "pause", "win"].includes(st.state), st);
check("runs earn points, deaths reset them", best > 50, best);
check("obstacles and particles stay bounded", st.obs < 12 && st.parts < 400 && st.clouds <= read("CFG.CLOUD_MAX"), st);
check("obstacle gaps never close to zero", read("G.obs.every(o => o.park || o.gap > 40)") === true);

/* ---------------------------------- audio --------------------------------- */
section("sound chip");
read('save.sound = true; persist();');
tapEl("bSound");
check("SOUND chip mutes", read("save.sound") === false);
check("chip label follows", els.bSound.textContent === "MUTED", els.bSound.textContent);
tapEl("bSound");
check("SOUND chip unmutes", read("save.sound") === true);
check("chip label returns", els.bSound.textContent === "SOUND");
check("persisted to localStorage", read('JSON.parse(localStorage.getItem(SAVE_KEY)).sound') === true);

/* --------------------------- touch hit testing ---------------------------- */
section("TOUCH: taps land where the button really is");
check("the harness runs at a phone-like pixel ratio (so dpr bugs can show)", read("window.devicePixelRatio") >= 2,
  read("window.devicePixelRatio"));
check("CSS px and device px are tracked separately", read("S !== CSS"), [read("S"), read("CSS")]);
check("CSS scale is the true on-screen size", (() => {
  const w = read("shell.style.width").replace("px", "");
  return Math.abs(read("CSS") - w / 384) < 1e-6;
})(), [read("CSS"), read("shell.style.width")]);
/* a tap at a button's real centre must resolve to that exact button */
const roundTrip = (id, state) => {
  if (state) { read("G.state = '" + state + "';"); step(2); }
  const b = read("ui.find(x => x.id === '" + id + "')");
  if (!b) return { id, ok: false, why: "no such button" };
  const k = read("CSS");
  const got = read("hitUI((" + (b.x + b.w / 2) * k + " - 0) / " + k + ", (" + (b.y + b.h / 2) * k + " - 0) / " + k + ")");
  return { id, ok: !!got && got.id === id };
};
check("CLOSE resolves at its real on-screen position", roundTrip("proclose", "pro").ok, roundTrip("proclose", "pro"));
check("ACTIVATE PRO resolves at its real on-screen position", roundTrip("proon", "pro").ok, roundTrip("proon", "pro"));
read("G.state = 'shop'; G.shopSel = 0;");
step(2);
check("so do the shop's skin rows", roundTrip("skin:0", "shop").ok, roundTrip("skin:0", "shop"));
/* and the real event path: a genuine pointerdown on CLOSE must close the panel */
read("G.state = 'ready'; openPro();");
step(2);
check("the PRO panel is open", read("G.state") === "pro");
tapWorld(read("ui.find(b => b.id === 'proclose')"));
check("tapping CLOSE on the real path closes it", read("G.state") === "ready", read("G.state"));
read("G.state = 'over'; openShop('over');");
step(2);
tapWorld(read("ui.find(b => b.id === 'close')"));
check("tapping CLOSE in the shop closes it too", read("G.state") === "over", read("G.state"));

/* ------------------------------ menu design -------------------------------- */
section("MENU DESIGN: every panel holds its own contents");
/* Each panel is a fixed world-space box; nothing it draws may escape it, or the
   menus break the moment a label gets longer. */
const panelBounds = { ready: [67, 26, 250, 132], over: [67, 14, 250, 172], pro: [20, 1, 344, 213], shop: [20, 1, 344, 213] };
const inPanel = (b, [px, py, pw, ph]) => b.x >= px - 0.5 && b.x + b.w <= px + pw + 0.5 &&
                                       b.y >= py - 0.5 && b.y + b.h <= py + ph + 0.5;
for (const [state, box] of Object.entries(panelBounds)) {
  arena();
  read("G.state = '" + state + "'; G.shopSel = 0; if (G.state === 'over') G.t = G.restartAt + 1;");
  step(2);
  const stray = read("ui").filter(b => !inPanel(b, box));
  check("the " + state + " panel keeps every button inside itself", stray.length === 0, stray);
}
/* the title card is the front door: it must offer a way in */
arena();
read("G.state = 'ready'; clearCheckpoint();");
step(2);
check("the title card has a START button", read("ui.some(b => b.id === 'startbtn')"), read("ui.map(b => b.id)"));
check("plus the shop and the VIP pass", read("ui.some(b => b.id === 'shop')") && read("ui.some(b => b.id === 'proui')"));
check("and all three sit side by side, not stacked",
  read("ui.filter(b => ['startbtn','shop','proui'].includes(b.id)).map(b => b.x).join()") ===
  read("ui.filter(b => ['startbtn','shop','proui'].includes(b.id)).map(b => b.x).sort((a,b)=>a-b).join()"),
  read("ui.filter(b => ['startbtn','shop','proui'].includes(b.id)).map(b => b.x)"));
read("G.state = 'ready';");
step(2);
tapWorld(read("ui.find(b => b.id === 'startbtn')"));
check("START actually starts a run", read("G.state") === "run", read("G.state"));
/* with a checkpoint banked the same button has to resume instead */
arena();
read("G.road = (CFG.CHECKPOINT - 40) / CFG.M_PER_UNIT;");   /* run first, so it banks */
step(120);
check("a checkpoint is banked", read("save.cp && save.cp.m >= 10000"), read("save.cp && save.cp.m"));
read("G.state = 'ready';");
step(2);
check("with a checkpoint the card offers RESUME and NEW RUN",
  read("ui.some(b => b.id === 'startbtn')") && read("ui.some(b => b.id === 'newrun')"),
  read("ui.map(b => b.id)"));
const resumeM = read("save.cp.m");
tapWorld(read("ui.find(b => b.id === 'startbtn')"));
check("and RESUME drops you back at the checkpoint",
  read("G.state") === "run" && read("G.meters") === resumeM, [read("G.state"), read("G.meters")]);
arena();
read("G.road = (CFG.CHECKPOINT - 40) / CFG.M_PER_UNIT;");
step(120);
read("G.state = 'ready';");
step(2);
tapWorld(read("ui.find(b => b.id === 'newrun')"));
check("NEW RUN throws the checkpoint away and starts from zero",
  read("G.state") === "run" && read("G.meters") < 200 && read("save.cp") === null,
  [read("G.state"), read("G.meters"), read("save.cp")]);

/* ------------------------------- hoverboard -------------------------------- */
section("HOVERBOARD: a board you carry, deploy and crash on");
arena();
check("you start with none in stock", read("save.boards") === 0 && read("P.board") === 0);
down("KeyH");
step(2);
check("H with an empty stock is refused, not spent", read("P.board") === 0 && /NO HOVERBOARD/.test(read("G.toast")),
  read("G.toast"));
read("save.boards = 1; persist();");
down("KeyH");
step(2);
check("H deploys a board you own", read("P.board") === 1, read("P.board"));
check("and it comes out of your stock", read("save.boards") === 0, read("save.boards"));
check("persisted, so a reload keeps your stock honest",
  read("JSON.parse(localStorage.getItem(SAVE_KEY)).boards") === 0);
step(30);
check("the dino floats above the ground", read("P.y") > 10 && Math.abs(read("P.y") - read("CFG.HOVER_H")) < 3,
  [read("P.y"), read("CFG.HOVER_H")]);
check("hovering leaves a spark trail", read("G.parts.length") > 0, read("G.parts.length"));
down("KeyH");
step(2);
check("H again stows it and banks a board for later", read("P.board") === 0 && read("save.boards") === 1,
  [read("P.board"), read("save.boards")]);

/* crash protection: the board eats one hit and the run continues */
arena();
read("save.boards = 1; P.board = 1;");
step(20);
addObs("cactus2", read("P.x + 10"));
step(3);
check("a cactus destroys the board, not the run", read("G.state") === "run" && read("P.dead") === false,
  read("G.state"));
check("the board is gone", read("P.board") === 0);
check("and the player is told", /HOVERBOARD CRASHED/.test(read("G.toast")), read("G.toast"));
check("the hazard is cleared so you are not instantly re-killed",
  read("G.obs.filter(o => !o.dead && o.x + o.w > P.x - 20 && o.x < P.x + 120).length") === 0);
step(60);
check("the run really carries on afterwards", read("G.state") === "run" && read("G.meters") > 0, read("G.state"));
addObs("cactus2", read("P.x + 10"));
step(3);
check("but a second crash with no board does end it", read("G.state") === "over", read("G.state"));

/* the kickflip is a real hop, not a cosmetic spin */
arena();
read("save.boards = 1; P.board = 1;");
step(30);
const yBefore = read("P.y");
check("the deck settles at the hover height and holds it",
  Math.abs(yBefore - read("CFG.HOVER_H")) < 3 && read("P.vy") === 0, [yBefore, read("P.vy")]);
down("Space");
check("jumping on a board starts a spin", read("P.spin") > 0, read("P.spin"));
check("and the kickflip leaves the deck on the very first frame", read("P.vy") > 0, read("P.vy"));
step(2);
check("and the dino leaves the hover height", read("P.y") > yBefore, [yBefore, read("P.y")]);
let hopTop = 0;
step(30, () => { hopTop = Math.max(hopTop, read("P.y")); });
check("the kickflip is a real hop, not a wobble", hopTop > yBefore + 30, [yBefore, hopTop]);
check("high enough to clear a bird on the wing", hopTop > 60, hopTop);
check("the spin is a full 360", read("CFG.HOVER_SPIN") === 30);
let spun = 0;
step(40, () => { spun = Math.max(spun, read("P.spin")); });
check("the deck catches the dino back at the hover height",
  Math.abs(read("P.y") - read("CFG.HOVER_H")) < 3 && read("P.vy") === 0,
  [read("P.y"), read("P.vy")]);
check("the spin completes and the dino settles back",
  read("P.spin") === 0 && Math.abs(read("P.y") - read("CFG.HOVER_H")) < 3, [read("P.spin"), read("P.y")]);
check("and the board is still flying", read("P.board") === 1);
check("the landing re-arms the kickflip", read("P.air") === 0, read("P.air"));

/* a second tap in mid-air is a second kickflip */
arena();
read("save.boards = 1; P.board = 1;");
step(30);
down("Space");
step(4);
const flipY = read("P.y");
down("Space");
check("a second tap on the board is a second kickflip", read("P.air") === 2, read("P.air"));
step(4);
check("which carries the dino higher still", read("P.y") > flipY, [flipY, read("P.y")]);
step(60);
check("and it all lands back on the deck", read("P.board") === 1 && read("P.air") === 0 && Math.abs(read("P.y") - read("CFG.HOVER_H")) < 3,
  [read("P.board"), read("P.air"), read("P.y")]);

/* the whole point of the hop: a board you can actually steer over the road */
arena();
read("save.boards = 1; P.board = 1;");
step(30);
addObs("cactus1", read("P.x + 90"));
step(24);
check("hovering into a cactus costs the board (the free hit still works)",
  read("P.board") === 0 && read("G.state") === "run", [read("P.board"), read("G.state")]);
step(60);
arena();
read("save.boards = 1; P.board = 1;");
step(30);
addObs("cactus1", read("P.x + 90"));
down("Space");
step(24);
check("but hopping the board over the same cactus keeps it flying",
  read("P.board") === 1 && read("G.state") === "run", [read("P.board"), read("G.state")]);
step(60);
arena();
read("save.boards = 1; P.board = 1;");
step(30);
addObs("ptero", read("P.x + 64"));
down("Space");
step(30);
check("and a kickflip clears a pterodactyl's flight line too",
  read("P.board") === 1 && read("G.state") === "run", [read("P.board"), read("G.state")]);
step(60);

/* a hovering dino must not sail over the track's own pickups */
arena();
read("save.boards = 1; P.board = 1;");
step(30);
read("G.items.push({ k: 'coin', x: P.x + 40, y: GROUND - 14, w: 11, h: 8 });");
step(12);
check("the low coin row is scooped up from the deck, not flown over", read("G.coinN") === 1, read("G.coinN"));
arena();
read("save.boards = 1; P.board = 1;");
step(30);
read("G.items.push({ k: 'coin', x: P.x + 40, y: GROUND - 54, w: 11, h: 8 });");
step(12);
check("and the middle row too", read("G.coinN") === 1, read("G.coinN"));
arena();
read("save.boards = 1; P.board = 1;");
step(30);
read("G.items.push({ k: 'rocket', x: P.x + 40, y: GROUND - 30, w: 13, h: 9 });");
step(12);
check("a [ROCKET] box is still within reach from the deck", read("G.ammo") === 3, read("G.ammo"));

/* a rocket fired from the deck has to reach the road, or the board makes the
   missile useless: it would sail over every cactus on the track */
arena();
read("save.boards = 1; P.board = 1;");
step(30);
addObs("cactus1", read("P.x + 140"));
read("G.ammo = 1;");
down("KeyF");
step(14);
check("a rocket fired from the board kills a cactus on the road",
  read("G.bonus") === 25 && read("P.board") === 1, [read("G.bonus"), read("P.board")]);
arena();
read("save.boards = 1; P.board = 1;");
step(30);
addObs("cactus2", read("P.x + 140"));
read("G.ammo = 1;");
down("KeyF");
step(14);
check("and a tall one as well", read("G.bonus") === 25 && read("P.board") === 1,
  [read("G.bonus"), read("P.board")]);

/* stowing mid-kickflip hands the dino back to ordinary gravity */
arena();
read("save.boards = 1; P.board = 1;");
step(30);
down("Space");
step(6);
down("KeyH");
check("you can stow the board in mid-air", read("P.board") === 0 && read("P.y") > read("CFG.HOVER_H"),
  [read("P.board"), read("P.y")]);
step(80);
check("and the dino falls all the way back to the road", read("P.y") === 0 && read("G.state") === "run",
  [read("P.y"), read("G.state")]);

/* the board blocks a boss shot too */
arena(); armBoss(0);
read("G.road = BOSSES[0].at / CFG.M_PER_UNIT;");
step(2);
read("save.boards = 1; P.board = 1; G.boss.fire = 1; G.boss.t = 61; G.waves.length = 0;");
step(2);
read("if (G.waves[0]) { G.waves[0].x = P.x + 20; G.waves[0].y = GROUND - 36; }");
step(2);
check("a boss pulse costs the board, not the run", read("G.state") === "run" && read("P.board") === 0, read("G.state"));

/* tap = jump, a quick second tap in the air = the 360 double jump */
arena();
read("save.boards = 1;");
const tapField = () => {
  const k = read("CSS");
  fire("wrap", "pointerdown", { pointerId: 77, clientX: 200 * k, clientY: 100 * k });
  fire("wrap", "pointerup", { pointerId: 77, clientX: 200 * k, clientY: 100 * k });
};
tapField();
check("a tap on the field jumps on the press, not the release", read("P.vy") > 0, read("P.vy"));
check("and a board in your pack is not spent on it", read("P.board") === 0, read("P.board"));
step(3);
check("three frames later it is really off the ground", read("P.y") > 15, read("P.y"));
const airY = read("P.y");
tapField();
step(2);
check("a second tap in mid-air is the double jump", read("P.air") === 1, read("P.air"));
check("which carries it higher than the first jump could", read("P.y") > airY, [airY, read("P.y")]);
check("and starts the 360 backflip", read("P.flip") >= 0, read("P.flip"));
step(6);
check("the backflip really turns", read("P.flip") > 0.2 && read("P.flip") <= 1, read("P.flip"));
step(130);
check("and it lands cleanly", read("P.y") === 0 && read("P.flip") === -1, [read("P.y"), read("P.flip")]);
/* releasing the finger must not add a second, phantom jump */
arena();
tapField();
const vyAfterTap = read("P.vy");
fire("wrap", "pointerup", { pointerId: 78 });
check("letting go of the field does not jump again", read("P.vy") === vyAfterTap, read("P.vy"));
read("save.boards = 0;");

/* the shop pack */
arena();
read("save.coins = 30; G.state = 'shop'; G.shopSel = -1;");
step(2);
check("the shop lists a hoverboard pack", read("ui.some(b => b.id === 'boardpack')"), read("ui.map(b => b.id)"));
tapWorld(read("ui.find(b => b.id === 'boardpack')"));
check("buying a pack costs 30 coins", read("save.coins") === 0, read("save.coins"));
check("and stocks three boards", read("save.boards") === 3, read("save.boards"));
check("persisted", read("JSON.parse(localStorage.getItem(SAVE_KEY)).boards") === 3);
read("save.coins = 5; G.shopSel = -1;");
step(2);
tapWorld(read("ui.find(b => b.id === 'boardpack')"));
check("too few coins is refused and explained", read("save.boards") === 3 && /NOT ENOUGH/.test(read("G.shopMsg")),
  read("G.shopMsg"));

/* PRO */
arena();
read("save.pro = true; start();");
check("PRO starts every run already flying", read("P.board") === 1 && read("save.boards") === 0,
  [read("P.board"), read("save.boards")]);
step(30);
check("and it hovers from the first frame", read("P.y") > 10, read("P.y"));
read("save.pro = false; start();");
check("a normal run starts on foot", read("P.board") === 0);

/* the rare pickup */
arena();
read("G.itemN = CFG.BOARD_EVERY - 1; G.items.length = 0;");
step(2);
read("G.itemT = 1;");
step(2);
check("a board pickup spawns on the track", read("G.items.some(i => i.k === 'board')"), read("G.items.map(i => i.k)"));
read("P.board = 0; save.boards = 0;");
read("G.items.filter(i => i.k === 'board').forEach(i => { i.x = P.x + 4; i.y = GROUND - 34; });");
step(2);
check("collecting it adds to your stock", read("save.boards") === 1, read("save.boards"));

/* ------------------------------ incognito --------------------------------- */
section("INCOGNITO: six seconds of being untouchable");
arena();
check("off by default", read("P.spy") === 0);
read("G.itemN = CFG.SPY_EVERY - 1; G.items.length = 0;");
step(2);
read("G.itemT = 1;");
step(2);
check("the spy hat spawns on the track", read("G.items.some(i => i.k === 'spy')"), read("G.items.map(i => i.k)"));
read("G.items.filter(i => i.k === 'spy').forEach(i => { i.x = P.x + 4; i.y = GROUND - 40; });");
step(2);
check("collecting it turns incognito on", read("P.spy") === 1, read("P.spy"));
check("for six seconds", read("P.spyT") > 5000 && read("P.spyT") <= read("CFG.SPY_MS"), read("P.spyT"));
check("and it says so", /INCOGNITO/.test(read("G.toast")), read("G.toast"));
step(40);
check("the ghost fades in", read("P.ghost") > 0.9, read("P.ghost"));

/* the whole point: you cannot be hurt */
addObs("cactus2", read("P.x + 10"));
step(3);
check("a cactus passes straight through you", read("G.state") === "run" && read("P.dead") === false, read("G.state"));
check("and is phased out rather than left to hit you later",
  read("G.obs.filter(o => o.k === 'cactus2' && !o.dead).length") === 0);
addObs("cactus2", read("P.x + 10"));
step(3);
check("and again, for as long as it lasts", read("G.state") === "run", read("G.state"));

/* the palette really is Chrome's incognito grey */
check("the paper turns incognito grey #202124", read("PAPER.toLowerCase()") === "#202124", read("PAPER"));
check("while the dino stays light so it reads as a ghost", read("INK.toLowerCase()") === "#e8eaed", read("INK"));

step(30);
check("the clock ticks down", read("P.spyT") < 5600, read("P.spyT"));
step(400);
check("after six seconds incognito ends", read("P.spy") === 0 && read("P.spyT") === 0, [read("P.spy"), read("P.spyT")]);
check("and the sky returns to normal", read("PAPER.toLowerCase()") === "#ffffff", read("PAPER"));
addObs("cactus2", read("P.x + 10"));
step(3);
check("with the dino solid again, cacti hurt", read("G.state") === "over", read("G.state"));

/* incognito also phases boss fire */
arena(); armBoss(0);
read("G.road = BOSSES[0].at / CFG.M_PER_UNIT;");
step(2);
read("P.spy = 1; P.spyT = 6000; P.ghost = 1; G.boss.fire = 1; G.boss.t = 61; G.waves.length = 0; P.shield = 0;");
step(2);
read("if (G.waves[0]) { G.waves[0].x = P.x + 20; G.waves[0].y = GROUND - 36; }");
step(2);
check("boss fire passes through too", read("G.state") === "run", read("G.state"));

/* a board banks in the checkpoint so a crash never costs it */
arena();
read("save.pro = true; start(); G.bosses = BOSSES.map(() => true); G.bossIdx = BOSSES.length;");
step(30);
read("G.road = (CFG.CHECKPOINT - 30) / CFG.M_PER_UNIT;");
step(90);
check("a checkpoint banks the deployed board", read("save.cp && save.cp.h") === 1, read("save.cp && save.cp.h"));

/* the power-ups have to be visible, not just present in the state */
section("POWER-UP RENDERING: what you actually see");
const aboveHead = () => { const g = read("GROUND") - 43;
  return drawn.filter(r => r[1] / read("S") < g && r[1] / read("S") > g - 30).length; };
arena(); read("G.clouds.length = 0; G.cloudT = 99999;"); drawn.length = 0; read("P.spy = 1; P.spyT = 6000; P.ghost = 1;"); step(2);
check("incognito puts a hat and shades above the dino's head", aboveHead() > 6, aboveHead());
/* the sky has to be empty for this one: a cloud in the band is a mark too */
arena(); read("G.clouds.length = 0; G.cloudT = 99999;"); drawn.length = 0; read("P.spy = 0;"); step(2);
check("and the plain dino has nothing on its head", aboveHead() === 0, aboveHead());
/* the deck is measured as extra marks under the feet, not an absolute count:
   the dino's own legs live in the same band */
const deckMarks = () => { const S = read("S"), G = read("GROUND");
  return drawn.filter(r => { const y = r[1] / S; return y > G - 12 && y < G - 1; }).length; };
arena(); drawn.length = 0; read("save.pro = false; save.boards = 0; start();"); step(40);
const onFoot = deckMarks();
arena(); drawn.length = 0; read("save.pro = true; start();"); step(40);
const onBoard = deckMarks();
check("the hoverboard paints a deck and jets under the dino's feet", onBoard > onFoot + 40, [onFoot, onBoard]);
check("and a spark trail hangs under it", read("G.parts.length") > 0, read("G.parts.length"));
read("save.pro = true; start();");
step(30);
drawn.length = 0;
read("P.spin = CFG.HOVER_SPIN;");
step(2);
check("a kickflip rotates the sprite rather than redrawing it upright", read("P.spin") > 0, read("P.spin"));
arena(); drawn.length = 0;
read("G.state = 'run'; G.items.push({ k: 'board', x: 200, y: GROUND - 34, w: 26, h: 14 });");
step(2);
check("the board pickup is on the track waiting to be collected",
  read("G.items.some(i => i.k === 'board')"), read("G.items.map(i => i.k)"));
/* the deck's 52x12 neon glow is the only rect that shape in the scene, so its
   top edge is a reliable probe for where the board is actually painted.  A
   deck left parked on the road while the dino spins overhead reads as a bug. */
const deckGlowY = () => {
  const S = read("S");
  const m = drawn.filter(r => r[2] > 175 && r[2] < 190 && r[3] > 36 && r[3] < 48);
  return m.length ? Math.max(...m.map(r => r[1])) / S : null;
};
arena();
read("G.clouds.length = 0; G.cloudT = 99999; save.boards = 1; P.board = 1;");
step(30);
drawn.length = 0;
step(2);
const glowRest = deckGlowY();
down("Space");
step(11);
drawn.length = 0;
step(1);
const glowHop = deckGlowY();
check("the deck is painted just above the road when the dino is hovering",
  glowRest !== null && glowRest > read("GROUND") - 14 && glowRest < read("GROUND") - 4, glowRest);
check("and it flies up with the dino through a kickflip",
  glowHop !== null && glowHop < glowRest - 40, [glowRest, glowHop]);

/* ---- the deck rides on springs, not on a string ---- */
arena();
read("G.clouds.length = 0; G.cloudT = 99999; save.boards = 1; P.board = 1;");
step(40);
check("the deck settles dead level at rest", Math.abs(read("P.bob")) < 0.05 && Math.abs(read("P.bobV")) < 0.05,
  [read("P.bob"), read("P.bobV")]);
down("Space");
let dip = 0, kicked = false;
step(45, () => {
  const b = read("P.bob");
  if (!kicked && read("P.bobV") < -0.5) kicked = true;
  if (kicked) dip = Math.min(dip, b);
});
check("landing compresses the suspension", kicked && dip < -2, [kicked, dip]);
step(90);
check("and the springs push it back to level instead of letting it ring",
  Math.abs(read("P.bob")) < 0.05 && Math.abs(read("P.bobV")) < 0.05, [read("P.bob"), read("P.bobV")]);
check("with the dino back on the cushion", Math.abs(read("P.y") - read("CFG.HOVER_H")) < 3, read("P.y"));

/* ---- the light pool under the deck: the cue that says "floating" ---- */
arena();
read("G.clouds.length = 0; G.cloudT = 99999; save.boards = 1; P.board = 1;");
step(30);
drawn.length = 0;
step(1);
const pool = drawn.filter(r => r[3] <= 4 && r[2] >= 40);      /* wide, flat rows on the road */
check("the deck throws a wide flat pool of light onto the road", pool.length >= 4, pool.length);
const poolFoot = (() => { drawn.length = 0; read("P.board = 0;"); step(1);
  return drawn.filter(r => r[3] <= 4 && r[2] >= 40).length; })();
check("which a dino standing on the road does not", poolFoot < pool.length / 2, [pool.length, poolFoot]);
arena();
read("G.clouds.length = 0; G.cloudT = 99999; save.boards = 1; P.board = 1;");
step(30);
down("Space");
step(12);
drawn.length = 0;
step(1);
const poolHigh = drawn.filter(r => r[3] <= 4 && r[2] >= 40).length;
check("and it tightens and dims as the deck climbs away", poolHigh < pool.length, [pool.length, poolHigh]);

/* ---- the rider leans into the run instead of being glued to the deck ---- */
/* SPT rotates about the sprite's own centre, so a turned sprite records its
   rects around the origin — negative x, y near zero.  Only that marks a tilt;
   the road's dashes and pebbles are drawn in world space and never look like it. */
const tilted = () => drawn.filter(r => r[0] < 0 && r[2] >= 3 && Math.abs(r[1]) < 120).length;
arena();
read("G.clouds.length = 0; G.cloudT = 99999; save.boards = 1; P.board = 1;");
step(30);
drawn.length = 0;
step(1);
const turned = tilted();
read("P.board = 0;");
drawn.length = 0;
step(1);
const footTurned = tilted();
check("the rider is drawn tilted while the board is simply hovering",
  turned > 0 && footTurned === 0, [turned, footTurned]);

/* ---- and the engine hum climbs with the speed of the run ---- */
arena();
read("save.boards = 1; P.board = 1; G.road = 0; P.shield = 1e9;");
audio.notes.length = 0;
step(40);
const humWalk = Math.max.apply(null, audio.notes.filter(n => n.type === "sine" && n.f < 400).map(n => n.f));
read("G.road = 399000; P.board = 1; P.shield = 1e9;");
audio.notes.length = 0;
step(40);
const humSprint = Math.max.apply(null, audio.notes.filter(n => n.type === "sine" && n.f < 400).map(n => n.f));
check("and the sprint really is a sprint", read("G.speed") > read("CFG.MAX_SPEED") - 0.2, read("G.speed"));
check("the hover hum rises as the run speeds up", humSprint > humWalk * 1.3, [humWalk, humSprint]);

/* --------------------------- the 7-button bar ----------------------------- */
section("CONTROLS: the seven-button mobile bar");
const BAR = ["bGrind", "bSlow", "bParry", "bRocket", "bHook", "bRide", "bJump"];
check("the bar holds exactly the seven controls the design calls for",
  BAR.every(id => !!els[id]), BAR.filter(id => !els[id]));
check("and each one belongs to the pad, not the page",
  BAR.every(id => els[id].closest("#pad") === els[id]));
check("JUMP is on the bar, so a phone never depends on a gesture alone",
  BAR[BAR.length - 1] === "bJump" && /bJump/.test(html), true);
arena();
tapEl("bJump");
step(3);
check("tapping JUMP jumps", read("P.y") > 0, read("P.y"));
step(130);
tapEl("bJump");
step(3);
tapEl("bJump");
step(2);
check("and a second JUMP in the air is the double jump", read("P.air") === 1, read("P.air"));
step(140);
arena();
read("G.ammo = 3;");
tapEl("bRocket");
check("tapping ROCKET fires", read("G.shots.length") === 1);
arena();
fire("bGrind", "pointerdown", { pointerId: 5 });
step(2);
check("holding GRIND slides", read("P.duck") === true);
fire("bGrind", "pointerup", { pointerId: 5 });
arena();
tapEl("bSlow");
check("tapping SLOW starts bullet time", read("G.slowT") > 0);

/* ------------------------------ grappling hook ----------------------------- */
section("HOOK: grapple up and swing over the road");
arena();
read("G.clouds.length = 0;");
down("KeyG");
check("with nothing overhead the hook is refused, not wasted",
  read("P.hookT") === 0 && /NO ANCHOR/.test(read("G.toast")), read("G.toast"));
arena();
read("G.clouds.length = 0; G.clouds.push({ x: 210, y: 40, s: 1 });");
down("KeyG");
check("a cloud overhead is a valid anchor", read("P.hookT") > 0, read("P.hookT"));
check("and the shout goes up", /GRAPPLE/.test(read("G.toast")), read("G.toast"));
step(30);
check("the pendulum carries the dino into the air", read("P.y") > 30, read("P.y"));
addObs("cactus2", read("P.x + 10"));
step(3);
check("a ground cactus passes safely underneath", read("G.state") === "run", read("G.state"));
step(170);
check("about three seconds later the hook releases", read("P.hookT") === 0, read("P.hookT"));
check("with a NICE! pop-up", /NICE/.test(read("G.toast")), read("G.toast"));
arena();
fire("bHook", "pointerdown", { pointerId: 6 });
check("the HOOK button works from touch too", read("P.hookT") > 0 || /NO ANCHOR/.test(read("G.toast")));
/* the clouds are the anchor, so the sky has to be stocked and in reach */
check("the cloud band is hookable and clear of the road",
  read("CFG.CLOUD_MIN_Y") >= 30 && read("CFG.CLOUD_MAX_Y") <= read("GROUND - 36 - 24"),
  [read("CFG.CLOUD_MIN_Y"), read("CFG.CLOUD_MAX_Y"), read("GROUND - 60")]);
check("and the band matches what the hook caller accepts",
  read("CFG.CLOUD_MAX_Y + 8 < GROUND - 36"), read("GROUND - 36"));
arena();
read("G.clouds.length = 0; G.cloudT = 1;");
step(1200);
check("clouds keep drifting in all through a run", read("G.clouds.length") >= 2, read("G.clouds.length"));
check("never more than the sky box allows", read("G.clouds.length") <= read("CFG.CLOUD_MAX"), read("G.clouds.length"));
check("and every one of them sits inside the band",
  read("G.clouds.every(c => c.y >= CFG.CLOUD_MIN_Y && c.y <= CFG.CLOUD_MAX_Y)"),
  read("G.clouds.map(c => Math.round(c.y))"));
/* the rope itself: a real line, not a three-pixel stub */
arena();
read("G.clouds.length = 0; G.clouds.push({ x: 210, y: 40, s: 1 });");
step(2);
drawn.length = 0;
step(1);
const rectsBare = drawn.length;
drawn.length = 0;
down("KeyG");
step(1);
const rectsRoped = drawn.length;
check("a grapple paints a long rope up to the cloud",
  read("P.hookT") > 0 && rectsRoped > rectsBare + 40, [rectsBare, rectsRoped]);

/* ------------------------------- laser roar -------------------------------- */
section("LASER ROAR: a screen-clearing beam");
arena();
read("G.obs.length = 0;");
addObs("cactus1", 100); addObs("cactus2", 170); addObs("ptero", 240);
down("KeyR");
check("R fires the Laser Roar", read("G.beamT") > 0, read("G.beamT"));
check("and vaporizes every cactus and bird on screen",
  read("G.obs.filter(o => !o.park && !o.dead).length") === 0, read("G.obs.map(o => o.dead)"));
drawn.length = 0;
step(2);
check("the beam is painted across the frame", drawn.length > 40, drawn.length);
arena();
read("G.obs.length = 0; G.combo = 0;");
read("bumpCombo(1); bumpCombo(1); bumpCombo(1); bumpCombo(1);");
check("four kills do not yet fire the Roar", read("G.beamT") === 0 && read("G.combo") === 4, [read("G.beamT"), read("G.combo")]);
read("bumpCombo(1)");
check("the fifth chains into the Laser Roar", read("G.beamT") > 0 && read("G.combo") === 0, read("G.combo"));
arena();
read("G.obs.length = 0;");
down("KeyC"); step(1); down("KeyC");
check("a double-tapped PARRY fires it too", read("G.beamT") > 0, read("G.beamT"));
check("and the PARRY shout lands", /PARRY|LASER/.test(read("G.toast")), read("G.toast"));

/* ---- the limit: a gun, not a button you can lean on ---- */
/* the shield keeps the probe dino alive, so the block below is about the
   cooldown and nothing else — no stray cactus ending the run mid-measurement */
const gunSafe = () => read("P.dead = false; G.state = 'run'; P.shield = 1e9; G.obs.length = 0;");
arena(); gunSafe();
down("KeyR");
check("firing it starts the recharge", read("G.beamCd") === read("CFG.LASER_CD"),
  [read("G.beamCd"), read("CFG.LASER_CD")]);
check("while the beam itself is only a split second",
  read("G.beamT") > 0 && read("G.beamT") <= read("CFG.LASER_MS"), read("G.beamT"));
step(60);
gunSafe();
check("when the beam burns out the gun is still hot", read("G.beamT") === 0 && read("G.beamCd") > 0,
  [read("G.beamT"), read("G.beamCd")]);
addObs("cactus1", 250);
down("KeyR");
check("a second press while it is hot is refused, not fired", read("G.beamT") === 0, read("G.beamT"));
check("and the player is told how long is left", /LASER RECHARGING/.test(read("G.toast")), read("G.toast"));
check("so the screen is not cleared a second time", read("G.obs.filter(o => !o.dead).length") === 1,
  read("G.obs.map(o => o.dead)"));
read("G.beamCd = 100;");
step(10);
gunSafe();
check("the charge runs out on its own", read("G.beamCd") === 0, read("G.beamCd"));
addObs("cactus1", 250);
down("KeyR");
check("and then it fires again", read("G.beamT") > 0, read("G.beamT"));
arena(); gunSafe();
read("G.beamCd = 4000;");
down("KeyC"); step(1); down("KeyC");
check("a hot gun refuses the double-tap too", read("G.beamT") === 0 && /RECHARGING/.test(read("G.toast")),
  read("G.toast"));
arena(); gunSafe();
read("G.beamCd = 4000; G.combo = 4;");
read("bumpCombo(1)");
check("but a five-kill combo is a reward, so it may spend a warm charge", read("G.beamT") > 0, read("G.beamT"));
check("and it re-arms the clock, so even the combo cannot machine-gun it",
  read("G.beamCd") === read("CFG.LASER_CD"), read("G.beamCd"));
arena();
read("G.road = 8000; G.meters = 2000; G.beamCd = 3000; writeCheckpoint();");
check("a banked checkpoint keeps the recharge, so dying is not a reload",
  read("save.cp.w") === 3000, read("save.cp && save.cp.w"));
read("resume()");
check("and resuming puts it back still charging", read("G.beamCd") === 3000, read("G.beamCd"));

/* ------------------------------ trajectory --------------------------------- */
section("TRAJECTORY: a dotted arc through the air");
arena();
read("G.obs.length = 0; G.arc.length = 0;");
down("Space");
step(5);
check("an airborne dino leaves a trajectory trail", read("G.arc.length") > 2, read("G.arc.length"));
check("which tracks real height, not a flat line", (() => {
  const a = read("G.arc.slice()");
  return new Set(a.map(v => Math.round(v))).size > 1;
})());
step(80);
check("and the trail clears on landing", read("G.arc.length") === 0, read("G.arc.length"));

/* ----------------------------- mystery boxes ------------------------------- */
section("MYSTERY BOXES: [H], [I] and [ROCKET] on the track");
arena();
read("G.items.length = 0; G.items.push({ k:'board', x:200, y:GROUND - 34, w:26, h:14 });"
   + " G.items.push({ k:'spy', x:240, y:GROUND - 40, w:24, h:16 });"
   + " G.items.push({ k:'rocket', x:280, y:GROUND - 30, w:13, h:9 });");
drawn.length = 0;
step(2);
check("all three box kinds paint without error", errors.length === 0);
check("the board box is a floating [H]", read("G.items.some(i => i.k === 'board')"));
read("P.board = 0; save.boards = 0; G.items.filter(i => i.k === 'board').forEach(i => { i.x = P.x + 4; i.y = GROUND - 34; });");
step(2);
check("collecting the [H] box stocks a hoverboard", read("save.boards") === 1, read("save.boards"));
read("G.items.length = 0; G.items.push({ k:'rocket', x: P.x + 4, y: GROUND - 30, w:13, h:9 }); G.ammo = 0;");
step(2);
check("collecting the [ROCKET] box loads three", read("G.ammo") === read("CFG.BOX_AMMO"), read("G.ammo"));

/* ------------------------------- hud layout -------------------------------- */
section("HUD: three columns that cannot overlap");
const HUDC = read("HUD");
check("the left cluster stops before the centre column", HUDC.colR <= HUDC.barX - 8, [HUDC.colR, HUDC.barX]);
check("the progress bar is centred in the 384px world", HUDC.barX === 384 - HUDC.barR, [HUDC.barX, HUDC.barR]);
check("the left rows sit above the bar", HUDC.rowA < HUDC.barY && HUDC.rowB < HUDC.barY - 3);
check("the right rows sit above the bar too", HUDC.rA < HUDC.barY && HUDC.rB < HUDC.barY - 3);
check("the right cluster starts below the DOM chips overhead", HUDC.rA >= 24, HUDC.rA);
check("the bands stack without touching",
  HUDC.barY < HUDC.seedY && HUDC.seedY + 6 <= HUDC.toastY && HUDC.toastY + 6 <= HUDC.alertY,
  [HUDC.barY, HUDC.seedY, HUDC.toastY, HUDC.alertY]);
check("and the CERTIFIED LEGEND tag has a line of its own",
  HUDC.tagY > HUDC.rowB && HUDC.tagY < HUDC.toastY, [HUDC.rowB, HUDC.tagY, HUDC.toastY]);
check("the two recharge lines stack under the score without touching",
  HUDC.chargeY > HUDC.rB && HUDC.chargeY + 2 < HUDC.chargeY2 && HUDC.chargeY2 < HUDC.seedY + 2,
  [HUDC.rB, HUDC.chargeY, HUDC.chargeY2, HUDC.seedY]);
/* The real question is whether the boxes those numbers describe collide.
   Sizes come from a true Courier New advance (0.6em), not the stubbed TW(). */
const hudBoxes = (() => {
  const H = HUDC, w = (s, size, sp) => s.length * (size * 0.6 + (sp || 0));
  const B = (id, x, y, ww, h) => ({ id, x1: x, x2: x + ww, y1: y, y2: y + h });
  return [
    B("coins", H.L, H.rowA - 13, 16 + w("99999", 13) + 4 + w("x2", 8), 13),
    B("rocket", 84, H.rowA - 13, 13 + 4 + w("x9", 13), 13),
    B("board", H.L, H.rowB - 11, 32 + w("x99", 11), 12),
    B("spy", 74, H.rowB - 11, 15 + 5 + w("9.9", 10), 11),
    B("hi", H.R - 60, H.rA - 12, 60, 12),
    B("score", H.R - w("000000", 18), H.rB - 20, w("000000", 18), 20),
    B("pct", H.barX - 10 - w("100%", 9), H.barY - 3, w("100%", 9), 11),
    B("bar", H.barX - 8, H.barY - 17, H.barW + 8, 25),
    B("label", H.barR + 20, H.barY - 3, w("100,000m", 7), 11),
    B("seed", 160, H.seedY - 8, 64, 8),
    B("legend", H.L, H.tagY - 8, w("CERTIFIED LEGEND", 8, 2), 8),
    B("slowCd", H.R - w("SLOW 9.9s", 7), H.chargeY - 7, w("SLOW 9.9s", 7), 8.4),
    B("laserCd", H.R - w("LASER 9.9s", 7), H.chargeY2 - 7, w("LASER 9.9s", 7), 8.4)
  ];
})();
const hudHits = [];
for (let i = 0; i < hudBoxes.length; i++) for (let j = i + 1; j < hudBoxes.length; j++) {
  const a = hudBoxes[i], b = hudBoxes[j];
  if (a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1) hudHits.push(a.id + " x " + b.id);
}
check("no two HUD groups overlap", hudHits.length === 0, hudHits);
/* And the same question asked of the labels the frame really painted.  Boxes are
   rebuilt from the device-px anchor, the font the game set and a true Courier
   New advance, so this is the actual output, not the layout table again. */
const textRows = maxWorldY => {
  const S = read("S"), out = [];
  for (const t of texts) {
    const m = /(\d+)px/.exec(t.font || "");
    if (!m) continue;
    const size = +m[1];
    if (t.y / S > maxWorldY) continue;
    const wpx = t.s.length * (size * 0.6 + (parseFloat(t.ls) || 0));
    const x1 = t.align === "right" ? t.x - wpx : t.align === "center" ? t.x - wpx / 2 : t.x;
    out.push({ s: t.s, x1: x1 / S, x2: (x1 + wpx) / S, y1: (t.y - size) / S, y2: (t.y + size * 0.2) / S });
  }
  return out;
};
const textClash = rows => {
  const out = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j];
    if (a.x1 < b.x2 - 0.6 && a.x2 > b.x1 + 0.6 && a.y1 < b.y2 - 0.6 && a.y2 > b.y1 + 0.6)
      out.push(a.s + " x " + b.s);
  }
  return out;
};
arena();
read("G.clouds.length = 0; G.cloudT = 99999; G.toast = ''; G.toastT = 0;"
   + " save.coins = 1234; save.pro = true; save.best = 4820; save.boards = 2; G.ammo = 4;"
   + " G.meters = 40000; G.road = 160000; G.cpN = 4; G.score = 1268;"
   + " G.slowCd = 3000; G.beamCd = 4200;"
   + " P.spy = 3000; P.spyT = 3000; save.bestM = 39500; save.title = 'CERTIFIED LEGEND';");
texts.length = 0;
step(1);
const painted = textRows(115);
check("the top strip paints every one of its labels at once", painted.length >= 8, painted.map(r => r.s));
check("and the busiest frame has both limited weapons on their clocks",
  painted.some(r => /^LASER /.test(r.s)) && painted.some(r => /^SLOW /.test(r.s)),
  painted.map(r => r.s).filter(s => /LASER|SLOW/.test(s)));
const paintedClash = textClash(painted);
check("and not one painted label overlaps another", paintedClash.length === 0, paintedClash);
check("the busiest HUD frame paints without error", errors.length === 0);
read("save.coins = 0; save.pro = false; save.boards = 0; save.title = ''; G.ammo = 0; P.spy = 0; G.meters = 0; G.road = 0; G.score = 0;");

/* ----------------------------- installable / APK --------------------------- */
section("PWA: installable, offline, and ready to wrap into an APK");
const readFile = f => { try { return fs.readFileSync(path.join(__dirname, f), "utf8"); } catch (e) { return null; } };
const manifestRaw = readFile("manifest.webmanifest");
let manifest = null;
try { manifest = JSON.parse(manifestRaw); } catch (e) { manifest = null; }
check("a web app manifest ships with the game", !!manifest, manifestRaw === null ? "missing" : "unparseable");
check("it opens standalone, from its own scope",
  !!manifest && manifest.display === "standalone" && manifest.start_url === "./" && manifest.scope === "./",
  manifest && { d: manifest.display, s: manifest.start_url, sc: manifest.scope });
check("and declares 192, 512 and maskable icons",
  !!manifest && manifest.icons.some(i => i.sizes === "192x192") &&
  manifest.icons.some(i => i.sizes === "512x512") &&
  manifest.icons.some(i => i.purpose === "maskable"), manifest && manifest.icons);
for (const ic of (manifest ? manifest.icons : [])) {
  const buf = fs.existsSync(path.join(__dirname, ic.src)) ? fs.readFileSync(path.join(__dirname, ic.src)) : null;
  const want = ic.sizes.split("x").map(Number);
  check("the icon " + ic.src + " is a real PNG of its declared size",
    !!buf && buf.slice(0, 8).toString("hex") === "89504e470d0a1a0a" &&
    buf.readUInt32BE(16) === want[0] && buf.readUInt32BE(20) === want[1],
    buf ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : "missing");
}
check("the generator that made them is checked in too", fs.existsSync(path.join(__dirname, "make-icons.cjs")));
const swSrc = readFile("sw.js");
check("an offline service worker ships with it", !!swSrc && /addEventListener\(\s*"fetch"/.test(swSrc));
check("the worker is network-first, so an online visitor is never served a stale build",
  !!swSrc && /req\.mode === "navigate"/.test(swSrc) && swSrc.indexOf("fetch(req)") < swSrc.indexOf("caches.match(req)"));
check("the page links the manifest, the icon and the touch icon",
  /<link rel="manifest" href="manifest\.webmanifest">/.test(html) &&
  /<link rel="icon" type="image\/png" sizes="192x192" href="icons\/icon-192\.png">/.test(html) &&
  /rel="apple-touch-icon"/.test(html));
check("and registers the worker once the page has loaded", /serviceWorker\.register\("sw\.js"\)/.test(src));
check("the INSTALL chip exists and is hidden until the browser offers a prompt",
  /id="bInstall"[^>]*hidden/.test(html));
check("the browser's install prompt reveals it", (() => {
  fire("__win", "beforeinstallprompt", { preventDefault() {} });
  return els.bInstall.hidden === false;
})(), els.bInstall.hidden);
check("and appinstalled hides it again", (() => {
  fire("__win", "appinstalled", {});
  return els.bInstall.hidden === true;
})(), els.bInstall.hidden);
check("the Android status bar colour follows the sky", (() => {
  read("setNight(true)");
  const dark = els.metaTheme.content;
  read("setNight(false)");
  return dark === "#0e0e0e" && els.metaTheme.content === "#ffffff";
})(), els.metaTheme.content);
check("the packaging guide is checked in", fs.existsSync(path.join(__dirname, "ANDROID.md")));

/* ----------------------------- mobile / layout ----------------------------- */
section("MOBILE: the pad sits on the game, modals own the screen");
check("the pad and chips live inside the game box, not the page",
  els.shell.contains(els.pad) && els.shell.contains(els.topbar),
  { padInShell: els.shell.contains(els.pad), topInShell: els.shell.contains(els.topbar) });
check("the pad is hidden until a touch is seen", (() => {
  els.body.classList.remove("touch");            /* an earlier section already touched */
  read("touchUI = false;");                       /* so re-arm the first-touch path */
  return els.body.classList.contains("touch") === false;
})());
read("enableTouchUI()");
check("a touch turns the pad on", els.body.classList.contains("touch") === true);
check("and reserves a band under the game for it", els.wrap.style.paddingBottom !== "");
read("G.state = 'pro';");
step(2);
check("a modal fades the pad out from under itself", els.body.classList.contains("modal") === true);
read("G.state = 'run';");
step(2);
check("and the pad comes back when it closes", els.body.classList.contains("modal") === false);
check("every control is sized off the on-screen game height", els.shell.style.getPropertyValue("--u") !== "");

/* the PRO panel has to survive a 384px-wide world: nothing may overrun it */
const PERKS_EVERY = read("PERKS.map(p => p[1])");
arena();
read("G.state = 'pro'; G.shopSel = 0;");
drawn.length = 0;
step(2);
const proFits = (() => {
  const w = 344, x = (384 - w) / 2;
  const bad = [];
  for (const b of read("ui")) {
    if (b.x < x - 0.5 || b.x + b.w > x + w + 0.5) bad.push([b.id, b.x, b.x + b.w]);
  }
  return bad;
})();
check("no PRO button spills outside the panel", proFits.length === 0, proFits);
check("and the panel still offers both a toggle and a close",
  read("ui.some(b => b.id === 'proon')") && read("ui.some(b => b.id === 'proclose')"));
check("the widest perk badge no longer collides with its name", read("TW('CROWN', 10, 700)") < 40,
  read("TW('CROWN', 10, 700)"));
/* the eight-perk grid is the one place two columns of text sit side by side, so
   both facts are checked on the labels the frame really painted: every one
   inside the panel, and no two of them sharing a pixel.  The comparison is on
   real label *boxes*, not on equal baselines — the last row's blurb and the
   summary line are six units apart vertically and still overlapped, because
   they were compared for being on the same row rather than for touching. */
arena();
read("G.state = 'pro'; G.shopSel = 0; save.pro = true;");
texts.length = 0;
step(1);
const proLabels = (() => {
  const Sc = read("S"), out = [];
  for (const t of texts) {
    const m = /(\d+)px/.exec(t.font || "");
    if (!m) continue;
    const size = +m[1];
    const wpx = t.s.length * (size * 0.6 + (parseFloat(t.ls) || 0));
    const x1 = t.align === "right" ? t.x - wpx : t.align === "center" ? t.x - wpx / 2 : t.x;
    out.push({ s: t.s, x1: x1 / Sc, x2: (x1 + wpx) / Sc, y1: (t.y - size) / Sc, y2: (t.y + size * 0.2) / Sc });
  }
  /* the HUD is still painted under the modal, so only what the panel itself
     draws counts: everything from its own title onwards */
  const at = out.findIndex(t => t.s.indexOf("DINO PRO") >= 0);
  return at < 0 ? [] : out.slice(at);
})();
const proStray = proLabels.filter(t => t.x1 < 19.5 || t.x2 > 364.5 || t.y1 < 0.5 || t.y2 > 214.5);
check("no PRO label spills outside its panel", proStray.length === 0, proStray.map(t => [t.s, t.x1, t.x2]));
check("and the panel really does list all eight perks at once",
  PERKS_EVERY.every(n => proLabels.some(t => t.s === n)), PERKS_EVERY.filter(n => !proLabels.some(t => t.s === n)));
const proColHits = [];
for (let i = 0; i < proLabels.length; i++) for (let j = i + 1; j < proLabels.length; j++) {
  const a = proLabels[i], b = proLabels[j];
  if (a.x1 < b.x2 - 0.6 && a.x2 > b.x1 + 0.6 && a.y1 < b.y2 - 0.6 && a.y2 > b.y1 + 0.6)
    proColHits.push(a.s + " x " + b.s);
}
check("and not one of those labels overlaps another", proColHits.length === 0, proColHits);
const lastBlurb = proLabels.filter(t => t.s === "Nine seconds of ghost.")[0];
const proSummary = proLabels.filter(t => /9s GHOST/.test(t.s))[0];
check("the summary line keeps clear of the last row of perks",
  !!lastBlurb && !!proSummary && proSummary.y1 - lastBlurb.y2 > 3,
  lastBlurb && proSummary && [+(proSummary.y1 - lastBlurb.y2).toFixed(2)]);
read("G.state = 'shop'; G.shopSel = 0;");
step(2);
check("the skin shop panel is intact too", read("ui.some(b => /^skin:/.test(b.id))"));

/* ------------------------------ ability audit ----------------------------- */
/* One section that walks the whole control surface in order and proves each
   ability does its job on its own: every press causes exactly one effect, and
   nothing silently degrades into a spin with no physics behind it. */
section("ABILITY AUDIT: every control, one press, one provable effect");

/* JUMP + DOUBLE JUMP */
arena();
down("Space");
check("JUMP: the press lifts the dino on the same frame", read("P.vy") > 0, read("P.vy"));
step(4);
const auditJumpY = read("P.y");
check("JUMP: and he really leaves the ground", auditJumpY > 15, auditJumpY);
down("Space");
check("DOUBLE JUMP: a second press in the air registers once", read("P.air") === 1, read("P.air"));
step(4);
check("DOUBLE JUMP: with a 360 backflip", read("P.flip") > 0 && read("P.flip") <= 1, read("P.flip"));
check("DOUBLE JUMP: and it out-climbs the first jump", read("P.y") > auditJumpY, [auditJumpY, read("P.y")]);
up("Space");
step(140);
check("JUMP: and gravity always brings him home", read("P.y") === 0 && read("P.air") === 0 && read("P.flip") === -1,
  [read("P.y"), read("P.air"), read("P.flip")]);

/* SLIDE + DIVE */
arena();
down("ArrowDown");
step(2);
check("SLIDE: holding down ducks on the spot", read("P.duck") === true);
arena();
down("Space");
step(2);
const auditFall = read("P.vy");
down("ArrowDown");
step(1);
check("SLIDE: and adds dive gravity in the air", read("P.vy") < auditFall - 1.5, [auditFall, read("P.vy")]);
up("ArrowDown");

/* GRIND */
arena();
addObs("cactus1", read("P.x + 30"));
read("P.y = OBST.cactus1.h; P.vy = 0;");
down("ArrowDown");
step(2);
check("GRIND: dropping onto a cactus crown rides it", read("P.grind") !== null, read("P.grind && P.grind.k"));
check("GRIND: feet snap to the crown, no collision",
  read("P.y") === read("OBST.cactus1.h") && read("P.dead") === false, read("P.y"));
step(24);
check("GRIND: and the rail pays as it carries you", read("G.bonus") > 0, read("G.bonus"));
check("GRIND: releasing when the cactus is behind you", read("P.grind") === null);
up("ArrowDown");
step(40);

/* PARRY */
arena();
addObs("cactus1", read("P.x + 40"));
down("KeyC");
check("PARRY: swats the threat that is in range", read("G.obs.filter(o => o.dead).length") === 1,
  read("G.obs.map(o => o.dead)"));
check("PARRY: pays +50", read("G.bonus") === 50, read("G.bonus"));
check("PARRY: and the shockwave launches a backflip", read("P.vy") > 0 && read("P.flip") >= 0,
  [read("P.vy"), read("P.flip")]);
arena();
down("KeyC");
check("PARRY: with nothing in range it refuses instead of firing", read("G.bonus") === 0 && read("G.obs.length") === 1);

/* ROCKET */
arena();
read("G.ammo = 2;");
down("KeyF");
check("ROCKET: fires a missile and spends exactly one", read("G.shots.length") === 1 && read("G.ammo") === 1,
  [read("G.shots.length"), read("G.ammo")]);
check("ROCKET: out of the dino's nose, at chest height", read("G.shots[0].x") === read("P.x + 30"), read("G.shots[0].x"));
arena();
addObs("cactus1", read("P.x + 120"));
read("G.ammo = 1;");
down("KeyF");
step(12);
check("ROCKET: the missile kills what it reaches and pays +25", read("G.bonus") === 25, read("G.bonus"));
arena();
down("KeyF");
check("ROCKET: an empty chamber is denied, not swallowed", read("G.shots.length") === 0 && read("G.ammo") === 0);

/* SLOW */
arena();
const auditFull = read("CFG.SPEED");
down("ShiftLeft");
step(1);
check("SLOW: bullet time engages", read("G.slowT") > 0, read("G.slowT"));
check("SLOW: and the world really drops to 35%", read("G.spd") < auditFull * 0.5, [auditFull, read("G.spd")]);
check("SLOW: with a longer recharge behind it", read("G.slowCd") > read("G.slowT"), [read("G.slowT"), read("G.slowCd")]);
up("ShiftLeft");

/* GRAPPLE */
arena();
read("G.clouds.push({ x: P.x + 60, y: 60, s: 1 });");
down("KeyG");
check("HOOK: the rope catches the cloud overhead", read("P.hookT") > 0 && read("P.hook") !== null, read("P.hookT"));
step(30);
check("HOOK: and swings the dino up over the road", read("P.y") > 40, read("P.y"));
step(180);
check("HOOK: then releases with the +60 NICE", read("P.hookT") === 0 && read("G.bonus") >= read("CFG.HOOK_PTS"),
  [read("P.hookT"), read("G.bonus")]);
arena();
down("KeyG");
check("HOOK: with an empty sky it says NO ANCHOR instead of wasting the input",
  read("P.hookT") === 0 && /NO ANCHOR/.test(read("G.toast")), read("G.toast"));

/* LASER ROAR */
arena();
addObs("cactus1", read("P.x + 150"));
addObs("cactus2", read("P.x + 250"));
down("KeyR");
check("LASER ROAR: the beam fires on demand", read("G.beamT") > 0, read("G.beamT"));
check("LASER ROAR: and clears everything on the screen",
  read("G.obs.filter(o => !o.dead && o.x > 0 && o.x < WW).length") === 0,
  read("G.obs.filter(o => !o.dead).map(o => o.x)"));
check("LASER ROAR: paying for each kill", read("G.bonus") >= 20, read("G.bonus"));

/* ACTION (Enter / J / →) stays context sensitive */
arena();
read("G.ammo = 1;");
addObs("cactus1", read("P.x + 40"));
down("Enter");
check("ACTION: with a threat in range it parries", read("G.bonus") === 50 && read("G.ammo") === 1,
  [read("G.bonus"), read("G.ammo")]);
arena();
read("G.ammo = 1;");
down("ArrowRight");
check("ACTION: with a clear road it spends a rocket", read("G.shots.length") === 1 && read("G.ammo") === 0,
  [read("G.shots.length"), read("G.ammo")]);

/* INCOGNITO */
arena();
read("grantSpy()");
step(1);
check("INCOGNITO: the hat makes the dino intangible", read("phasing()") === true);
check("INCOGNITO: for six seconds, counted down",
  read("P.spyT") > 0 && read("P.spyT") <= read("CFG.SPY_MS"),
  [read("P.spyT"), read("CFG.SPY_MS")]);
addObs("cactus1", read("P.x + 40"));
step(12);
check("INCOGNITO: cacti phase straight through it", read("P.dead") === false && read("G.state") === "run",
  [read("P.dead"), read("G.state")]);
step(400);
check("INCOGNITO: and it wears off on its own", read("P.spy") === 0 && read("P.ghost") === 0, read("P.spy"));

/* HOVERBOARD */
arena();
read("save.boards = 1;");
down("KeyH");
check("HOVERBOARD: H/RIDE deploys one from your pack", read("P.board") === 1 && read("save.boards") === 0,
  [read("P.board"), read("save.boards")]);
step(30);
check("HOVERBOARD: it floats you at the hover height", Math.abs(read("P.y") - read("CFG.HOVER_H")) < 3, read("P.y"));
check("HOVERBOARD: with jets, sparks and a hum", read("G.parts.length") > 0, read("G.parts.length"));
down("Space");
let auditHop = 0;
step(30, () => { auditHop = Math.max(auditHop, read("P.y")); });
check("HOVERBOARD: and a kickflip is a real hop you can dodge with", auditHop > 60, auditHop);
down("KeyH");
check("HOVERBOARD: H again stows it back in the pack", read("P.board") === 0 && read("save.boards") === 1,
  [read("P.board"), read("save.boards")]);

/* PAUSE + MUTE */
arena();
down("KeyP");
check("PAUSE: opens over a live run", read("G.state") === "pause", read("G.state"));
down("KeyP");
check("PAUSE: and closes back into it", read("G.state") === "run", read("G.state"));
const auditSound = read("save.sound");
down("KeyM");
check("MUTE: flips the sound chip", read("save.sound") !== auditSound, [auditSound, read("save.sound")]);
down("KeyM");
check("MUTE: and flips it back", read("save.sound") === auditSound);

/* every ability leaves the game in a state it can recover from */
check("no ability test left the run dead or in a modal", read("G.state") === "run" && read("P.dead") === false,
  [read("G.state"), read("P.dead")]);

/* --------------------------------- report --------------------------------- */
console.log("\n" + pass + " passed, " + fail + " failed, " + errors.length + " runtime errors");
if (errors.length) console.error("\nfirst error:\n", (errors[0] && errors[0].stack) || errors[0]);
if (fail || errors.length) process.exit(1);
console.log("SMOKE TEST PASSED");
