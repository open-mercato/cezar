// Generates the launcher icons, splash screens and connect-screen mark from the brand source,
// docs/brand/cezar-icon-black.svg (guidelines: docs/brand/README.md). No dependency: the mark is
// four polygons, so a scanline rasterizer and Node's zlib are enough.
//   node scripts/build-brand.mjs                write every output
//   node scripts/build-brand.mjs --check        exit 1 when an output is missing or stale
//   node scripts/build-brand.mjs --previews DIR also render shape and splash previews into DIR
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '../..');
export const SOURCE = join(repo, 'docs/brand/cezar-icon-black.svg');
// The cockpit and the desktop app ship the same mark; main() refuses to run if either drifts.
const SAME_MARK = ['packages/web/public/icon.svg', 'packages/desktop/src-tauri/icons/source.svg'];
const RES = join(root, 'android/app/src/main/res');
const XCASSETS = join(root, 'ios/App/App/Assets.xcassets');

// docs/brand/README.md: tile black, mark white, stroke x = 90 u, and x of clear space around a
// mark without its tile.
const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];
const STROKE = 90;

// ---------------------------------------------------------------- source

export function readMark(svg = readFileSync(SOURCE, 'utf8')) {
  const tile = Number(/<rect[^>]*\bwidth="([\d.]+)"/.exec(svg)?.[1]);
  const radius = Number(/<rect[^>]*\brx="([\d.]+)"/.exec(svg)?.[1]);
  const polygons = [...svg.matchAll(/<polygon points="([^"]+)"/g)].map((m) => m[1].trim().split(/\s+/).map((pair) => pair.split(',').map(Number)));
  if (!tile || !radius || polygons.length !== 4) throw new Error(`${relative(repo, SOURCE)}: expected one tile and four polygons`);
  const xs = polygons.flat().map((p) => p[0]);
  const ys = polygons.flat().map((p) => p[1]);
  const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  return { tile, radius, polygons, box, cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, height: box.y1 - box.y0 };
}

const MARK = readMark();
// The mark plus x of clear space on each side: the side of the square it needs.
const CLEAR_SIDE = MARK.height + 2 * STROKE;

// ---------------------------------------------------------------- geometry

/** Maps the mark so its clear-space square spans `side` px, centred at (ox, oy). */
const fitMark = (side, ox, oy) => {
  const s = side / CLEAR_SIDE;
  return MARK.polygons.map((poly) => poly.map(([x, y]) => [ox + (x - MARK.cx) * s, oy + (y - MARK.cy) * s]));
};
/** The brand tile as designed (mark at its tile proportions), scaled into a `side` px square at (x, y). */
const tileMark = (side, x = 0, y = 0) => {
  const s = side / MARK.tile;
  return MARK.polygons.map((poly) => poly.map(([px, py]) => [x + px * s, y + py * s]));
};
const rect = (x, y, w, h) => [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
const superellipse = (cx, cy, r, n, steps = 720) => [
  Array.from({ length: steps }, (_, i) => {
    const t = (i / steps) * 2 * Math.PI;
    const c = Math.cos(t);
    const s = Math.sin(t);
    return [cx + r * Math.sign(c) * Math.abs(c) ** (2 / n), cy + r * Math.sign(s) * Math.abs(s) ** (2 / n)];
  }),
];
const circle = (cx, cy, r) => superellipse(cx, cy, r, 2);
const roundRect = (x, y, w, h, r, steps = 32) => {
  const pts = [];
  const corners = [
    [x + w - r, y + r, -Math.PI / 2],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, Math.PI / 2],
    [x + r, y + r, Math.PI],
  ];
  for (const [cx, cy, start] of corners) for (let i = 0; i <= steps; i++) pts.push([cx + r * Math.cos(start + (i / steps) * (Math.PI / 2)), cy + r * Math.sin(start + (i / steps) * (Math.PI / 2))]);
  return [pts];
};

// ---------------------------------------------------------------- raster

const SUB = 16;

