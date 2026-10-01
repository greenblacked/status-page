// Bakes the displacement map behind the board's liquid-glass lenses.
//
// It writes public/lens-map.png: a 128 x 128, 8-bit RGB PNG (about 17 KB) that
// describes one circular lens. The red channel is the horizontal shift and the
// green channel the vertical one, 128 meaning none, which is what
// feDisplacementMap reads (see src/components/status/lens-field.tsx). Inside
// the circle the sample offset pulls toward the centre (a magnified core) and
// pinches back out toward the rim (the bezel). Outside it, and in the blue
// channel, every value is neutral.
//
// The output is deterministic: no dependencies, no randomness, the same bytes
// on every run.
//
//   node scripts/lens-map.mjs                   writes public/lens-map.png
//   node scripts/lens-map.mjs --stdout > f.png  writes the PNG to stdout
//   node scripts/lens-map.mjs 64                a different size, for experiments
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const args = process.argv.slice(2);
const toStdout = args.includes("--stdout");
const size = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 128);

// How far the encoded range reaches, as a fraction of the lens radius.
const MAX_DISPLACEMENT = 0.5;

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = ~0;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return ~c >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
const smoothstep = (from, to, x) => {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

const rowBytes = size * 3 + 1;
const raw = Buffer.alloc(rowBytes * size);
for (let y = 0; y < size; y++) {
  raw[y * rowBytes] = 0; // filter type: none
  for (let x = 0; x < size; x++) {
    const vx = ((x + 0.5) / size) * 2 - 1;
    const vy = ((y + 0.5) / size) * 2 - 1;
    const r = Math.hypot(vx, vy);
    // Sample offset as a fraction of the position vector: negative pulls
    // toward the centre (magnifies), positive pushes out (pinches).
    const k = r < 1 ? -0.22 * (1 - r * r) + 0.42 * smoothstep(0.72, 1, r) ** 2 : 0;
    const dx = (vx * k) / MAX_DISPLACEMENT;
    const dy = (vy * k) / MAX_DISPLACEMENT;
    const offset = y * rowBytes + 1 + x * 3;
    raw[offset] = Math.round(128 + dx * 127);
    raw[offset + 1] = Math.round(128 + dy * 127);
    raw[offset + 2] = 128;
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8; // bit depth
header[9] = 2; // colour type: truecolour RGB
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

if (toStdout) {
  process.stdout.write(png);
} else {
  const target = fileURLToPath(new URL("../public/lens-map.png", import.meta.url));
  writeFileSync(target, png);
  console.error(`${target}: ${size}x${size}, ${png.length} bytes`);
}
