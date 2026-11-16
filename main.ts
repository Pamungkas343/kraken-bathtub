// THE KRAKEN IN THE BATHTUB — ai-excited-01 entry.
// A program (Node 22, standard library only) that draws one image procedurally
// and writes it to /output/entry.png (MAKEFUN_OUTPUT_DIR locally).
// No network, no assets, no image model: every pixel comes from the code below.
// Deterministic: a fixed seed, so two runs write identical bytes.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) + small helpers
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xC0FFEE);

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

type RGB = [number, number, number];
const rgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(lerp(a[0], b[0], t)),
  Math.round(lerp(a[1], b[1], t)),
  Math.round(lerp(a[2], b[2], t)),
];

// ---------------------------------------------------------------------------
// Canvas: internal 2x supersampled RGBA buffer, downsampled to 1024 at the end.
// ---------------------------------------------------------------------------
const W = 1024;
const H = 1024;
const S = 2; // supersample factor
const IW = W * S;
const IH = H * S;

class Canvas {
  buf: Uint8Array;
  constructor() {
    this.buf = new Uint8Array(IW * IH * 4);
  }
  // Blend one internal pixel (ix, iy in 2048 space), alpha 0..255.
  px(ix: number, iy: number, r: number, g: number, b: number, a: number): void {
    if (ix < 0 || iy < 0 || ix >= IW || iy >= IH || a <= 0) return;
    const o = (iy * IW + ix) * 4;
    if (a >= 255) {
      this.buf[o] = r; this.buf[o + 1] = g; this.buf[o + 2] = b; this.buf[o + 3] = 255;
      return;
    }
    const m = 256 - a;
    this.buf[o] = ((r * a + this.buf[o] * m) >> 8);
    this.buf[o + 1] = ((g * a + this.buf[o + 1] * m) >> 8);
    this.buf[o + 2] = ((b * a + this.buf[o + 2] * m) >> 8);
    this.buf[o + 3] = 255;
  }
  // Fill a rect given in 1024 coordinates (scaled internally).
  rect(x: number, y: number, w: number, h: number, c: RGB, a = 255): void {
    const x0 = Math.max(0, Math.floor(x * S));
    const y0 = Math.max(0, Math.floor(y * S));
    const x1 = Math.min(IW, Math.ceil((x + w) * S));
    const y1 = Math.min(IH, Math.ceil((y + h) * S));
    for (let iy = y0; iy < y1; iy++) {
      for (let ix = x0; ix < x1; ix++) this.px(ix, iy, c[0], c[1], c[2], a);
    }
  }
  // Vertical gradient rect (1024 coords), top color -> bottom color.
  vgrad(x: number, y: number, w: number, h: number, top: RGB, bot: RGB, a = 255): void {
    const x0 = Math.max(0, Math.floor(x * S));
    const y0 = Math.max(0, Math.floor(y * S));
    const x1 = Math.min(IW, Math.ceil((x + w) * S));
    const y1 = Math.min(IH, Math.ceil((y + h) * S));
    for (let iy = y0; iy < y1; iy++) {
      const t = (iy / S - y) / h;
      const c = mix(top, bot, clamp(t, 0, 1));
      for (let ix = x0; ix < x1; ix++) this.px(ix, iy, c[0], c[1], c[2], a);
    }
  }
  // Radial gradient disc: center color -> edge color (1024 coords).
  rgrad(cx: number, cy: number, r: number, inner: RGB, outer: RGB, a = 255): void {
    const x0 = Math.max(0, Math.floor((cx - r) * S));
    const y0 = Math.max(0, Math.floor((cy - r) * S));
    const x1 = Math.min(IW, Math.ceil((cx + r) * S));
    const y1 = Math.min(IH, Math.ceil((cy + r) * S));
    const rr = r * S;
    for (let iy = y0; iy < y1; iy++) {
      for (let ix = x0; ix < x1; ix++) {
        const dx = ix - cx * S;
        const dy = iy - cy * S;
        const d = Math.sqrt(dx * dx + dy * dy) / rr;
        if (d > 1) continue;
        const c = mix(inner, outer, d);
        this.px(ix, iy, c[0], c[1], c[2], a);
      }
    }
  }
  // Antialiased filled circle (1024 coords), 1px soft edge in internal space.
  circle(cx: number, cy: number, r: number, c: RGB, a = 255): void {
    const x0 = Math.max(0, Math.floor((cx - r - 1) * S));
    const y0 = Math.max(0, Math.floor((cy - r - 1) * S));
    const x1 = Math.min(IW, Math.ceil((cx + r + 1) * S));
    const y1 = Math.min(IH, Math.ceil((cy + r + 1) * S));
    const ccx = cx * S;
    const ccy = cy * S;
    const rr = r * S;
    for (let iy = y0; iy < y1; iy++) {
      for (let ix = x0; ix < x1; ix++) {
        const dx = ix + 0.5 - ccx;
        const dy = iy + 0.5 - ccy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const cov = clamp(rr + 0.75 - d, 0, 1);
        if (cov <= 0) continue;
        this.px(ix, iy, c[0], c[1], c[2], Math.round(a * cov));
      }
    }
  }
  // Antialiased filled ellipse (1024 coords).
  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 255): void {
    const x0 = Math.max(0, Math.floor((cx - rx - 1) * S));
    const y0 = Math.max(0, Math.floor((cy - ry - 1) * S));
    const x1 = Math.min(IW, Math.ceil((cx + rx + 1) * S));
    const y1 = Math.min(IH, Math.ceil((cy + ry + 1) * S));
    const ccx = cx * S;
    const ccy = cy * S;
    const rrx = rx * S;
    const rry = ry * S;
    for (let iy = y0; iy < y1; iy++) {
      for (let ix = x0; ix < x1; ix++) {
        const dx = (ix + 0.5 - ccx) / rrx;
        const dy = (iy + 0.5 - ccy) / rry;
        const d = Math.sqrt(dx * dx + dy * dy);
        const cov = clamp(1.15 - d, 0, 1);
        if (cov <= 0) continue;
        this.px(ix, iy, c[0], c[1], c[2], Math.round(a * cov));
      }
    }
  }
  // Filled polygon (1024 coords), scanline even-odd. AA comes from 2x downsample.
  poly(pts: Array<[number, number]>, c: RGB, a = 255): void {
    const n = pts.length;
    if (n < 3) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of pts) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const y0 = Math.max(0, Math.floor(minY * S));
    const y1 = Math.min(IH, Math.ceil(maxY * S));
    for (let iy = y0; iy < y1; iy++) {
      const y = (iy + 0.5) / S;
      const xs: number[] = [];
      for (let i = 0; i < n; i++) {
        const [x1, y1p] = pts[i];
        const [x2, y2p] = pts[(i + 1) % n];
        if ((y1p <= y && y2p > y) || (y2p <= y && y1p > y)) {
          xs.push(x1 + ((y - y1p) / (y2p - y1p)) * (x2 - x1));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.floor(xs[k] * S));
        const xb = Math.min(IW, Math.ceil(xs[k + 1] * S));
        for (let ix = xa; ix < xb; ix++) this.px(ix, iy, c[0], c[1], c[2], a);
      }
    }
  }
  // Thick antialiased line segment (1024 coords), round caps.
  line(x1: number, y1: number, x2: number, y2: number, w: number, c: RGB, a = 255): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const hw = w / 2;
    this.poly(
      [
        [x1 + nx * hw, y1 + ny * hw],
        [x2 + nx * hw, y2 + ny * hw],
        [x2 - nx * hw, y2 - ny * hw],
        [x1 - nx * hw, y1 - ny * hw],
      ],
      c,
      a,
    );
    this.circle(x1, y1, hw, c, a);
    this.circle(x2, y2, hw, c, a);
  }
}