/** Antialiased nonzero coverage of `polygons` on a w×h grid: exact horizontally, SUB rows per pixel. */
function coverage(w, h, polygons) {
  const cov = new Float32Array(w * h);
  const edges = polygons.flatMap((poly) => poly.map((a, i) => [a, poly[(i + 1) % poly.length]]).filter(([a, b]) => a[1] !== b[1]));
  const ys = polygons.flat().map((p) => p[1]);
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const bottom = Math.min(h, Math.ceil(Math.max(...ys)));
  for (let py = top; py < bottom; py++) {
    for (let k = 0; k < SUB; k++) {
      const y = py + (k + 0.5) / SUB;
      const hits = [];
      for (const [a, b] of edges) {
        const [lo, hi] = a[1] < b[1] ? [a, b] : [b, a];
        if (y < lo[1] || y >= hi[1]) continue;
        hits.push([a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), a[1] < b[1] ? 1 : -1]);
      }
      hits.sort((p, q) => p[0] - q[0]);
      let winding = 0;
      for (let i = 0; i < hits.length - 1; i++) {
        winding += hits[i][1];
        if (winding !== 0) span(cov, w, py, hits[i][0], hits[i + 1][0]);
      }
    }
  }
  for (let i = 0; i < cov.length; i++) if (cov[i] > 1) cov[i] = 1;
  return cov;
}

function span(cov, w, py, xa, xb) {
  xa = Math.max(0, xa);
  xb = Math.min(w, xb);
  if (xb <= xa) return;
  const row = py * w;
  const ia = Math.floor(xa);
  const ib = Math.floor(xb);
  if (ia === ib) {
    cov[row + ia] += (xb - xa) / SUB;
    return;
  }
  cov[row + ia] += (ia + 1 - xa) / SUB;
  for (let x = ia + 1; x < ib; x++) cov[row + x] += 1 / SUB;
  if (ib < w) cov[row + ib] += (xb - ib) / SUB;
}

class Canvas {
  constructor(w, h, background = [0, 0, 0, 0]) {
    this.w = w;
    this.h = h;
    this.px = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) this.px.set(background.map((c) => c / 255), i * 4);
  }
  /** Source-over, premultiplied internally. */
  fill(polygons, color) {
    const cov = coverage(this.w, this.h, polygons);
    const [r, g, b, a] = color.map((c) => c / 255);
    for (let i = 0; i < cov.length; i++) {
      const sa = cov[i] * a;
      if (!sa) continue;
      const o = i * 4;
      const da = this.px[o + 3];
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) this.px[o + c] = (([r, g, b][c] * sa + this.px[o + c] * da * (1 - sa)) / oa);
      this.px[o + 3] = oa;
    }
    return this;
  }
  /** Keeps only what lies inside `polygons`. */
  clip(polygons) {
    const cov = coverage(this.w, this.h, polygons);
    for (let i = 0; i < cov.length; i++) this.px[i * 4 + 3] *= cov[i];
    return this;
  }
  draw(other, x, y) {
    for (let j = 0; j < other.h; j++)
      for (let i = 0; i < other.w; i++) {
        const s = (j * other.w + i) * 4;
        const sa = other.px[s + 3];
        if (!sa || x + i >= this.w || y + j >= this.h) continue;
        const o = ((y + j) * this.w + x + i) * 4;
        const da = this.px[o + 3];
        const oa = sa + da * (1 - sa);
        for (let c = 0; c < 3; c++) this.px[o + c] = (other.px[s + c] * sa + this.px[o + c] * da * (1 - sa)) / oa;
        this.px[o + 3] = oa;
      }
    return this;
  }
  /** 8-bit rows, RGB when `opaque` (iOS refuses an app icon with alpha), else RGBA. */
  bytes(opaque) {
    const channels = opaque ? 3 : 4;
    const out = Buffer.alloc(this.w * this.h * channels);
    for (let i = 0; i < this.w * this.h; i++)
      for (let c = 0; c < channels; c++) out[i * channels + c] = Math.round(Math.min(1, Math.max(0, this.px[i * 4 + c])) * 255);
    return { w: this.w, h: this.h, channels, data: out };
  }
}

// ---------------------------------------------------------------- png

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
/** Rows with filter byte 0, so --check can compare pixels whatever zlib version compressed them. */
const scanlines = ({ w, h, channels, data }) => Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.concat([Buffer.from([0]), data.subarray(y * w * channels, (y + 1) * w * channels)])));

