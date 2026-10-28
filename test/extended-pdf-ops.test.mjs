import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import {
  annotatePdf, fillPdfForms, flattenPdf, inspectPdfForms, removeMetadataPdf, signPdf,
} from '../src/extended-pdf-ops.mjs';
import { PdfInputError } from '../src/pdf-ops.mjs';

async function fileFrom(document, name = 'source.pdf') {
  return { name, data: Buffer.from(await document.save()).toString('base64') };
}

async function plainFile() {
  const document = await PDFDocument.create();
  document.addPage([400, 600]);
  document.addPage([600, 400]);
  return fileFrom(document);
}

async function formFile() {
  const document = await PDFDocument.create();
  const page = document.addPage([600, 800]);
  const form = document.getForm();
  const name = form.createTextField('customer.name');
  name.setMaxLength(30);
  name.setText('Before');
  name.addToPage(page, { x: 30, y: 700, width: 200, height: 30 });
  const accepted = form.createCheckBox('accepted');
  accepted.addToPage(page, { x: 30, y: 650, width: 20, height: 20 });
  const color = form.createDropdown('color');
  color.setOptions(['Blue', 'Green']);
  color.select('Blue');
  color.addToPage(page, { x: 30, y: 600, width: 200, height: 30 });
  const languages = form.createOptionList('languages');
  languages.setOptions(['English', 'French', 'German']);
  languages.enableMultiselect();
  languages.addToPage(page, { x: 30, y: 480, width: 200, height: 90 });
  const plan = form.createRadioGroup('plan');
  plan.addOptionToPage('Basic', page, { x: 30, y: 440, width: 20, height: 20 });
  plan.addOptionToPage('Extended', page, { x: 100, y: 440, width: 20, height: 20 });
  const locked = form.createTextField('locked');
  locked.setText('Do not edit');
  locked.addToPage(page, { x: 30, y: 390, width: 200, height: 30 });
  locked.enableReadOnly();
  return fileFrom(document);
}

function content(page) {
  const raw = page.node.Contents();
  const streams = raw instanceof PDFArray ? raw.asArray().map((ref) => page.doc.context.lookup(ref, PDFRawStream)) : [raw];
  return streams.map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join('\n');
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let i = 0; i < 8; i += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function imageFile() {
  const chunk = (type, data) => {
    const label = Buffer.from(type);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([label, data])));
    return Buffer.concat([length, label, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return { name: 'signature.png', data: Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 10, 20, 30, 40, 50, 60]))), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64') };
}

test('form inspection distinguishes types, values, options and read-only fields', async () => {
  const inspected = await inspectPdfForms(await formFile());
  assert.equal(inspected.pageCount, 1);
  assert.equal(inspected.fields.length, 6);
  const fields = Object.fromEntries(inspected.fields.map((field) => [field.name, field]));
  assert.equal(fields['customer.name'].type, 'text');
  assert.equal(fields['customer.name'].value, 'Before');
  assert.equal(fields['customer.name'].maxLength, 30);
  assert.equal(fields.accepted.value, false);
  assert.deepEqual(fields.color.options, ['Blue', 'Green']);
  assert.equal(fields.languages.multiselect, true);
  assert.equal(fields.locked.readOnly, true);
  assert.equal(fields.locked.supported, false);
  assert.deepEqual((await inspectPdfForms(await plainFile())).fields, []);
});

test('form filling survives a save/reload for text, checkbox, dropdown, list and radio values', async () => {
  const output = await fillPdfForms(await formFile(), { fields: {
    'customer.name': 'Ada Lovelace', accepted: true, color: 'Green', languages: ['English', 'German'], plan: 'Extended',
  } });
  const form = (await PDFDocument.load(output.bytes)).getForm();
  assert.equal(output.pageCount, 1);
  assert.equal(form.getTextField('customer.name').getText(), 'Ada Lovelace');
  assert.equal(form.getCheckBox('accepted').isChecked(), true);
  assert.deepEqual(form.getDropdown('color').getSelected(), ['Green']);
  assert.deepEqual(form.getOptionList('languages').getSelected(), ['English', 'German']);
  assert.equal(form.getRadioGroup('plan').getSelected(), 'Extended');
  assert.equal(form.getTextField('locked').getText(), 'Do not edit');
  const cleared = await fillPdfForms({ name: 'filled.pdf', data: Buffer.from(output.bytes).toString('base64') }, {
    fields: { color: '', plan: '', languages: [], accepted: false },
  });
  const clearedForm = (await PDFDocument.load(cleared.bytes)).getForm();
  assert.deepEqual(clearedForm.getDropdown('color').getSelected(), []);
  assert.equal(clearedForm.getRadioGroup('plan').getSelected(), undefined);
  assert.deepEqual(clearedForm.getOptionList('languages').getSelected(), []);
  assert.equal(clearedForm.getCheckBox('accepted').isChecked(), false);
});

test('invalid field names, read-only values, booleans and option selections return input errors', async () => {
  const file = await formFile();
  for (const fields of [{ missing: 'x' }, { locked: 'x' }, { accepted: 'true' }, { color: 'Orange' }, { color: ['Blue', 'Green'] }, { plan: ['Basic'] }, { 'customer.name': 'x'.repeat(31) }, {}]) {
    await assert.rejects(() => fillPdfForms(file, { fields }), PdfInputError);
  }
  await assert.rejects(() => fillPdfForms(file, { fields: { 'customer.name': '你好' } }), /Latin/);
});

