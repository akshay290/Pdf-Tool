import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from 'pdf-lib';
import { cropPdf, imagesToPdf, numberPdf, organizePdf, watermarkPdf } from '../src/advanced-pdf-ops.mjs';
import { PdfInputError } from '../src/pdf-ops.mjs';

async function makeFile() {
  const document = await PDFDocument.create();
  for (const size of [[200, 300], [400, 500], [600, 700]]) document.addPage(size);
  return { name: 'source.pdf', data: Buffer.from(await document.save()).toString('base64') };
}

function contentText(page) {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray
    ? contents.asArray().map((reference) => page.doc.context.lookup(reference, PDFRawStream))
    : [contents];
  return streams.map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join('\n');
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let index = 0; index < 8; index += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const label = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([label, data])));
  return Buffer.concat([length, label, data, checksum]);
}

// Generate a complete two-pixel RGB PNG rather than relying on an external file.
function makePng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return {
    name: 'red-blue.png',
    data: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 0, 0, 255]))),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64'),
  };
}

// Original 2 x 1 red/blue JPEG, generated locally with the Windows image encoder.
const jpeg = {
  name: 'red-blue.jpg',
  data: '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD4H8Q/8h/Uv+vmX/0M0UUV/ptkP/Ipwn/XuH/pKPAzr/kZ4r/r5P8A9KZ//9k=',
};

test('organizes pages in selected order, permits independent duplicates, and preserves sizes', async () => {
  const result = await organizePdf(await makeFile(), { pages: [3, 1, 3], rotations: [90, 0, 180] });
  const document = await PDFDocument.load(result.bytes);
  assert.equal(result.pageCount, 3);
  assert.deepEqual(document.getPages().map((page) => page.getSize()), [
    { width: 600, height: 700 }, { width: 200, height: 300 }, { width: 600, height: 700 },
  ]);
  assert.deepEqual(document.getPages().map((page) => page.getRotation().angle), [90, 0, 180]);
  const extraction = await organizePdf(await makeFile(), { pages: [2] });
  assert.equal((await PDFDocument.load(extraction.bytes)).getPageCount(), 1);
});

test('organize rejects invalid bounds, empty selections, and inconsistent rotations', async () => {
  const file = await makeFile();
  for (const pages of [[], [0], [4], [1.5], ['1']]) {
    await assert.rejects(() => organizePdf(file, { pages }), PdfInputError);
  }
  await assert.rejects(() => organizePdf(file, { pages: [1], rotations: [45] }), /rotation/);
  await assert.rejects(() => organizePdf(file, { pages: [1, 2], rotations: [90] }), /rotation/);
});

test('watermarks every page with requested text and opacity', async () => {
  const result = await watermarkPdf(await makeFile(), { text: 'DRAFT', opacity: 0.25 });
  const document = await PDFDocument.load(result.bytes);
  assert.equal(document.getPageCount(), 3);
  for (const page of document.getPages()) {
    assert.match(contentText(page), /<4452414654> Tj/);
    assert.match(page.node.Resources().toString(), /\/ca 0\.25/);
  }
  await assert.rejects(async () => watermarkPdf(await makeFile(), { text: '' }), PdfInputError);
  await assert.rejects(async () => watermarkPdf(await makeFile(), { text: 'DRAFT', opacity: 2 }), /opacity/);
  await assert.rejects(async () => watermarkPdf(await makeFile(), { text: '测试' }), /Latin letters/);
});

test('page numbers start with the requested number and advance in output content', async () => {
  const result = await numberPdf(await makeFile(), { startNumber: 7 });
  const document = await PDFDocument.load(result.bytes);
  const pages = document.getPages();
  assert.match(contentText(pages[0]), /<37> Tj/);
  assert.match(contentText(pages[1]), /<38> Tj/);
  assert.match(contentText(pages[2]), /<39> Tj/);
  await assert.rejects(async () => numberPdf(await makeFile(), { startNumber: 0 }), PdfInputError);
  await assert.rejects(async () => numberPdf(await makeFile(), { startNumber: 1.1 }), PdfInputError);
});

test('crop trims every visible edge without removing the original media box', async () => {
  const file = await makeFile();
  const result = await cropPdf(file, { margin: 10 });
  const document = await PDFDocument.load(result.bytes);
  assert.deepEqual(document.getPage(0).getCropBox(), { x: 10, y: 10, width: 180, height: 280 });
  assert.deepEqual(document.getPage(0).getMediaBox(), { x: 0, y: 0, width: 200, height: 300 });
  assert.deepEqual(document.getPage(2).getCropBox(), { x: 10, y: 10, width: 580, height: 680 });
  await assert.rejects(() => cropPdf(file, { margin: 100 }), /too large/);
  await assert.rejects(() => cropPdf(file, { margin: -1 }), /margin/);
});

test('images become ordered pages with embedded PNG and JPEG data', async () => {
  const result = await imagesToPdf([makePng(), jpeg]);
  const document = await PDFDocument.load(result.bytes);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(document.getPages().map((page) => page.getSize()), [
    { width: 842, height: 595 }, { width: 842, height: 595 },
  ]);
  const firstResources = document.getPage(0).node.Resources().toString();
  const secondResources = document.getPage(1).node.Resources().toString();
  assert.match(firstResources, /\/Image-/);
  assert.match(secondResources, /\/Image-/);
  assert.match(contentText(document.getPage(0)), /\/Image-\d+ Do/);
  await assert.rejects(() => imagesToPdf([]), /Choose between/);
  await assert.rejects(() => imagesToPdf([{ ...makePng(), name: 'fake.jpg' }]), /valid JPG/);
  await assert.rejects(() => imagesToPdf([{ name: 'broken.png', data: 'not base64!' }]), /could not be read/);
  await assert.rejects(() => imagesToPdf([{ ...makePng(), name: 'bad.gif' }]), /filename/);
});

test('additional operations reject malformed PDFs and oversized inputs', async () => {
  const broken = { name: 'bad.pdf', data: Buffer.from('not a PDF').toString('base64') };
  await assert.rejects(() => organizePdf(broken, { pages: [1] }), /damaged or password-protected/);
  const oversized = { name: 'big.png', data: 'A'.repeat(Math.ceil(16 * 1024 * 1024 * 4 / 3) + 12) };
  await assert.rejects(() => imagesToPdf([oversized]), /16 MB/);
});

test('every added PDF operation rejects documents marked as encrypted', async () => {
  const document = await PDFDocument.create();
  document.addPage();
  // The encrypted trailer is sufficient to exercise pdf-lib's encryption guard.
  // No password or encryption bypass is provided to the loader.
  document.context.trailerInfo.Encrypt = document.context.register(document.context.obj({ Filter: 'Standard' }));
  const file = { name: 'encrypted.pdf', data: Buffer.from(await document.save()).toString('base64') };
  const actions = [
    () => organizePdf(file, { pages: [1] }),
    () => watermarkPdf(file, { text: 'DRAFT' }),
    () => numberPdf(file, { startNumber: 1 }),
    () => cropPdf(file, { margin: 10 }),
  ];
  for (const action of actions) await assert.rejects(action, /password-protected/);
});
