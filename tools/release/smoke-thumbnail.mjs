/**
 * Thumbnail smoke test of a `cellhive-api` image (tools/release/smoke.sh): renders WebP
 * thumbnails of a generated PNG with the worker's own `renderThumbnails`, so sharp loads
 * the libvips binary the image installed for its architecture (`@img/sharp-linuxmusl-arm64`
 * on arm64). Run inside the image: `node --input-type=module - < smoke-thumbnail.mjs`.
 */
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { crc32, deflateSync } from 'node:zlib';

const WORKER = '/app/node_modules/@cellhive/worker/dist/thumbnails/render-thumbnails.js';
const WIDTH = 320;
const HEIGHT = 240;
const SIZES = [64, 256];

/** One PNG chunk: length, type, data, CRC-32 of type + data. */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A WIDTH × HEIGHT 8-bit RGB gradient. */
function png() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(HEIGHT * (1 + WIDTH * 3));
  for (let y = 0; y < HEIGHT; y += 1) {
    const row = y * (1 + WIDTH * 3);
    for (let x = 0; x < WIDTH; x += 1) {
      rows.set([x % 256, y % 256, (x + y) % 256], row + 1 + x * 3);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function fail(message) {
  process.stderr.write(`thumbnail smoke test failed: ${message}\n`);
  process.exit(1);
}

const { renderThumbnails } = await import(WORKER);
const result = await renderThumbnails(png(), SIZES);
if (!result.ok) fail(`no thumbnail (${result.reason})`);
const sizes = result.thumbnails.map((thumbnail) => thumbnail.size);
if (sizes.join() !== SIZES.join()) fail(`sizes ${sizes.join()} instead of ${SIZES.join()}`);
for (const { size, data } of result.thumbnails) {
  const webp =
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!webp) fail(`the ${String(size)} px thumbnail is not a WebP image`);
}
process.stdout.write(
  `thumbnails ${result.thumbnails.map(({ size, data }) => `${String(size)} px: ${String(data.length)} B`).join(', ')} ` +
    `(${process.platform}/${process.arch})\n`,
);
