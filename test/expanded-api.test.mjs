import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createServer } from '../server.mjs';

const pixel = { name: 'pixel.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=' };

test('expanded API returns working PDF editing, security, conversion and text downloads', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  const page = source.addPage([612, 792]);
  for (const x of [40, 280, 440]) page.drawLine({ start: { x, y: 610 }, end: { x, y: 730 }, thickness: 1 });
  for (const y of [610, 650, 690, 730]) page.drawLine({ start: { x: 40, y }, end: { x: 440, y }, thickness: 1 });
  [['Item', 'Qty'], ['Paper', '2'], ['Pen', '4']].forEach((row, r) => row.forEach((text, c) => page.drawText(text, { x: [48, 288][c], y: 705 - r * 40, size: 12, font })));
  const field = source.getForm().createTextField('Customer');
  field.setText('Before'); field.addToPage(page, { x: 40, y: 500, width: 200, height: 30 });
  const file = { name: 'table-and-form.pdf', data: Buffer.from(await source.save()).toString('base64') };
  const post = (route, body) => fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function download(route, body, type, suffix) {
    const response = await post(route, body);
    assert.equal(response.status, 200, `${route}: ${response.status === 200 ? '' : await response.text()}`);
    assert.match(response.headers.get('content-type'), type, route);
    assert.match(response.headers.get('content-disposition'), new RegExp(`\\.${suffix}"$`));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(Number(response.headers.get('x-page-count')) > 0);
    return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  }
  const fields = await post('forms-inspect', { file });
  assert.equal(fields.status, 200);
  assert.equal((await fields.json()).fields[0].name, 'Customer');
  for (const [route, body] of [
    ['flatten', { file }], ['metadata', { file }],
    ['annotate', { file, text: 'Approved', page: 1, x: 30, y: 40, fontSize: 18, color: '#008060' }],
    ['sign', { file, image: pixel, page: 1, x: 30, y: 40, width: 80 }],
    ['forms-fill', { file, fields: { Customer: 'After' }, flatten: false }],
    ['repair', { file }], ['compress', { file, compression: 'lossless' }],
    ['html', { html: '<h1>Local HTML conversion</h1><p>Offline document.</p>' }],
  ]) {
    const result = await download(route, body, /application\/pdf/, 'pdf');
    const pdf = await PDFDocument.load(result.bytes);
    assert.equal(pdf.getPageCount(), 1, route);
    if (route === 'flatten') assert.equal(pdf.getForm().getFields().length, 0);
    if (route === 'forms-fill') assert.equal(pdf.getForm().getTextField('Customer').getText(), 'After');
    if (route === 'compress') assert.ok(Number(result.response.headers.get('x-output-bytes')) <= Number(result.response.headers.get('x-input-bytes')));
  }
  const locked = await download('protect', { file, password: 'api-test-password' }, /application\/pdf/, 'pdf');
  const encrypted = { name: 'protected.pdf', data: locked.bytes.toString('base64') };
  const wrong = await post('unlock', { file: encrypted, password: 'incorrect' });
  assert.equal(wrong.status, 400);
  const unlocked = await download('unlock', { file: encrypted, password: 'api-test-password' }, /application\/pdf/, 'pdf');
  assert.equal((await PDFDocument.load(unlocked.bytes)).isEncrypted, false);
  const zip = await download('render', { file, format: 'png', dpi: 72 }, /application\/zip/, 'zip');
  assert.equal(zip.bytes.readUInt32LE(0), 0x04034b50);
  const text = await download('text', { file, format: 'txt' }, /text\/plain/, 'txt');
  assert.match(text.bytes.toString(), /Paper/);
  const compared = await download('compare', { files: [file, file] }, /text\/markdown/, 'md');
  assert.match(compared.bytes.toString(), /No differences/);
  for (const [route, subtype] of [['docx', 'wordprocessingml.document'], ['pptx', 'presentationml.presentation'], ['xlsx', 'spreadsheetml.sheet']]) {
    const converted = await download(route, { file }, new RegExp(subtype.replaceAll('.', '\\.')), route);
    assert.equal(converted.bytes.readUInt32LE(0), 0x04034b50);
    if (route === 'docx') {
      const office = await download('office', { file: { name: 'roundtrip.docx', data: converted.bytes.toString('base64') } }, /application\/pdf/, 'pdf');
      assert.equal((await PDFDocument.load(office.bytes)).getPageCount(), 1);
    }
  }
  const ocr = await download('ocr', { file }, /application\/pdf/, 'pdf');
  const searchable = { name: 'searchable.pdf', data: ocr.bytes.toString('base64') };
  const extracted = await download('text', { file: searchable }, /text\/plain/, 'txt');
  assert.match(extracted.bytes.toString(), /Paper/);
});