// Cubic bezier point.
function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// Sample a cubic bezier curve into points (1024 coords).
function bezierPts(
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number, steps = 28,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push([cubic(x0, x1, x2, x3, t), cubic(y0, y1, y2, y3, t)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Glow layer: shapes drawn white-hot here get blurred and added over the scene.
// ---------------------------------------------------------------------------
class Glow {
  buf: Uint8Array; // single channel, internal 2048 space
  constructor() {
    this.buf = new Uint8Array(IW * IH);
  }
  circle(cx: number, cy: number, r: number, v: number): void {
    const x0 = Math.max(0, Math.floor((cx - r) * S));
    const y0 = Math.max(0, Math.floor((cy - r) * S));
    const x1 = Math.min(IW, Math.ceil((cx + r) * S));
    const y1 = Math.min(IH, Math.ceil((cy + r) * S));
    const ccx = cx * S;
    const ccy = cy * S;
    const rr = r * S;
    for (let iy = y0; iy < y1; iy++) {
      for (let ix = x0; ix < x1; ix++) {
        const dx = ix + 0.5 - ccx;
        const dy = iy + 0.5 - ccy;
        const d = Math.sqrt(dx * dx + dy * dy) / rr;
        if (d >= 1) continue;
        const o = iy * IW + ix;
        const val = Math.round(v * (1 - d * d));
        if (val > this.buf[o]) this.buf[o] = val;
      }
    }
  }
  // Separable box blur, radius in internal pixels (sliding window, O(n)).
  blur(radius: number): void {
    const tmp = new Uint8Array(IW * IH);
    const r = Math.max(1, Math.round(radius));
    const w = 2 * r + 1;
    for (let y = 0; y < IH; y++) {
      let sum = 0;
      const row = y * IW;
      for (let x = -r; x <= r; x++) sum += this.buf[row + clamp(x, 0, IW - 1)];
      for (let x = 0; x < IW; x++) {
        tmp[row + x] = Math.round(sum / w);
        sum += this.buf[row + clamp(x + r + 1, 0, IW - 1)] - this.buf[row + clamp(x - r, 0, IW - 1)];
      }
    }
    for (let x = 0; x < IW; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[clamp(y, 0, IH - 1) * IW + x];
      for (let y = 0; y < IH; y++) {
        this.buf[y * IW + x] = Math.round(sum / w);
        sum += tmp[clamp(y + r + 1, 0, IH - 1) * IW + x] - tmp[clamp(y - r, 0, IH - 1) * IW + x];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PNG encoder (RGBA, filter 0, zlib level 9). Fully deterministic.
// ---------------------------------------------------------------------------
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  dv.setUint32(8 + data.length, crc);
  return out;
}

function filterRow(row: Uint8Array, prev: Uint8Array | null, type: number): Uint8Array {
  const out = new Uint8Array(row.length);
  const bpp = 4;
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    let v = row[i];
    if (type === 1) v = (row[i] - a) & 255;
    else if (type === 2) v = (row[i] - b) & 255;
    else if (type === 3) v = (row[i] - ((a + b) >> 1)) & 255;
    else if (type === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      v = (row[i] - pr) & 255;
    }
    out[i] = v;
  }
  return out;
}

function encodePNG(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = new Uint8Array(h * (1 + w * 4));
  let prev: Uint8Array | null = null;
  for (let y = 0; y < h; y++) {
    const row = rgba.subarray(y * w * 4, (y + 1) * w * 4);
    // Pick the filter whose bytes sum smallest in absolute (signed) value.
    let bestType = 0;
    let bestScore = Infinity;
    let best: Uint8Array | null = null;
    for (let t = 0; t <= 4; t++) {
      const f = filterRow(row, prev, t);
      let score = 0;
      for (let i = 0; i < f.length; i++) {
        const s = f[i] < 128 ? f[i] : f[i] - 256;
        score += s < 0 ? -s : s;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = t;
        best = f;
      }
    }
    raw[y * (1 + w * 4)] = bestType;
    raw.set(best!, y * (1 + w * 4) + 1);
    prev = row;
  }
  const idat = deflateSync(raw, { level: 9 });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Downsample 2048 -> 1024 (2x2 box), then grain + vignette at 1024.
function finish(cv: Canvas, glow: Glow, glowColor: RGB, glowStrength: number): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let gl = 0;
      for (let dy = 0; dy < S; dy++) {
        for (let dx = 0; dx < S; dx++) {
          const ix = x * S + dx;
          const iy = y * S + dy;
          const o = (iy * IW + ix) * 4;
          r += cv.buf[o];
          g += cv.buf[o + 1];
          b += cv.buf[o + 2];
          gl += glow.buf[iy * IW + ix];
        }
      }
      const n = S * S;
      r = Math.round(r / n);
      g = Math.round(g / n);
      b = Math.round(b / n);
      const add = Math.round((gl / n / 255) * glowStrength);
      r = Math.min(255, r + Math.round(add * glowColor[0] / 255));
      g = Math.min(255, g + Math.round(add * glowColor[1] / 255));
      b = Math.min(255, b + Math.round(add * glowColor[2] / 255));
      // Vignette: darken edges.
      const dxn = (x - W / 2) / (W / 2);
      const dyn = (y - H / 2) / (H / 2);
      const d2 = dxn * dxn + dyn * dyn;
      const vig = 1 - 0.22 * Math.max(0, d2 - 0.55);
      // Grain: deterministic, +/-2 (kept small so the PNG stays under 1 MiB).
      const gr = Math.round((rng() - 0.5) * 4);
      const o = (y * W + x) * 4;
      out[o] = clamp(Math.round(r * vig) + gr, 0, 255);
      out[o + 1] = clamp(Math.round(g * vig) + gr, 0, 255);
      out[o + 2] = clamp(Math.round(b * vig) + gr, 0, 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const C = {
  wallTop: rgb('#0a2a36'),
  wallBot: rgb('#145060'),
  grout: rgb('#08222c'),
  floorA: rgb('#d8c8a4'),
  floorB: rgb('#3d6b74'),
  floorLine: rgb('#8a7a5c'),
  tub: rgb('#f2ede1'),
  tubShade: rgb('#b3a98f'),
  tubRim: rgb('#fffdf6'),
  water: rgb('#0d4b5e'),
  waterLight: rgb('#1f8ba0'),
  foam: rgb('#dff3f0'),
  body: rgb('#6e2a86'),
  bodyDark: rgb('#42135e'),
  bodyLight: rgb('#a04bb8'),
  bodyHi: rgb('#cf7ce0'),
  sucker: rgb('#eec9ea'),
  suckerDark: rgb('#8a3f9c'),
  eyeAmber: rgb('#ffb020'),
  eyeDeep: rgb('#e07b00'),
  eyeGlow: rgb('#ffcf5e'),
  pupil: rgb('#160a00'),
  duck: rgb('#ffd93b'),
  duckShade: rgb('#e0a800'),
  beak: rgb('#ff8c1a'),
  moon: rgb('#eaf5ff'),
  ring: rgb('#7a5c2e'),
  splash: rgb('#cfeef2'),
};

// ---------------------------------------------------------------------------
// Scene pieces
// ---------------------------------------------------------------------------
function drawBathroom(cv: Canvas): void {
  cv.vgrad(0, 0, W, 830, C.wallTop, C.wallBot);
  // Tile grout: brick pattern.
  const ts = 88;
  for (let y = 0; y <= 830; y += ts) cv.rect(0, y, W, 2, C.grout, 70);
  for (let row = 0; row * ts <= 830; row++) {
    const off = row % 2 === 0 ? 0 : ts / 2;
    for (let x = off; x <= W; x += ts) cv.rect(x, row * ts, 2, ts, C.grout, 70);
  }
  // Floor: checker bands, rows grow toward the viewer.
  const bands: Array<[number, number]> = [[830, 872], [872, 922], [922, 982], [982, 1024]];
  bands.forEach(([y0, y1], bi) => {
    const n = 8 + bi * 2;
    const cw = W / n;
    for (let i = 0; i < n; i++) {
      const col = (i + bi) % 2 === 0 ? C.floorA : C.floorB;
      cv.rect(i * cw, y0, cw, y1 - y0, col, 255);
    }
    cv.rect(0, y0, W, 2, C.floorLine, 120);
  });
  // Soft shadow under the tub area.
  cv.ellipse(340, 950, 320, 42, rgb('#04141a'), 110);
}

function drawWindow(cv: Canvas, glow: Glow): void {
  const cx = 815;
  const cy = 185;
  const r = 102;
  glow.circle(cx, cy, r + 26, 150);
  cv.circle(cx, cy, r + 12, C.ring, 255);
  cv.circle(cx, cy, r, rgb('#0e3a4a'), 255);
  cv.rgrad(cx - 18, cy - 22, r - 8, rgb('#9fd8ef'), rgb('#1d5a70'), 255);
  cv.circle(cx + 26, cy - 30, 34, C.moon, 255);
  cv.circle(cx + 14, cy - 18, 10, rgb('#c9dcea'), 255);
  cv.circle(cx + 38, cy - 38, 7, rgb('#c9dcea'), 255);
  // Window cross bars.
  cv.rect(cx - r, cy - 3, r * 2, 6, C.ring, 255);
  cv.rect(cx - 3, cy - r, 6, r * 2, C.ring, 255);
}

function drawTubBack(cv: Canvas): void {
  // Water inside the tub (drawn before the kraken rises out of it).
  cv.ellipse(340, 772, 272, 38, C.water, 255);
  cv.ellipse(300, 768, 150, 20, C.waterLight, 130);
  // Foam ring on the water.
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const fx = 340 + Math.cos(a) * (200 + rng() * 60);
    const fy = 772 + Math.sin(a) * (24 + rng() * 8);
    cv.circle(fx, fy, 5 + rng() * 7, C.foam, 200);
  }
}

// Front wall of the tub, drawn OVER the kraken's lower body so the monster
// reads as rising out of the bath, not pasted on top of it.
function drawTubFront(cv: Canvas): void {
  // Claw feet (bronze, clearly visible below the panel).
  cv.circle(150, 955, 30, rgb('#6b4a1f'), 255);
  cv.circle(150, 950, 22, rgb('#a07a35'), 255);
  cv.circle(545, 955, 30, rgb('#6b4a1f'), 255);
  cv.circle(545, 950, 22, rgb('#a07a35'), 255);
  // Front panel.
  cv.ellipse(340, 830, 300, 118, C.tub, 255);
  cv.rect(40, 770, 600, 130, C.tub, 255);
  cv.ellipse(340, 770, 300, 52, C.tubRim, 255);
  // Rim highlight + shading under the rim.
  cv.ellipse(340, 762, 292, 34, rgb('#ffffff'), 160);
  cv.ellipse(340, 800, 296, 40, C.tubShade, 90);
  cv.rect(40, 880, 600, 20, C.tubShade, 60);
  // Panel seam lines + a soft vertical sheen.
  cv.rect(180, 800, 4, 120, C.tubShade, 80);
  cv.rect(500, 800, 4, 120, C.tubShade, 80);
  cv.rect(300, 790, 60, 130, rgb('#ffffff'), 50);
  // Faucet at the left end: pipe, spout, knobs. Instant "bathtub" read.
  cv.rect(84, 660, 16, 110, rgb('#c8c2b2'), 255);
  cv.rect(78, 660, 28, 14, rgb('#8f8875'), 255);
  const spout = bezierPts(92, 664, 92, 640, 130, 636, 148, 652, 14);
  for (let i = 0; i < spout.length - 1; i++) {
    cv.line(spout[i][0], spout[i][1], spout[i + 1][0], spout[i + 1][1], 13, rgb('#c8c2b2'), 255);
  }
  cv.circle(148, 656, 7, rgb('#8f8875'), 255);
  cv.circle(60, 700, 16, rgb('#c8c2b2'), 255);
  cv.circle(60, 700, 8, rgb('#8f8875'), 255);
  cv.circle(128, 700, 16, rgb('#c8c2b2'), 255);
  cv.circle(128, 700, 8, rgb('#8f8875'), 255);
  // Drips from the spout.
  cv.circle(148, 676, 5, C.splash, 220);
  cv.circle(148, 692, 4, C.splash, 180);
}

function drawDuck(cv: Canvas): void {
  const x = 235;
  const y = 742;
  cv.ellipse(x, y, 26, 17, C.duckShade, 255);
  cv.ellipse(x - 2, y - 3, 24, 15, C.duck, 255);
  cv.circle(x + 16, y - 20, 13, C.duck, 255);
  cv.poly([[x + 26, y - 24], [x + 40, y - 19], [x + 26, y - 14]], C.beak, 255);
  cv.circle(x + 19, y - 24, 3, rgb('#1a1a1a'), 255);
  cv.ellipse(x - 4, y - 12, 12, 4, rgb('#fff3ad'), 160);
}

// One tentacle: tapered ribbon along a cubic bezier, segment-wise gradient,
// suckers along one edge, highlight ribbon along the other edge.
function tentacle(
  cv: Canvas,
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  w0: number, w1: number, colBase: RGB, colTip: RGB,
  suckerSide: 1 | -1, suckers: boolean,
): void {
  const pts = bezierPts(x0, y0, x1, y1, x2, y2, x3, y3, 30);
  const n = pts.length;
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[i];
    const [qx, qy] = pts[Math.min(i + 1, n - 1)];
    const [rx, ry] = pts[Math.max(i - 1, 0)];
    let tx = qx - rx;
    let ty = qy - ry;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const t = i / (n - 1);
    const w = lerp(w0, w1, Math.pow(t, 0.8)) / 2;
    left.push([px - ty * w, py + tx * w]);
    right.push([px + ty * w, py - tx * w]);
  }
  // Fill in segments so the color flows base -> tip.
  for (let i = 0; i < n - 1; i++) {
    const t = i / (n - 1);
    const col = mix(colBase, colTip, t);
    cv.poly([left[i], left[i + 1], right[i + 1], right[i]], col, 255);
  }
  // Rounded tip.
  cv.circle(pts[n - 1][0], pts[n - 1][1], w1 / 2, colTip, 255);
  // Highlight: one continuous line along the outer edge (toward the light).
  const hiPts: Array<[number, number]> = [];
  for (let i = 2; i < n - 2; i++) {
    const t = i / (n - 1);
    const w = lerp(w0, w1, Math.pow(t, 0.8));
    const [px, py] = pts[i];
    const [qx, qy] = pts[Math.min(i + 1, n - 1)];
    const [rx, ry] = pts[Math.max(i - 1, 0)];
    let tx = qx - rx;
    let ty = qy - ry;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    hiPts.push([px - ty * w * 0.40 * suckerSide, py + tx * w * 0.40 * suckerSide]);
  }
  for (let i = 0; i < hiPts.length - 1; i++) {
    const t = i / Math.max(1, hiPts.length - 1);
    const w = Math.max(3, lerp(w0, w1, Math.pow(t, 0.8)) * 0.10);
    cv.line(hiPts[i][0], hiPts[i][1], hiPts[i + 1][0], hiPts[i + 1][1], w, C.bodyHi, 130);
  }
  // Suckers along the inner edge.
  if (suckers) {
    for (let i = 4; i < n - 2; i += 3) {
      const t = i / (n - 1);
      const w = lerp(w0, w1, Math.pow(t, 0.8));
      const [px, py] = pts[i];
      const [qx, qy] = pts[Math.min(i + 1, n - 1)];
      const [rx, ry] = pts[Math.max(i - 1, 0)];
      let tx = qx - rx;
      let ty = qy - ry;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const sx = px + ty * w * 0.30 * suckerSide;
      const sy = py - tx * w * 0.30 * suckerSide;
      const sr = Math.max(3, w * 0.16);
      cv.circle(sx, sy, sr, C.suckerDark, 255);
      cv.circle(sx, sy, sr * 0.55, C.sucker, 255);
    }
  }
}

// The tentacle draped over the tub's left edge: drawn AFTER the tub front
// so it hangs in front of the panel instead of being cut by it.
function drawTentacleOverTub(cv: Canvas): void {
  tentacle(cv, 430, 700, 310, 770, 220, 800, 155, 830, 40, 12, C.body, C.bodyLight, -1, true);
}

function drawKraken(cv: Canvas, glow: Glow): void {
  // Body mass: a clear dome-shaped head (mantle) rising out of the tub,
  // with a darker skirt below so the creature has a readable shape.
  // Dark rim first so the dome separates from the wall; the eye sits
  // fully inside the dome (its top used to poke out and read as a sun).
  cv.ellipse(540, 600, 172, 157, C.bodyDark, 255);
  cv.ellipse(540, 700, 175, 120, C.bodyDark, 255);
  cv.ellipse(540, 600, 165, 150, C.body, 255);
  cv.ellipse(505, 545, 95, 80, C.bodyLight, 200);
  cv.ellipse(470, 505, 55, 42, C.bodyHi, 140);
  // Mantle spots for texture.
  for (let i = 0; i < 12; i++) {
    const a = rng() * Math.PI * 2;
    const d = 40 + rng() * 110;
    cv.circle(540 + Math.cos(a) * d * 0.9, 600 + Math.sin(a) * d * 0.7, 5 + rng() * 8, C.bodyDark, 120);
  }
  // Small mouth below the eye.
  cv.ellipse(545, 665, 30, 12, rgb('#2a0a38'), 220);

  // Tentacles, back to front.
  tentacle(cv, 470, 660, 330, 520, 210, 360, 150, 215, 46, 10, C.bodyDark, C.bodyLight, -1, true);
  tentacle(cv, 560, 640, 700, 430, 880, 300, 955, 215, 44, 9, C.body, C.bodyLight, 1, true);
  tentacle(cv, 520, 640, 520, 420, 545, 250, 600, 140, 42, 8, C.bodyDark, C.bodyHi, -1, true);
  tentacle(cv, 620, 650, 760, 560, 860, 620, 830, 760, 38, 10, C.bodyDark, C.bodyLight, 1, true);
  // Foreground tentacle sweeping toward the viewer, bottom-right.
  tentacle(cv, 600, 720, 760, 790, 855, 830, 880, 905, 62, 14, C.body, C.bodyHi, 1, true);

  // The eye: one huge amber eye staring out. Glow behind it.
  const ex = 545;
  const ey = 520;
  glow.circle(ex, ey, 95, 170);
  cv.ellipse(ex, ey, 74, 62, rgb('#2a0a38'), 255);
  cv.circle(ex, ey, 56, C.eyeDeep, 255);
  cv.circle(ex, ey, 46, C.eyeAmber, 255);
  cv.circle(ex - 6, ey - 6, 34, rgb('#ffcf5e'), 220);
  cv.ellipse(ex, ey, 13, 40, C.pupil, 255);
  cv.circle(ex - 18, ey - 20, 12, rgb('#ffffff'), 235);
  cv.circle(ex + 10, ey + 16, 5, rgb('#ffffff'), 140);
  // Brow ridge shadow above the eye.
  cv.ellipse(ex, ey - 62, 78, 20, C.bodyDark, 200);
}

function drawSplash(cv: Canvas): void {
  // Exploding droplets, clustered near the tub rim (not scattered everywhere).
  for (let i = 0; i < 42; i++) {
    const cx = 100 + rng() * 520;
    const cy = 700 - rng() * rng() * 260;
    cv.circle(cx, cy, 2 + rng() * 7, C.splash, 150 + Math.floor(rng() * 80));
  }
  // A few curved water arcs bursting out of the tub, varied heights.
  for (let i = 0; i < 5; i++) {
    const x0 = 130 + rng() * 560;
    const y0 = 730 + rng() * 20;
    const apexX = x0 + (rng() - 0.5) * 200;
    const apexY = y0 - 70 - rng() * 160;
    const x1 = apexX + (rng() - 0.5) * 120;
    const y1 = y0 - 20 - rng() * 60;
    const pts = bezierPts(x0, y0, x0, apexY, apexX, apexY, x1, y1, 10);
    for (let k = 0; k < pts.length - 1; k++) {
      cv.line(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], 3 + rng() * 2, C.splash, 170);
    }
  }
  // Bubbles rising close to the water only.
  for (let i = 0; i < 18; i++) {
    const x = 120 + rng() * 460;
    const y = 700 - rng() * 180;
    const r = 3 + rng() * 8;
    cv.circle(x, y, r, C.foam, 120);
    cv.circle(x - r * 0.3, y - r * 0.3, r * 0.35, rgb('#ffffff'), 200);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  const t0 = Date.now();
  const cv = new Canvas();
  const glow = new Glow();
  drawBathroom(cv);
  drawWindow(cv, glow);
  drawTubBack(cv);
  drawKraken(cv, glow);
  drawTubFront(cv);
  drawTentacleOverTub(cv);
  drawSplash(cv);
  drawDuck(cv);
  glow.blur(14);
  const rgba = finish(cv, glow, C.eyeGlow, 150);
  const png = encodePNG(rgba, W, H);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'entry.png'), png);
  const ms = Date.now() - t0;
  console.log(`wrote entry.png: ${png.length} bytes, ${W}x${H}, ${ms} ms`);
}

main();