test('flattening removes interactive fields while retaining their appearances on the page', async () => {
  const file = await formFile();
  const output = await flattenPdf(file);
  const document = await PDFDocument.load(output.bytes);
  assert.equal(document.getForm().getFields().length, 0);
  assert.match(content(document.getPage(0)), /\/FlatWidget-/);
  const resources = document.getPage(0).node.Resources().lookup(PDFName.of('XObject'), PDFDict);
  assert.ok(resources.keys().some((key) => key.toString().startsWith('/FlatWidget-')));
  const filled = await fillPdfForms(file, { fields: { 'customer.name': 'Flat Ada' }, flatten: true });
  assert.equal((await PDFDocument.load(filled.bytes)).getForm().getFields().length, 0);
  assert.equal((await flattenPdf(await plainFile())).pageCount, 2);
});

test('XFA is rejected before the library can silently discard it', async () => {
  const document = await PDFDocument.create();
  document.addPage();
  const form = document.getForm();
  form.acroForm.dict.set(PDFName.of('XFA'), document.context.obj('unsupported XML form'));
  const file = await fileFrom(document);
  for (const operation of [inspectPdfForms, flattenPdf, (input) => fillPdfForms(input, { fields: { x: 'value' } })]) {
    await assert.rejects(() => operation(file), /XFA/);
  }
});

test('document metadata removal removes Info and XMP objects and preserves pages', async () => {
  const document = await PDFDocument.create();
  document.addPage([321, 654]);
  document.setTitle('Private title canary');
  document.setAuthor('Private author canary');
  const metadata = document.context.stream('Private XMP canary', { Type: 'Metadata', Subtype: 'XML' });
  document.catalog.set(PDFName.of('Metadata'), document.context.register(metadata));
  const output = await removeMetadataPdf(await fileFrom(document));
  const loaded = await PDFDocument.load(output.bytes, { updateMetadata: false });
  assert.equal(loaded.context.trailerInfo.Info, undefined);
  assert.equal(loaded.catalog.get(PDFName.of('Metadata')), undefined);
  assert.equal(loaded.context.trailerInfo.ID, undefined);
  assert.deepEqual(loaded.getPage(0).getSize(), { width: 321, height: 654 });
  for (const [, object] of loaded.context.enumerateIndirectObjects()) {
    assert.doesNotMatch(object.toString(), /Private|canary/);
  }
});

test('text annotation uses the selected page, requested color and top-left position', async () => {
  const output = await annotatePdf(await plainFile(), { text: 'Added note', page: 2, x: 20, y: 30, fontSize: 18, color: '#ff0000' });
  const document = await PDFDocument.load(output.bytes);
  assert.equal(document.getPage(0).node.Contents(), undefined);
  const second = content(document.getPage(1));
  assert.match(second, /<4164646564206E6F7465> Tj/i);
  assert.match(second, /1 0 0 rg/);
  assert.match(second, /20 352 Tm/);
  const wrapped = await annotatePdf(await plainFile(), { text: 'Wrap words across a narrow remaining area', x: 300, y: 10, fontSize: 12 });
  assert.ok((content((await PDFDocument.load(wrapped.bytes)).getPage(0)).match(/T\*/g) || []).length > 1);
});

test('text annotation validates fit, page selection, encoding, text size and color', async () => {
  const file = await plainFile();
  for (const options of [
    { text: 'x', page: 3 }, { text: 'x', x: -1 }, { text: 'x', y: 599 }, { text: 'x', fontSize: 0 },
    { text: 'x', color: 'red' }, { text: '' }, { text: '测试' }, { text: 'a'.repeat(4001) },
  ]) await assert.rejects(() => annotatePdf(file, options), PdfInputError);
});

test('signature image is embedded on the selected page with aspect ratio preserved', async () => {
  const output = await signPdf(await plainFile(), { image: imageFile(), page: 2, x: 20, y: 30, width: 100 });
  const document = await PDFDocument.load(output.bytes);
  assert.equal(document.getPage(0).node.Contents(), undefined);
  const second = content(document.getPage(1));
  assert.match(second, /100 0 0 50 0 0 cm/);
  assert.match(second, /1 0 0 1 20 320 cm/);
  assert.match(second, /\/Image-\d+ Do/);
  const file = await plainFile();
  await assert.rejects(() => signPdf(file, { image: imageFile(), width: 1000 }), /does not fit/);
  await assert.rejects(() => signPdf(file, { image: { name: 'fake.png', data: Buffer.from('bad').toString('base64') } }), /valid PNG/);
});

test('all extended operations reject damaged and encrypted PDF inputs', async () => {
  const encrypted = await PDFDocument.create();
  encrypted.addPage();
  encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({ Filter: 'Standard' }));
  const inputs = [{ name: 'bad.pdf', data: Buffer.from('broken').toString('base64') }, await fileFrom(encrypted)];
  const actions = [inspectPdfForms, flattenPdf, removeMetadataPdf,
    (file) => fillPdfForms(file, { fields: { x: 'x' } }),
    (file) => annotatePdf(file, { text: 'x' }), (file) => signPdf(file, { image: imageFile() }),
  ];
  for (const input of inputs) for (const action of actions) await assert.rejects(() => action(input), /damaged or password-protected/);
});
