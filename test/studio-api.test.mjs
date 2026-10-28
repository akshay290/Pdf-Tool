import test from 'node:test';
import assert from 'node:assert/strict';
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib';
import { createServer } from '../server.mjs';

const image = { name: 'pixel.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=' };

async function fixture() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([400, 600]);
  page.setCropBox(10, 20, 380, 560);
  page.setRotation(degrees(90));
  page.drawText('API_ORIGINAL_SECRET', { x: 40, y: 480, size: 18, font });
  page.drawText('API_SIBLING_STAYS', { x: 40, y: 440, size: 16, font });
  document.addPage([600, 400]);
  return { name: 'studio-api.pdf', data: Buffer.from(await document.save()).toString('base64') };
}

test('studio API previews, edits original text and produces real organized/cropped/forms/watermark/signature PDFs', { timeout: 180_000 }, async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function pdfFor(route, body) {
    const response = await post(route, body);
    assert.equal(response.status, 200, `${route}: ${response.status === 200 ? '' : await response.text()}`);
    assert.match(response.headers.get('content-type'), /application\/pdf/);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    const document = await PDFDocument.load(bytes);
    assert.equal(Number(response.headers.get('x-page-count')), document.getPageCount());
    return { bytes, document, file: { name: `${route}.pdf`, data: bytes.toString('base64') } };
  }
  const file = await fixture();
  const preview = await post('preview', { file, pages: [1, 1], dpi: 72 });
  assert.equal(preview.status, 200);
  const rendered = await preview.json();
  assert.equal(rendered.pageCount, 2);
  assert.deepEqual(rendered.pages.map((page) => [page.width, page.height, page.rotation]), [[380, 560, 90], [380, 560, 90]]);
  const png = Buffer.from(rendered.pages[0].data, 'base64');
  assert.equal(png.readUInt32BE(16), 380);
  assert.equal(png.readUInt32BE(20), 560);

  const inspected = await post('text-objects', { file, page: 1 });
  assert.equal(inspected.status, 200);
  const objects = (await inspected.json()).objects;
  const original = objects.find((item) => item.text.includes('API_ORIGINAL_SECRET'));
  assert.ok(original?.editable);
  const edited = await pdfFor('edit', { file, items: [
    { type: 'replace-text', page: 1, objectIndex: original.objectIndex, text: 'API_REPLACED', x: original.x, y: original.y, fontSize: 18 },
    { type: 'line', page: 2, x: 180, y: 40, x2: 20, y2: 100 },
    { type: 'highlight', page: 2, x: 20, y: 150, width: 140, height: 20 },
  ] });
  const extracted = await post('text', { file: edited.file, format: 'txt' });
  assert.equal(extracted.status, 200);
  const text = await extracted.text();
  assert.match(text, /API_REPLACED/);
  assert.match(text, /API_SIBLING_STAYS/);
  assert.doesNotMatch(text, /API_ORIGINAL_SECRET/);

  const second = await PDFDocument.create();
  second.addPage([700, 300]);
  const secondFile = { name: 'second.pdf', data: Buffer.from(await second.save()).toString('base64') };
  const organized = await pdfFor('organize-pages', { files: [file, secondFile], pages: [
    { fileIndex: 1, page: 1, rotation: 0 }, { fileIndex: 0, page: 1, rotation: 90 },
  ] });
  assert.deepEqual(organized.document.getPages().map((page) => page.getWidth()), [700, 400]);
  assert.deepEqual(organized.document.getPages().map((page) => page.getRotation().angle), [0, 180]);
  const cropped = await pdfFor('crop-area', { file, areas: [{ page: 1, x: 10, y: 10, width: 120, height: 160 }] });
  assert.deepEqual(cropped.document.getPage(0).getCropBox(), { x: 20, y: 410, width: 120, height: 160 });

  const form = await pdfFor('forms-create', { file, fields: [
    { name: 'apiName', type: 'text', page: 2, x: 20, y: 20, width: 180, height: 30 },
    { name: 'apiConsent', type: 'checkbox', page: 2, x: 20, y: 70, width: 20, height: 20 },
    { name: 'apiColor', type: 'dropdown', page: 2, x: 20, y: 110, width: 150, height: 30, options: ['Blue', 'Green'] },
    { name: 'apiPlan', type: 'radio', page: 2, x: 20, y: 160, width: 180, height: 50, options: ['Basic', 'Plus'] },
  ] });
  assert.equal(form.document.getForm().getFields().length, 4);
  const formInspect = await post('forms-inspect', { file: form.file });
  assert.equal(formInspect.status, 200);
  assert.equal((await formInspect.json()).fields.length, 4);
  const filled = await pdfFor('forms-fill', { file: form.file, fields: { apiName: 'API Ada', apiConsent: true, apiColor: 'Green', apiPlan: 'Plus' } });
  assert.equal(filled.document.getForm().getTextField('apiName').getText(), 'API Ada');
  assert.equal(filled.document.getForm().getRadioGroup('apiPlan').getSelected(), 'Plus');

  const marked = await pdfFor('image-watermark', { file, image, opacity: 0.25, width: 80, rotation: 20 });
  assert.ok(marked.document.getPages().every((page) => /\/Image-/.test(page.node.Resources().toString())));
  const signed = await pdfFor('typed-signature', { file, text: 'API Ada', page: 2, x: 20, y: 20, width: 160, fontStyle: 'italic' });
  assert.match(signed.document.getPage(1).node.Resources().toString(), /Times-Italic/);

  const badCrop = await post('crop-area', { file, areas: [{ page: 1, x: 300, y: 0, width: 200, height: 30 }] });
  assert.equal(badCrop.status, 400);
  assert.match((await badCrop.json()).error, /Width|beyond/);
  const badObject = await post('edit', { file, items: [{ type: 'replace-text', page: 1, objectIndex: 999, text: 'x' }] });
  assert.equal(badObject.status, 400);
  assert.match((await badObject.json()).error, /not a direct text object/);
});
