/* A PNG encoder on top of node's zlib, and the tiny raster it writes into.
   Zero dependencies, shared by make-icons.cjs and make-store-assets.cjs.

   node -e "require('./png.cjs')"        (see make-icons.cjs)

   Everything here is 8-bit truecolour (colour type 2), no alpha: an icon is
   full-bleed, and Android's mask and iOS's rounded corner both want exactly
   that, so there is never a reason to pay for an alpha channel. */
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
  const cv = { w, h, d: Buffer.alloc(w * h * 3) };
  if (bg) { const c = hex(bg); for (let i = 0; i < w * h; i++) { cv.d[i * 3] = c[0]; cv.d[i * 3 + 1] = c[1]; cv.d[i * 3 + 2] = c[2]; } }
  return cv;
};

/* how many bytes into the buffer the pixel at (x, y) starts */
const at = (cv, x, y) => (y * cv.w + x) * 3;

function px(cv, x, y, c, a) {
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const o = at(cv, x, y);
  if (a === undefined || a >= 1) { cv.d[o] = c[0]; cv.d[o + 1] = c[1]; cv.d[o + 2] = c[2]; return; }
  if (a <= 0) return;
  cv.d[o] = c[0] * a + cv.d[o] * (1 - a);
  cv.d[o + 1] = c[1] * a + cv.d[o + 1] * (1 - a);
  cv.d[o + 2] = c[2] * a + cv.d[o + 2] * (1 - a);
}
const rect = (cv, x, y, w, h, col, a) => {
  const c = typeof col === "string" ? hex(col) : col;
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(cv.w, Math.round(x + w)), y1 = Math.min(cv.h, Math.round(y + h));
  for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) px(cv, i, j, c, a);
};

/* paste a smaller canvas onto a bigger one, with an optional integer scale and
   top-left anchor — this is how a rendered 384-unit game frame lands inside a
   1920x1080 screenshot without resampling anything by hand. */
function blit(dst, src, x, y, scale) {
  const s = scale || 1;
  for (let j = 0; j < src.h * s; j++) {
    const sy = (j / s) | 0;
    for (let i = 0; i < src.w * s; i++) {
      const o = at(src, (i / s) | 0, sy);
      px(dst, x + i, y + j, [src.d[o], src.d[o + 1], src.d[o + 2]]);
    }
  }
}

module.exports = { encodePNG, canvas, rect, blit, px, hex, at };
