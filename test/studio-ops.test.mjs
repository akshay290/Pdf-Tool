import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { decodePDFRawStream, degrees, PDFArray, PDFDocument, PDFRawStream, StandardFonts } from 'pdf-lib';
import { cropAreas, createFormFields, editPdf, imageWatermark, organizePages, typedSignature } from '../src/studio-ops.mjs';
import { fillPdfForms } from '../src/extended-pdf-ops.mjs';
import { PdfInputError } from '../src/pdf-ops.mjs';
import { pythonExecutable, runPython } from '../src/python-bridge.mjs';

async function fileFrom(document, name = 'source.pdf') {
  return { name, data: Buffer.from(await document.save()).toString('base64') };
}

async function sourceFile() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const first = document.addPage([400, 600]);
  first.drawText('ORIGINALSECRET123', { x: 40, y: 480, font, size: 18 });
  first.drawText('SIBLING_REMAINS', { x: 40, y: 440, font, size: 16 });
  first.drawRectangle({ x: 40, y: 350, width: 100, height: 20 });
  first.setCropBox(10, 20, 380, 560);
  const second = document.addPage([600, 400]);
  second.drawText('SECOND_PAGE', { x: 40, y: 300, font, size: 18 });
  return fileFrom(document);
}

function streams(document) {
  return document.getPages().map((page) => {
    const raw = page.node.Contents();
    if (!raw) return '';
    const parts = raw instanceof PDFArray ? raw.asArray().map((ref) => page.doc.context.lookup(ref, PDFRawStream)) : [raw];
    return parts.map((part) => Buffer.from(decodePDFRawStream(part).decode()).toString()).join('\n');
  });
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let index = 0; index < 8; index += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function imageFile() {
  const chunk = (type, data) => {
    const label = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([label, data])));
    return Buffer.concat([length, label, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return { name: 'mark.png', data: Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0, 100, 200]))), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64') };
}

async function textOf(bytes) {
  return (await runPython('text', { file: { name: 'result.pdf', data: Buffer.from(bytes).toString('base64') }, format: 'txt' })).text;
}

async function objectsOf(file, page = 1) {
  return (await runPython('studio-text-objects', { file, page })).objects;
}

test('cross-file organization preserves selected page order, sizes, crops and independent rotations', async () => {
  const second = await PDFDocument.create();
  second.addPage([700, 300]);
  second.addPage([800, 250]);
  const result = await organizePages({ files: [await sourceFile(), await fileFrom(second)], pages: [
    { fileIndex: 1, page: 2, rotation: 90 }, { fileIndex: 0, page: 1 }, { fileIndex: 1, page: 1, rotation: 180 },
  ] });
  const loaded = await PDFDocument.load(result.bytes);
  assert.deepEqual(loaded.getPages().map((page) => page.getSize()), [{ width: 800, height: 250 }, { width: 400, height: 600 }, { width: 700, height: 300 }]);
  assert.deepEqual(loaded.getPages().map((page) => page.getRotation().angle), [90, 0, 180]);
  assert.deepEqual(loaded.getPage(1).getCropBox(), { x: 10, y: 20, width: 380, height: 560 });
  await assert.rejects(async () => organizePages({ files: [await sourceFile()], pages: [{ fileIndex: 1, page: 1 }] }), PdfInputError);
});

test('crop rectangles use the selected page top-left crop coordinates and retain other pages', async () => {
  const file = await sourceFile();
  const output = await cropAreas({ file, areas: [{ page: 1, x: 10, y: 30, width: 100, height: 200 }] });
  const loaded = await PDFDocument.load(output.bytes);
  assert.deepEqual(loaded.getPage(0).getCropBox(), { x: 20, y: 350, width: 100, height: 200 });
  assert.deepEqual(loaded.getPage(1).getCropBox(), { x: 0, y: 0, width: 600, height: 400 });
  await assert.rejects(() => cropAreas({ file, areas: [{ page: 1, x: 300, y: 0, width: 100, height: 100 }] }), /beyond/);
  await assert.rejects(() => cropAreas({ file, areas: [null] }), PdfInputError);
});

