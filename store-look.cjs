/* Throwaway: decodes a store/*.png back to ASCII so the artwork can be eyeballed
   in a terminal.  Only understands what png.cjs writes: 8-bit truecolour, no
   alpha, filter type 0 on every row.
   node store-look.cjs <file> [cols] [rows] [x0 y0 x1 y1]                        */
const fs = require("fs"), zlib = require("zlib");
const buf = fs.readFileSync(process.argv[2]);
let o = 8, W = 0, H = 0, idat = [];
while (o < buf.length) {
  const len = buf.readUInt32BE(o), type = buf.toString("ascii", o + 4, o + 8);
  const data = buf.slice(o + 8, o + 8 + len);
  if (type === "IHDR") { W = data.readUInt32BE(0); H = data.readUInt32BE(4); }
  if (type === "IDAT") idat.push(data);
  o += 12 + len;
}
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = W * 3 + 1;
const hexAt = (x, y) => raw.toString("hex", y * stride + 1 + x * 3, y * stride + 1 + x * 3 + 3);
const COLS = +(process.argv[3] || 150), ROWS = +(process.argv[4] || 44);
const X0 = +(process.argv[5] || 0), Y0 = +(process.argv[6] || 0);
const X1 = +(process.argv[7] || W), Y1 = +(process.argv[8] || H);
console.log(process.argv[2] + "  " + W + "x" + H + "  showing [" + X0 + "," + Y0 + " - " + X1 + "," + Y1 + "]");
const glyph = h => {
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (r * 3 + g * 6 + b) / 10;
  if (r > 120 && g > 90 && b < 100) return "@";   /* gold / red accent */
  if (b > 110 && g > 110 && r < 110) return "+";   /* cyan */
  if (lum > 235) return " ";
  if (lum > 170) return ":";
  if (lum > 120) return "*";
  if (lum > 70) return "%";
  return "#";
};
for (let ry = 0; ry < ROWS; ry++) {
  let line = "";
  for (let rx = 0; rx < COLS; rx++) {
    const x = Math.max(0, Math.min(W - 1, Math.round(X0 + (rx + 0.5) * (X1 - X0) / COLS - 0.5)));
    const y = Math.max(0, Math.min(H - 1, Math.round(Y0 + (ry + 0.5) * (Y1 - Y0) / ROWS - 0.5)));
    line += glyph(hexAt(x, y));
  }
  console.log(line);
}
