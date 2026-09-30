/* Renders the dino skins side by side, straight out of the sprite rect
   tables in index.html — ANSI pixel art in the terminal, plus skins.svg.
   Usage: node skin-card.cjs                                              */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];

/* Everything from the palette helpers through the skin table is pure data:
   no DOM, no state.  Slice exactly that and evaluate it on its own. */
const from = src.indexOf("const WW = 384");
const to = src.indexOf("const skinIndex = id =>");
if (from < 0 || to < 0) throw new Error("could not find the sprite tables in index.html");
const box = vm.createContext({ Math, JSON, Object, Array, Number, String, console });
const { SPR, SKINS, ACCENT, DAYC, NIGHTC } =
  vm.runInContext("(function(){\n" + src.slice(from, to) + "\nreturn { SPR, SKINS, ACCENT, DAYC, NIGHTC };\n})()", box);
const INK = DAYC.ink, PAPER = DAYC.paper;
const colour = a => (a ? ACCENT[a] : INK);

/* --------------------------- pixel grid from a frame ---------------------- */
function grid(key, frame, y0, y1) {
  const s = SPR[key], fr = s.f[((frame | 0) % s.f.length + s.f.length) % s.f.length];
  const rows = [];
  for (let y = y0; y < y1; y++) {
    const row = new Array(s.w).fill(null);
    for (const r of fr) if (y >= r[1] && y < r[1] + r[3]) for (let x = r[0]; x < r[0] + r[2]; x++) row[x] = colour(r[4]);
    rows.push({ y, row });
  }
  return { w: s.w, top: y0, rows };
}
function extent(key, frame) {
  const s = SPR[key], fr = s.f[((frame | 0) % s.f.length + s.f.length) % s.f.length];
  let lo = 0, hi = 0;
  for (const r of fr) { lo = Math.min(lo, r[1]); hi = Math.max(hi, r[1] + r[3]); }
  return [lo, hi];
}

/* ------------------------------ terminal card ---------------------------- */
const W = (s) => "\x1b[38;2;" + rgb(s).join(";") + "m";
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const GLYPH = { [INK]: "#", [ACCENT[1]]: "G", [ACCENT[2]]: "C", [ACCENT[3]]: "R", [ACCENT[5]]: "g", [PAPER]: "." };

function art(key, frame, y0, y1) {
  const g = grid(key, frame, y0, y1);
  return { top: g.top, w: g.w, lines: g.rows.map(r => {
    let line = "";
    for (let x = 0; x < g.w; x++) line += r.row[x] ? GLYPH[r.row[x]] : " ";
    return line;
  }) };
}

function card(pose, frame, title) {
  const span = SKINS.map(sk => extent(sk.id + "_" + pose, frame));
  const top = Math.min(...span.map(s => s[0])), bottom = Math.max(...span.map(s => s[1]));
  const cells = SKINS.map(sk => ({ sk, a: art(sk.id + "_" + pose, frame, top, bottom) }));
  console.log("\n" + title);
  console.log("     " + Array.from({ length: cells[0].a.w }, (_, i) => (i % 10 === 0 ? String((i / 10) | 0) : "·")).join(""));
  for (let i = 0; i < cells[0].a.lines.length; i++) {
    const left = String(top + i).padStart(4) + " ";
    console.log(cells.map(c => left + c.a.lines[i].padEnd(c.a.w) + "  ").join("| "));
  }
}

card("idle", 0, "STANDING (idle frame)");
card("duck", 0, "DUCKING (55x25 pose)");
console.log("\nlegend  # dino ink   G gold   g pale gold   C cyan   R red   . paper (the hole cut out of an accessory)");
console.log("        one text row = one sprite row.  Columns line up across every skin, so compare them.");

/* --------------------------- alignment diagnostics ------------------------ */
/* The eye is the blank notch the Chrome head has cut out of itself: find it per
   pose instead of guessing, then check each accessory against it. */
