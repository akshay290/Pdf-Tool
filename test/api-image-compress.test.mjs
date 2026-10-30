import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createServer } from '../server.mjs';

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function png(width = 240, height = 160, noise = false) {
  const chunk = (type, data) => {
    const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  let seed = 123456;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    for (let c = 0; c < 3; c += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels[offset + c] = noise ? seed >>> 24 : [20, 100, 180][c];
    }
    pixels[offset + 3] = x < width / 4 ? 0 : 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function api(t) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return (body) => fetch(`http://127.0.0.1:${server.address().port}/api/compress-image`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('image compression API retains an already-small transparent original and supplies measured download metadata', { timeout: 30_000 }, async (t) => {
  const post = await api(t), bytes = png();
  const response = await post({ file: { name: 'sample.png', data: bytes.toString('base64') }, targetBytes: 500_000, outputFormat: 'auto' });
  assert.equal(response.status, 200, response.status === 200 ? '' : await response.text());
  assert.match(response.headers.get('content-type'), /image\/png/);
  assert.match(response.headers.get('content-disposition'), /localfold-compressed\.png/);
  assert.equal(response.headers.get('x-target-reached'), 'true');
  assert.equal(response.headers.get('x-target-bytes'), '500000');
  assert.equal(response.headers.get('x-compression-method'), 'original');
  assert.equal(response.headers.get('x-image-width'), '240');
  assert.equal(response.headers.get('x-image-height'), '160');
  assert.equal(response.headers.get('x-image-frames'), '1');
  assert.equal(response.headers.get('x-image-resized'), 'false');
  assert.equal(Number(response.headers.get('x-output-bytes')), bytes.length);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test('image compression API returns actual WebP bytes under a feasible target with matching image metadata', { timeout: 95_000 }, async (t) => {
  const post = await api(t), bytes = png(320, 240, true), targetBytes = 18_000;
  const response = await post({ file: { name: 'noise.png', data: bytes.toString('base64') }, targetBytes, outputFormat: 'webp' });
  assert.equal(response.status, 200, response.status === 200 ? '' : await response.text());
  const output = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get('x-target-reached'), 'true');
  assert.match(response.headers.get('content-type'), /image\/webp/);
  assert.equal(response.headers.get('x-image-format'), 'webp');
  assert.equal(output.toString('ascii', 0, 4), 'RIFF');
  assert.equal(output.toString('ascii', 8, 12), 'WEBP');
  assert.equal(Number(response.headers.get('x-output-bytes')), output.length);
  assert.equal(Number(response.headers.get('x-input-bytes')), bytes.length);
  assert.ok(output.length <= targetBytes && output.length < bytes.length);
  assert.ok(Number(response.headers.get('x-image-width')) <= 320);
  assert.ok(Number(response.headers.get('x-image-height')) <= 240);
});

test('image compression API rejects invalid targets, unsafe inputs and transparency-losing JPG requests', { timeout: 65_000 }, async (t) => {
  const post = await api(t), file = { name: 'transparent.png', data: png().toString('base64') };
  for (const targetBytes of [undefined, 999, 1000.5, true, '50000', 16 * 1024 * 1024 + 1]) {
    const response = await post({ file, targetBytes });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /target|maximum|byte/i);
  }
  for (const badFile of [{ name: 'bad.png', data: 'invalid!' }, { name: 'fake.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') }]) {
    const response = await post({ file: badFile, targetBytes: 5000 });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('x-target-reached'), null);
  }
  const response = await post({ file, targetBytes: 5000, outputFormat: 'jpeg' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /transparency/i);
});
