import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { pythonExecutable, runPython } from '../src/python-bridge.mjs';

async function fileFor(document) { return { name: 'fixture.pdf', data: Buffer.from(await document.save()).toString('base64') }; }
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=', 'base64');
function archiveContents(data) {
  return JSON.parse(execFileSync(pythonExecutable(), ['-c', 'import base64,io,json,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(base64.b64decode(json.load(sys.stdin)["data"]))); print(json.dumps({"names":z.namelist(),"report":json.loads(z.read("report.json")) if "report.json" in z.namelist() else json.loads(z.read("manifest.json"))}))'], {
    input: JSON.stringify({ data }), encoding: 'utf8', windowsHide: true,
  }));
}

test('previews honor CropBox coordinates and report source rotation without rotating the preview', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([400, 600]);
  page.setCropBox(20, 30, 300, 400); page.setRotation(degrees(90));
  const result = await runPython('preview', { file: await fileFor(document), pages: [1, 1], dpi: 72 });
  assert.equal(result.pageCount, 1);
  assert.equal(result.pages[0].width, 300);
  assert.equal(result.pages[0].height, 400);
  assert.equal(result.pages[0].rotation, 90);
  assert.equal(result.pages[1].rotation, 90);
  const png = Buffer.from(result.pages[0].data, 'base64');
  assert.equal(png.readUInt32BE(16), 300);
  assert.equal(png.readUInt32BE(20), 400);
  await assert.rejects(runPython('preview', { file: await fileFor(document), pages: [2] }), /valid page numbers/);
});

test('embedded image extraction returns actual source image files with a page manifest', async () => {
  const document = await PDFDocument.create();
  const image = await document.embedPng(pixel);
  document.addPage([200, 200]).drawImage(image, { x: 10, y: 10, width: 50, height: 50 });
  const result = await runPython('extract-images', { file: await fileFor(document) });
  const contents = archiveContents(result.data);
  assert.equal(contents.report.images.length, 1);
  assert.equal(contents.report.images[0].page, 1);
  assert.ok(contents.names.some((name) => name.endsWith('.png')));
  const blank = await PDFDocument.create(); blank.addPage();
  await assert.rejects(runPython('extract-images', { file: await fileFor(blank) }), /No embedded raster images/);
});

test('visual comparison identifies a graphics-only change and reports equal PDFs as identical', async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([300, 200]);
  page.drawText('Same text', { x: 20, y: 150, font, size: 16 });
  const before = await fileFor(document);
  // Reload after saving: pdf-lib caches a serialized content stream and does
  // not invalidate that cache when appending to the same stream after save().
  const revised = await PDFDocument.load(Buffer.from(before.data, 'base64'));
  revised.getPage(0).drawRectangle({ x: 30, y: 30, width: 80, height: 40, color: rgb(1, 0, 0) });
  const after = await fileFor(revised);
  const sameText = await runPython('compare', { files: [before, after] });
  assert.match(sameText.text, /No differences/);
  const changed = archiveContents((await runPython('compare-visual', { files: [before, after] })).data);
  assert.ok(changed.report.pages[0].changedPixels > 3000, JSON.stringify(changed.report));
  assert.ok(changed.names.includes('index.html'));
  assert.ok(changed.names.includes('pages/0001-difference.png'));
  const equal = archiveContents((await runPython('compare-visual', { files: [before, before] })).data);
  assert.equal(equal.report.pages[0].changedPixels, 0);
});

test('OCR rasterization supports bounded chunks and retains the total document page count', async () => {
  const document = await PDFDocument.create();
  for (let i = 0; i < 6; i++) document.addPage([100, 100]);
  const result = await runPython('ocr-raster', { file: await fileFor(document), pageStart: 6, pageEnd: 6 });
  assert.equal(result.pageCount, 6);
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].page, 6);
});
