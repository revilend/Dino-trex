/* Generates the app icons from the game's own sprite tables, with no
   dependencies at all — a tiny PNG encoder on top of node's zlib.

     node make-icons.cjs

   The dino is rasterised from the same `classic_idle` rect table the game
   draws, on an integer scale so the pixel art stays crisp, onto Chrome's ink
   grey.  Writes icons/*.png.  Re-run it whenever the sprite art changes. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

/* ------------------------------- PNG writer ------------------------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/* 8-bit truecolour (colour type 2), no alpha: every icon is full-bleed, which
   is what Android's mask and iOS's rounded corner both want. */
function encodePNG(w, h, rgb) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ------------------------------ tiny raster ------------------------------- */
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const canvas = (w, h, bg) => {
  const d = Buffer.alloc(w * h * 3);
  const c = hex(bg);
  for (let i = 0; i < w * h; i++) { d[i * 3] = c[0]; d[i * 3 + 1] = c[1]; d[i * 3 + 2] = c[2]; }
  return { w, h, d };
};
function rect(cv, x, y, w, h, col) {
  const c = hex(col);
  for (let j = Math.max(0, y); j < Math.min(cv.h, y + h); j++) {
    for (let i = Math.max(0, x); i < Math.min(cv.w, x + w); i++) {
      const o = (j * cv.w + i) * 3;
      cv.d[o] = c[0]; cv.d[o + 1] = c[1]; cv.d[o + 2] = c[2];
    }
  }
}

/* --------------------------- the sprite, from the game -------------------- */
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];
const from = src.indexOf("const WW = 384");
const to = src.indexOf("const skinIndex = id =>");
if (from < 0 || to < 0) throw new Error("could not find the sprite tables in index.html");
const box = vm.createContext({ Math, JSON, Object, Array, Number, String, console });
const { SPR } = vm.runInContext(
  "(function(){\n" + src.slice(from, to) + "\nreturn { SPR };\n})()", box);
const DINO = SPR["classic_idle"];

const BG = "#535353";        /* the game's ink, full bleed */
const MARK = "#ffffff";      /* the dino itself, the game's paper */
const GOLD = "#c39a24";      /* one accent, so the tile is not two flat greys */

/* An icon is the dino, centred, on an integer scale, with a gold ground line
   under its feet.  `fit` is the fraction of the icon the dino's height takes,
   and maskable icons keep it small enough to survive a circular crop. */
function icon(size, fit, out) {
  const cv = canvas(size, size, BG);
  const s = Math.max(1, Math.round((size * fit) / DINO.h));
  const w = DINO.w * s, h = DINO.h * s;
  const ox = Math.round((size - w) / 2), oy = Math.round((size - h) / 2);
  for (const fr of DINO.f[0]) {
    rect(cv, ox + fr[0] * s, oy + fr[1] * s, Math.max(1, fr[2] * s), Math.max(1, fr[3] * s), MARK);
  }
  /* a signal bar under the feet: gold, the same width as the dino, one pixel row tall */
  rect(cv, ox, oy + h + Math.round(s * 1.5), w, Math.max(1, Math.round(s * 0.6)), GOLD);
  fs.writeFileSync(path.join(__dirname, out), encodePNG(size, size, cv.d));
  return { out, size, scale: s };
}

const iconsDir = path.join(__dirname, "icons");
fs.mkdirSync(iconsDir, { recursive: true });
const made = [
  icon(192, 0.62, "icons/icon-192.png"),
  icon(512, 0.62, "icons/icon-512.png"),
  icon(512, 0.50, "icons/maskable-512.png"),   /* inside the 80% safe circle */
  icon(180, 0.62, "icons/apple-touch-icon.png"),
  icon(32, 0.70, "icons/favicon-32.png"),
  icon(1024, 0.62, "icons/icon-1024.png")      /* store / mipmap source */
];
for (const m of made) console.log("wrote " + m.out + "  " + m.size + "px  scale " + m.scale + "x");
console.log("icons regenerated from SPR.classic_idle in index.html");
