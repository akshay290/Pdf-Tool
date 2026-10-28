import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { officeToPdf } from '../src/office-ops.mjs';
import { PdfInputError } from '../src/pdf-ops.mjs';
import { runPython } from '../src/python-bridge.mjs';

// Original, minimal OOXML fixtures avoid any runtime authoring dependencies.
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let i = 0; i < 8; i += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [filename, contents] of Object.entries(entries)) {
    const name = Buffer.from(filename);
    const data = Buffer.from(contents);
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10); record.writeUInt32LE(checksum, 16); record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';

function packageEntries(extension) {
  const main = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[extension];
  const type = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  }[extension];
  const entries = {
    '_rels/.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="${main}"/></Relationships>`,
  };
  let extraTypes = '';
  if (extension === 'docx') {
    entries[main] = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>LocalFold Word conversion canary</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
  } else if (extension === 'xlsx') {
    entries[main] = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE}"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    entries['xl/_rels/workbook.xml.rels'] = `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
    entries['xl/worksheets/sheet1.xml'] = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="60" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>LocalFold Excel conversion canary</t></is></c></row><row r="2"><c r="A2"><v>42</v></c></row></sheetData></worksheet>';
    extraTypes = '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
  } else {
    entries[main] = `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
    entries['ppt/_rels/presentation.xml.rels'] = `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE}/slide" Target="slides/slide1.xml"/></Relationships>`;
    entries['ppt/slides/slide1.xml'] = '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="500000"/><a:ext cx="8000000" cy="2000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400"/><a:t>LocalFold PowerPoint conversion canary</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
    extraTypes = '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>';
  }
  entries['[Content_Types].xml'] = `<Types xmlns="${TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="${type}"/>${extraTypes}</Types>`;
  return entries;
}

function fixture(extension, additions = {}) {
  return { name: `test.${extension}`, data: zip({ ...packageEntries(extension), ...additions }).toString('base64') };
}

async function extractedText(bytes) {
  return (await runPython('text', { file: { name: 'converted.pdf', data: Buffer.from(bytes).toString('base64') }, format: 'txt' })).text;
}

test('real DOCX, XLSX and PPTX conversions produce PDFs containing their authored text', { timeout: 300_000 }, async () => {
  const before = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith('localfold-office-')));
  for (const [extension, expected] of [['docx', 'Word'], ['xlsx', 'Excel'], ['pptx', 'PowerPoint']]) {
    const output = await officeToPdf(fixture(extension));
    assert.ok(output.pageCount >= 1 && output.pageCount <= 200);
    assert.equal((await PDFDocument.load(output.bytes)).getPageCount(), output.pageCount);
    assert.match(await extractedText(output.bytes), new RegExp(`LocalFold ${expected} conversion canary`));
  }
  const after = (await readdir(os.tmpdir())).filter((name) => name.startsWith('localfold-office-') && !before.has(name));
  assert.deepEqual(after, [], 'Per-conversion input, output and profile folders must be removed.');
});

test('Office conversion rejects unsupported inputs, package macros and fetching external relationships', { timeout: 45_000 }, async () => {
  const ordinary = fixture('docx');
  for (const file of [null, { ...ordinary, name: 'macro.docm' }, { ...ordinary, name: 'legacy.doc' }, { name: 'bad.docx', data: '!!not-base64!!' }, { name: 'bad.docx', data: Buffer.from('not a ZIP').toString('base64') }]) {
    await assert.rejects(() => officeToPdf(file), PdfInputError);
  }
  const macros = fixture('docx', { 'word/vbaProject.bin': 'macro canary' });
  await assert.rejects(() => officeToPdf(macros), /macro|active|executable|embedded/i);
  const external = fixture('docx', { 'word/_rels/document.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="external" Type="${OFFICE}/image" Target="http://127.0.0.1:1/never-fetch" TargetMode="External"/></Relationships>` });
  await assert.rejects(() => officeToPdf(external), /external|link/i);
});

test('Office task queue accepts one waiting conversion and rejects a third task', { timeout: 210_000 }, async () => {
  const first = officeToPdf(fixture('docx'));
  const second = officeToPdf(fixture('xlsx'));
  await assert.rejects(() => officeToPdf(fixture('pptx')), (error) => error instanceof PdfInputError && error.status === 429);
  const outputs = await Promise.all([first, second]);
  assert.equal(outputs.length, 2);
  assert.ok(outputs.every((output) => output.pageCount >= 1));
});
