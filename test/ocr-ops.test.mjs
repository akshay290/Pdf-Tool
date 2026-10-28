import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { localOcrOptions, ocrPdf, OCR_LANGUAGES } from '../src/ocr-ops.mjs';
import { pythonExecutable, runPython } from '../src/python-bridge.mjs';

async function makeFile(document, name = 'scan.pdf') {
  return { name, data: Buffer.from(await document.save()).toString('base64') };
}

test('OCR reads image-only pages, adds searchable text, and preserves page sizes', { timeout: 120_000 }, async () => {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  const sizes = [[640, 180], [420, 220]];
  for (const [index, size] of sizes.entries()) {
    const page = source.addPage(size);
    page.drawText(index === 0 ? 'LocalFold privacy' : 'Searchable PDF test', {
      x: 30, y: 100, size: 32, font,
    });
  }
  const raster = await runPython('ocr-raster', { file: await makeFile(source, 'printed.pdf') });
  const scanned = await PDFDocument.create();
  for (const image of raster.pages) {
    const page = scanned.addPage([image.width, image.height]);
    page.drawImage(await scanned.embedJpg(Uint8Array.from(Buffer.from(image.data, 'base64'))), {
      x: 0, y: 0, width: image.width, height: image.height,
    });
  }
  const imageOnlyFile = await makeFile(scanned);
  const originalText = await runPython('text', { file: imageOnlyFile, format: 'txt' });
  assert.equal(originalText.text.trim(), '', 'the fixture must contain images without a text layer');

  const result = await ocrPdf(imageOnlyFile);
  const output = await PDFDocument.load(result.bytes);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(output.getPages().map((page) => [page.getWidth(), page.getHeight()]), sizes);
  const extracted = await runPython('text', {
    file: { name: 'searchable.pdf', data: Buffer.from(result.bytes).toString('base64') }, format: 'txt',
  });
  assert.match(extracted.text, /privacy/i);
  assert.match(extracted.text, /searchable/i);
});

test('OCR rejects long PDFs and malformed input before starting recognition', async () => {
  const document = await PDFDocument.create();
  for (let index = 0; index < 51; index += 1) document.addPage([200, 200]);
  await assert.rejects(ocrPdf(await makeFile(document)), /1 to 50 pages/);
  await assert.rejects(ocrPdf({ name: 'bad.pdf', data: Buffer.from('invalid PDF').toString('base64') }), /readable PDF/);
});

test('OCR supports installed languages and processes documents across the five-page chunk boundary', { timeout: 120_000 }, async () => {
  assert.deepEqual(Object.keys(OCR_LANGUAGES), ['eng', 'hin', 'spa', 'fra', 'deu', 'por']);
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 6; index += 1) document.addPage([300, 100]).drawText('Bonjour le monde', { x: 15, y: 45, size: 20, font });
  const result = await ocrPdf(await makeFile(document), { language: 'fra' });
  assert.equal(result.language, 'fra');
  assert.equal(result.pageCount, 6);
  const extracted = await runPython('text', { file: { name: 'french.pdf', data: Buffer.from(result.bytes).toString('base64') }, format: 'txt' });
  assert.equal((extracted.text.match(/Bonjour/gi) || []).length, 6);
  await assert.rejects(ocrPdf(await makeFile(document), { language: '../../model' }), /Choose English/);
});

test('OCR paths resolve to local packages and a local model directory', () => {
  const options = localOcrOptions();
  for (const path of [options.langPath, options.workerPath, options.corePath]) {
    assert.equal(isAbsolute(path), true);
    assert.doesNotMatch(path, /^https?:/);
  }
  assert.equal(options.gzip, false);
  assert.equal(options.cacheMethod, 'none');
});

test('OCR recognizes a small ruled table and its PDF form appearance', { timeout: 120_000 }, async () => {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  const page = source.addPage([612, 792]);
  for (const x of [40, 280, 440]) page.drawLine({ start: { x, y: 610 }, end: { x, y: 730 }, thickness: 1 });
  for (const y of [610, 650, 690, 730]) page.drawLine({ start: { x: 40, y }, end: { x: 440, y }, thickness: 1 });
  [['Item', 'Qty'], ['Paper', '2'], ['Pen', '4']].forEach((row, r) => row.forEach((text, c) => page.drawText(text, {
    x: [48, 288][c], y: 705 - r * 40, size: 12, font,
  })));
  const field = source.getForm().createTextField('Customer');
  field.setText('Before');
  field.addToPage(page, { x: 40, y: 500, width: 200, height: 30 });
  const result = await ocrPdf(await makeFile(source));
  const extracted = await runPython('text', { file: { name: 'recognized.pdf', data: Buffer.from(result.bytes).toString('base64') }, format: 'txt' });
  assert.match(extracted.text, /Paper/);
  assert.match(extracted.text, /2/);
  assert.match(extracted.text, /Before/);
});

test('French OCR reads accented words from a real Arial image-only scan', { timeout: 120_000 }, async () => {
  const script = `
import base64, io, os, sys
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
font = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "arial.ttf"
pdfmetrics.registerFont(TTFont("LocalArial", str(font)))
stream = io.BytesIO()
document = canvas.Canvas(stream, pagesize=(640,180))
document.setFont("LocalArial", 28)
document.drawString(30, 90, "Café français, été à Paris")
document.save()
sys.stdout.write(base64.b64encode(stream.getvalue()).decode("ascii"))
`;
  const source = { name: 'french-arial.pdf', data: execFileSync(pythonExecutable(), ['-c', script], { encoding: 'utf8', windowsHide: true }).trim() };
  const raster = await runPython('ocr-raster', { file: source, pageStart: 1, pageEnd: 1 });
  const scanned = await PDFDocument.create();
  const image = raster.pages[0];
  scanned.addPage([image.width, image.height]).drawImage(await scanned.embedJpg(Uint8Array.from(Buffer.from(image.data, 'base64'))), {
    x: 0, y: 0, width: image.width, height: image.height,
  });
  const result = await ocrPdf(await makeFile(scanned), { language: 'fra' });
  assert.equal(result.language, 'fra');
  const extracted = await runPython('text', { file: { name: 'french-ocr.pdf', data: Buffer.from(result.bytes).toString('base64') }, format: 'txt' });
  assert.match(extracted.text, /café/i);
  assert.match(extracted.text, /français/i);
  assert.match(extracted.text, /été/i);
});
