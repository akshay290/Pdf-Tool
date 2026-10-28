import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { createServer } from '../server.mjs';

test('advanced API routes produce readable PDFs and reject invalid selections', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  const source = await PDFDocument.create();
  source.addPage([200, 300]); source.addPage([400, 500]);
  const file = { name: 'api-fixture.pdf', data: Buffer.from(await source.save()).toString('base64') };
  async function post(route, body) {
    return fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  for (const [route, body, expectedPages] of [
    ['organize', { file, pages: [2, 1, 2] }, 3],
    ['watermark', { file, text: 'DRAFT', opacity: 0.3 }, 2],
    ['number', { file, startNumber: 8 }, 2],
    ['crop', { file, margin: 10 }, 2],
    ['images', { files: [{ name: 'pixel.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=' }] }, 1],
  ]) {
    const response = await post(route, body);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type'), /application\/pdf/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(Number(response.headers.get('x-page-count')), expectedPages);
    const output = await PDFDocument.load(await response.arrayBuffer());
    assert.equal(output.getPageCount(), expectedPages);
    if (route === 'organize') assert.deepEqual(output.getPages().map((page) => page.getWidth()), [400, 200, 400]);
    if (route === 'crop') assert.deepEqual(output.getPage(0).getCropBox(), { x: 10, y: 10, width: 180, height: 280 });
  }
  const badSelection = await post('organize', { file, pages: [3] });
  assert.equal(badSelection.status, 400);
  assert.match((await badSelection.json()).error, /between 1 and 2/);
  const invalidBody = await post('merge', null);
  assert.equal(invalidBody.status, 400);
});
