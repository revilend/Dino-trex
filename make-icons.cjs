/* Generates the app icons from the game's own sprite tables, with no
   dependencies at all — a tiny PNG encoder on top of node's zlib.

     node make-icons.cjs

   The dino is rasterised from the same `classic_idle` rect table the game
   draws, on an integer scale so the pixel art stays crisp, onto Chrome's ink
   grey.  Writes icons/*.png.  Re-run it whenever the sprite art changes. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
/* the PNG encoder and the tiny raster it fills live in png.cjs, shared with
   make-store-assets.cjs so the app icon and the Play Store listing graphics are
   guaranteed to be written by exactly the same code. */
const { encodePNG, canvas, rect } = require("./png.cjs");

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
