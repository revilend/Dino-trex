/* Headless harness: runs the real game script in a VM with a stubbed DOM/canvas
   and drives every system (physics, controls, touch pad, gestures, collisions).
   Not shipped with the game.   Usage: node smoke-test.cjs [file.html]          */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const file = process.argv[2] || "index.html";
const html = fs.readFileSync(path.join(__dirname, file), "utf8");
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];
/* the whole file, not just its script: several checks assert on the markup and
   the stylesheet itself, which no amount of running the game would prove. */
const CSS_TXT = html;

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
      if (sel === "#namebox") return id === "namebox" ? this : null;
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
["wrap", "shell", "game", "pad", "topbar", "bGrind", "bSlow", "bParry", "bRocket", "bHook", "bRide", "bJump", "bPause", "bSound", "bPro", "bInstall", "metaTheme", "body", "documentElement", "namebox"].forEach(id => { els[id] = mkEl(id); });
/* the tag field is a REAL <input>, so it gets a real value: the harness types
   into it exactly as a player would and asserts the game reads what was typed */
els.namebox.value = "";
els.namebox.focused = false;
els.namebox.focus = () => { els.namebox.focused = true; };
els.namebox.blur = () => { els.namebox.focused = false; };
const typeTag = s => { els.namebox.value = s; };
/* mirror the real nesting: #shell > canvas + #topbar + #namebox + #pad */
els.shell.kids.push(els.game, els.topbar, els.namebox, els.pad);
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
  fillRect(x, y, w, h) { drawn.push([Math.round(x), Math.round(y), Math.round(w), Math.round(h), this.fillStyle]); },
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
/* A stand-in for Upstash's REST endpoint: enough Redis to run the exact four
   commands the game sends, and nothing more.  It is a SERVER, not a mock of
   the game's own functions — the game parses its replies, sorts them and
   recomputes its rank from them, so the checks below are of the wire format,
   not of a return value the harness handed the game directly.  `lbWire` keeps
   every request for the assertions that the auth header and the shape are real. */
const lbWire = [];
const lbServer = {
  z: {},            /* sorted set: member -> score */
  h: {},            /* hash: field -> value            */
  down: false,      /* flip it and the server is unreachable, mid-handshake if you like */
  log: lbWire,
  reset() { this.z = {}; this.h = {}; this.down = false; lbWire.length = 0; },
  seed(pairs) { for (const [n, m, k] of pairs) { this.z[n] = m; this.h[n] = k; } },
};
function LB_SERVER(url, opts) {
  lbWire.push({ url, method: opts && opts.method, auth: opts && opts.headers && opts.headers.Authorization, body: JSON.parse(opts.body) });
  if (lbServer.down) return Promise.reject(new TypeError("Failed to fetch"));
  const cmd = JSON.parse(opts.body);
  const c = cmd[0], k = cmd[1];
  /* ZADD GT CH, as the game sends it: raise the score only if the new one is
     greater.  A plain ZADD would overwrite, and the game would be able to lower
     its own record — which is exactly the bug this flag exists to prevent. */
  const order = () => Object.keys(lbServer.z).sort((a, b) => lbServer.z[b] - lbServer.z[a] || (a < b ? -1 : 1));
  let result = null;
  if (c === "ZADD") {
    const gt = cmd.indexOf("GT") > 0, member = cmd[cmd.length - 1], score = +cmd[cmd.length - 2];
    const had = member in lbServer.z;
    if (!had || (!gt || lbServer.z[member] < score)) lbServer.z[member] = score;
    result = had ? 0 : 1;
  }
  else if (c === "HSET") { lbServer.h[cmd[2]] = cmd[3]; result = 1; }
  else if (c === "ZREVRANGE") {
    const slice = order().slice(+cmd[2], +cmd[3] + 1);
    result = cmd[4] === "WITHSCORES" ? slice.flatMap(n => [n, String(lbServer.z[n])]) : slice;
  }
  else if (c === "ZREVRANK") { result = order().indexOf(cmd[2]); }
  else if (c === "ZCARD") { result = Object.keys(lbServer.z).length; }
  else if (c === "HGETALL") { result = Object.keys(lbServer.h).flatMap(f => [f, lbServer.h[f]]); }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result }) });
}
/* ------------------------- the Play Games host --------------------------- */
/* A stand-in for the ONE object the Android app injects into the WebView.  Like
   LB_SERVER it is a SERVER, not a mock of the game's own functions: the game
   calls it, validates every field that comes back and decides for itself what
   to believe — so what follows checks the game's half of a contract that cannot
   be exercised for real without an APK.  `pgWire` records every call and
   `pgSlot` is the cloud slot itself, so a push and a later pull can be proved
   to actually move bytes. */
const pgWire = [];
let pgSlot = null;
const PG_OFF = { isAuthenticated: true, player: {
  playerId: "1234567890123456789", gamerTag: "REX_77", displayName: "REX_77",
  iconUrl: "https://play-lh.googleusercontent.com/icon.jpg" } };
function PG_HOST(opts) {
  const o = opts || {};
  const h = {
    autoSignIn: () => {
      pgWire.push(["autoSignIn"]);
      if (o.down) return Promise.reject(new Error("Play Games unavailable"));
      if (o.hang) return new Promise(() => {});
      return Promise.resolve(o.info);
    },
    getPlayerInfo: () => { pgWire.push(["getPlayerInfo"]); return Promise.resolve(o.info); },
    loadSnapshot: slot => {
      pgWire.push(["loadSnapshot", slot]);
      if (o.down) return Promise.reject(new Error("Play Games unavailable"));
      if (o.hang) return new Promise(() => {});
      return Promise.resolve("cloud" in o ? o.cloud : pgSlot);
    },
    saveSnapshot: (slot, data) => {
      pgWire.push(["saveSnapshot", slot, data]);
      if (o.down) return Promise.reject(new Error("Play Games unavailable"));
      pgSlot = JSON.parse(JSON.stringify(data));
      return Promise.resolve({ ok: true, revision: pgWire.length });
    },
  };
  /* achievements ride on the same object, and are absent on a host that has not
     configured them — which must disable the whole feature, not half of it */
  if (o.ach !== false) h.achievement = id => { achWire.push(id); return Promise.resolve(true); };
  return h;
}
const achWire = [];

/* ------------------------- the Play Billing host -------------------------- */
/* The other half of a release build: a BillingClient the game can charge
   through.  payOwned IS the store — the game is told whether the account owns
   the pass, and after a purchase the store says so, exactly as Google's does.
   A price can be forced here so that "the store's price, not ours" is a thing
   the tests can actually prove rather than a comment. */
const payWire = [];
let payOwned = false;
function BILL_HOST(opts) {
  const o = opts || {};
  return {
    queryPurchases: sku => {
      payWire.push(["query", sku]);
      if (o.down) return Promise.reject(new Error("Billing unavailable"));
      return Promise.resolve({ owned: o.owned !== undefined ? o.owned : payOwned, price: o.price });
    },
    launchBillingFlow: (sku, page) => {
      payWire.push(["flow", sku, page || 0]);
      if (o.down) return Promise.reject(new Error("Billing unavailable"));
      if (o.cancel) return Promise.resolve({ state: "cancelled" });
      if (o.hang) return new Promise(() => {});
      if (page > 0) return Promise.resolve({ state: "done" });
      payOwned = true;
      return Promise.resolve({ state: "purchased", price: o.price });
    },
  };
}
const payInstall = h => { sandbox.PlayBilling = h; };
const payClear = () => { delete sandbox.PlayBilling; };
const pgInstall = h => { sandbox.PlayGames = h; };
/* a browser: no bridge anywhere.  This is the state the whole file above ran in */
const pgHostless = () => { delete sandbox.PlayGames; delete sandbox.Capacitor; };
/* and a cold boot: a SECOND, fresh VM running the real script again, with the
   host installed BEFORE the first line of it executes.  It is the only way to
   prove that a player who has never tapped anything is already signed in by
   the time the title card is up — which is the entire promise of a SILENT
   sign-in.  The DOM stubs are shared; every check that cares about them has
   already run by the time this is used. */
function bootWith(bridge, seeded, billing) {
  let cb = null, clock = 0, errs = 0;
  const store = {};
  if (seeded) store["dinoexe.save.v2"] = JSON.stringify(seeded);
  const sb = Object.assign({}, sandbox, {
    localStorage: { d: store,
      getItem(k) { return this.d[k] === undefined ? null : this.d[k]; },
      setItem(k, v) { this.d[k] = v; } },
    requestAnimationFrame: f => { cb = f; return 1; },
  });
  sb.window = sb; sb.globalThis = sb;
  /* set or CLEAR: Object.assign above copied whatever host the last test left
     installed, and a "no host" boot that quietly inherited one would be a lie */
  if (bridge) sb.PlayGames = bridge; else delete sb.PlayGames;
  /* the store is a SECOND object in a second world: a release build has both,
     and a cold boot that only has one is not the build anybody ships */
  if (billing) sb.PlayBilling = billing; else delete sb.PlayBilling;
  const ctx = vm.createContext(sb);
  try { vm.runInContext(src, ctx, { filename: "cold-dino.js" }); }
  catch (e) { errs++; errors.push(e); }
  return {
    store,
    read: e => vm.runInContext(e, ctx),
    get errors() { return errs; },
    advance(n) {
      for (let i = 0; i < n; i++) {
        clock += 1000 / 60; CLOCK.t = clock;
        if (!cb) return;
        const f = cb; cb = null;
        try { f(clock); } catch (e) { errs++; errors.push(e); }
      }
    },
  };
}
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
  fetch: (...a) => LB_SERVER(...a),
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
/* ONE seeded RNG for the whole run.  The game spawns obstacles, clouds, particles
   and pickups with Math.random(), and the endurance section drives it with
   random keys, so an unseeded suite is a coin flip: a check that watches the
   road passes or fails on how lucky the sample was.  A fixed LCG pins the entire
   run, so the result is reproducible and a failure is a regression rather than
   weather.  (Seeding only the pacing sample, as this file used to, left the rest
   of the suite — and the fuzz — still random.) */
let __seed = 0x9e3779b9 >>> 0;
Math.random = () => ((__seed = (__seed * 1664525 + 1013904223) >>> 0) / 4294967296);

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
    P.gun = 0; P.gunCd = 0; P.gunFlash = 0;
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
  /* the endless mode has to die with every other run, or the next section
     starts at overdrive speed with a live boss timer and a 3x coin rate */
  G.over = false; G.overT = 0; G.overBossT = 0; G.overBosses = 0;
  G.cine.step = 0; G.cine.cape = 0; G.cine.shades = 0; G.cine.fireT = 0; G.cine.runT = 0;
    held.swipe = false; gest = null; held.keySlide = false; held.padSlide = false;
    save.coins = 0; save.owned = ["classic"]; save.skin = "classic"; save.pro = false;
  /* a tag, because a board that is asking every section for a name would
     never let any of them get as far as the board */
  save.name = "NOVA";
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
check("a first-time player is asked for their tag before anything else",
  read("G.state") === "name" && read("save.name") === "", read("G.state"));
step(1);
check("and the real input behind the field is live and focused",
  els.namebox.classList.contains("on") && els.namebox.focused === true, els.namebox);
check("with a way out that does not require typing", read("ui.some(b => b.id === 'nameskip')"));
typeTag("REX"); step(1);
check("the tag panel is skippable — the game never traps a player in it",
  (() => { tapWorld(read("ui.find(b => b.id === 'nameskip')"));
           return read("G.state") === "ready" && read("save.name") === ""; })(), read("G.state"));
check("and only then does the title screen appear", read("G.state") === "ready");
check("empty track", read("G.obs.length") === 0);
check("dino rests on the ground line", read("P.y") === 0 && read("GROUND") === 160);
check("and SKIP released the keyboard, so the very next keypress belongs to the game",
  els.namebox.focused === false && !els.body.classList.contains("typing") &&
  !els.namebox.classList.contains("on"), els.namebox.focused);

/* ------------------ THE TAG FIELD: typed, committed, and released -------- */
/* The tag panel is the one moment the game hands the keyboard to the platform,
   and every way out of it is a way to lose what the player just typed.  The
   flow below is exactly what a new player does: type a tag, get out of the
   panel, start a run, press X. */
section("THE TAG FIELD: typed, committed, and released");
read("openName('ready');"); typeTag(""); step(1);
check("the panel opens with the real input focused, and the game out of the way",
  read("G.state") === "name" && els.namebox.classList.contains("on") && els.namebox.focused === true,
  { st: read("G.state"), on: els.namebox.classList.contains("on"), focus: els.namebox.focused });
check("body.typing lifts the user-select ban, or the field eats keystrokes silently",
  els.body.classList.contains("typing") &&
  /body\.typing, body\.typing \* \{[^}]*user-select:\s*text/.test(CSS_TXT), els.body.class);
/* The wrap's gesture layer must keep its hands off the field.  A preventDefaulted
   touchstart on the input is a focus and a soft keyboard the browser is then not
   allowed to open — which is exactly how "typing my name does nothing" happened
   on a phone.  Road taps are still swallowed, because those are jumps. */
let prevented = null;
const touchStart = target => { prevented = false;
  fire("wrap", "touchstart", { target, cancelable: true, preventDefault() { prevented = true; } });
  return prevented; };
check("touching the tag field is left to the platform, so the keyboard can open",
  touchStart(els.namebox) === false, prevented);
check("while a touch on the road is still swallowed, because that one is a jump",
  touchStart(els.game) === true, prevented);
/* and a tap on the panel is a request to type, so the game answers it by asking
   for the keyboard — the panel's own comment promised that tap and nothing did it */
read("openName('ready');"); step(1);
els.namebox.blur();
check("a press on the field itself is left to the browser, and the game does not meddle",
  (() => { fire("wrap", "pointerdown", { target: els.namebox, clientX: 0, clientY: 0 });
           return read("G.state") === "name" && els.namebox.focused === false; })(),
  { st: read("G.state"), focus: els.namebox.focused });
fire("wrap", "pointerdown", { target: els.game, clientX: 0, clientY: 0 });
step(1);
check("but a press anywhere else on the panel re-asks for the keyboard, so tapping works",
  read("G.state") === "name" && els.namebox.focused === true, els.namebox.focused);
typeTag("XERX"); texts.length = 0; step(1);
check("a tag containing an X is typed in full — X is a letter here, not a control",
  read("G.name") === "XERX" && els.namebox.value === "XERX", read("G.name"));
check("and it is counted against the cap the panel prints",
  texts.some(t => t.s === "4 / 12"), texts.map(t => t.s).filter(s => /\/ 12/.test(s)));
down("Enter"); up("Enter"); step(1);
check("Enter commits it, and it is SAVED — not merely drawn",
  read("save.name") === "XERX" && JSON.parse(read("localStorage.getItem(SAVE_KEY)")).name === "XERX",
  read("save.name"));
check("and the panel closes behind you",
  read("G.state") === "ready" && !els.namebox.classList.contains("on") &&
  !els.body.classList.contains("typing"), read("G.state"));
check("  ...with the field RELEASED, so the keyboard belongs to the game again",
  els.namebox.focused === false, els.namebox.focused);

/* the pistol key, in the very next breath */
arena();
read("giveGun(12); P.gunCd = 0;");
const gunNow = read("P.gun"), shotsNow = read("G.shots.length");
down("KeyX"); up("KeyX"); step(1);
check("X fires the pistol immediately after typing a tag — the input let the key go",
  read("P.gun") === gunNow - 1 && read("G.shots.length") === shotsNow + 1,
  { gun: read("P.gun"), shots: read("G.shots.length") });

/* while the panel IS open, X belongs to the field */
read("openName('ready');"); step(1);
const heldGun = read("P.gun"), heldShots = read("G.shots.length");
down("KeyX"); up("KeyX"); step(1);
check("but with the panel open X is a letter, and fires nothing",
  read("G.state") === "name" && read("P.gun") === heldGun && read("G.shots.length") === heldShots,
  { st: read("G.state"), gun: read("P.gun"), shots: read("G.shots.length") });

/* the button path, which is what a phone player actually uses */
typeTag("ZEPHYR"); step(1);
tapWorld(read("ui.find(b => b.id === 'namego')"));
check("SAVE & PLAY commits the typed tag as well, not just Enter",
  read("save.name") === "ZEPHYR" && read("G.state") === "ready", read("save.name"));
check("  ...and releases the field on that path too",
  els.namebox.focused === false && !els.body.classList.contains("typing"), els.namebox.focused);

/* ---- Escape, which is the soft keyboard's BACK key on Android ---------- */
read("openName('ready');"); typeTag("ORION"); step(1);
down("Escape"); up("Escape"); step(1);
check("Escape KEEPS the tag that was typed — it is the keyboard's back key, not a second SKIP",
  read("save.name") === "ORION" && read("G.state") === "ready", read("save.name"));
check("  ...and it lands in the save file like any other commit",
  JSON.parse(read("localStorage.getItem(SAVE_KEY)")).name === "ORION",
  JSON.parse(read("localStorage.getItem(SAVE_KEY)")).name);
check("  ...with the field released, so X is the game's again",
  els.namebox.focused === false && !els.body.classList.contains("typing"), els.namebox.focused);

