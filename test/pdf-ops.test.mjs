import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { inspectFiles, mergePdfs, rotatePdf, splitPdf } from '../src/pdf-ops.mjs';
import { createServer } from '../server.mjs';

async function makeFile(name, count, size = [612, 792]) {
  const doc = await PDFDocument.create();
  for (let index = 0; index < count; index += 1) doc.addPage(size);
  return { name, data: Buffer.from(await doc.save()).toString('base64') };
}

async function readPdf(bytes) {
  return PDFDocument.load(bytes);
}

test('merges PDFs in input order and reports the combined page count', async () => {
  const files = [await makeFile('first.pdf', 2, [220, 300]), await makeFile('second.pdf', 1, [500, 700])];
  const result = await mergePdfs(files);
  const output = await readPdf(result.bytes);
  assert.equal(result.pageCount, 3);
  assert.equal(output.getPageCount(), 3);
  assert.deepEqual(output.getPages().map((page) => page.getWidth()), [220, 220, 500]);
});

test('splits page ranges into separate PDFs and rejects out-of-range pages', async () => {
  const file = await makeFile('report.pdf', 5);
  const outputs = await splitPdf(file, '1-2, 4, 5');
  assert.deepEqual(outputs.map((output) => output.pageCount), [2, 1, 1]);
  assert.deepEqual(outputs.map((output) => output.name), ['report-pages-1-2.pdf', 'report-pages-4.pdf', 'report-pages-5.pdf']);
  await assert.rejects(() => splitPdf(file, '1-6'), /must stay between 1 and 5/);
});

test('rotates every page while keeping the original page count', async () => {
  const file = await makeFile('pages.pdf', 2);
  const result = await rotatePdf(file, 90);
  const output = await readPdf(result.bytes);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(output.getPages().map((page) => page.getRotation().angle), [90, 90]);
});

test('local API inspects PDFs and exposes its health status', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${base}/api/health`);
  assert.deepEqual(await health.json(), { ok: true, service: 'LocalFold', storage: 'local-processing', temporaryFiles: 'office-conversion-only' });
  const homepage = await fetch(base);
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /LocalFold — Private PDF tools/);
  const first = await makeFile('first.pdf', 2);
  const second = await makeFile('second.pdf', 1);
  const inspected = await fetch(`${base}/api/inspect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [await makeFile('sample.pdf', 3)] }),
  });
  assert.equal(inspected.status, 200);
  assert.equal((await inspected.json()).files[0].pageCount, 3);

  const merged = await fetch(`${base}/api/merge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [first, second] }),
  });
  assert.equal(merged.status, 200);
  assert.equal((await PDFDocument.load(await merged.arrayBuffer())).getPageCount(), 3);

  const split = await fetch(`${base}/api/split`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: first, ranges: '1, 2' }),
  });
  const splitPayload = await split.json();
  assert.equal(split.status, 200);
  assert.deepEqual(splitPayload.outputs.map((output) => output.pageCount), [1, 1]);

  const rotated = await fetch(`${base}/api/rotate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: first, rotation: 90 }),
  });
  assert.equal(rotated.status, 200);
  const rotatedPdf = await PDFDocument.load(await rotated.arrayBuffer());
  assert.deepEqual(rotatedPdf.getPages().map((page) => page.getRotation().angle), [90, 90]);
});
