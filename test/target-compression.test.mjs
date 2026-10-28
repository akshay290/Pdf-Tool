import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { runPython } from '../src/python-bridge.mjs';

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let index = 0; index < 8; index += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function noisePng(alpha = false, width = 320, height = 240) {
  const channels = alpha ? 4 : 3;
  const rows = Buffer.alloc(height * (1 + width * channels));
  let seed = 123456789;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * (1 + width * channels) + 1 + x * channels;
      for (let channel = 0; channel < 3; channel += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        rows[offset + channel] = seed >>> 24;
      }
      if (alpha) rows[offset + 3] = x % 13 ? 255 : 200;
    }
  }
  const chunk = (type, data) => {
    const label = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([label, data])));
    return Buffer.concat([length, label, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

async function richFixture({ alpha = false, pages = 2, form = false } = {}) {
  const document = await PDFDocument.create();
  const image = await document.embedPng(noisePng(alpha));
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = document.addPage([360, 280]);
    page.drawImage(image, { x: 20, y: 20, width: 320, height: 240 });
    page.drawText(`Selectable source page ${index + 1}`, { x: 20, y: 260, size: 10, font });
  }
  if (form) {
    const field = document.getForm().createTextField('customer');
    field.setText('Ada');
    field.addToPage(document.getPage(0), { x: 20, y: 5, width: 90, height: 12 });
  }
  return { name: 'image-rich.pdf', data: Buffer.from(await document.save()).toString('base64') };
}

function checkResult(result, target, originalBytes) {
  const bytes = Buffer.from(result.data, 'base64');
  assert.equal(result.targetBytes, target);
  assert.equal(result.inputBytes, originalBytes);
  assert.equal(result.outputBytes, bytes.length);
  assert.equal(result.targetReached, bytes.length <= target);
  assert.ok(bytes.length <= originalBytes);
  assert.equal(result.reduced, bytes.length < originalBytes);
  assert.ok(Number.isInteger(result.attempts) && result.attempts <= 24);
  assert.ok(result.resultMessage.length > 20);
  return bytes;
}

test('target maximum preserves an already-small original, including documents above the raster page cap', { timeout: 120_000 }, async () => {
  const document = await PDFDocument.create();
  for (let index = 0; index < 45; index += 1) document.addPage([100, 100]);
  const raw = Buffer.from(await document.save());
  const target = raw.length + 1000;
  const result = await runPython('compress', { file: { name: 'already-small.pdf', data: raw.toString('base64') }, compression: 'target', targetBytes: target });
  assert.deepEqual(checkResult(result, target, raw.length), raw);
  assert.equal(result.compressionMethod, 'original');
  assert.equal(result.rasterized, false);
  assert.equal(result.attempts, 0);
  assert.equal(result.pageCount, 45);
  assert.equal(result.qualityDpi, null);
  assert.equal(result.qualityJpeg, null);
});

test('target search prefers lossless compression and preserves selectable source text', { timeout: 120_000 }, async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 8; index += 1) document.addPage([360, 280]).drawText(`Lossless selectable text page ${index + 1}`, { x: 20, y: 180, font, size: 12 });
  // A stale unreferenced stream models document-editing residue that can be
  // removed without changing visible content. Normal compact PDFs may not shrink.
  document.context.register(document.context.stream(Buffer.from('obsolete editing residue\n'.repeat(2000))));
  const raw = Buffer.from(await document.save({ useObjectStreams: false }));
  const file = { name: 'lossless-source.pdf', data: raw.toString('base64') };
  const lossless = await runPython('compress', { file, compression: 'lossless' });
  assert.ok(lossless.outputBytes < raw.length);
  const result = await runPython('compress', { file, compression: 'target', targetBytes: lossless.outputBytes });
  const bytes = checkResult(result, lossless.outputBytes, raw.length);
  assert.equal(result.targetReached, true);
  assert.equal(result.compressionMethod, 'lossless');
  assert.equal(result.rasterized, false);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 8);
  const text = await runPython('text', { file: { name: 'result.pdf', data: result.data } });
  assert.match(text.text, /Lossless selectable text page 8/);
});

test('opaque image optimization reaches a real maximum while preserving text and form fields', { timeout: 120_000 }, async () => {
  const file = await richFixture({ form: true });
  const original = Buffer.from(file.data, 'base64');
  const target = 80_000;
  assert.ok(original.length > target);
  const result = await runPython('compress', { file, compression: 'target', targetBytes: target });
  const bytes = checkResult(result, target, original.length);
  assert.equal(result.targetReached, true);
  assert.equal(result.compressionMethod, 'image-jpeg');
  assert.equal(result.rasterized, false);
  assert.ok(result.qualityJpeg >= 35 && result.qualityJpeg <= 95);
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 2);
  assert.equal(document.getForm().getTextField('customer').getText(), 'Ada');
  const text = await runPython('text', { file: { name: 'result.pdf', data: result.data } });
  assert.match(text.text, /Selectable source page 2/);
});

test('raster fallback reaches a feasible maximum with page count and quality floor reported', { timeout: 120_000 }, async () => {
  const file = await richFixture({ alpha: true, pages: 1 });
  const original = Buffer.from(file.data, 'base64');
  const target = 45_000;
  const result = await runPython('compress', { file, compression: 'target', targetBytes: target });
  const bytes = checkResult(result, target, original.length);
  assert.equal(result.targetReached, true);
  assert.equal(result.compressionMethod, 'raster-jpeg');
  assert.equal(result.rasterized, true);
  assert.ok(result.qualityDpi >= 72 && result.qualityDpi <= 144);
  assert.ok(result.qualityJpeg >= 35 && result.qualityJpeg <= 95);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  assert.match(result.resultMessage, /Selectable text.*removed/);
});

test('impossible maxima and oversized-page-count searches return honest closest valid files', { timeout: 120_000 }, async () => {
  const file = await richFixture({ alpha: true, pages: 1 });
  const raw = Buffer.from(file.data, 'base64');
  const impossible = await runPython('compress', { file, compression: 'target', targetBytes: 1000 });
  const closest = checkResult(impossible, 1000, raw.length);
  assert.equal(impossible.targetReached, false);
  assert.match(impossible.resultMessage, /could not be reached/);
  assert.match(impossible.resultMessage, /72 DPI.*35/);
  assert.equal((await PDFDocument.load(closest)).getPageCount(), 1);
  const large = await richFixture({ pages: 41 });
  const capped = await runPython('compress', { file: large, compression: 'target', targetBytes: 1000 });
  checkResult(capped, 1000, Buffer.from(large.data, 'base64').length);
  assert.equal(capped.targetReached, false);
  assert.equal(capped.rasterized, false);
  assert.match(capped.resultMessage, /40 pages.*Split/s);
  assert.equal((await PDFDocument.load(Buffer.from(capped.data, 'base64'))).getPageCount(), 41);
});

test('target maximum rejects missing, non-integer, string, boolean and out-of-range byte values', { timeout: 120_000 }, async () => {
  const document = await PDFDocument.create(); document.addPage([100, 100]);
  const file = { name: 'validation.pdf', data: Buffer.from(await document.save()).toString('base64') };
  for (const targetBytes of [undefined, null, true, false, '1000', 999, 16_777_217, 1000.5, {}, []]) {
    await assert.rejects(() => runPython('compress', { file, compression: 'target', targetBytes }), /whole number/);
  }
});