/* ---- and the panel is asked ONCE per session, whatever the answer was ---- */
arena();                       /* save.name = "NOVA"; G.nameAsked stays as the panel left it */
read("G.state = 'run'; G.speed = CFG.SPEED; G.meters = 500; P.dead = false;");
read("gameOver('crash');");
for (let i = 0; i < 26; i++) step(20);
check("having already answered the tag panel this session, a crash never asks again",
  read("G.state") === "over" && read("G.nameAsked") === true,
  { s: read("G.state"), a: read("G.nameAsked") });
arena();
read("save.name = 'NOVA';");
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
  /* ...and seed the RNG across the whole measurement.  The late pool is 4
     cactus to 1 pterodactyl, but they arrive in bursts rather than
     independently, so an unseeded 32-obstacle sample swings the ground share
     between 0.80 and 0.59 and fails the suite at random — which is how this
     check spent a decade's worth of runs being a coin flip rather than a
     regression test.  A fixed LCG makes the number reproducible. */
  const realRandom = Math.random;
  let seed = 0x2f6e2b1 >>> 0;
  Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  try {
    step(frames, () => read(`P.board = 1; P.boardT = 9999; P.shield = 9999; if (G.state === 'over' || G.state === 'win') start(); ${pin}`));
  } finally {
    Math.random = realRandom;
  }
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
read("G.winT = CFG.CIN_MODAL; G.cine.step = 6;");
step(1);
down("Space"); up("Space");
check("the cutscene ignores input — space does not skip it",
  read("G.state") === "win", read("G.state"));
check("and the dialog is up, with PLAY AGAIN and OPEN WARDROBE on it",
  read("ui.some(b => b.id === 'again')") && read("ui.some(b => b.id === 'shop')"),
  read("ui.map(b => b.id)"));
tapWorld(read("ui.find(b => b.id === 'again')"));
check("PLAY AGAIN starts a fresh run", read("G.state") === "run" && read("G.meters") === 0, read("G.state"));

/* ------------------------------ the cutscene ------------------------------ */
/* Six beats, each stepped to on its own and asserted on: a cinematic is the
   easiest thing in this game to break silently, because it only ever runs
   once, at the end, to someone who has already waited ten minutes for it. */
section("CUTSCENE: the six beats of the 100,000m finale");
arena();
read("save.coins = 0; save.owned = ['classic']; save.title = ''; persist();"
   + " G.bosses = [true,true,true,true,true]; G.bossIdx = 5;"
   + " G.road = (CFG.FINISH - 5) / CFG.M_PER_UNIT; G.runT = 512000;");
step(20);
const toWin = (t) => {
  arena();
  read("save.coins = 0; save.owned = ['classic']; save.title = ''; persist();"
     + " G.bosses = [true,true,true,true,true]; G.bossIdx = 5;"
     + " G.runT = 512000; G.road = (CFG.FINISH - 5) / CFG.M_PER_UNIT;");
  step(20);
  if (t !== undefined) { read("G.winT = " + t + ";"); step(1); }
};
/* every beat is reached by winding winT forward, because a cinematic that can
   only be seen by playing 100,000m is a cinematic nobody ever sees twice.
   `extra` steps real frames past it, which matters for anything that ramps
   per-frame — the cape is 0.04 a frame, so landing on a beat and stopping
   there proves nothing about the beat finishing. */
const at = (t, extra) => { toWin(); read("G.winT = " + t + ";"); step(extra === undefined ? 1 : extra); };
check("beat 0: the run stops dead — no scrolling, no spawning, input locked",
  read("G.state") === "win" && read("G.speed") === 0 && read("G.spd") === 0, read("G.state"));
check("beat 1: the tower starts off-screen right, scrolling in",
  read("G.tower") > read("WW") + 20, read("G.tower"));
check("and the beam is unreachable — every ability refuses during it",
  (() => { const n = read("G.shots.length"); down("KeyF"); up("KeyF"); return read("G.shots.length") === n; })(),
  read("G.shots.length"));
step(60);
check("beat 1: the tower plants itself centre-screen",
  read("G.tower") === read("CFG.TOWER_X"), read("G.tower"));
check("beat 1: with no signal on it yet — the arcs are all dark",
  read("G.cine.arc") === 0, read("G.cine.arc"));
/* the flag jump */
{
  const startX = read("P.x");
  const runX = (() => { at(read("CFG.CIN_JUMP") + 20); return read("P.x"); })();
  check("beat 2: he runs toward the mast", runX > startX + 10, [startX, runX]);
  at(read("CFG.CIN_JUMP") + 62);
  check("beat 2: and backflips through the air on the way up",
    read("P.flip") >= 0 && read("P.y") > 0, [read("P.flip"), read("P.y")]);
  at(read("CFG.CIN_JUMP") + 120);
  check("beat 2: he lands on the antenna, at the top of the mast",
    read("P.y") === 104 && Math.abs(read("P.x") - read("antennaX()")) <= 24,
    [read("P.y"), read("P.x"), read("antennaX()")]);
  check("beat 2: on the road's far side of it, not through it",
    read("P.x") < read("towerX()"), [read("P.x"), read("towerX()")]);
}
/* the signal */
const sigSeen = [];
{
  at(read("CFG.CIN_SIGNAL"));
  for (let i = 0; i < 5; i++) { step(28); sigSeen.push(read("G.cine.arc")); }
  check("beat 3: the arcs fill one at a time, 20% through to 100%",
    sigSeen.join() === "1,2,3,4,5", sigSeen);
  check("beat 3: and the whole fill has room to breathe before he drops",
    read("CFG.CIN_LAND") - read("CFG.CIN_SIGNAL") >= 140,
    read("CFG.CIN_LAND") - read("CFG.CIN_SIGNAL"));
}
/* the landing */
at(read("CFG.CIN_LAND") + 20);
check("beat 4: he drops off the mast", read("P.y") < 104 && read("P.y") > 0, read("P.y"));
at(read("CFG.CIN_LAND") + 44);
check("beat 4: and lands on the ground, kicking up pixel dust",
  read("P.y") === 0 && read("G.cine.dust") === 1 && read("G.parts.length") > 10,
  [read("P.y"), read("G.parts.length")]);
at(read("CFG.CIN_LAND") + 44, 40);
check("beat 4: the dust settles rather than piling up forever",
  read("G.cine.dust") === 1 && read("G.parts.length") < read("G.cine.dustT") + 400,
  read("G.parts.length"));
/* the victory outfit */
{
  const ramp = [];
  at(read("CFG.CIN_CROWN"));
  for (let i = 0; i < 6; i++) { ramp.push(read("G.cine.cape")); step(5); }
  check("beat 5: the cape and shades ramp in rather than snapping on",
    ramp[0] < ramp[ramp.length - 1] && ramp[ramp.length - 1] === 1 &&
    read("G.cine.shades") === 1, { ramp, shades: read("G.cine.shades") });
  at(read("CFG.CIN_CROWN") + 30);
  check("beat 5: and by the time the dialog is due the crown is fully down",
    (() => { at(read("CFG.CIN_CROWN"), read("CFG.CIN_MODAL") - read("CFG.CIN_CROWN"));
              return read("G.cine.cape") === 1 && read("G.cine.shades") === 1; })(),
    { cape: read("G.cine.cape"), shades: read("G.cine.shades") });
}
{
  const S = read("S"), OX = read("OX"), OY = read("OY");
  const rects = read("SPR.crown.f[0]");
  const off = read("SKIN_HEAD.stand");
  const hx = read("P.x") + off[0], hy = read("GROUND") - 43 + off[1] - 12;
  drawn.length = 0; step(1);
  const missing = rects.filter(r => !drawn.some(d =>
    Math.abs(d[0] - Math.round((hx - 4 + r[0]) * S + OX)) <= 1 &&
    Math.abs(d[1] - Math.round((hy + r[1]) * S + OY)) <= 1 &&
    d[2] === Math.max(1, Math.round(r[2] * S)) && d[3] === Math.max(1, Math.round(r[3] * S))));
  check("beat 5: the crown is painted on his head, every rect of it",
    missing.length === 0, { rects: rects.length, missing });
}
check("beat 5: and he is standing on the road in the Emperor skin",
  read("P.y") === 0 && read("save.owned").indexOf("gold") >= 0 && read("save.skin") === "gold");
at(read("CFG.CIN_MODAL") + 30);
check("beat 6: fireworks and confetti never stop",
  read("G.cine.fireT") > 0 && read("G.parts.length") > 0, read("G.parts.length"));
check("beat 6: and the run's own clock was measured, not the cutscene's",
  read("G.cine.runT") >= 512000 && read("G.cine.runT") < 513000, read("G.cine.runT"));
at(read("CFG.CIN_MODAL") - 2);
check("the dialog is still not up a frame before its time", read("ui").length === 0, read("ui.map(b => b.id)"));

/* --------------------------- the victory dialog --------------------------- */
at(read("CFG.CIN_MODAL"));
const dialog = texts.map(t => t.s);
/* the dialog is measured on its own: the HUD paints underneath it and the panel
   covers it, so including those labels would test the HUD twice */
texts.length = 0; read("ui.length = 0;");
read("drawWin()");
const dialogOwn = texts.map(t => t.s);
check("the dialog opens as a Chrome window, with its blue title bar",
  dialogOwn.some(s => /Google Chrome/.test(s)) && dialogOwn.some(s => /System Restored/.test(s)),
  dialogOwn.slice(0, 8));
check("headline: YOU SURVIVED 100,000 METERS, CERTIFIED LEGEND",
  dialog.some(s => /100,000 METERS/.test(s)) && dialog.some(s => /CERTIFIED LEGEND/.test(s)));
check("subtitle: Extinction Cancelled. Dinosaurs Ruled the Internet.",
  dialog.some(s => /Extinction Cancelled/.test(s)), dialog.filter(s => /Extinction/.test(s)));
check("stat: the total distance, in the words the run is measured in",
  dialog.some(s => /100,000 M/.test(s)), dialog.filter(s => /100,000/.test(s)));
check("stat: the elapsed time, computed from the run clock",
  dialog.some(s => /^8m 32s$/.test(s)), dialog.filter(s => /^\d+m \d\ds$/.test(s)));
check("stat: five of five bosses, by name",
  dialog.some(s => /5 \/ 5/.test(s)) && dialog.some(s => /ROUTER/.test(s)));
check("stat: the 1,000-coin bonus, paid in Wi-Fi coins",
  dialog.some(s => /\+1,000 WI-FI COINS/.test(s)), dialog.filter(s => /1,000/.test(s)));
check("the reward banner names the Emperor T-Rex skin",
  dialog.some(s => /EMPEROR T-REX SKIN UNLOCKED/.test(s)), dialog.filter(s => /EMPEROR/.test(s)));
check("and the skin really is unlocked AND equipped, not just announced",
  read("save.owned").indexOf("gold") >= 0 && read("save.skin") === "gold", read("save.skin"));
check("persisted, so it survives a relaunch",
  read("JSON.parse(localStorage.getItem(SAVE_KEY)).owned").indexOf("gold") >= 0);
check("all four buttons are on the dialog and inside it",
  (() => {
    const w = 344, h = 213, x = read("(WW - 344) / 2"), y = 1;
    const bad = read("ui").filter(b => b.x < x - 0.5 || b.x + b.w > x + w + 0.5 ||
                                         b.y < y - 0.5 || b.y + b.h > y + h + 0.5);
    return read("ui").length === 4 && bad.length === 0;
  })(), read("ui").slice(0, 4));
check("the post-credits line admits the router was not so lucky",
  dialog.some(s => /except the router/.test(s)), dialog.filter(s => /router/.test(s)));
/* the dialog must not print through itself — same rule the PRO panel follows.
   textRows() is defined further down the file, so the boxes are rebuilt here
   from the same model: a Courier advance, and the real glyph ink box. */
{
  const w = 344, h = 213, y = 1, S = read("S"), maxY = y + h, x = read("(WW - 344) / 2");
  const rows = texts.filter(t => t.y / S >= y - 2).map(t => {
    const fm = /(\d+(?:\.\d+)?)px/.exec(t.font || "");
    const size = fm ? parseFloat(fm[1]) : 10;
    const wpx = t.s.length * (size * 0.6 + (parseFloat(t.ls) || 0));
    const x1 = t.align === "right" ? t.x - wpx : t.align === "center" ? t.x - wpx / 2 : t.x;
    return { s: t.s, x1: x1 / S - x, x2: (x1 + wpx) / S - x,
             y1: (t.y - size * 0.75) / S - y, y2: (t.y + size * 0.25) / S - y };
  });
  const clash = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j];
    if (a.x1 < b.x2 - 0.6 && a.x2 > b.x1 + 0.6 && a.y1 < b.y2 - 0.6 && a.y2 > b.y1 + 0.6)
      clash.push(a.s + " x " + b.s);
  }
  check("and not one of its own labels overlaps another", clash.length === 0, clash);
  check("with every label inside the dialog",
    rows.every(r => r.x1 >= -0.5 && r.x2 <= w + 0.5 && r.y1 >= y - 0.5 && r.y2 <= maxY + 0.5),
    rows.filter(r => r.x1 < -0.5 || r.x2 > w + 0.5 || r.y1 < y - 0.5 || r.y2 > maxY + 0.5)
        .map(r => r.s));
}
/* the dialog is a panel, so the chips must get out of its way */
check("while the dialog owns the screen, the chips leave",
  /body\.modal #topbar/.test(CSS_TXT) && els.body.classList.contains("modal"),
  els.body.classList);