test('visual editor writes actual text, paths, highlights and fitted images into the requested page', async () => {
  const output = await editPdf({ file: await sourceFile(), items: [
    { type: 'text', page: 2, x: 20, y: 20, width: 160, height: 60, text: 'Added studio note', fontSize: 14 },
    { type: 'rectangle', page: 2, x: 200, y: 20, width: 80, height: 30, color: '#ff0000' },
    { type: 'ellipse', page: 2, x: 300, y: 20, width: 80, height: 30, color: '#00ff00' },
    { type: 'line', page: 2, x: 20, y: 100, width: 150, height: 0 },
    { type: 'highlight', page: 2, x: 20, y: 150, width: 150, height: 20 },
    { type: 'image', page: 2, x: 250, y: 150, width: 100, height: 100, image: imageFile() },
  ] });
  const loaded = await PDFDocument.load(output.bytes);
  const second = streams(loaded)[1];
  assert.match(second, /41646465642073747564696F206E6F7465/i);
  assert.match(second, /0 30 l\n80 30 l\n80 0 l\nh/);
  assert.match(second, /\bc\b/);
  assert.match(second, /\bl\b/);
  assert.match(second, /\/Image-\d+ Do/);
  assert.match(loaded.getPage(1).node.Resources().toString(), /\/ca 0\.3/);
  assert.match(streams(loaded)[0], /4F524947494E414C534543524554313233/i);
});

test('image watermarks are centered on every page with rotation and opacity', async () => {
  const output = await imageWatermark({ file: await sourceFile(), image: imageFile(), width: 100, rotation: 20, opacity: 0.25 });
  const loaded = await PDFDocument.load(output.bytes);
  for (const page of loaded.getPages()) {
    assert.match(streams(loaded)[loaded.getPageIndices().find((index) => loaded.getPage(index) === page)], /\/Image-\d+ Do/);
    assert.match(page.node.Resources().toString(), /\/ca 0\.25/);
  }
});

test('new text, checkbox, dropdown and radio fields remain fillable after save and reload', async () => {
  const created = await createFormFields({ file: await sourceFile(), fields: [
    { name: 'fullName', type: 'text', page: 2, x: 20, y: 20, width: 180, height: 30 },
    { name: 'accepted', type: 'checkbox', page: 2, x: 20, y: 70, width: 20, height: 20 },
    { name: 'color', type: 'dropdown', page: 2, x: 20, y: 110, width: 150, height: 30, options: ['Red', 'Blue'] },
    { name: 'plan', type: 'radio', page: 2, x: 20, y: 160, width: 180, height: 50, options: ['Basic', 'Plus'] },
  ] });
  const fields = (await PDFDocument.load(created.bytes)).getForm();
  assert.equal(fields.getFields().length, 4);
  assert.deepEqual(fields.getDropdown('color').getOptions(), ['Red', 'Blue']);
  assert.deepEqual(fields.getRadioGroup('plan').getOptions(), ['Basic', 'Plus']);
  const filled = await fillPdfForms({ name: 'created.pdf', data: Buffer.from(created.bytes).toString('base64') }, {
    fields: { fullName: 'Ada', accepted: true, color: 'Blue', plan: 'Plus' },
  });
  const reloaded = (await PDFDocument.load(filled.bytes)).getForm();
  assert.equal(reloaded.getTextField('fullName').getText(), 'Ada');
  assert.equal(reloaded.getRadioGroup('plan').getSelected(), 'Plus');
});

test('typed signatures produce readable name text in the selected style', async () => {
  const output = await typedSignature({ file: await sourceFile(), text: 'Ada Lovelace', page: 2, x: 20, y: 20, width: 180, fontStyle: 'italic' });
  const loaded = await PDFDocument.load(output.bytes);
  assert.match(loaded.getPage(1).node.Resources().toString(), /Times-Italic/);
  assert.match(streams(loaded)[1], /416461204C6F76656C616365/i);
});

test('existing text replacement removes original operators and extracted text while preserving siblings', { timeout: 120_000 }, async () => {
  const file = await sourceFile();
  const original = (await objectsOf(file)).find((item) => item.text.includes('ORIGINALSECRET123'));
  assert.ok(original?.editable);
  const output = await editPdf({ file, items: [{ type: 'replace-text', page: 1, objectIndex: original.objectIndex, text: 'REPLACED_TEXT', x: original.x, y: original.y, fontSize: 18 }] });
  const text = await textOf(output.bytes);
  assert.match(text, /REPLACED_TEXT/);
  assert.match(text, /SIBLING_REMAINS/);
  assert.doesNotMatch(text, /ORIGINALSECRET123/);
  const operators = streams(await PDFDocument.load(output.bytes)).join('\n');
  assert.doesNotMatch(operators, /ORIGINALSECRET123|4F524947494E414C534543524554313233/i);
  const outputObjects = await objectsOf({ name: 'result.pdf', data: Buffer.from(output.bytes).toString('base64') });
  assert.equal(outputObjects.length, 2);
});