function eyeOf(pose) {
  const s = SPR[pose], fr = s.f[0];
  const ink = (x, y) => fr.some(r => x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]);
  const gaps = [];
  for (let y = 0; y < 10; y++) {                     /* the eye lives in the top of the head */
    let run = null;
    for (let x = (s.w * 0.45) | 0; x <= s.w; x++) {
      const solid = x < s.w && ink(x, y);
      if (!solid && run === null) run = x;
      if (solid && run !== null) { if (run - 1 >= s.w * 0.45 && ink(run - 1, y)) gaps.push([run, x - 1, y]); run = null; }
    }
  }
  /* the eye is the narrowest enclosed gap — the wider ones are neck and mouth */
  const best = gaps.slice().sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]) || b[0] - a[0])[0] || [0, 0, 0];
  return { x: best[0], y: best[2], w: best[1] - best[0] + 1, h: gaps.filter(g => g[0] === best[0]).length };
}
/* connected groups of accessory pixels, and whether each one reaches the sprite */
function components(px) {
  const seen = new Set(), out = [];
  for (const p of px) {
    if (seen.has(p)) continue;
    const group = [], queue = [p];
    seen.add(p);
    while (queue.length) {
      const [x, y] = queue.pop().split(",").map(Number);
      group.push([x, y]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = (x + dx) + "," + (y + dy);
        if (px.has(k) && !seen.has(k)) { seen.add(k); queue.push(k); }
      }
    }
    out.push(group);
  }
  return out;
}
function inkSet(pose) {
  const fr = SPR[pose].f[0], set = new Set();
  for (const r of fr) for (let x = r[0]; x < r[0] + r[2]; x++) for (let y = r[1]; y < r[1] + r[3]; y++) set.add(x + "," + y);
  return set;
}
const rule = s => console.log("\n" + s + "\n" + "-".repeat(s.length));
rule("ALIGNMENT");
for (const [pose, off] of [["idle", [20, 0]], ["blink", [20, 0]], ["crash", [20, 0]], ["duck", [35, 1]]]) {
  const eye = eyeOf(pose), ink = inkSet(pose);
  console.log("\n" + pose + "  head offset [" + off + "]   eye notch at x" + eye.x + ".." + (eye.x + eye.w - 1) +
              ", y" + eye.y + ".." + (eye.y + eye.h - 1));
  for (const sk of SKINS) {
    if (!sk.acc) { console.log("  " + sk.name.padEnd(16) + " no accessory"); continue; }
    const abs = sk.acc.map(r => [r[0] + off[0], r[1] + off[1], r[2], r[3], r[4]]);
    const px = new Set();
    for (const r of abs) for (let x = r[0]; x < r[0] + r[2]; x++) for (let y = r[1]; y < r[1] + r[3]; y++) px.add(x + "," + y);
    const orphans = components(px).filter(g => !g.some(([x, y]) =>
      [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => ink.has((x + dx) + "," + (y + dy)))));
    const onEye = [...px].some(p => {
      const [x, y] = p.split(",").map(Number);
      return x >= eye.x && x < eye.x + eye.w && y >= eye.y && y < eye.y + eye.h;
    });
    const xs = abs.map(r => r[0] + r[2]), ys = abs.map(r => r[1] + r[3]);
    console.log("  " + sk.name.padEnd(16) +
      " x " + Math.min(...abs.map(r => r[0])) + ".." + (Math.max(...xs) - 1) +
      "  y " + Math.min(...abs.map(r => r[1])) + ".." + (Math.max(...ys) - 1) +
      "  " + components(px).length + " pieces" +
      (onEye ? "  over the eye" : "  eye clear") +
      (orphans.length ? "  \x1b[31m" + orphans.length + " piece(s) floating off the sprite\x1b[0m"
                      : "  all pieces touch the sprite"));
  }
}

/* ---------------------------------- SVG ---------------------------------- */
const SC = 7, COL = SKINS.map(sk => ({ sk, s: SPR[sk.id + "_idle"], d: SPR[sk.id + "_duck"] }));
const cw = 46 * SC, chh = 66 * SC;
const svgRows = ["<svg xmlns='http://www.w3.org/2000/svg' width='" + cw * COL.length +
  "' height='" + (chh * 2 + 78) + "' viewBox='0 0 " + cw * COL.length + " " + (chh * 2 + 78) + "'>",
  "<rect width='100%' height='100%' fill='" + PAPER + "'/>",
  "<style>text{font:700 13px 'Courier New',monospace;fill:" + INK + ";letter-spacing:.08em}" +
  ".s{font:400 11px 'Courier New',monospace;fill:" + DAYC.soft + "}</style>"];

function pose(x, y, spr, frame, ghost) {
  const fr = spr.f[frame];
  let out = "";
  if (ghost) out += "<g opacity='.13'>" + fr.map(r => `<rect x='${(x + r[0]) * SC}' y='${(y + r[1]) * SC}' width='${r[2] * SC}' height='${r[3] * SC}' fill='${INK}'/>`).join("") + "</g>";
  out += fr.map(r => `<rect x='${(x + r[0]) * SC}' y='${(y + r[1]) * SC}' width='${r[2] * SC}' height='${r[3] * SC}' fill='${colour(r[4])}'/>`).join("");
  return out;
}

COL.forEach((c, i) => {
  const x = i * cw + 3 * SC;
  svgRows.push(`<text x='${x}' y='26'>${c.sk.name}</text>`);
  svgRows.push(`<text class='s' x='${x}' y='44'>${c.sk.blurb}</text>`);
  const ty = 70 + 10 * SC;                                    /* 10px of headroom for the hat */
  svgRows.push(pose(x, ty, c.s, 0, i > 0));                  /* ghost of the Chrome frame underneath */
  svgRows.push(`<line x1='${x - 4}' y1='${(ty + 43) * SC}' x2='${x + 60 * SC}' y2='${(ty + 43) * SC}' stroke='${INK}' stroke-width='2'/>`);
  svgRows.push(`<text class='s' x='${x}' y='${(ty + 43) * SC + 18}'>feet on the ground line</text>`);
  const dy = chh + 12 * SC;
  svgRows.push(pose(x, dy, c.d, 0, i > 0));
  svgRows.push(`<line x1='${x - 4}' y1='${(dy + 25) * SC}' x2='${x + 60 * SC}' y2='${(dy + 25) * SC}' stroke='${INK}' stroke-width='2'/>`);
  svgRows.push(`<text class='s' x='${x}' y='${(dy + 25) * SC + 18}'>ducking, same ground line</text>`);
});
svgRows.push("<text class='s' x='12' y='" + (chh * 2 + 62) + "'>Top row: standing, 7x. Bottom row: ducking, 7x. Each skin sits on its own ghosted copy of the untouched Chrome frame so you can see exactly what the accessory adds and where it lands.</text>");
svgRows.push("</svg>");
fs.writeFileSync(path.join(__dirname, "skins.svg"), svgRows.join("\n"));
console.log("wrote skins.svg — open it in a browser for the 7x version with the Chrome ghost underneath.\n");