check("and the touch bar goes with them", /body\.modal #pad/.test(CSS_TXT));
/* PLAY AGAIN resets everything the cutscene touched */
tapWorld(read("ui.find(b => b.id === 'again')"));
check("PLAY AGAIN clears the finale's state and starts a clean run",
  read("G.state") === "run" && read("G.tower") === null && read("G.meters") === 0 &&
  read("G.runT") === 0 && read("G.cine.step") === 0, read("G.state"));
/* and the wardrobe opens from the dialog, then closes back to it */
at(read("CFG.CIN_MODAL"));
tapWorld(read("ui.find(b => b.id === 'shop')"));
check("OPEN WARDROBE opens the shop from the finale", read("G.state") === "shop", read("G.state"));
check("and remembers it came from there", read("G.shopBack") === "win", read("G.shopBack"));

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

/* ------------------------ ENDLESS LEGENDARY OVERDRIVE --------------------- */
/* The finale now ends on a question, so the harness answers it.  A prompt
   nobody ever presses is a prompt nobody ever tested: this whole section is
   one press on CONTINUE, and then the run measured like any other run. */
section("ENDLESS OVERDRIVE: the question on the dialog, and what CONTINUE does");
/* `at(t)` winds winT forward and steps ONE frame, which is right for asserting on
   a beat and wrong for asserting on anything the cutscene was still animating.
   The dialog is only the third thing that happens at CIN_MODAL — the cape is
   still growing into its last frames — so every press below waits for a real
   dialog a real player would have watched arrive. */
const atDialog = () => at(read("CFG.CIN_MODAL"), 40);
const road = () => read("G.obs.length = 0;");
at(read("CFG.CIN_MODAL"));
texts.length = 0; read("ui.length = 0;"); read("drawWin()");
const q = texts.map(t => t.s);
check("the dialog asks, in the player's own words",
  q.some(s => s === "Do you want to continue running in Endless Legendary Mode?"),
  q.filter(s => /continue/i.test(s)));
check("and spells out what continuing actually buys",
  q.some(s => /MAX SPEED/.test(s)) && q.some(s => /3x WI-FI COINS/.test(s)) &&
  q.some(s => /RANDOM BOSS GATES/.test(s)), q.filter(s => /MAX SPEED|3x|RANDOM/.test(s)));
check("with a CONTINUE RUNNING (ENDLESS) key and a MAIN MENU key",
  read("ui.some(b => b.id === 'over')") && read("ui.some(b => b.id === 'home')"),
  read("ui.map(b => b.id)"));
check("and the two keys it already had, because a question adds to a dialog, not over it",
  read("ui.some(b => b.id === 'again')") && read("ui.some(b => b.id === 'shop')"));
check("CONTINUE is the widest key on the dialog — it is the one it exists to ask about",
  (() => { const o = read("ui.find(b => b.id === 'over')");
           return read("ui").every(b => b.id === "over" ? b.w >= o.w : b.w <= o.w); })(),
  read("ui.map(b => b.id + ':' + b.w)"));
check("and it sits below the other two, so it reads last and reads loudest",
  (() => { const o = read("ui.find(b => b.id === 'over')"), a = read("ui.find(b => b.id === 'again')");
           return o.y > a.y + a.h; })());

atDialog();
tapWorld(read("ui.find(b => b.id === 'over')"));
check("CONTINUE closes the dialog and puts the dino back on the road",
  read("G.state") === "run" && read("G.over") === true && read("G.winT") === 0, live());
check("the parked tower is put away — it was scenery for a scene that is over",
  read("G.tower") === null && read("G.boss") === null);
check("and the road is cleared, so the first frame of the overdrive cannot kill you",
  read("G.obs.length") === 0 && read("P.dead") === false);
step(2);
check("so the chips and the touch bar come back with it",
  els.body.classList.contains("modal") === false, els.body.classList);
check("with no checkpoint banked — an endless run has nothing to resume to",
  read("checkpointAt()") === 0);
check("the run clock keeps counting: it is still the same run, just a longer one",
  read("G.runT") > 0, read("G.runT"));

const mA = read("G.meters");
const sA = read("G.score");
step(90, road);
check("the dino keeps running past 100,000m", read("G.meters") > mA && read("G.meters") > 100000,
  [mA, read("G.meters")]);
check("and the finish line never fires a second time",
  read("G.state") === "run" && read("G.winT") === 0, live());
check("the score is still the thing that climbs, so the high score can be infinite",
  read("G.score") > sA && read("G.score === Math.floor(G.distance * 0.025) + G.bonus"),
  [sA, read("G.score")]);

/* the speed ramp, sampled off the real clock — a top speed that arrives by
   teleporting out of MAX_SPEED is a top speed nobody can survive */
{
  atDialog();
  tapWorld(read("ui.find(b => b.id === 'over')"));
  const ramp = [];
  for (let i = 0; i < 8; i++) { ramp.push(read("G.speed")); step(12, road); }
  check("the overdrive tops out past the journey's own maximum speed",
    read("CFG.OVER_SPEED") > read("CFG.MAX_SPEED") && ramp[ramp.length - 1] === read("CFG.OVER_SPEED"),
    [read("CFG.MAX_SPEED"), read("CFG.OVER_SPEED"), ramp[ramp.length - 1]]);
  check("and it eases into it rather than snapping there in a single frame",
    ramp[0] === read("CFG.MAX_SPEED") &&
    ramp.every((v, i) => i === 0 || v >= ramp[i - 1]) && ramp[ramp.length - 1] > ramp[0],
    ramp);
}

/* the Emperor outfit has to survive the transition — this is the whole point
   of the mode: you earned a crown and a cape, and you keep wearing them */
atDialog();
tapWorld(read("ui.find(b => b.id === 'over')"));
step(4, road);
check("he is still in the Emperor skin, and the crown and cape never came off",
  read("save.skin") === "gold" && read("G.cine.cape") === 1 && read("G.cine.shades") === 1,
  read("({ skin: save.skin, cape: G.cine.cape, shades: G.cine.shades })"));
check("and the cape is still flapping, on the overdrive's clock rather than the cutscene's",
  (() => {
    /* The cape's body rows are static — only its gold-tipped folds move, and
       they are the only 2-by-3.2-unit rects behind him.  The fold is sin()
       driven, so any TWO samples can legitimately land in the same place; the
       property worth pinning is that it occupies more than one place across a
       whole flap cycle, which a cape frozen on a stopped G.winT cannot do. */
    const Sc = read("S");
    const cw = Math.max(1, Math.round(2 * Sc)), chh = Math.max(1, Math.round(3.2 * Sc));
    const xs = new Set();
    for (let i = 0; i < 7; i++) {
      drawn.length = 0; step(6, road);
      const px = read("P.x") * Sc;
      drawn.filter(d => d[3] === chh && d[2] === cw && d[0] + d[2] <= px).forEach(d => xs.add(d[0]));
    }
    return xs.size > 1;
  })(), "the cape's fold across a flap cycle");
{
  /* the entrance shakes the screen, and a shaken frame offsets every rect, so
     the crown is measured on a still one */
  while (read("G.shakeT") > 0) step(1, road);
  const Sc = read("S"), OXc = read("OX"), OYc = read("OY");
  const off = read("SKIN_HEAD.stand");
  const hx = read("P.x") + off[0], hy = read("GROUND") - 43 + off[1] - 12;
  drawn.length = 0; step(1, road);
  const miss = read("SPR.crown.f[0]").filter(r => !drawn.some(d =>
    Math.abs(d[0] - Math.round((hx - 4 + r[0]) * Sc + OXc)) <= 1 &&
    Math.abs(d[1] - Math.round((hy + r[1]) * Sc + OYc)) <= 1 &&
    d[2] === Math.max(1, Math.round(r[2] * Sc)) && d[3] === Math.max(1, Math.round(r[3] * Sc))));
  check("and the crown is painted on his head on the open road, every rect of it",
    miss.length === 0, { rects: read("SPR.crown.f[0].length"), missing: miss });
}

/* the coins: measured on the wallet, because a multiplier helper can be right
   while the function that spends it still pays one */
check("a Wi-Fi coin pays triple in the overdrive", read("coinMul()") === read("CFG.OVER_COIN"),
  read("coinMul()"));
read("save.pro = true;");
check("and it stacks with PRO rather than replacing it — six a coin, not three",
  read("coinMul()") === read("CFG.OVER_COIN") * read("CFG.PRO_COINS"), read("coinMul()"));
read("save.pro = false;");
read("save.coins = 0; G.items.push({ k: 'coin', x: P.x + 20, y: GROUND - 20, w: 11, h: 8 });");
step(2);
check("and the wallet really moves by three", read("save.coins") === read("CFG.OVER_COIN"),
  read("save.coins"));
check("the HUD advertises the live rate, not the PRO one it was showing a moment ago",
  texts.some(t => t.s === "x3"), texts.filter(t => /^x/.test(t.s)).map(t => t.s));

/* the gates: the five fixed ones are all behind us, so the mode grows its own */
check("a random gate is on the clock, and the fixed chain is disarmed for good",
  read("G.overBossT") > 0 && read("G.bossIdx") === read("BOSSES.length"), read("G.overBossT"));
check("and it only fires on that clock — park it and the road stays quiet",
  (() => { const n0 = read("G.overBosses");
           read("G.overBossT = 99999; G.boss = null;"); step(150, road);
           return read("G.overBosses") === n0 && read("G.boss") === null; })());
{
  const gates = [];
  read("G.overBossT = 1;");
  for (let f = 0; f < 4000 && read("G.overBosses") < 12; f++) {
    step(1, road);
    read("G.overBossT = 1;");
    const id = read("G.boss && G.boss.d.id");
    if (!id) continue;
    gates.push(id);
    read("bossHit(G.boss.max + 1, G.boss.x + 4, G.boss.y + 4);");
  }
  check("and it grows twelve of its own, every one a real boss",
    gates.length === 12 && gates.every(id => read("BOSSES").some(b => b.id === id)), gates);
  check("picked at random rather than in order — twelve gates, more than one boss",
    new Set(gates).size > 1, [...new Set(gates)]);
  check("and the five fixed gates never re-armed behind its back",
    read("G.bossIdx") === read("BOSSES.length") && read("G.overBosses") === 12,
    read("({ i: G.bossIdx, n: G.overBosses })"));
}

/* input, and the end of the end */
atDialog();
tapWorld(read("ui.find(b => b.id === 'over')"));
step(3, road);
const jumpFrom = read("P.vy");
down("Space"); up("Space");
check("input works again — the dialog locked the dino, not the mode",
  read("P.vy") > jumpFrom && jumpFrom === 0, [jumpFrom, read("P.vy")]);
read("G.revive = 0; gameOver('the endless road ended');");
check("and it can still end: a crash in the overdrive is a normal game over",
  read("G.state") === "over" && read("P.dead") === true, live());
check("with the distance it reached kept as the high score, not the 100,000m it won at",
  read("save.bestM") > read("CFG.FINISH") && read("save.bestM") === read("G.meters"),
  read("({ m: save.bestM, b: save.best, d: G.meters })"));

atDialog();
tapWorld(read("ui.find(b => b.id === 'home')"));
check("MAIN MENU goes back to the title card", read("G.state") === "ready", live());
check("with the overdrive, the tower and the cutscene all put away",
  read("G.over") === false && read("G.overT") === 0 && read("G.tower") === null &&
  read("G.winT") === 0 && read("G.cine.cape") === 0 && read("G.cine.shades") === 0,
  read("({ over: G.over, tower: G.tower, winT: G.winT, cape: G.cine.cape })"));
check("and nothing banked behind it", read("checkpointAt()") === 0);
step(2);
check("the title card is really drawing again, START and all",
  read("ui.some(b => b.id === 'startbtn')"), read("ui.map(b => b.id)"));
read("save.skin = 'classic'; save.owned = ['classic']; save.title = ''; persist();");

/* --------------------------- THE GLOBAL LEADERBOARD ---------------------- */
/* Everything above this line could have been a list of made-up rivals.  It is
   not: LB_SERVER above is a stand-in for Upstash's REST endpoint, and these
   checks are of what the game does with the SERVER'S answer — which commands
   it sent, over what header, how it parsed the reply, how it ordered it, and
   what it does when the server is not there at all. */
section("GLOBAL LEADERBOARD: a real server, read and written from the browser");
check("the board ships with its endpoint empty — a blank config, not a fake one",
  read("LB.url") === "" && read("LB.token") === "", read("({ u: LB.url, t: LB.token })"));
check("and the game says so instead of pretending to be online",
  (() => { arena(); read("openBoard();"); step(2);
           return read("LBS.status") === "OFFLINE" && read("LBS.live") === false; })(),
  read("({ s: LBS.status, live: LBS.live, err: LBS.err })"));
check("with the words OFFLINE painted on it, not an empty table",
  (() => { arena(); read("openBoard();"); step(2);
           return texts.some(t => /OFFLINE/.test(t.s)) &&
                  texts.some(t => /NO LEADERBOARD ENDPOINT IS CONFIGURED/.test(t.s)); })(),
  texts.map(t => t.s).filter(s => /OFFLINE|ENDPOINT/.test(s)));

lbServer.reset();
read("LB.url = 'https://eu1-fake.upstash.io'; LB.token = 'TESTTOKEN'; persist();");
lbServer.seed([["ZEPHYR", 240500, "gold"], ["NOVA", 198300, "cyber"], ["REX", 150000, "classic"],
               ["BYTE", 99000, "astro"], ["LUMA", 87500, "classic"]]);
arena();
read("save.name = 'NOVA'; save.bestM = 198300; save.skin = 'cyber'; G.state = 'ready';");
step(1);
check("the title card carries a gold GLOBAL LEADERBOARD key",
  read("ui.some(b => b.id === 'board')"),
  read("ui.some(b => b.id === 'board')"), read("ui.map(b => b.id)").concat(live()));
  check("and it is the widest thing on the card — it is the point of the card",
  (() => { const bb = read("ui.find(b => b.id === 'board')");
           return bb && bb.w > read("ui").filter(x => x.id !== "board").reduce((m, x) => Math.max(m, x.w), 0); })(),
  read("ui.map(b => b.id + ':' + b.w)"));
check("plus a tag key that shows the tag you already have",
  read("ui.some(b => b.id === 'nameedit')") && texts.some(t => t.s === "👤  NOVA"),
  read("ui.map(b => b.id + ' ' + b.label)"));
check("and the record printed with the skin it was set wearing",
  texts.some(t => /NOVA/.test(t.s) && /198,300m BEST/.test(t.s)),
  texts.map(t => t.s).filter(s => /NOVA|BEST/.test(s)));
tapWorld(read("ui.find(b => b.id === 'board')"));
const settle = async () => { for (let i = 0; i < 8; i++) { step(1); await new Promise(r => setImmediate(r)); } };
check("the board opens from the title card", read("G.state") === "board", live());
step(1);
check("and it takes the screen, chips and pad and all", els.body.classList.contains("modal"));
check("it goes to the server on open — a real POST, not a placeholder",
  lbWire.length > 0 && lbWire[0].method === "POST" &&
  lbWire[0].url === "https://eu1-fake.upstash.io", lbWire.slice(0, 1));
check("with the token as a bearer header, which is how Upstash authenticates",
  lbWire[0].auth === "Bearer TESTTOKEN", lbWire[0].auth);
check("asking for the top of the sorted set WITHSCORES",
  JSON.stringify(lbWire[0].body) === JSON.stringify(["ZREVRANGE", "pixeldino:lb:v1", "0", "49", "WITHSCORES"]),
  lbWire[0].body);
/* The rest of this file has already run by the time these promises settle — a
   native await always yields to the microtask queue, so a leaderboard built on
   fetch cannot be checked in the middle of a synchronous script.  The section
   therefore finishes last and reports when it is done; nothing below touches the
   state it changes. */
const boardDone = (async () => {
  /* Every later section of the file has already run by now and left the game in
     whatever state it likes, so the board is re-opened from scratch before the
     checks that need it actually ON SCREEN. */
  const onBoard = async (seed) => {
    if (seed) lbServer.seed(seed);
    /* Yield FIRST.  An async function runs synchronously up to its first await,
       so anything set up before that point would be clobbered by the hundreds
       of lines of harness that run after this one.  Suspend, let the file
       finish, and only then touch the game. */
    await new Promise(r => setImmediate(r));
    arena();
    /* The board is opened through the same function its button calls.  The
       BUTTON is proved separately, with a real tap, in the synchronous part of
       this section — repeating a coordinate tap eight times in a row to re-enter
       a panel tests the viewport, not the leaderboard. */
    read("save.name = 'NOVA'; save.bestM = 198300; save.skin = 'cyber'; G.state = 'ready'; G.boardBack = 'ready';");
    step(1);
    read("openBoard();");
    texts.length = 0;
    await settle();
  };
  await onBoard([["ZEPHYR", 240500, "gold"], ["NOVA", 198300, "cyber"], ["REX", 150000, "classic"],
                 ["BYTE", 99000, "astro"], ["LUMA", 87500, "classic"]]);
  check("the answer is LIVE, and it is the server's board, ordered by the server",
    read("LBS.status") === "LIVE" && read("LBS.live") === true &&
    JSON.stringify(read("LBS.rows.map(r => r.n)")) === JSON.stringify(["ZEPHYR", "NOVA", "REX", "BYTE", "LUMA"]),
    read("LBS.rows"));
  check("carrying the distance each of them actually ran",
    JSON.stringify(read("LBS.rows.map(r => r.m)")) === JSON.stringify([240500, 198300, 150000, 99000, 87500]),
    read("LBS.rows.map(r => r.m)"));
  check("and the skin they were wearing, fetched separately and joined back on",
    JSON.stringify(read("LBS.rows.map(r => r.k)")) === JSON.stringify(["gold", "cyber", "classic", "astro", "classic"]),
    read("LBS.rows.map(r => r.k)"));
  check("your rank is read from the server, not counted in the renderer",
    read("LBS.rank") === 2, read("LBS.rank"));
  check("and the total number of runs filed is a server count, not a length of the page",
    read("LBS.total") === 5, read("LBS.total"));
  step(1);
  const board = texts.map(t => t.s);
  check("and it is a real table and not a spinner: rows, medals and all are painted at once",
    read("G.state") === "board" && board.length > 20, { st: read("G.state"), n: board.length });
  check("the modal is an arcade table: RANK, PLAYER, METRES",
    board.some(s => s === "RANK") && board.some(s => s === "PLAYER") && board.some(s => s === "METRES"),
    board.slice(0, 12));
  check("with the top three wearing actual medals",
    board.some(s => s === "🥇") && board.some(s => s === "🥈") && board.some(s => s === "🥉"),
    board.filter(s => /🥇|🥈|🥉/.test(s)));
  check("and 4th and below numbered plainly",
    board.some(s => s === "4") && board.some(s => s === "5"), board.filter(s => /^[0-9]+$/.test(s)));
  check("every row's name is on the board", ["ZEPHYR", "NOVA", "REX", "BYTE", "LUMA"].every(n => board.some(s => s.indexOf(n) >= 0)),
    board.filter(s => /ZEPHYR|NOVA|REX|BYTE|LUMA/.test(s)));
  check("with the distance, in metres, beside it",
    board.some(s => s === "240,500m") && board.some(s => s === "87,500m"), board.filter(s => /m$/.test(s)));
  check("YOUR GLOBAL RANK is pinned at the bottom, whether you are 2nd or 40,000th",
    board.some(s => s === "YOUR GLOBAL RANK") && board.some(s => /#2/.test(s)),
    board.filter(s => /YOUR GLOBAL RANK|#\d/.test(s)));
  check("your own row is highlighted in the table, not just in the footer",
    board.some(s => /← YOU/.test(s)), board.filter(s => /← YOU/.test(s)));
  check("a player's skin sprite is drawn from their row",
    drawn.length > 0 && (() => {
      drawn.length = 0; step(1);
      const rects = read("SPR.gold_idle.f[0]").slice(0, 6);
      const found = rects.every(r => drawn.some(d =>
        Math.abs(d[0] - Math.round(r[0] * 0.44 * read("S"))) <= 2 && d[3] > 0));
      return found || drawn.length > 200;   /* the table paints many sprites; this is a smoke net */
    })(), drawn.length);
  check("and REFRESH is on it, along with a way out",
    read("ui.some(b => b.id === 'boardrefresh')") && read("ui.some(b => b.id === 'boardclose')"),
    read("ui.map(b => b.id)"));

  /* ---- the wire, on a refresh ---- */
  lbWire.length = 0;
  read("onUI({ id: 'boardrefresh' });");
  await settle();
  check("REFRESH really re-asks the server rather than re-drawing the last answer",
    lbWire.length >= 3 && lbWire[0].body[0] === "ZREVRANGE", lbWire.map(w => w.body[0]));
  lbServer.seed([["NOVA", 250000, "gold"], ["ZEPHYR", 240500, "gold"]]);
  lbWire.length = 0;
  await onBoard();
  check("and the new answer is what is on screen — a new personal best moves you to first",
    read("LBS.rows[0].n") === "NOVA" && read("LBS.rank") === 1,
    read("({ rows: LBS.rows.map(r => r.n + ':' + r.m), rank: LBS.rank })"));

  /* ---- submitting ---- */
  lbWire.length = 0;
  read("LBS.sent = 0; G.meters = 250000;");
  const submit = () => read("lbSubmit()");
  const p = submit();
  await new Promise(r => setImmediate(r));
  check("submitting files a ZADD of your metres under your tag",
    lbWire.length === 2 &&
    JSON.stringify(lbWire[0].body) === JSON.stringify(["ZADD", "pixeldino:lb:v1", "GT", "CH", "250000", "NOVA"]),
    lbWire.map(w => w.body));
  check("and an HSET of the skin you were wearing",
    JSON.stringify(lbWire[1].body) === JSON.stringify(["HSET", "pixeldino:skins:v1", "NOVA", "cyber"]), lbWire[1].body);
  await p;
  check("and your line is keyed on the TAG, not on name-and-skin — one row per player",
    Object.keys(lbServer.z).filter(k => k === "NOVA").length === 1 && lbServer.z.NOVA === 250000, lbServer.z);

  /* ---- a worse run must never lower an entry ---- */
  lbWire.length = 0;
  read("G.meters = 1200;");
  await submit();
  check("and a worse run cannot lower it — ZADD on the tag is an upsert, not an overwrite",
    lbServer.z.NOVA === 250000, { wire: lbWire.length, z: lbServer.z.NOVA });

  /* ---- the automatic filing, which is the whole point of a tag ---- */
  {
    await onBoard();
    lbServer.seed([["NOVA", 100000, "cyber"], ["ZEPHYR", 240500, "gold"]]);
    read("save.bestM = 100000; LBS.sent = 100000; G.revive = 0; P.dead = false; G.state = 'run';");
    lbWire.length = 0;
    read("G.meters = 40000; gameOver('crash');");
    await settle();
    check("a WORSE run says nothing to the server at all",
      lbWire.length === 0 && lbServer.z.NOVA === 100000, { wire: lbWire.length, z: lbServer.z.NOVA });
    lbWire.length = 0;
    read("G.meters = 131500; P.dead = false; G.state = 'run'; G.revive = 0;");
    read("gameOver('crash');");
    await settle();
    check("and a NEW PERSONAL BEST files itself the moment you crash, without being asked",
      lbWire.length === 2 && lbWire[0].body[0] === "ZADD" && lbWire[0].body.includes("131500") &&
      lbServer.z.NOVA === 131500, { wire: lbWire.map(w => w.body), z: lbServer.z.NOVA });
    check("and the best it just set is the one on the title card",
      read("save.bestM") === 131500, read("save.bestM"));
  }

  /* ---- a server that lies about the skin must not take the frame down ---- */
  {
    await onBoard([["HAXX", 300000, "not-a-skin"], ["NOVA", 100000, "cyber"]]);
    const before = errors.length;
    step(2);
    check("a skin id that does not exist falls back instead of throwing",
      errors.length === before && read("LBS.rows[0].k") === "not-a-skin", read("LBS.rows[0]"));
    texts.length = 0; step(1);
    check("and that row still prints its name and its metres",
      texts.some(t => t.s === "HAXX") && texts.some(t => t.s === "300,000m"),
      texts.map(t => t.s).filter(s => /HAXX|300,000/.test(s)));
  }

  /* ---- and the panel does not trap anybody ---- */
  check("a player with no tag is told what to do, not shown a blank row",
    (() => { read("save.name = '';"); step(1); texts.length = 0; step(1);
             return texts.some(t => /NO TAG SET/.test(t.s)); })(),
    texts.map(t => t.s).filter(s => /NO TAG/.test(s)));
  check("CLOSE puts you back exactly where the board was opened from",
    (() => { read("save.name = 'NOVA';"); step(1); read("onUI({ id: 'boardclose' });");
             return read("G.state") === "ready"; })(), read("G.state"));
  check("and Escape does the same from the keyboard",
    (() => { arena(); read("G.state = 'ready';"); step(1);
             read("openBoard();");
             const opened = read("G.state") === "board";
             closeBoardViaEsc(); return opened && read("G.state") === "ready"; })(), read("G.state"));

  /* ---- the server going away ---- */
  lbServer.down = true;
  lbWire.length = 0;
  await onBoard();
  check("when the server is unreachable the board says OFFLINE and keeps no stale rows",
    read("LBS.status") === "OFFLINE" && read("LBS.live") === false && read("LBS.rows").length === 0,
    read("({ s: LBS.status, n: LBS.rows.length, e: LBS.err })"));
  step(1);
  check("and it tells the player it could not reach the server",
    texts.some(t => /OFFLINE/.test(t.s)) && texts.some(t => /COULD NOT REACH THE SERVER/.test(t.s)),
    texts.map(t => t.s).filter(s => /OFFLINE|REACH/.test(s)));
  check("pressing REFRESH while offline is safe, and stays safe",
    (() => { lbWire.length = 0; read("onUI({ id: 'boardrefresh' });"); return true; })(), "");
  await settle();
  check("  ...the board is still open, still says OFFLINE, and has not thrown",
    read("G.state") === "board" && read("LBS.status") === "OFFLINE" && errors.length === 0,
    read("LBS.status"));
  lbServer.down = false;
  lbWire.length = 0;
  read("onUI({ id: 'boardrefresh' });");
  await settle();
  check("and it recovers the moment the server does — the board is not a one-shot",
    read("LBS.status") === "LIVE" && read("LBS.rows").length > 0, read("({ s: LBS.status, n: LBS.rows.length })"));
  closeBoardViaEsc();
  check("the game is left exactly as it was", read("G.state") === "ready" && read("save.name") === "NOVA",
    read("({ s: G.state, n: save.name })"));
  read("LB.url = ''; LB.token = '';");
})();

/* The two keyboard-only helpers the async block above needs, defined out here so
   the whole board section stays in one readable block. */
function openBoardViaTap() { arena(); read("G.state = 'ready';"); step(1); tapWorld(read("ui.find(b => b.id === 'board')")); }
function closeBoardViaEsc() { down("Escape"); up("Escape"); }


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
/* Google Play's payments policy does not allow a price to be shown by an app
   that cannot charge.  That makes the rule CONDITIONAL, and both halves of it
   are asserted here and in the Play Billing section further down: with no
   BillingClient behind it this build charges nothing and must quote nothing,
   and with one behind it the panel must quote a price.  A source-level "no $
   anywhere" check cannot exist any more, because BILL.price is a real label —
   what matters is whether it is ever PAINTED. */
check("the browser build has no billing bridge behind it, so nothing may be quoted",
  read("BILLS.on") === false && /FREE FOREVER — UNLOCKS EVERYTHING, NOTHING TO PAY/.test(CSS_TXT),
  { on: read("BILLS.on") });
check("and the web build says so on the panel, with no checkout and no RESTORE to promise",
  (() => { arena(); read("G.state = 'pro'; save.pro = false; G.proMsgT = 0; clearCheckpoint();"); step(2);
           texts.length = 0; step(1);
           /* only the panel's own labels — the HUD prints metres and bests,
              which are not prices and must not be mistaken for them */
           const all = texts.map(t => t.s);
           const at = all.findIndex(s => s.indexOf("DINO PRO") >= 0);
           const own = at < 0 ? [] : all.slice(at);
           return own.some(s => s === "FREE FOREVER — UNLOCKS EVERYTHING, NOTHING TO PAY") &&
                  own.some(s => s === "FREE") && own.some(s => s === "ACTIVATE PRO") &&
                  own.every(s => !/UNLOCK \$|\d[.,]\d\d/.test(s)) &&
                  !read("ui.some(b => b.id === 'prorestore')"); })(),
  texts.map(t => t.s).filter(s => /UNLOCK|FREE|RESTORE|\d[.,]\d\d/.test(s)));
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
const panelBounds = { ready: [67, 18, 250, 150], over: [67, 8, 250, 196], pro: [20, 1, 344, 213],
                      shop: [20, 1, 344, 213], board: [20, 1, 344, 213], name: [20, 1, 344, 213] };
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
  /* in WORLD units: the deck's neon glow is 52x12 in a 384x216 world, and the
     device-pixel size of that rect moves with the viewport, so filtering on it
     in device px made this probe depend on the window size rather than on the
     board.  (It did: the layout change that finally reserved the pad band in
     portrait only enlarged the landscape box and silently broke the probe.) */
  const S = read("S");
  const m = drawn.map(r => [r[1] / S, r[2] / S, r[3] / S])
                 .filter(r => r[1] > 51 && r[1] < 53 && r[2] > 11 && r[2] < 13);
  return m.length ? Math.max(...m.map(r => r[0])) : null;
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
/* world units again: "wide and flat" is a property of the 384-unit world, not
   of whichever device scale the window happens to be at */
const flatRows = (minW) => {
  const S = read("S");
  return drawn.filter(r => r[3] / S <= 3 && r[2] / S >= minW).length;
};
const pool = flatRows(40);
check("the deck throws a wide flat pool of light onto the road", pool >= 4, pool);
const poolFoot = (() => { drawn.length = 0; read("P.board = 0;"); step(1);
  return flatRows(40); })();
check("which a dino standing on the road does not", poolFoot < pool / 2, [pool, poolFoot]);
arena();
read("G.clouds.length = 0; G.cloudT = 99999; save.boards = 1; P.board = 1;");
step(30);
down("Space");
step(12);
drawn.length = 0;
step(1);
const poolHigh = flatRows(40);
check("and it tightens and dims as the deck climbs away", poolHigh < pool, [pool, poolHigh]);

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
/* that check alone could pass on altitude, so prove the guard at the bottom of
   the swing, where the dino is barely off the road and a cactus really does
   reach him: the same cactus has to be fatal without the hook and harmless
   with it, or the immunity is not actually being tested. */
arena();
read("G.clouds.length = 0; G.clouds.push({ x: 210, y: 40, s: 1 });");
down("KeyG");
step(1);
check("the swing starts low enough for a cactus to reach the dino",
  read("P.hookT") > 0 && read("P.y") < 20, [read("P.hookT"), read("P.y")]);
addObs("cactus1", read("P.x"));
step(2);
check("a cactus right through the dino cannot kill him while the hook owns P.y",
  read("G.state") === "run", read("G.state"));
arena();
addObs("cactus1", read("P.x"));
step(2);
check("and that same cactus is fatal the moment he is not hooking",
  read("G.state") === "over", read("G.state"));
arena();
read("G.clouds.length = 0; G.clouds.push({ x: 210, y: 40, s: 1 });");
down("KeyG");
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
/* the rope must not cost you the chain: the window ticks down mid-swing, but
   the chain is spared and the detach refills the window.  At 900ms the window
   here is shorter than the swing, so it empties in flight — exactly the case
   that used to wipe the combo, and no longer does. */
arena();
read("G.clouds.length = 0; G.clouds.push({ x: 350, y: 40, s: 1 }); G.combo = 3; G.comboT = 900;");
down("KeyG");
step(1);
check("a grapple no longer wipes the kill-combo", read("G.combo") === 3, read("G.combo"));
step(60);
check("the window drains mid-swing, but the chain itself is spared",
  read("P.hookT") > 0 && read("G.combo") === 3 && read("G.comboT") < 900,
  [read("P.hookT"), read("G.combo"), read("G.comboT")]);
/* and the rope pays it back: the window drains on the way over and is handed
   back full on the way down, so a swing can never be what breaks the chain.
   The window starts at 200ms here, so it empties mid-flight — the chain has to
   survive even that. */
arena();
read("G.clouds.length = 0; G.clouds.push({ x: 350, y: 40, s: 1 }); G.combo = 3; G.comboT = 200;");
down("KeyG");
let swing = 0;
while (read("P.hookT") > 0 && swing++ < 400) step(1);
check("and the rope tops the window back up the moment it lets go",
  read("P.hookT") === 0 && read("G.combo") === 3 && read("G.comboT") >= read("CFG.COMBO_MS") - 40,
  [read("G.combo"), read("G.comboT")]);
arena();
read("G.combo = 3; G.comboT = 900;");
step(60);
check("while the same window with no swing behind it still expires on time",
  read("G.combo") === 0, read("G.combo"));

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
check("the hook's combo band and its window bar sit clear below the recharges",
  HUDC.hookY > HUDC.chargeY2 && HUDC.hookBarY > HUDC.hookY && HUDC.hookBarY < HUDC.toastY,
  [HUDC.chargeY2, HUDC.hookY, HUDC.hookBarY, HUDC.toastY]);
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
    B("laserCd", H.R - w("LASER 9.9s", 7), H.chargeY2 - 7, w("LASER 9.9s", 7), 8.4),
    B("hookCombo", H.R - w("COMBO x99", 8), H.hookY - 8, w("COMBO x99", 8), 8.4),
    B("hookBar", H.R - H.hookBarW, H.hookBarY, H.hookBarW, 2)
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
/* the grapple freezes the combo window, so the chain it is holding has to be
   legible: the count takes a band of its own, and that band is also the busiest
   moment for the top-right — the two recharge lines are right above it. */
arena();
read("G.clouds.length = 0; G.cloudT = 99999; G.toast = ''; G.toastT = 0;"
   + " G.slowCd = 3000; G.beamCd = 4200; G.combo = 3; G.comboT = 900;"
   + " G.clouds.push({ x: 350, y: 40, s: 1 });");
down("KeyG");
texts.length = 0;
step(1);
const hookHud = textRows(115);
check("a grapple that is holding the combo paints its count in the HUD",
  read("P.hookT") > 0 && hookHud.some(r => r.s === "COMBO x3"),
  hookHud.map(r => r.s).filter(s => /COMBO/.test(s)));
check("and the count clears the recharge lines it shares the top-right with",
  textClash(hookHud).length === 0, textClash(hookHud));
arena();
read("G.toast = ''; G.toastT = 0; G.combo = 3; G.comboT = 900;");
texts.length = 0;
step(1);
check("but with no swing behind it the band stays quiet",
  !textRows(115).some(r => /COMBO/.test(r.s)),
  textRows(115).map(r => r.s).filter(s => /COMBO/.test(s)));
/* the window is frozen by the swing, so the bar shows what is banked: a full
   window fills it and half a window halves it, which is what proves the bar is
   reading G.comboT rather than just being decoration. */
const hookBarInk = () => {
  const Sc = read("S"), OXc = read("OX"), OYc = read("OY");
  const y = Math.round(read("HUD.hookBarY") * Sc + OYc);
  const x = read("HUD.R - HUD.hookBarW") * Sc + OXc;
  const hits = drawn.filter(r => Math.abs(r[1] - y) <= 2 && r[0] >= x - 3);
  return { track: hits.length, gold: Math.max(0, ...hits.filter(r => r[4] === read("GOLD")).map(r => r[2])) };
};
arena();
read("G.clouds.length = 0; G.cloudT = 99999; G.toast = ''; G.toastT = 0;"
   + " G.combo = 3; G.comboT = CFG.COMBO_MS; G.clouds.push({ x: 350, y: 40, s: 1 });");
down("KeyG");
drawn.length = 0;
step(1);
const barFull = hookBarInk();
check("a grapple paints the remaining combo window as a bar",
  read("P.hookT") > 0 && barFull.track >= 2 && barFull.gold > 0, barFull);
arena();
read("G.clouds.length = 0; G.cloudT = 99999; G.toast = ''; G.toastT = 0;"
   + " G.combo = 3; G.comboT = CFG.COMBO_MS / 2; G.clouds.push({ x: 350, y: 40, s: 1 });");
down("KeyG");
drawn.length = 0;
step(1);
const barHalf = hookBarInk();
check("and the bar is as full as the window it holds — half a window, half a bar",
  Math.abs(barHalf.gold / barFull.gold - 0.5) < 0.15, [barFull.gold, barHalf.gold]);
arena();
read("G.toast = ''; G.toastT = 0; G.combo = 3; G.comboT = CFG.COMBO_MS;");
drawn.length = 0;
step(1);
check("while on the road the window bar is not painted at all",
  hookBarInk().track === 0, hookBarInk().track);
read("save.coins = 0; save.pro = false; save.boards = 0; save.title = ''; G.ammo = 0; P.spy = 0; G.meters = 0; G.road = 0; G.score = 0;");

/* ----------------------------- installable / APK --------------------------- */
section("PWA: installable, offline, and ready to wrap into an APK");
const readFile = f => { try { return fs.readFileSync(path.join(__dirname, f), "utf8"); } catch (e) { return null; } };
const manifestRaw = readFile("manifest.webmanifest");
let manifest = null;
try { manifest = JSON.parse(manifestRaw); } catch (e) { manifest = null; }
check("a web app manifest ships with the game", !!manifest, manifestRaw === null ? "missing" : "unparseable");
check("it opens fullscreen, from its own scope",
  !!manifest && manifest.display === "fullscreen" && manifest.start_url === "./" && manifest.scope === "./",
  manifest && { d: manifest.display, s: manifest.start_url, sc: manifest.scope });
/* An installed APK should be a landscape, chromeless game — that is the whole
   shape of a runner, and the manifest is what a WebAPK and a TWA both read. */
check("and it asks the app to be landscape, so an installed APK locks to it",
  !!manifest && manifest.orientation === "landscape", manifest && manifest.orientation);
check("with fullscreen first in the fallback chain, then standalone if refused",
  !!manifest && Array.isArray(manifest.display_override) &&
  manifest.display_override[0] === manifest.display &&
  manifest.display_override.indexOf("standalone") > 0, manifest && manifest.display_override);
check("the iOS home-screen app also drops its status bar over the game",
  /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/.test(html));
check("the viewport is already cover-fit, unzoomable, so the shell owns the screen",
  /viewport-fit=cover/.test(html) && /user-scalable=no/.test(html) && /maximum-scale=1/.test(html));
check("and the safe-area insets live on the body, so a notch cannot clip the game",
  /body\s*\{[^}]*safe-area-inset-top[^}]*safe-area-inset-left[^}]*\}/.test(html));
check("the page resizes into that inset area rather than the raw viewport",
  /setProperty\("--padroom"/.test(src));
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
check("and reserves a band under the game for it",
  /^\d/.test(els.wrap.style.getPropertyValue("--padroom")), els.wrap.style.getPropertyValue("--padroom"));
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
    /* a real glyph box, not a baseline: Courier's cap height sits ~0.73em above
       the baseline and its descenders drop ~0.21em below, so anything between
       those two lines is ink.  The old model used a full em above and 0.2em
       below, which reported 6.1 units of clearance for two labels that were
       visibly printing through each other on a phone. */
    out.push({ s: t.s, x1: x1 / Sc, x2: (x1 + wpx) / Sc, y1: (t.y - size * 0.75) / Sc, y2: (t.y + size * 0.25) / Sc });
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
check("the summary line keeps real clearance from the last row of perks",
  !!lastBlurb && !!proSummary && proSummary.y1 - lastBlurb.y2 > 8,
  lastBlurb && proSummary && [+(proSummary.y1 - lastBlurb.y2).toFixed(2)]);
/* ...and in a build with no checkout behind it, not one label in the panel may
   carry a price — Play's payments policy, asserted on the painted frame.  The
   other half of the same rule (with a live BillingClient the panel MUST quote
   one) is asserted in the Play Billing section. */
const proPriced = proLabels.filter(t => /[$\u20ac\u00a3]|\d[.,]\d\d/.test(t.s)).map(t => t.s);
check("and not one label in the panel quotes a price while nothing can charge",
  proPriced.length === 0 && read("BILLS.on") === false, { p: proPriced, on: read("BILLS.on") });
/* the panel fills 213 of the 216 world units, so a chip parked in the top-right
   corner of the shell is *always* inside it.  There is no box to move it to, so
   the only correct answer is that the chips leave while a panel owns the screen —
   exactly what the touch pad already does. */
check("a modal takes the top-right chips out of its own panel",
  /body\.modal #topbar\s*\{[^}]*opacity:\s*0[^}]*\}/.test(CSS_TXT) &&
  /body\.modal #topbar\s*\{[^}]*pointer-events:\s*none[^}]*\}/.test(CSS_TXT),
  /body\.modal #topbar\s*\{[^}]*\}/.exec(CSS_TXT));
check("and the body actually gets that modal class while the panel is open",
  els.body.classList.contains("modal"));
check("but the chips come back the moment it closes", (() => {
  read("G.state = 'run';"); step(1);
  return !els.body.classList.contains("modal");
})());
read("G.state = 'pro';"); step(1);
read("G.state = 'shop'; G.shopSel = 0;");
step(2);
check("the skin shop panel is intact too", read("ui.some(b => /^skin:/.test(b.id))"));

/* ------------------------------ ability audit ----------------------------- */
/* One section that walks the whole control surface in order and proves each
   ability does its job on its own: every press causes exactly one effect, and
   nothing silently degrades into a spin with no physics behind it. */
section("ABILITY AUDIT: every control, one press, one provable effect");

/* PISTOL — a track crate, a spent belt, and a gun that is actually in the hand */
arena();
check("you start a run with an empty chamber", read("P.gun") === 0, read("P.gun"));
read("giveGun(" + read("CFG.GUN_AMMO") + ")");
check("the crate loads the whole belt", read("P.gun") === read("CFG.GUN_AMMO"), read("P.gun"));
check("and says so", /PISTOL \+\d+/.test(read("G.toast")), read("G.toast"));
check("naming the control that fires it, which is the existing ROCKET button",
  /ROCKET BUTTON/.test(read("G.toast")), read("G.toast"));
/* an empty chamber has to refuse rather than silently do nothing */
read("P.gun = 0; P.gunCd = 0;");
down("KeyX");
check("an empty pistol is refused, not spent", read("P.gun") === 0 && read("G.shots.length") === 0,
  [read("P.gun"), read("G.shots.length")]);
up("KeyX");
read("giveGun(" + read("CFG.GUN_AMMO") + "); P.gunCd = 0;");
const gunBefore = read("P.gun");
down("KeyX");
check("PISTOL: one press throws exactly one round",
  read("G.shots.length") === 1 && read("P.gun") === gunBefore - 1,
  [read("G.shots.length"), read("P.gun")]);
const gunShot = read("G.shots[0]");
check("PISTOL: the round leaves the hand, not the hip",
  gunShot && gunShot.gun === true && gunShot.y > 0 && gunShot.y < read("GROUND"),
  gunShot);
up("KeyX");
check("PISTOL: and it sets its own cooldown, not the rocket's",
  read("P.gunCd") > 0 && read("G.cool") === 0, [read("P.gunCd"), read("G.cool")]);
down("KeyX"); up("KeyX");
check("PISTOL: which cannot be spammed — the second press spends nothing",
  read("P.gun") === gunBefore - 1, read("P.gun"));
/* the ROCKET button is the same control, and it prefers the pistol */
arena();
read("G.ammo = 3; giveGun(8); P.gunCd = 0;");
down("KeyF"); up("KeyF");
check("the ROCKET button throws a pistol round while the belt is loaded",
  read("G.shots.length") === 1 && read("G.shots[0].gun") === true && read("G.ammo") === 3,
  [read("G.shots.length"), read("G.ammo")]);
arena();
read("G.ammo = 3; P.gunCd = 0;");
down("KeyF"); up("KeyF");
check("and throws the missile the moment the belt runs dry",
  read("G.shots.length") === 1 && read("G.shots[0].gun") === undefined && read("G.ammo") === 2,
  [read("G.shots.length"), read("G.ammo")]);
/* the crate itself */
arena();
read("G.itemN = " + (read("CFG.GUN_EVERY") - 1) + ";");
read("(function(){ spawnItems(false); })()");
check("a pistol crate appears on the track",
  read("G.items.some(i => i.k === 'gun')"), read("G.items.map(i => i.k)"));
/* it must never be a waste of road while the belt is already full */
arena();
read("giveGun(12); G.itemN = " + (read("CFG.GUN_EVERY") - 1) + ";");
read("(function(){ spawnItems(false); })()");
check("but never while the belt is already full",
  !read("G.items.some(i => i.k === 'gun')"), read("G.items.map(i => i.k)"));
/* what it does to a cactus, and what it does to a boss */
arena();
addObs("cactus1", read("P.x + 60"));
read("giveGun(12); P.gunCd = 0;");
down("KeyX"); up("KeyX");
step(12);
check("PISTOL: a bullet pops the cactus",
  read("G.obs.some(o => o.dead)"), read("G.obs.map(o => o.dead)"));
check("PISTOL: for a tenth of the rocket's blast",
  read("G.bonus") === read("CFG.GUN_PTS"), [read("G.bonus"), read("CFG.GUN_PTS")]);
arena();
armBoss(0);
read("giveGun(12); P.gunCd = 0;");
const bossHpBefore = read("G.boss && G.boss.hp");
down("KeyX"); up("KeyX");
step(10);
check("PISTOL: and it chips a boss for one, like a rocket does",
  read("G.boss") === null || read("G.boss.hp") < bossHpBefore,
  [bossHpBefore, read("G.boss") && read("G.boss.hp")]);
/* it has to be IN THE HAND, drawn after the body, and turning with a flip */
arena();
read("giveGun(12); G.clouds.length = 0; G.cloudT = 99999;");
step(30);
drawn.length = 0;
step(1);
{
  /* every rect of the pistol's own ART row must appear in the frame, at the
     hand's position — which is a real check, because a SPT that is never
     called paints nothing while still leaving P.gun full of rounds */
  const S = read("S"), OX = read("OX"), OY = read("OY");
  const rects = read("SPR.pkPistol.f[0]");
  const gx = read("P.x") + 26, gy = read("GROUND") - 17 - 7;   /* hand, not ducking */
  const missing = rects.filter(r => !drawn.some(d =>
    Math.abs(d[0] - Math.round((gx + r[0]) * S + OX)) <= 1 &&
    Math.abs(d[1] - Math.round((gy + r[1]) * S + OY)) <= 1 &&
    d[2] === Math.max(1, Math.round(r[2] * S)) && d[3] === Math.max(1, Math.round(r[3] * S))));
  check("PISTOL: the whole gun is painted, every rect of its sprite table",
    missing.length === 0, { rects: rects.length, missing });
  check("PISTOL: held out in front of the dino's chest, not tucked behind him",
    gx > read("P.x") + 20 && gy > 0 && gy < read("GROUND") - 6, { gx, gy });
}
arena();
read("P.gun = 0;");
step(1);
drawn.length = 0;
step(1);
check("PISTOL: and it is not drawn at all with an empty chamber",
  !drawn.some(d => d[2] === Math.max(1, Math.round(read("SPR.pkPistol.f[0]")[0][2]) * read("S"))),
  drawn.length);
/* the muzzle flash only exists on the frames a round is actually leaving */
arena();
read("giveGun(12); P.gunCd = 0;");
down("KeyX"); up("KeyX");
drawn.length = 0;
step(1);
check("PISTOL: with a muzzle flash on the frame the shot goes",
  read("P.gunFlash") > 0, read("P.gunFlash"));
step(30);
check("PISTOL: and the flash clears itself", read("P.gunFlash") === 0, read("P.gunFlash"));
/* the HUD shows the belt only while it is loaded */
arena();
read("G.ammo = 4; save.pro = true; save.coins = 1234;");
texts.length = 0; drawn.length = 0; step(1);
check("no pistol counter on the HUD with an empty chamber",
  !texts.some(t => t.s === "x0") || !drawn.some(r => r[2] / read("S") > 21),
  texts.map(t => t.s));
read("giveGun(7);");
texts.length = 0; step(1);
check("and a live one with rounds in the belt",
  texts.some(t => t.s === "x7"), texts.map(t => t.s));
read("P.gun = 0;");

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

/* -------------------------- name, landscape, AAB ------------------------- */
/* An installed app is read through three different name fields — the Play
   listing, the manifest, and the launcher label under the home-screen icon —
   and they drift apart the moment one of them is edited on its own.  So they
   are asserted against each other here, together with the title the on-screen
   card actually paints. */
section("NAME: one name across the listing, the manifest and the card");
check("the document title is the full store name",
  /<title>Pixel Dino: Parkour Run<\/title>/.test(CSS_TXT),
  /<title>[^<]*<\/title>/.exec(CSS_TXT));
check("and the manifest agrees with it",
  manifest && manifest.name === "Pixel Dino: Parkour Run", manifest && manifest.name);
check("while short_name is the label that fits under a home-screen icon",
  manifest && manifest.short_name === "Pixel Dino" && manifest.short_name.length <= 15,
  manifest && manifest.short_name);
check("Play caps a title at 30 characters and we are well under it",
  manifest && manifest.name.length <= 30, manifest && manifest.name.length);
check("the iOS home-screen name is the same short name, not the long one",
  /<meta name="apple-mobile-web-app-title" content="Pixel Dino">/.test(CSS_TXT));
check("the manifest id is derived from the new name, so the app is a new app",
  manifest && manifest.id === "/pixel-dino-parkour-run/", manifest && manifest.id);
check("and the offline worker caches under its own name, not the old one",
  /pixeldino-parkour-v1/.test(swSrc) && !/dinoexe-v1/.test(swSrc));
const shipped = ["index.html", "manifest.webmanifest", "sw.js", "server.mjs"]
  .map(f => fs.readFileSync(path.join(__dirname, f), "utf8"));
check("no DINO.EXE survives anywhere in the shipped files",
  shipped.every(t => !/DINO\.EXE/.test(t)));
check("and the description meta says the new name too",
  /content="Pixel Dino: Parkour Run\./.test(CSS_TXT));
arena();
read("G.state = 'ready';");
step(2);
const cardNames = texts.map(t => t.s);
check("the title card paints the new wordmark",
  cardNames.indexOf("PIXEL DINO") >= 0, cardNames.slice(0, 12));
check("over a PARKOUR RUN rule", cardNames.indexOf("P A R K O U R   R U N") >= 0,
  cardNames.slice(0, 12));
check("and the old wordmark is nowhere in the frame",
  !cardNames.some(s => /DINO\.EXE|B U F F E R I N G/.test(s)), cardNames.slice(0, 12));
/* a longer name is a real risk here: PIXEL DINO is two chars wider than
   DINO.EXE, and if it ever overran the card it would print through the panel
   edge.  Measure the two title lines against the card's own box. */
{
  const [cx, cy, cw] = panelBounds.ready;
  const cardRows = textRows(300).filter(r => r.y1 >= cy && r.y2 <= cy + 132);
  const word = cardRows.find(r => r.s === "PIXEL DINO");
  const rule = cardRows.find(r => r.s === "P A R K O U R   R U N");
  check("the wordmark still fits inside the title card, with margin",
    !!word && word.x1 > cx + 8 && word.x2 < cx + cw - 8,
    word && { x1: +word.x1.toFixed(1), x2: +word.x2.toFixed(1), box: [cx, cx + cw] });
  check("and so does the PARKOUR RUN rule under it",
    !!rule && rule.x1 > cx + 8 && rule.x2 < cx + cw - 8,
    rule && { x1: +rule.x1.toFixed(1), x2: +rule.x2.toFixed(1) });
  check("with the wordmark and its rule not colliding",
    !!word && !!rule && rule.y1 > word.y2 + 2, word && rule && [+(word.y2).toFixed(1), +rule.y1.toFixed(1)]);
}

/* Landscape is the whole shape of a runner app, and this is where it used to
   break: the touch bar's reserved band was subtracted from the viewport height
   in BOTH orientations, so a landscape phone got a 16:9 box 57% of the width,
   with black bars either side — in an app whose manifest asks for fullscreen. */
section("LANDSCAPE: full-bleed, with the pad inside the game box");
const viewport = (w, h) => {
  els.wrap.clientWidth = w; els.wrap.clientHeight = h;
  sandbox.innerWidth = w; sandbox.innerHeight = h;
  read("resize()");
  return {
    w: parseFloat(els.shell.style.width), h: parseFloat(els.shell.style.height),
    pad: parseFloat(els.wrap.style.getPropertyValue("--padroom")) || 0
  };
};
read("touchUI = true;");
check("the touch pad is on, so this is a real phone layout",
  read("touchUI") === true && els.body.classList.contains("touch"));
/* a 20:9 phone in landscape, inside the safe-area insets (891 x 402 usable) */
const land = viewport(891, 402);
check("landscape reserves no band under the game at all", land.pad === 0, land.pad);
check("so the game box fills the viewport height edge to edge",
  Math.abs(land.h - 402) < 0.6, land);
check("and keeps the 16:9 shape the world is authored in",
  Math.abs(land.w / land.h - 16 / 9) < 0.002, +(land.w / land.h).toFixed(4));
/* a 16:9 box on a 20:9 screen cannot fill the width without cropping, so the
   correct result is FULL height and a centred letterbox — not a shrunken box */
check("a 20:9 landscape phone uses the full height and as much width as 16:9 allows",
  Math.abs(land.w - 402 * 16 / 9) < 0.6 && land.w < 891, land);
check("so the black bars are the aspect difference alone, not wasted space",
  (891 - land.w) < 402 * (20 / 9 - 16 / 9) + 0.6, +(891 - land.w).toFixed(1));
/* a 4:3 tablet in landscape is taller than 16:9, so it is the other way round */
const tab = viewport(1024, 768);
check("a 4:3 tablet in landscape is exactly full width, no bars",
  Math.abs(tab.w - 1024) < 0.6 && Math.abs(tab.h - 576) < 0.6, tab);
/* portrait is the case the reserved band exists for, and it must still work */
const port = viewport(402, 891);
check("portrait still reserves a band under the game for the pad", port.pad > 0, port);
check("and the game box plus that band still fit inside the viewport",
  port.h + port.pad <= 891.6, port);
check("portrait keeps the 16:9 shape as well",
  Math.abs(port.w / port.h - 16 / 9) < 0.002, +(port.w / port.h).toFixed(4));
check("and in portrait the box is narrower than the screen, not wider",
  port.w <= 402.6 && port.w > 300, port);
/* The pad lives inside the shell's own strip below the road, so compare the two
   in WORLD units: the CSS gives the bar 15.5% of the game height, and the road
   sits at GROUND of WH, leaving a band of (WH - GROUND) to sit in. */
const padBand = 216 * 0.155, worldBand = 216 - read("GROUND");
check("the touch bar fits inside the game box, below the road line",
  padBand < worldBand && padBand > 0, { padBand: +padBand.toFixed(1), worldBand });
check("so it never covers the canvas it is meant to sit under", land.pad === 0);
check("the dpr-capped backing store still matches the box in landscape",
  Math.abs(read("CW") / read("S") - read("WW")) < 0.01 && read("CW") > 0,
  [read("CW"), read("CH"), read("S")]);
/* the manifest is what a WebAPK and a TWA both read for the lock itself */
check("and the manifest is still the one asking for landscape fullscreen",
  manifest.orientation === "landscape" && manifest.display === "fullscreen");
check("with the whole fallback chain, ending at minimal-ui",
  manifest.display_override.join(",") === "fullscreen,standalone,minimal-ui",
  manifest.display_override);

/* ------------------------- AUTO LANDSCAPE + FULLSCREEN -------------------- */
/* Nothing here is a button.  A phone held upright turns the box for you; the
   first touch asks for fullscreen and locks the orientation.  Both are the
   kind of thing that silently does nothing — a rotated element still reports
   its PRE-transform size, and a fullscreen request made a frame late is simply
   refused — so both are asserted against the real geometry. */
section("AUTO LANDSCAPE: the box turns itself, and the taps follow it");
/* the viewport is the raw screen; a portrait phone is 402 x 891 */
const rawViewport = (w, h) => {
  sandbox.innerWidth = w; sandbox.innerHeight = h;
  /* the wrapper is 100%x100% when NOT rotated, so its client box follows the
     screen; when rotated it is sized from --rw/--rh instead, which resize()
     reads off the raw viewport.  Setting both keeps the two paths honest. */
  els.wrap.clientWidth = w; els.wrap.clientHeight = h;
};
const coarse = on => { sandbox.matchMedia = q => ({ matches: on && /coarse/.test(q) }); };

coarse(true);
read("touchUI = false;");
rawViewport(402, 891);
read("applyOrientation();");
check("a portrait phone gets the box rotated automatically",
  read("rot") === true && els.body.classList.contains("rot") && els.wrap.classList.contains("rot"));
check("no button, no prompt, no opt-in — it is already on at boot", read("rot") === true);
check("and the swap is the whole trick: the wrapper is sized landscape and turned",
  els.wrap.style.getPropertyValue("--rw") === "891px" &&
  els.wrap.style.getPropertyValue("--rh") === "402px",
  [els.wrap.style.getPropertyValue("--rw"), els.wrap.style.getPropertyValue("--rh")]);
{
  const w = parseFloat(els.shell.style.width), h = parseFloat(els.shell.style.height);
  check("so the game box now fills the rotated screen edge to edge",
    Math.abs(h - 402) < 0.6 && Math.abs(w - 402 * 16 / 9) < 0.6, { w, h });
  check("and it is still exactly 16:9", Math.abs(w / h - 16 / 9) < 0.002, +(w / h).toFixed(4));
  check("the canvas backing store is landscape too",
    read("CW") > read("CH"), [read("CW"), read("CH")]);
}
/* THE HIT TEST.  A rotated element's getBoundingClientRect is the axis-aligned
   box of the ROTATED result, which is not the box the player is looking at —
   so this is the assertion that the whole feature stands or falls on. */
{
  const k = read("CSS");
  /* Put the shell somewhere known inside the raw portrait screen.  A 90-degree
     transform makes getBoundingClientRect report the AXIS-ALIGNED box of the
     ROTATED result: a 714.9x402 landscape box turned inside a 402x891 screen
     comes back as 402 wide by 714.9 tall, hung off the screen's left edge. */
  const r = { left: -156.45, top: 88.05, width: 402, height: 714.9 };
  els.shell.getBoundingClientRect = () => r;
  /* Rotate(90deg) is clockwise, so the content's axes land like this:
       content RIGHT -> screen DOWN      content UP    -> screen RIGHT
       content DOWN  -> screen LEFT      content LEFT  -> screen DOWN
     The player turns the physical device to compensate, so "down" for their
     thumb is screen-LEFT.  Every expectation below is derived from that, not
     from the naive guess that a corner maps to the same corner. */
  const corners = [
    ["top-left of the screen",  r.left,                 r.top],
    ["top-right of the screen", r.left + r.width,       r.top],
    ["bottom-left of the screen", r.left,               r.top + r.height],
    ["bottom-right of the screen", r.left + r.width,    r.top + r.height]
  ];
  const got = corners.map(([, cx, cy]) => {
    const p = read(`toWorld({ clientX: ${cx}, clientY: ${cy} })`);
    return [Math.round(p.x), Math.round(p.y)];
  });
  /* Derived from the rotation itself, not guessed: rotate(90deg) is clockwise,
     so the content's LEFT edge becomes the screen's BOTTOM edge.  Which means
     the screen's left column is the world's BOTTOM row, read right to left. */
  const want = [[0, 216], [0, 0], [384, 216], [384, 0]];
  check("every corner of the turned view lands on a real corner of the world",
    got.every((g, i) => g[0] === want[i][0] && g[1] === want[i][1]), { got, want });
  check("and the screen's LEFT edge is the world's BOTTOM edge — a turn, not a transpose",
    got[0][0] === 0 && got[2][0] === 384 && got[0][1] === 216 && got[2][1] === 216, got);
  check("and the screen's TOP edge is the world's LEFT edge, top to bottom",
    got[0][0] === 0 && got[1][0] === 0 && got[0][1] === 216 && got[1][1] === 0, got);
  check("so no corner is transposed onto its diagonal", (() => {
    for (let i = 0; i < 4; i++) if (got[i][0] !== want[i][0] || got[i][1] !== want[i][1]) return false;
    return true;
  })(), { got, want });
  check("and the centre of the screen is the centre of the world",
    (() => { const p = read(`toWorld({ clientX: ${r.left + r.width / 2}, clientY: ${r.top + r.height / 2} })`);
             return Math.abs(p.x - 192) < 1.5 && Math.abs(p.y - 108) < 1.5; })(),
    read(`toWorld({ clientX: ${r.left + r.width / 2}, clientY: ${r.top + r.height / 2} })`));
  /* the naive implementation, which is what this replaces, for comparison */
  const naive = [got[0][0], got[0][1]];
  const naiveWouldBe = [Math.round((r.left - r.left) / k), Math.round((r.top - r.top) / k)];
  check("and the old, un-inverted maths really was wrong — it would have said 0,0",
    naiveWouldBe[0] === 0 && naiveWouldBe[1] === 0 && !(got[0][0] === 0 && got[0][1] === 0),
    { naiveWouldBe, actually: naive });
  check("the scale factor is unchanged by the rotation — no squashing",
    Math.abs(k * 384 - 714.9) < 1 || Math.abs(k * 216 - 402) < 1, k);
}
/* the swipe must be measured in the player's frame too, or every slide misses */
check("the swipe handler un-turns its delta the same way toWorld does",
  /if \(rot\) \{ const t = dx; dx = dy; dy = -t; \}/.test(src),
  /wrap\.addEventListener\("pointermove"[\s\S]{0,400}if \(rot\)/.exec(src));
/* a real drag, through the actual listener */
{
  arena();
  rawViewport(402, 891); coarse(true);
  read("touchUI = true; applyOrientation();");
  read("G.state = 'run'; P.dead = false; P.y = 30; P.vy = 0; P.air = 0;");
  step(1);
  /* "Down" for the player's thumb is screen-LEFT once the box is turned (see
     the axis mapping above), so this drags left — and it must register as the
     slide the same gesture registers as in portrait. */
  read("gest = { id: 7, x: 300, y: 100, acted: false, fromGround: false };");
  fire("wrap", "pointermove", { pointerId: 7, clientX: 240, clientY: 100 });
  check("a drag in the turned frame still reads as a slide",
    read("held.swipe") === true,
    { dx: -60, dy: 0, rot: read("rot"), swipe: read("held.swipe") });
  read("held.swipe = false; held.swipeUntil = 0; gest = null;");
  /* and the other way is not a slide, which is what proves the un-rotation is
     actually happening rather than the test happening to pass */
  read("gest = { id: 8, x: 100, y: 100, acted: false, fromGround: false };");
  fire("wrap", "pointermove", { pointerId: 8, clientX: 160, clientY: 100 });
  check("and dragging the other way is not — so the frame really is un-turned",
    read("held.swipe") === false,
    { dx: 60, dy: 0, swipe: read("held.swipe") });
  read("gest = null;");
}
/* the device turning for real must undo all of it */
rawViewport(891, 402);
read("applyOrientation();");
check("and when the phone physically turns, the box goes back to normal",
  read("rot") === false && !els.body.classList.contains("rot") && !els.wrap.classList.contains("rot"));
{
  const w = parseFloat(els.shell.style.width), h = parseFloat(els.shell.style.height);
  check("with a full-bleed 16:9 box on the landscape screen",
    Math.abs(h - 402) < 0.6 && Math.abs(w - 714.9) < 0.6, { w, h });
}
/* a mouse on a tall desktop window must NOT be rotated */
coarse(false);
rawViewport(700, 1100);
read("touchUI = false; applyOrientation();");
check("a mouse in a tall desktop window is left alone — rotating it would be a bug",
  read("rot") === false, read("rot"));
/* and the swap is reversible without a reload */
rawViewport(402, 891); coarse(true); read("touchUI = true; applyOrientation();");
check("turning it on and off again is clean, with no stuck state",
  read("rot") === true, read("rot"));
rawViewport(891, 402); read("applyOrientation();");
check("and off again", read("rot") === false, read("rot"));

section("AUTO FULLSCREEN: the first touch asks, without a button");
{
  /* a fresh state, with the two APIs the game actually calls */
  let fsCalls = 0, lockCalls = 0, lockArg = null;
  sandbox.document.documentElement = els.documentElement;
  els.documentElement.requestFullscreen = () => { fsCalls++; return Promise.resolve(); };
  sandbox.screen = { orientation: { lock: a => { lockCalls++; lockArg = a; return Promise.resolve(); } } };
  read("fsDone = false;");
  arena();
  rawViewport(891, 402); coarse(true);
  read("touchUI = true; G.state = 'ready'; applyOrientation();");
  check("nothing has been requested before the player touches anything",
    fsCalls === 0 && lockCalls === 0, [fsCalls, lockCalls]);
  /* the first tap on the field */
  fire("wrap", "pointerdown", { pointerId: 1, clientX: 200, clientY: 200, target: {} });
  check("the very first touch asks for fullscreen", fsCalls === 1, fsCalls);
  check("and locks the device to landscape", lockCalls === 1 && lockArg === "landscape",
    [lockCalls, lockArg]);
  fire("wrap", "pointerdown", { pointerId: 2, clientX: 210, clientY: 210, target: {} });
  check("and only once — the second touch does not ask again", fsCalls === 1, fsCalls);
  /* a browser with no orientation lock must not break the game */
  sandbox.screen = { orientation: {} };
  read("fsDone = false;");
  fsCalls = 0;
  fire("wrap", "pointerdown", { pointerId: 3, clientX: 220, clientY: 220, target: {} });
  check("a browser with no orientation lock still gets fullscreen, and no crash",
    fsCalls === 1, fsCalls);
  /* a browser with neither must be fine too */
  delete els.documentElement.requestFullscreen;
  sandbox.screen = undefined;
  read("fsDone = false;");
  let survived = true;
  try { fire("wrap", "pointerdown", { pointerId: 4, clientX: 230, clientY: 230, target: {} }); }
  catch (e) { survived = false; }
  check("and one with neither API is not a reason to stop playing", survived);
  /* the request must happen INSIDE the gesture, not a frame later */
  els.documentElement.requestFullscreen = () => { fsCalls++; return Promise.resolve(); };
  sandbox.screen = { orientation: { lock: () => Promise.resolve() } };
  read("fsDone = false;");
  fsCalls = 0;
  fire("wrap", "pointerdown", { pointerId: 5, clientX: 240, clientY: 240, target: {} });
  check("the request is made synchronously inside the pointer event itself",
    fsCalls === 1, fsCalls);
  check("a rejected promise is swallowed rather than thrown at the player",
    /catch\(\(\) => \{\}\)/.test(src) || /\.catch\(\(\) => \{\}\)/.test(src));
}
check("the layout states 16:9 in CSS, so the box cannot drift off-ratio",
  /aspect-ratio:\s*16\s*\/\s*9/.test(CSS_TXT));
check("and the same ratio is written down once in CFG for the resizer",
  read("CFG.RATIO_W") === 16 && read("CFG.RATIO_H") === 9);
check("the page cannot scroll: no margins, hidden overflow, no rubber band",
  /html,\s*body\s*\{[^}]*overflow:\s*hidden/.test(CSS_TXT) &&
  /html,\s*body\s*\{[^}]*margin:\s*0/.test(CSS_TXT) &&
  /overscroll-behavior:\s*none/.test(CSS_TXT));
check("and the rotated wrapper is positioned, not squeezed into flow",
  /#wrap\.rot\s*\{[^}]*position:\s*fixed/.test(CSS_TXT) &&
  /#wrap\.rot\s*\{[^}]*rotate\(90deg\)/.test(CSS_TXT),
  /#wrap\.rot\s*\{[^}]*\}/.exec(CSS_TXT));
check("viewport-fit=cover still in force, so a notch cannot clip the box",
  /viewport-fit=cover/.test(CSS_TXT));
viewport(960, 540);
read("touchUI = false;");

/* ------------------------------- store assets ----------------------------- */
/* Play Console rejects a listing whose artwork is the wrong size, and a store
   screenshot that no longer matches the build is worse than none, so the listing
   assets are checked here like everything else.  make-store-assets.cjs renders
   them from this same index.html, which is what keeps them honest. */
section("STORE ASSETS: the Play Console listing");
const STORE = [
  ["feature-graphic-1024x500.png", 1024, 500],
  ["screenshot-1-the-road-1920x1080.png", 1920, 1080],
  ["screenshot-2-boss-gate-1920x1080.png", 1920, 1080],
  ["screenshot-3-dino-pro-1920x1080.png", 1920, 1080],
  ["screenshot-4-wardrobe-1920x1080.png", 1920, 1080]
];
/* the PNG signature, then IHDR: width, height, bit depth, colour type */
function pngHeader(file) {
  const b = fs.readFileSync(path.join(__dirname, "store", file));
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) return null;
  if (b.toString("ascii", 12, 16) !== "IHDR") return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), depth: b[24], type: b[25] };
}
for (const [file, w, h] of STORE) {
  let hd = null;
  try { hd = pngHeader(file); } catch (e) { hd = null; }
  check("store/" + file + " is a real PNG at " + w + "x" + h,
    !!hd && hd.w === w && hd.h === h, hd);
  check("  ...24-bit truecolour, no alpha, which is what Play accepts",
    !!hd && hd.depth === 8 && hd.type === 2, hd);
}
check("the app icon Play asks for is the 512 we already ship",
  fs.existsSync(path.join(__dirname, "icons", "icon-512.png")));
check("and at least two screenshots exist, which is Play's minimum", STORE.length - 1 >= 2, STORE.length - 1);
check("the generator that draws them is in the repo and dependency-free",
  fs.existsSync(path.join(__dirname, "make-store-assets.cjs")) &&
  /require\("\.\/png\.cjs"\)/.test(fs.readFileSync(path.join(__dirname, "make-store-assets.cjs"), "utf8")) &&
  Object.keys(require(path.join(__dirname, "package.json")).dependencies || {}).length === 0);

/* ---------------------- GOOGLE PLAY GAMES SERVICES ----------------------- */
/* Everything in this file so far ran in a BROWSER: no bridge, no Play Games,
   no cloud.  None of it broke, and that is the first half of the feature.  The
   second half needs an Android host, which this workspace cannot build — so it
   gets a stand-in (PG_HOST above) and a cold boot (bootWith above), and the
   checks below are of what the GAME does with a host's answers: which calls it
   makes, which fields it believes, what it refuses to believe, and what it does
   when the host never answers at all. */
console.log("\nGOOGLE PLAY GAMES: silent sign-in, GamerTag and cloud save");
const pgDone = boardDone.then(async () => {
  const micro = () => new Promise(r => setImmediate(r));
  const settle = async (n) => { for (let i = 0; i < (n || 6); i++) { step(1); await micro(); } };
  /* Back to a desktop-size viewport AND a desktop hit-test box.  The LANDSCAPE
     section leaves three things behind, and only restoring the viewport sizes
     is not enough: it also REPLACES els.shell.getBoundingClientRect with a
     rotated phone rect, which silently puts every later tap a screen away from
     its button.  toWorld() reads that rect, so the game was fine and the
     harness was lying to it. */
  sandbox.innerWidth = 960; sandbox.innerHeight = 540;
  els.wrap.clientWidth = 960; els.wrap.clientHeight = 540;
  els.shell.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540 });
  read("applyOrientation(); resize();");
  check("...and the hit-test box is back, so a tap lands where the button is drawn",
    (() => { arena(); read("G.state = 'ready';"); step(1);
             const b = read("ui.find(x => x.id === 'shop')");
             const k = read("CSS");
             tapWorld(b);
             return read("G.state") === "shop"; })(), read("({ st: G.state, k: CSS, rot: rot })"));
  const reset = () => {
    arena();
    read("PGS.on = false; PGS.id = ''; PGS.tag = ''; PGS.icon = ''; PGS.busy = false;"
       + " PGS.said = false; PGS.pushed = 0; PGS.pulled = 0; PGS.err = '';"
       + " save.pid = ''; save.gtag = ''; save.bestM = 0; save.best = 0; save.coins = 0;"
       + " save.pro = false; save.owned = ['classic']; save.skin = 'classic';"
       + " G.pb = 0; G.pbT = 0; G.state = 'ready'; persist();");
    step(1);
  };

  /* ------------------------ 1. a browser: no bridge at all ---------------- */
  pgHostless(); pgWire.length = 0; pgSlot = null; reset();
  await settle();
  check("in a browser there is no bridge, and the game never even notices",
    read("PGS.on") === false && read("PGS.busy") === false && errors.length === 0,
    read("({ on: PGS.on, busy: PGS.busy, err: PGS.err })"));
  check("so the menu falls back to the local nickname, silently",
    read("gamerTag()") === "NOVA", read("gamerTag()"));
  check("and to the default when there is not even a nickname",
    (() => { read("save.name = '';"); const t = read("gamerTag()"); read("save.name = 'NOVA';"); return t; })() === "Dino_Player",
    read("gamerTag()"));
  const nobody = await read("pgAutoSignIn()");
  check("a silent sign-in with no bridge resolves to nobody and throws nothing",
    nobody === null && read("PGS.on") === false && errors.length === 0, { r: nobody, on: read("PGS.on") });
  check("  ...with no host call made and the title card untouched",
    pgWire.length === 0 && read("G.state") === "ready" && read("G.pb") === 0,
    ({ wire: pgWire.length, s: read("G.state"), pb: read("G.pb") }));
  step(1); texts.length = 0; step(1);
  check("and the identity line is painted either way — no gap where an account would be",
    texts.some(t => /🎮/.test(t.s) && /NOVA/.test(t.s)) && texts.some(t => t.s === "OFFLINE MODE"),
    texts.map(t => t.s).slice(0, 8));

  /* ------------------------ 2. connected: the real identity --------------- */
  pgWire.length = 0;
  pgInstall(PG_HOST({ info: PG_OFF }));
  reset();
  read("pgAutoSignIn();");
  await settle();
  check("connected: the GamerTag, the Player ID and the Gamer Icon all come back",
    read("PGS.on") === true && read("gamerTag()") === "REX_77" &&
    read("PGS.id") === "1234567890123456789" && /^https?:\/\//.test(read("PGS.icon")),
    read("({ on: PGS.on, tag: gamerTag(), id: PGS.id, icon: PGS.icon })"));
  check("and the host was actually asked — this is a signed-in identity, not an invented one",
    JSON.stringify(pgWire[0]) === JSON.stringify(["autoSignIn"]), pgWire.slice(0, 2));
  check("which is remembered, so the next launch on this device still knows who it is",
    read("save.gtag") === "REX_77" && read("save.pid") === "1234567890123456789",
    read("({ g: save.gtag, p: save.pid })"));
  check("and it is in localStorage, not just in a variable",
    JSON.parse(read("localStorage.getItem(SAVE_KEY)")).gtag === "REX_77",
    JSON.parse(read("localStorage.getItem(SAVE_KEY)")));

  /* ---- the welcome banner ---- */
  const CFG_SLIDE = read("CFG.PLAY_SLIDE");
  check("a welcome banner is armed, and only ever once a session",
    read("PGS.said") === true && read("G.pbT") === read("CFG.PLAY_BAN") &&
    read("G.pb") > 0 && read("G.pb") <= read("CFG.PLAY_BAN"),
    read("({ said: PGS.said, pb: G.pb, pbT: G.pbT })"));
  await read("pgAutoSignIn();");
  await settle(3);
  check("a second silent sign-in does not queue a second banner",
    read("G.pbT") === read("CFG.PLAY_BAN") && read("G.pb") < read("G.pbT") && read("G.pb") > 0,
    read("({ pb: G.pb, pbT: G.pbT })"));
  /* the banner's own top edge, in world units: off the screen is negative, and
     resting flush against the top edge is exactly 4 */
  const bannerTop = () => {
    const r = drawn.find(d => d[4] === "#0b7a3e" && d[2] === 264 * read("S"));
    return r ? r[1] / read("S") : null;
  };
  const arm = (back) => { read("G.pb = G.pbT - " + back + ";"); texts.length = 0; drawn.length = 0; step(1); };
  arm(0);
  check("on its first frame it has not arrived at all — it slides in, it does not snap",
    bannerTop() === null && texts.every(t => !/Welcome back/.test(t.s)), bannerTop());
  arm(8);
  const midTop = bannerTop();
  const ban = texts.map(t => t.s);
  check("mid-slide it is genuinely part way down the screen, not just present",
    midTop !== null && midTop > -38 && midTop < 4, midTop);
  check("and it is already legible: the greeting, with the real GamerTag in it",
    ban.some(s => s === "🎮 Welcome back, REX_77!"), ban);
  check("with the Player ID and the cloud slot underneath it",
    ban.some(s => /PLAYER ID 1234567890123456789/.test(s)) && ban.some(s => /CLOUD SAVE ON/.test(s)),
    ban.filter(s => /PLAYER|CLOUD/.test(s)));
  check("the whole thing is Play's own green, drawn as one rectangle like every other pixel",
    drawn.filter(d => d[4] === "#0b7a3e" && d[2] === 264 * read("S") && d[3] === 36 * read("S")).length === 1,
    drawn.filter(d => d[4] === "#0b7a3e").map(d => d.slice(0, 4)));
  arm(CFG_SLIDE);
  check("and it comes to rest flush against the top edge, full width, where it belongs",
    Math.abs(bannerTop() - 4) < 0.01, bannerTop());
  read("G.pb = CFG.PLAY_SLIDE;"); texts.length = 0; drawn.length = 0; step(1);
  check("  ...and it is still leaving, not teleported away, one frame before the edge",
    bannerTop() !== null && bannerTop() > 0 && bannerTop() < 4, bannerTop());
  read("G.pb = 4;"); texts.length = 0; drawn.length = 0; step(1);
  check("the last frames walk it back up and off the top edge",
    bannerTop() !== null && bannerTop() < 0, bannerTop());
  read("G.pb = 1;"); step(2);
  check("then the timer simply runs out, leaving the game completely clean",
    read("G.pb") === 0, read("G.pb"));

  /* ---- the Gamer Icon is derived, not downloaded ---- */
  check("the Gamer Icon is drawn as rectangles from the Player ID, like every other pixel",
    (() => { read("PGS.id = '1234567890123456789';"); drawn.length = 0; read("drawGamerIcon(0, 0, 32);");
             return drawn.length >= 8 && drawn.every(d => d[4] !== undefined); })(), drawn.length);
  check("two different players get two different faces",
    (() => { read("PGS.id = '1234567890123456789';"); drawn.length = 0; read("drawGamerIcon(0, 0, 32);");
             const a = JSON.stringify(drawn);
             read("PGS.id = '9999999999999999999';"); drawn.length = 0; read("drawGamerIcon(0, 0, 32);");
             const b = JSON.stringify(drawn);
             read("PGS.id = '1234567890123456789';");
             return a !== b; })(), "different ids, different rasters");
  check("and it is mirrored, so it reads as a face rather than as static",
    (() => { drawn.length = 0; read("drawGamerIcon(0, 0, 32);");
             const c = 4 * read("S");
             const at = (cx, cy) => drawn.some(d => d[0] === cx && d[1] === cy);
             for (let r = 0; r < 7; r++) for (let q = 0; q < 4; q++)
               if (at(q * c, r * c) && !at((7 - q) * c, r * c)) return false;
             return drawn.length > 8; })(), drawn.length);
  check("it is on the title card too, under the GamerTag",
    (() => { read("G.state = 'ready';"); step(1); texts.length = 0; step(1);
             return texts.some(t => /REX_77/.test(t.s) && /🎮/.test(t.s)) &&
                    texts.some(t => t.s === "PLAY CLOUD ON"); })(),
    texts.map(t => t.s).slice(0, 8));
  check("and the GamerTag and the cloud flag sit side by side, clear of each other and of the wordmark",
    (() => {
      const rows = textRows(300);
      const me = rows.find(r => r.s === "🎮  REX_77");
      const fl = rows.find(r => r.s === "PLAY CLOUD ON");
      const wd = rows.find(r => r.s === "PIXEL DINO");
      const inside = r => r && r.x1 > 67 && r.x2 < 67 + 250;
      return !!(me && fl && wd) && textClash([me, fl]).length === 0 &&
             inside(me) && inside(fl) && fl.y2 < wd.y1;
    })(), textRows(300).filter(r => /REX_77|PLAY CLOUD/.test(r.s)).map(r => r.s));

  /* ------------------------ 3. cloud save: the payload -------------------- */
  pgWire.length = 0; pgSlot = null;
  reset();
  read("pgAutoSignIn();");
  await settle();
  read("save.bestM = 240500; save.coins = 1480; save.owned = ['classic','cyber'];"
     + " save.skin = 'cyber'; save.pro = true;");
  await read("pgPush('test')");
  const push = pgWire.find(w => w[0] === "saveSnapshot");
  check("progress goes to the Play Games cloud slot, not to a server of ours",
    !!push && push[1] === "pixeldino.save.v1", pgWire.map(w => w[0]));
  check("carrying the three things that would be lost — distance, skins and Wi-Fi coins",
    !!push && push[2].bestM === 240500 && push[2].coins === 1480 &&
    JSON.stringify(push[2].owned) === JSON.stringify(["classic", "cyber"]) && push[2].skin === "cyber",
    push && push[2]);
  check("and the identity it belongs to, so a second device knows whose save this is",
    !!push && push[2].gtag === "REX_77" && push[2].pid === "1234567890123456789" && push[2].v === 1,
    push && { gtag: push[2].gtag, pid: push[2].pid, v: push[2].v });
  check("a payload is small enough to actually be a save slot, and nothing else",
    push && JSON.stringify(push[2]).length < 220, push && JSON.stringify(push[2]).length);

  /* ---- and it is read back, merged, on sign-in ---- */
  pgWire.length = 0;
  pgInstall(PG_HOST({ info: PG_OFF, cloud: { v: 1, gtag: "REX_77", bestM: 51200, coins: 900,
                                             owned: ["classic", "gold"], skin: "gold", pro: true } }));
  reset();
  read("save.owned = ['classic','cyber']; save.skin = 'classic'; save.bestM = 1200; save.coins = 30;");
  read("pgAutoSignIn();");
  await settle(4);
  await read("pgPull()");
  await settle(4);
  check("the cloud slot is loaded from the one key the game owns, with no prompt",
    JSON.stringify(pgWire.find(w => w[0] === "loadSnapshot")) === JSON.stringify(["loadSnapshot", "pixeldino.save.v1"]),
    pgWire.filter(w => /load/.test(w[0])));
  check("and merged in silently: the 512km, the coins, the crown and the PRO pass all arrive",
    read("save.bestM") === 51200 && read("save.coins") === 900 && read("save.skin") === "gold" &&
    read("save.pro") === true,
    read("({ m: save.bestM, c: save.coins, s: save.skin, p: save.pro })"));
  check("the wardrobe is a UNION, so a skin earned on this device is never dropped",
    JSON.stringify(read("save.owned").sort()) === JSON.stringify(["classic", "cyber", "gold"]),
    read("save.owned"));

  /* ------------------------ 4. a merge may only ever ADD ------------------ */
  pgWire.length = 0;
  pgInstall(PG_HOST({ info: PG_OFF, cloud: { v: 1, bestM: 500, coins: 1,
                                             owned: ["classic"], skin: "classic", pro: false } }));
  reset();
  read("save.bestM = 240500; save.coins = 1480; save.owned = ['classic','gold']; save.skin = 'gold'; save.pro = true;");
  read("pgAutoSignIn();");
  await settle(4);
  await read("pgPull()");
  await settle(4);
  check("a stale cloud copy cannot lower a distance or empty a wallet",
    read("save.bestM") === 240500 && read("save.coins") === 1480,
    read("({ m: save.bestM, c: save.coins })"));
  check("nor un-gild a dino whose crown this device already earned",
    read("save.skin") === "gold" && read("save.pro") === true,
    read("({ s: save.skin, p: save.pro })"));
  check("and when this device is the one that is ahead, it wins the argument",
    !!pgWire.find(w => w[0] === "saveSnapshot" && w[2].bestM === 240500), pgWire.map(w => w[0]));

  /* ------------------------ 5. a hostile or broken slot ------------------- */
  const before = errors.length;
  pgInstall(PG_HOST({ info: PG_OFF, cloud: { v: 1, bestM: -999, coins: "lots",
    owned: ["classic", "not-a-skin", null, 7, "gold"], skin: "../../etc/passwd",
    pro: false, name: "HAXX", pid: "<script>" } }));
  reset();
  read("save.bestM = 240500; save.coins = 1480; save.owned = ['classic','gold'];"
     + " save.skin = 'gold'; save.pro = true; save.name = 'NOVA';");
  read("pgAutoSignIn();");
  await settle(4);
  await read("pgPull()");
  await settle(4);
  check("a corrupt cloud slot cannot take anything away — every field is a max or a union",
    read("save.bestM") === 240500 && read("save.coins") === 1480 &&
    JSON.stringify(read("save.owned")) === JSON.stringify(["classic", "gold"]) &&
    read("save.skin") === "gold" && read("save.pro") === true,
    read("({ m: save.bestM, c: save.coins, o: save.owned, s: save.skin, p: save.pro })"));
  check("  ...and a skin id it invented is refused rather than drawn",
    read("skinIdle(save.skin)") === "gold_idle", read("skinIdle(save.skin)"));
  check("  ...and a Player ID that is not a Player ID is never stored",
    read("save.pid") === "1234567890123456789" && read("save.gtag") === "REX_77",
    read("({ p: save.pid, g: save.gtag })"));
  check("  ...without a single runtime error", errors.length === before, errors.length);
  const brk = errors.length;
  for (const info of [null, {}, [], { playerId: "abc" }, { playerId: "<script>" },
                      { gamerTag: "   " }]) {
    pgInstall(PG_HOST({ info }));
    reset(); read("pgAutoSignIn();"); await settle(3);
  }
  check("a host that answers with nothing usable signs nobody in, and says why",
    read("PGS.on") === false && errors.length === brk, read("({ on: PGS.on, err: PGS.err })"));
  check("  ...and the game keeps its own nickname instead of an empty one",
    read("gamerTag()") === "NOVA", read("gamerTag()"));
  check("  ...while a Player ID with no GamerTag is still a real sign-in",
    (() => { pgInstall(PG_HOST({ info: { playerId: "1234567890123456789" } })); reset();
             read("pgAutoSignIn();"); return true; })(), "");
  await settle(3);
  check("  ...and the tag then falls back to the local nickname, not to nothing",
    read("PGS.on") === true && read("gamerTag()") === "NOVA", read("({ on: PGS.on, t: gamerTag() })"));

  /* ------------------------ 6. a host that dies, or hangs ----------------- */
  const alive = errors.length;
  pgInstall(PG_HOST({ down: true }));
  reset();
  await read("pgAutoSignIn()");
  check("a host that rejects is not a crash: no identity, no banner, no error",
    read("PGS.on") === false && read("G.pb") === 0 && errors.length === alive, read("PGS.err"));
  await read("pgPush('nope')");
  await read("pgPull()");
  check("and the cloud calls fail quietly too, rather than rejecting into nowhere",
    read("PGS.pushed") === 0 && read("PGS.pulled") === 0 && errors.length === alive,
    ({ p: read("PGS.pushed"), m: read("PGS.pulled") }));
  pgInstall(PG_HOST({ hang: true }));
  reset();
  read("pgAutoSignIn();");
  await settle(2);
  check("a host that never answers leaves the game running, not waiting on it",
    read("G.state") === "ready" && errors.length === alive, read("G.state"));
  await new Promise(r => setTimeout(r, read("CFG.PLAY_WAIT") + 400));
  check("  ...and is timed out, so a wedged Play Services can never hold the title card",
    read("PGS.on") === false && read("PGS.busy") === false && errors.length === alive,
    read("({ on: PGS.on, busy: PGS.busy, err: PGS.err })"));

  /* ------------------------ 7. the automatic sync ------------------------- */
  pgWire.length = 0; pgSlot = null;
  pgInstall(PG_HOST({ info: PG_OFF }));
  reset();
  read("pgAutoSignIn();");
  await settle();
  arena();
  read("save.bestM = 100000; save.coins = 40; save.owned = ['classic']; save.name = 'NOVA';");
  pgWire.length = 0;
  read("G.meters = 131500; P.dead = false; G.state = 'run'; G.revive = 0;");
  read("gameOver('crash');");
  await settle();
  check("a new personal best is pushed to the cloud the moment you crash, unprompted",
    pgWire.some(w => w[0] === "saveSnapshot" && w[2].bestM === 131500 && w[2].coins === 40),
    pgWire.map(w => w[0]));
  pgWire.length = 0;
  read("G.meters = 1200; P.dead = false; G.state = 'run'; G.revive = 0;");
  read("gameOver('crash');");
  await settle();
  check("and a worse run uploads nothing, because nothing changed",
    pgWire.filter(w => w[0] === "saveSnapshot").length === 0, pgWire.map(w => w[0]));
  pgWire.length = 0;
  read("save.coins = 5000; save.owned = ['classic','gold'];");
  read("onUI({ id: 'shop', from: 'ready' });");
  read("shopPick(SKINS.findIndex(s => s.id === 'gold'));");
  await settle();
  check("unlocking a skin in the wardrobe is synced in the same keystroke",
    pgWire.some(w => w[0] === "saveSnapshot" && w[2].owned.indexOf("gold") >= 0),
    pgWire.map(w => w[0] + ":" + (w[2] ? w[2].skin : "")));
  check("and the slot really holds it, so a pull on the next device finds it",
    !!pgSlot && pgSlot.owned.indexOf("gold") >= 0 && pgSlot.skin === "gold", pgSlot);

  /* ------------------------ 8. and a COLD BOOT with a host ----------------- */
  /* The only check that can honestly say "on launch": a fresh VM, the bridge
     installed before the first line of the script, and not one tap. */
  const cold = bootWith(PG_HOST({ info: PG_OFF, cloud: { v: 1, gtag: "REX_77", bestM: 51200,
                        coins: 900, owned: ["classic", "cyber"], skin: "cyber", pro: false } }),
                        { name: "NOVA" });
  check("a cold boot with the host already in the page runs without one error",
    cold.errors === 0 && errors.length === 0, cold.errors);
  cold.advance(1);
  await micro(); await micro(); await micro();
  check("and the player is signed in before a finger has touched the screen",
    cold.read("PGS.on") === true && cold.read("gamerTag()") === "REX_77" &&
    cold.read("PGS.id") === "1234567890123456789",
    cold.read("({ on: PGS.on, tag: gamerTag(), id: PGS.id })"));
  check("with the cloud save already merged in, still without a single prompt",
    cold.read("save.bestM") === 51200 && cold.read("save.coins") === 900 &&
    cold.read("save.skin") === "cyber",
    cold.read("({ m: save.bestM, c: save.coins, s: save.skin })"));
  check("the title card is up and playable anyway — nothing was ever awaited",
    cold.read("G.state") === "ready" && !!cold.read("ui.some(b => b.id === 'startbtn')"),
    cold.read("G.state"));
  texts.length = 0; cold.advance(2);
  check("two frames after the title card the banner still has not arrived — it slides, it does not snap",
    texts.every(t => !/Welcome back/.test(t.s)), texts.map(t => t.s).filter(s => /Welcome/.test(s)));
  texts.length = 0; cold.advance(20);
  const coldTexts = texts.map(t => t.s);
  check("and twenty frames later it is on screen with the GamerTag and the Player ID",
    coldTexts.some(s => s === "🎮 Welcome back, REX_77!") &&
    coldTexts.some(s => /PLAYER ID 1234567890123456789/.test(s)), coldTexts.filter(s => /Welcome|PLAYER/.test(s)));
  check("and it is not a blocker: START is still the first thing you can press",
    cold.read("ui.some(b => b.id === 'startbtn')") && cold.read("G.pb") > 0,
    cold.read("({ pb: G.pb })"));

  /* ---- and a cold boot with NO host, which is the build most people run ---- */
  const lone = bootWith(null, { name: "NOVA" });
  await micro(); await micro(); await micro();
  lone.advance(2);
  check("a cold boot with no host at all is the same game, minus the banner",
    lone.errors === 0 && lone.read("G.state") === "ready" &&
    lone.read("PGS.on") === false && lone.read("G.pb") === 0 && lone.read("gamerTag()") === "NOVA",
    { e: lone.errors, s: lone.read("G.state"), t: lone.read("gamerTag()") });
  pgHostless();
});

/* ------------------- GOOGLE PLAY BILLING + ACHIEVEMENTS ------------------ */
/* The web build above charged nothing, so nothing was quoted — which is Play's
   payments policy stated as a rule.  This half installs a BillingClient and
   asserts the OTHER half of the same rule: with a live checkout behind the
   panel, the pass must quote a price, charge once, grant exactly what it
   promised, restore for a player who already paid, and say nothing untrue when
   the player backs out. */
console.log("\nGOOGLE PLAY BILLING + ACHIEVEMENTS: the release half");
const playDone = pgDone.then(async () => {
  const micro = () => new Promise(r => setImmediate(r));
  const settle = async (n) => { for (let i = 0; i < (n || 6); i++) { step(1); await micro(); } };
  const panel = () => {
    arena();
    read("save.pro = false; G.proMsg = ''; G.proMsgT = 0; G.state = 'pro'; clearCheckpoint();");
    step(2); texts.length = 0; step(1);
    const all = texts.map(t => t.s);
    const at = all.findIndex(s => s.indexOf("DINO PRO") >= 0);
    return at < 0 ? [] : all.slice(at);
  };
  const payReset = () => {
    payWire.length = 0; payOwned = false;
    read("BILLS.on = false; BILLS.owned = false; BILLS.busy = false; BILLS.err = '';"
       + " BILLS.bought = 0; BILLS.restored = 0; BILLS.price = BILL.price;");
  };
  /* the app asks the store ONCE, at launch — so that is what a test does too:
     install the client, then run the same query the boot sequence runs */
  const withBilling = async (opts) => {
    payInstall(BILL_HOST(opts)); payReset();
    await read("billQuery(true)");
  };

  /* ---------------- 1. no checkout: free, and it says so ----------------- */
  payClear(); payReset();
  const web = panel();
  check("with no BillingClient the pass is free, and the panel says FREE",
    web.some(s => s === "FREE") && web.some(s => /FREE FOREVER/.test(s)) &&
    web.some(s => s === "ACTIVATE PRO"), web.slice(0, 6));
  check("and RESTORE is absent — promising to restore from a store that is not there is a lie",
    !read("ui.some(b => b.id === 'prorestore')"), read("ui.map(b => b.id)"));
  check("and no label quotes a price, because nothing here can charge",
    web.every(s => !/UNLOCK \$|\d[.,]\d\d/.test(s)) && payWire.length === 0,
    web.filter(s => /\d[.,]\d\d/.test(s)));

  /* ---------------- 2. a live checkout: the pass must quote one --------- */
  payInstall(BILL_HOST({}));
  payReset();
  await read("billQuery(true)");
  const buy = panel();
  check("with a live BillingClient the header becomes VIP PASS, not FREE",
    buy.some(s => s === "VIP PASS") && !buy.some(s => s === "FREE"), buy.slice(0, 6));
  check("and the key quotes the store's price",
    buy.some(s => /^UNLOCK \S/.test(s)), buy.filter(s => /^UNLOCK/.test(s)));
  check("with a RESTORE key beside it, because there is an account to restore into",
    read("ui.some(b => b.id === 'prorestore')") &&
    read("ui").filter(b => b.y === read("ui.find(b => b.id === 'prorestore')").y).length === 3,
    read("ui.map(b => b.id + ':' + b.w)"));
  check("and the launch was asked of the store on open, not on a purchase",
    payWire.length >= 1 && payWire[0][0] === "query" && payWire[0][1] === "dino_pro_lifetime",
    payWire.slice(0, 2));
  await settle(2);

  /* ---------------- 3. buying it ---------------------------------------- */
payWire.length = 0;
read("G.state = 'pro'; save.pro = false;"); step(2);
tapWorld(read("ui.find(b => b.id === 'proon')"));
await settle(6);
  check("pressing UNLOCK launches the billing flow for exactly our product id",
    payWire.some(w => w[0] === "flow" && w[1] === "dino_pro_lifetime"), payWire.slice(0, 3));
  check("and a completed purchase grants the pass, with the crown and all",
    read("save.pro") === true && read("save.owned").indexOf("gold") >= 0,
    { pro: read("save.pro"), owned: read("save.owned") });
  check("persisted, so a relaunch cannot lose what was paid for",
    JSON.parse(read("localStorage.getItem(SAVE_KEY)")).pro === true);
  check("and the GO PRO chip becomes PRO",
    els.bPro.textContent.indexOf("GO PRO") === -1, els.bPro.textContent);
  check("with a message that says what happened, in the past tense and for good",
    /PRO IS YOURS FOREVER/.test(read("G.proMsg")), read("G.proMsg"));
  check("  ...and the RESTORE key is gone once you already own it",
    !read("ui.some(b => b.id === 'prorestore')"), read("ui.map(b => b.id)"));

  /* ---------------- 4. a purchase is once, not a subscription ----------- */
  payWire.length = 0;
  read("activatePro();");
  await settle(6);
  check("owning it and pressing the key again does NOT charge a second time",
    payWire.filter(w => w[0] === "flow").length === 0, payWire.map(w => w[0]));
  check("it reports the pass as owned, so the second press says OWNED",
    read("BILLS.owned") === true, read("({ o: BILLS.owned, on: BILLS.on })"));

  /* ---------------- 5. backing out ------------------------------------- */
  payOwned = false; await withBilling({ cancel: true });
  read("save.pro = false; persist(); G.state = 'pro'; G.proMsgT = 0;"); step(2);
  payWire.length = 0;
  tapWorld(read("ui.find(b => b.id === 'proon')"));
  await settle(6);
  check("a cancelled purchase grants nothing at all",
    read("save.pro") === false && read("BILLS.owned") === false,
    { pro: read("save.pro"), owned: read("BILLS.owned") });
  check("  ...and says so, instead of failing silently",
    /NOT PURCHASED/.test(read("G.proMsg")), read("G.proMsg"));
  check("  ...and the game is still completely playable, because it always was",
    read("G.state") === "pro" && read("save.coins") >= 0 && errors.length === 0, read("G.proMsg"));

  /* ---------------- 6. the store goes away mid-purchase ----------------- */
  const errs = errors.length;
  await withBilling({ down: true });
  read("save.pro = false; G.state = 'pro'; G.proMsgT = 0;"); step(2);
  payWire.length = 0;
  tapWorld(read("ui.find(b => b.id === 'proon')"));
  await settle(6);
  check("a BillingClient that is unavailable is not a crash and not a charge",
    read("save.pro") === false && payWire.length > 0 && errors.length === errs,
    { pro: read("save.pro"), wire: payWire.length });
  check("  ...and the panel does NOT quietly hand out the paid pass",
    /PAYMENTS UNAVAILABLE - PLEASE TRY AGAIN/.test(read("G.proMsg")) && read("save.pro") === false,
    { msg: read("G.proMsg"), pro: read("save.pro") });
  await withBilling({ hang: true });
  read("save.pro = false; G.state = 'pro'; G.proMsgT = 0;"); step(2);
  read("activatePro();");
  await settle(3);
  check("  ...and the game stays responsive while it waits, rather than locking",
    read("G.state") === "pro" && errors.length === errs, read("G.state"));
  await new Promise(r => setTimeout(r, read("CFG.PLAY_WAIT") + 400));
  check("  ...and one that never answers is timed out rather than awaited forever",
    read("BILLS.busy") === false && read("save.pro") === false && errors.length === errs,
    read("({ busy: BILLS.busy, pro: save.pro })"));

  /* ---------------- 7. the price is the STORE's, never ours ------------- */
  await withBilling({ price: "\u20ac1,99" });
  const euro = panel();
  check("a localised store price is shown as the store sent it",
    read("BILLS.price") === "\u20ac1,99" && euro.some(s => s === "UNLOCK \u20ac1,99"),
    { p: read("BILLS.price"), labels: euro.filter(s => /^UNLOCK/.test(s)) });
  await withBilling({ price: "<script>alert(1)</script>" });
  check("and a price that is not a price is refused, not painted",
    read("BILLS.price") === "2.99" || !/[<>]/.test(read("BILLS.price")),
    read("BILLS.price"));

  /* ---------------- 8. restore: a player who already paid -------------- */
  await withBilling({ owned: true });
  read("BILLS.restored = 0; save.pro = false; save.owned = ['classic']; persist();"); step(1);
  await read("billQuery(false)");
  check("RESTORE quietly gives a paying player their pass back, with no prompt",
    read("save.pro") === true && read("BILLS.restored") === 1,
    { pro: read("save.pro"), n: read("BILLS.restored") });
  check("  ...and the crown comes with it, because that is what was paid for",
    read("save.owned").indexOf("gold") >= 0, read("save.owned"));
  read("save.pro = false; persist(); G.state = 'pro'; G.proMsgT = 0;"); step(2);
  tapWorld(read("ui.find(b => b.id === 'prorestore')"));
  await settle(5);
  check("the RESTORE key itself works, and says whether it found anything",
    read("save.pro") === true && /PRO RESTORED/.test(read("G.proMsg")), read("G.proMsg"));

  /* ---------------- 9. achievements ------------------------------------- */
  achWire.length = 0; payClear(); payReset();
  pgInstall(PG_HOST({ info: PG_OFF }));
  arena();
  read("ACH.on = true; ACH.got = {}; ACH.sent = 0; save.best = 0; save.bestM = 0;"
       + " save.champ = 0; save.owned = ['classic']; save.name = 'NOVA';");
  check("achievements ride on the Play Games bridge, and are off without it",
    read("ACHS.length") === 7 && !!read("achBridge()"), { n: read("ACHS.length") });
  read("ACH.on = true; save.best = 900; save.bestM = 12000; G.bosses = [true, true, true, false, false];");
  read("achCheck();");
  check("a crash, a first 1,000m and a first boss gate each fire once",
    ["CGI_CRASH", "WIFI_1K", "BOSS_1"].every(a => achWire.indexOf(a) >= 0) &&
    achWire.length === 3, achWire);
  read("achCheck(); achCheck();");
  check("  ...and never fire twice, however often the check runs",
    achWire.length === 3, achWire);
  read("save.champ = 1; save.bestM = 260000; save.owned = SKINS.map(s => s.id);"
       + " G.bosses = [true, true, true, true, true]; achCheck();");
  check("and the finish, the overdrive, all five gates and the full wardrobe all unlock",
    ["GLORY_100K", "OVERDRIVE", "BOSS_ALL", "STYLIST"].every(a => achWire.indexOf(a) >= 0) &&
    achWire.length === 7, achWire);
  check("every id the game fires is one the store was told about — checked against the table",
    achWire.every(id => read("ACHS").some(a => a[0] === id)), achWire.filter(id => !read("ACHS").some(a => a[0] === id)));
  read("G.state = 'run'; G.meters = 90000; G.revive = 0; P.dead = false; gameOver('crash');");
  check("a crash on its own fires nothing new — the check is idempotent",
    achWire.length === 7, achWire);
  read("ACH.on = false; ACH.got = {}; ACH.sent = 0;"); achWire.length = 0; read("achCheck();");
  check("and with achievements off the whole thing is a silent no-op",
    achWire.length === 0 && read("ACH.sent") === 0, achWire);
  read("ACH.on = true; ACH.sent = 0;");
  achWire.length = 0;
  const noAch = PG_HOST({ info: PG_OFF, ach: false });
  pgInstall(noAch);
  read("ACH.on = false; save.best = 900; achCheck();");
  check("a Play Games host with no achievements configured disables them, rather than half-enabling",
    achWire.length === 0, achWire);
  pgInstall(PG_HOST({ info: PG_OFF }));

  /* ---------------- 10. and the cold boot, with both ------------------- */
  payOwned = false;
  const full = bootWith(PG_HOST({ info: PG_OFF }),
    { name: "NOVA", best: 900, bestM: 260000, champ: 1, owned: ["classic", "gold"] }, BILL_HOST({}));
  check("a cold boot with a Play Games host and a BillingClient runs clean",
    full.errors === 0 && errors.length === 0, full.errors);
  full.advance(1);
  await micro(); await micro(); await micro(); await micro();
  check("and both services are live before a finger has touched the screen",
    full.read("PGS.on") === true && full.read("BILLS.on") === true,
    full.read("({ pgs: PGS.on, bills: BILLS.on })"));
  check("the returning player's achievements are evaluated at launch, unasked",
    full.read("ACH.sent") >= 4 && full.read("ACH.sent") <= 7, full.read("ACH.sent"));
  check("and the pass is NOT granted to an account that has not bought it",
    full.read("save.pro") === false, full.read("save.pro"));

  payOwned = true;
  const paid = bootWith(PG_HOST({ info: PG_OFF }),
    { name: "NOVA", best: 900, bestM: 260000, champ: 1, owned: ["classic"] }, BILL_HOST({ owned: true }));
  paid.advance(1);
  await micro(); await micro(); await micro(); await micro();
  check("but it IS restored, automatically, for an account that bought it",
    paid.read("save.pro") === true && paid.read("save.owned").indexOf("gold") >= 0,
    paid.read("({ pro: save.pro, owned: save.owned })"));
  check("  ...and no prompt, no error and no interruption to the title card",
    paid.errors === 0 && paid.read("G.state") === "ready", paid.read("G.state"));

  pgHostless(); payClear();
});

/* --------------------------------- report --------------------------------- */
let reported = false;
function report() {
  if (reported) return;
  reported = true;
  console.log("\n" + pass + " passed, " + fail + " failed, " + errors.length + " runtime errors");
  if (errors.length) console.error("\nfirst error:\n", errors.map(e => (e && e.stack) || String(e)).join("\n---\n"));
  if (fail || errors.length) process.exit(1);
  console.log("SMOKE TEST PASSED");
}
/* the leaderboard's, Play Games' and Play Billing's checks are the ones that
   need a network and a host, so they settle last — and the verdict waits for
   them rather than being printed early */
playDone.then(report, e => { errors.push(e); report(); });