async function embeddedFixture() {
  const script = `import base64,io\nfrom pathlib import Path\nfrom reportlab.pdfgen import canvas\nfrom reportlab.pdfbase import pdfmetrics\nfrom reportlab.pdfbase.ttfonts import TTFont\nfont=next(p for p in [Path('C:/Windows/Fonts/arial.ttf'),Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')] if p.is_file())\npdfmetrics.registerFont(TTFont('StudioFixture',str(font)))\nb=io.BytesIO(); c=canvas.Canvas(b,pagesize=(400,600));c.setFont('StudioFixture',18);c.drawString(40,480,'Embedded Original');c.drawString(40,440,'Embedded Sibling');c.save();print(base64.b64encode(b.getvalue()).decode())`;
  const data = await new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable(), ['-c', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
  });
  return { name: 'embedded.pdf', data };
}

test('embedded-font Latin text uses real object replacement with an embedded substitution font', { timeout: 120_000 }, async () => {
  const file = await embeddedFixture();
  const original = (await objectsOf(file)).find((item) => item.text.includes('Embedded Original'));
  assert.ok(original?.editable);
  assert.equal(original.fontSubstitution, true);
  const output = await editPdf({ file, items: [{ type: 'replace-text', page: 1, objectIndex: original.objectIndex, text: 'Voilà Æther', x: original.x, y: original.y, fontSize: 18 }] });
  const text = await textOf(output.bytes);
  assert.match(text, /Voilà\sÆther/);
  assert.match(text, /Embedded Sibling/);
  assert.doesNotMatch(text, /Embedded Original/);
});

test('complex transforms, missing object indices and complex script replacements fail honestly', { timeout: 120_000 }, async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([400, 600]);
  page.drawText('Rotated text', { x: 100, y: 100, font, size: 18, rotate: degrees(45) });
  const file = await fileFrom(document);
  const rotated = (await objectsOf(file))[0];
  assert.equal(rotated.editable, false);
  await assert.rejects(() => editPdf({ file, items: [{ type: 'replace-text', page: 1, objectIndex: rotated.objectIndex, text: 'replacement' }] }), /Rotated|skewed|reflected/);
  const ordinary = await sourceFile();
  await assert.rejects(() => editPdf({ file: ordinary, items: [{ type: 'replace-text', page: 1, objectIndex: 999, text: 'x' }] }), /not a direct text object/);
  await assert.rejects(() => editPdf({ file: ordinary, items: [{ type: 'replace-text', page: 1, objectIndex: 0, text: 'हिंदी' }] }), /Complex script/);
});

test('oversize CropBox operations and text inspection share the visible media intersection', { timeout: 120_000 }, async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([400, 600]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('Visible object', { x: 40, y: 480, size: 18, font });
  page.setCropBox(-20, -30, 450, 680);
  const file = await fileFrom(document);
  const crop = await cropAreas({ file, areas: [{ page: 1, x: 10, y: 20, width: 100, height: 200 }] });
  assert.deepEqual((await PDFDocument.load(crop.bytes)).getPage(0).getCropBox(), { x: 10, y: 380, width: 100, height: 200 });
  const objects = await objectsOf(file);
  assert.ok(objects[0].x >= 39 && objects[0].x <= 41);
  assert.ok(objects[0].y >= 100 && objects[0].y <= 120);
  const mark = await imageWatermark({ file, image: imageFile(), width: 100 });
  assert.match(streams(await PDFDocument.load(mark.bytes))[0], /1 0 0 1 150 275 cm/);
});

test('line endpoints preserve negative slopes, horizontal and vertical directions within page bounds', async () => {
  const file = await sourceFile();
  const output = await editPdf({ file, items: [
    { type: 'line', page: 2, x: 180, y: 40, x2: 20, y2: 100, width: 160, height: 60 },
    { type: 'line', page: 2, x: 180, y: 120, x2: 20, y2: 120 },
    { type: 'line', page: 2, x: 200, y: 200, x2: 200, y2: 130 },
  ] });
  const operators = streams(await PDFDocument.load(output.bytes))[1];
  assert.match(operators, /180 360 m\n180 360 m\n20 300 l/);
  assert.match(operators, /180 280 m\n180 280 m\n20 280 l/);
  assert.match(operators, /200 200 m\n200 200 m\n200 270 l/);
  await assert.rejects(() => editPdf({ file, items: [{ type: 'line', page: 2, x: 20, y: 20, x2: -1, y2: 20 }] }), /Line end X/);
});

test('oversized encoded image dimensions are rejected before decompression', async () => {
  const image = imageFile();
  const bytes = Buffer.from(image.data, 'base64');
  bytes.writeUInt32BE(100_000, 16); bytes.writeUInt32BE(100_000, 20);
  const oversized = { name: 'oversized.png', data: bytes.toString('base64') };
  await assert.rejects(async () => imageWatermark({ file: await sourceFile(), image: oversized }), /12 million pixels/);
});
