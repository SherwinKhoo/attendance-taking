// Generate PWA icons as solid-colour PNGs with a centred letter "A".
// Pure Node, no external deps. Pixel buffers are encoded as a minimal PNG via
// zlib (built-in). Output:
//   icons/icon-192.png            — 192x192, navy bg + white "A"
//   icons/icon-512.png            — 512x512, same
//   icons/icon-maskable-512.png   — 512x512 with safe-zone padding (80% inset)
//
// To regenerate:  node scripts/generate-icons.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { Buffer } from "node:buffer";

const BG = [0x0f, 0x17, 0x2a, 0xff]; // #0f172a slate-900
const FG = [0xe2, 0xe8, 0xf0, 0xff]; // #e2e8f0 slate-200

mkdirSync("icons", { recursive: true });

function crc32Table() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC_TABLE = crc32Table();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0; // filter: none
    rgba.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(filtered);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Letter 'A' built from a 7x7 bitmap blown up to fill a circle inset.
const A_BITMAP = [
  "..XXX..",
  ".X...X.",
  "X.....X",
  "X.....X",
  "XXXXXXX",
  "X.....X",
  "X.....X",
];

function fillRgba(width, height) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4 + 0] = BG[0];
    buf[i * 4 + 1] = BG[1];
    buf[i * 4 + 2] = BG[2];
    buf[i * 4 + 3] = BG[3];
  }
  return buf;
}

function paintLetterA(buf, width, height, scale) {
  const charW = 7;
  const charH = 7;
  const pxW = Math.floor(width * scale / charW);
  const offsetX = Math.floor((width - pxW * charW) / 2);
  const offsetY = Math.floor((height - pxW * charH) / 2);

  for (let cy = 0; cy < charH; cy++) {
    for (let cx = 0; cx < charW; cx++) {
      if (A_BITMAP[cy][cx] !== "X") continue;
      for (let yy = 0; yy < pxW; yy++) {
        for (let xx = 0; xx < pxW; xx++) {
          const px = offsetX + cx * pxW + xx;
          const py = offsetY + cy * pxW + yy;
          if (px < 0 || px >= width || py < 0 || py >= height) continue;
          const i = (py * width + px) * 4;
          buf[i + 0] = FG[0];
          buf[i + 1] = FG[1];
          buf[i + 2] = FG[2];
          buf[i + 3] = FG[3];
        }
      }
    }
  }
}

function makeIcon(size, opts = {}) {
  const buf = fillRgba(size, size);
  // Maskable icons need a safe zone — keep the letter inside ~80% of the area.
  const scale = opts.maskable ? 0.45 : 0.6;
  paintLetterA(buf, size, size, scale);
  return encodePng(size, size, buf);
}

writeFileSync("icons/icon-192.png", makeIcon(192));
writeFileSync("icons/icon-512.png", makeIcon(512));
writeFileSync("icons/icon-maskable-512.png", makeIcon(512, { maskable: true }));

console.log("Wrote icons/icon-192.png, icons/icon-512.png, icons/icon-maskable-512.png");
