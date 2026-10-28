import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createServer } from '../server.mjs';

async function fixture(count = 1) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) document.addPage([300, 240]).drawText(`Target compression page ${i + 1}`, { x: 20, y: 180, font, size: 16 });
  const bytes = Buffer.from(await document.save());
  return { file: { name: 'compression.pdf', data: bytes.toString('base64') }, bytes };
}

test('target compression API reports the actual maximum, achieved status and unchanged input when already small', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/api/compress`;
  const post = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const source = await fixture();
  const response = await post({ file: source.file, compression: 'target', targetBytes: 500_000 });
  assert.equal(response.status, 200, response.status === 200 ? '' : await response.text());
  assert.match(response.headers.get('content-type'), /application\/pdf/);
  assert.equal(response.headers.get('x-target-bytes'), '500000');
  assert.equal(response.headers.get('x-target-reached'), 'true');
  assert.equal(response.headers.get('x-compression-method'), 'original');
  assert.equal(response.headers.get('x-rasterized'), 'false');
  assert.equal(Number(response.headers.get('x-input-bytes')), source.bytes.length);
  assert.equal(Number(response.headers.get('x-output-bytes')), source.bytes.length);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), source.bytes);
});

test('unreachable target is an honest downloadable result with retained pages and measured sizes', { timeout: 90_000 }, async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const source = await fixture(4);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/compress`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: source.file, compression: 'target', targetBytes: 1000 }),
  });
  assert.equal(response.status, 200, response.status === 200 ? '' : await response.text());
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get('x-target-reached'), 'false');
  assert.equal(response.headers.get('x-target-bytes'), '1000');
  assert.equal(Number(response.headers.get('x-output-bytes')), bytes.length);
  assert.ok(bytes.length > 1000);
  assert.ok(bytes.length <= source.bytes.length);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 4);
});

test('target size validation reaches the HTTP client as clear input errors', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const source = await fixture();
  for (const targetBytes of [0, 999, 1000.5, true, '500000', 16 * 1024 * 1024 + 1]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/compress`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: source.file, compression: 'target', targetBytes }),
    });
    assert.equal(response.status, 400, `Rejected ${String(targetBytes)}`);
    assert.match((await response.json()).error, /target|size|byte|integer/i);
    assert.equal(response.headers.get('x-target-reached'), null);
  }
});