function encodePng(image) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.w, 0);
  header.writeUInt32BE(image.h, 4);
  header[8] = 8;
  header[9] = image.channels === 3 ? 2 : 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines(image), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** The IHDR fields and inflated scanlines of a PNG, or null when it is not one. */
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let offset = 8;
  let header;
  const idat = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') header = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), colorType: data[9] };
    if (type === 'IDAT') idat.push(data);
    offset += len + 12;
  }
  return header ? { ...header, rows: inflateSync(Buffer.concat(idat)) } : null;
}

// ---------------------------------------------------------------- outputs

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const r1 = (n) => Number(n.toFixed(1));

/** Adaptive layers are 108 dp with 72 dp visible: the clear-space square spans those 72 dp. */
function foregroundVector() {
  const viewport = r1((CLEAR_SIDE * 108) / 72);
  const shift = r1(viewport / 2 - MARK.cx);
  const paths = MARK.polygons.map((poly) => `        <path android:fillColor="#FFFFFFFF" android:pathData="M${poly.map(([x, y]) => `${x},${y}`).join(' L')} Z"/>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by scripts/build-brand.mjs from docs/brand/cezar-icon-black.svg. Do not edit. -->
<!-- The mark plus x of clear space fills the 72 dp an adaptive icon always shows. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="${viewport}"
    android:viewportHeight="${viewport}">
    <group android:translateX="${shift}" android:translateY="${shift}">
${paths}
    </group>
</vector>
`;
}

const adaptiveIcon = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by scripts/build-brand.mjs. Do not edit. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
    <monochrome android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>
`;

const colors = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by scripts/build-brand.mjs. Do not edit. Tile black, docs/brand/README.md. -->
<resources>
    <color name="ic_launcher_background">#000000</color>
    <color name="splash_background">#000000</color>
</resources>
`;

// Before Android 12 the launch theme's background is the splash. 288 dp matches the size
// Android 12+ draws windowSplashScreenAnimatedIcon at, so both look the same.
const splashDrawable = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by scripts/build-brand.mjs. Do not edit. -->
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/splash_background"/>
    <item android:drawable="@drawable/ic_launcher_foreground" android:gravity="center" android:width="288dp" android:height="288dp"/>
</layer-list>
`;

/** Pre-26 launchers: the brand tile as designed, and a round tile with the clear-space mark. */
function legacyIcon(px, round) {
  // Material legacy keyline: 44 of 48 dp, centred.
  const side = Math.round((px * 44) / 48);
  const at = (px - side) / 2;
  const canvas = new Canvas(px, px);
  if (round) return canvas.fill(circle(px / 2, px / 2, side / 2), BLACK).fill(fitMark(side, px / 2, px / 2), WHITE);
  return canvas.fill(roundRect(at, at, side, side, (side * MARK.radius) / MARK.tile), BLACK).fill(tileMark(side, at, at), WHITE);
}

// iOS masks the icon itself, so it gets the tile edge to edge with the mark at its tile proportions.
const iosIcon = (variant) => {
  const side = 1024;
  if (variant === 'dark') return new Canvas(side, side).fill(tileMark(side), WHITE);
  return new Canvas(side, side, BLACK).fill(tileMark(side), WHITE);
};

const iosIconContents = `${JSON.stringify(
  {
    images: [
      { filename: 'AppIcon-512@2x.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
      { appearances: [{ appearance: 'luminosity', value: 'dark' }], filename: 'AppIcon-dark-512@2x.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
      { appearances: [{ appearance: 'luminosity', value: 'tinted' }], filename: 'AppIcon-tinted-512@2x.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
    ],
    info: { author: 'xcode', version: 1 },
  },
  null,
  2,
)}\n`;

// The launch storyboard fills the screen with this (scaleAspectFill), so the mark sits in the middle
// and keeps about 15% of the shorter screen side, near Android's 144 dp splash mark.
const SPLASH = 2732;
const iosSplash = () => new Canvas(SPLASH, SPLASH, BLACK).fill(fitMark(Math.round(SPLASH * 0.15 * (CLEAR_SIDE / MARK.height)), SPLASH / 2, SPLASH / 2), WHITE);

/** The connect screen's inline mark: inline SVG needs no img-src in its CSP and follows the theme. */
function connectMark() {
  const { x0, y0, x1, y1 } = MARK.box;
  const points = MARK.polygons.map((poly) => `<polygon points="${poly.map(([x, y]) => `${x},${y}`).join(' ')}"/>`).join('');
  return `<svg class="mark" viewBox="${r1(x0)} ${r1(y0)} ${r1(x1 - x0)} ${r1(y1 - y0)}" role="img" aria-label="cezar">${points}</svg>`;
}
const MARK_BLOCK = /<!-- brand:mark -->[\s\S]*?<!-- \/brand:mark -->/;
/** Status bar icon: Android draws only its alpha, in a 24 dp square with 1 dp of padding, so the mark fills 22 dp. */
function notificationVector() {
  const viewport = r1((MARK.height * 24) / 22);
  const paths = MARK.polygons.map((poly) => `        <path android:fillColor="#FFFFFFFF" android:pathData="M${poly.map(([x, y]) => `${x},${y}`).join(' L')} Z"/>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by scripts/build-brand.mjs from docs/brand/cezar-icon-black.svg. Do not edit. -->
<!-- The push notification's small icon: monochrome, the mark filling 22 of 24 dp. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="${viewport}"
    android:viewportHeight="${viewport}">
    <group android:translateX="${r1(viewport / 2 - MARK.cx)}" android:translateY="${r1(viewport / 2 - MARK.cy)}">
${paths}
    </group>
</vector>
`;
}

function connectIndex() {
  const path = join(root, 'connect/index.html');
  const html = readFileSync(path, 'utf8');
  if (!MARK_BLOCK.test(html)) throw new Error('connect/index.html: missing the <!-- brand:mark --> block');
  return html.replace(MARK_BLOCK, `<!-- brand:mark -->${connectMark()}<!-- /brand:mark -->`);
}

/** Every output, as [path, () => string | Buffer image]. */
export function outputs() {
  const list = [
    [join(RES, 'drawable/ic_launcher_foreground.xml'), foregroundVector],
    [join(RES, 'drawable/ic_stat_cezar.xml'), notificationVector],
    [join(RES, 'mipmap-anydpi-v26/ic_launcher.xml'), () => adaptiveIcon],
    [join(RES, 'mipmap-anydpi-v26/ic_launcher_round.xml'), () => adaptiveIcon],
    [join(RES, 'values/ic_launcher_background.xml'), () => colors],
    [join(RES, 'drawable/splash.xml'), () => splashDrawable],
    [join(XCASSETS, 'AppIcon.appiconset/Contents.json'), () => iosIconContents],
    [join(XCASSETS, 'AppIcon.appiconset/AppIcon-512@2x.png'), () => iosIcon('light').bytes(true)],
    [join(XCASSETS, 'AppIcon.appiconset/AppIcon-dark-512@2x.png'), () => iosIcon('dark').bytes(false)],
    [join(XCASSETS, 'AppIcon.appiconset/AppIcon-tinted-512@2x.png'), () => iosIcon('tinted').bytes(true)],
    [join(root, 'connect/index.html'), connectIndex],
  ];
  for (const [name, scale] of Object.entries(DENSITIES)) {
    const px = Math.round(48 * scale);
    list.push([join(RES, `mipmap-${name}/ic_launcher.png`), () => legacyIcon(px, false).bytes(false)]);
    list.push([join(RES, `mipmap-${name}/ic_launcher_round.png`), () => legacyIcon(px, true).bytes(false)]);
  }
  let splash;
  for (const file of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'])
    list.push([join(XCASSETS, `Splash.imageset/${file}`), () => (splash ??= iosSplash().bytes(true))]);
  return list;
}

/** True when the file on disk already holds `value` (pixels, for a PNG). */
function upToDate(path, value) {
  if (!existsSync(path)) return false;
  const current = readFileSync(path);
  if (typeof value === 'string') return current.toString('utf8') === value;
  const png = decodePng(current);
  return Boolean(png) && png.w === value.w && png.h === value.h && png.colorType === (value.channels === 3 ? 2 : 6) && png.rows.equals(scanlines(value));
}

// ---------------------------------------------------------------- previews

/** Launcher shapes, themed icons and both splashes, drawn from the same layers the app ships. */
function previews(dir) {
  mkdirSync(dir, { recursive: true });
  const size = 432; // 108 dp at 4x
  const visible = (size * 72) / 108;
  const c = size / 2;
  const masks = {
    circle: circle(c, c, visible / 2),
    squircle: superellipse(c, c, visible / 2, 5),
    'rounded-square': roundRect(c - visible / 2, c - visible / 2, visible, visible, visible * 0.2),
    teardrop: [[...circle(c, c, visible / 2)[0].filter(([x, y]) => !(x > c && y > c)), [c + visible / 2, c], [c + visible / 2, c + visible / 2], [c, c + visible / 2]]],
  };
  // Material You tints: light (a pale tint behind a dark mark) and dark.
  const themes = { light: [[0xd8, 0xe2, 0xff, 255], [0x00, 0x1a, 0x41, 255]], dark: [[0x00, 0x2e, 0x69, 255], [0xad, 0xc6, 0xff, 255]] };
  const layers = (bg, fg) => new Canvas(size, size, bg).fill(fitMark(visible, c, c), fg);
  const tiles = [
    ...Object.entries(masks).map(([name, mask]) => [name, layers(BLACK, WHITE).clip(mask)]),
    ...Object.entries(themes).map(([name, [bg, fg]]) => [`themed-${name}`, layers(bg, fg).clip(masks.circle)]),
    ['legacy', (() => { const k = new Canvas(size, size); return k.draw(legacyIcon(visible, false), (size - visible) / 2, (size - visible) / 2); })()],
    ['ios', new Canvas(size, size).draw(iosAt(visible).clip(superellipse(visible / 2, visible / 2, visible / 2, 5)), (size - visible) / 2, (size - visible) / 2)],
  ];
  const pad = 24;
  const sheet = new Canvas(tiles.length * (size + pad) + pad, size + 2 * pad, [0x60, 0x60, 0x66, 255]);
  tiles.forEach(([name, tile], i) => {
    writePng(join(dir, `icon-${name}.png`), tile.bytes(false));
    sheet.draw(tile, pad + i * (size + pad), pad);
  });
  writePng(join(dir, 'icon-shapes.png'), sheet.bytes(true));

  // A 412×915 dp phone at 2x. Android 12+: windowSplashScreenAnimatedIcon at 288 dp, centred.
  const [w, h] = [824, 1830];
  writePng(join(dir, 'splash-android.png'), new Canvas(w, h, BLACK).fill(fitMark((288 * 2 * 72) / 108, w / 2, h / 2), WHITE).bytes(true));
  // iOS: the 2732 image, scaleAspectFill into a 390×844 pt phone at 2x.
  const ios = new Canvas(780, 1688, BLACK);
  const scale = 1688 / SPLASH;
  writePng(join(dir, 'splash-ios.png'), ios.fill(fitMark(Math.round(SPLASH * 0.15 * (CLEAR_SIDE / MARK.height)) * scale, 390, 844), WHITE).bytes(true));
}

/** The iOS icon drawn afresh at `side` px, for the preview's squircle. */
const iosAt = (side) => new Canvas(side, side, BLACK).fill(tileMark(side), WHITE);

function writePng(path, image) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(image));
}

// ---------------------------------------------------------------- main

function main(argv) {
  for (const file of SAME_MARK) {
    const other = readMark(readFileSync(join(repo, file), 'utf8'));
    if (JSON.stringify(other.polygons) !== JSON.stringify(MARK.polygons)) throw new Error(`${file} and docs/brand/cezar-icon-black.svg draw different marks`);
  }
  const check = argv.includes('--check');
  const stale = [];
  for (const [path, make] of outputs()) {
    const value = make();
    if (upToDate(path, value)) continue;
    if (check) {
      stale.push(relative(root, path));
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : encodePng(value));
    console.log(`wrote ${relative(root, path)}`);
  }
  const previewDir = argv[argv.indexOf('--previews') + 1];
  if (argv.includes('--previews') && previewDir) previews(previewDir);
  if (stale.length) {
    console.error(`stale brand outputs, run npm run brand:\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
