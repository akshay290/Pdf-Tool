import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { pythonExecutable, runPython } from '../src/python-bridge.mjs';

async function fileFor(document, name = 'source.pdf') {
  return { name, data: Buffer.from(await document.save()).toString('base64') };
}

async function textPdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const [index, size] of [[400, 200], [200, 400]].entries()) {
    document.addPage(size).drawText(index === 0 ? 'Editable document' : 'Second page content', {
      x: 15, y: 100, size: 14, font,
    });
  }
  return fileFor(document);
}

function inspectOffice(result) {
  // Check real Open XML contents using the standard-library ZIP/XML readers.
  const script = `
import base64, io, json, re, sys, zipfile
from xml.etree import ElementTree as ET
from PIL import Image
raw = base64.b64decode(json.load(sys.stdin)["data"])
with zipfile.ZipFile(io.BytesIO(raw)) as archive:
    names = archive.namelist()
    document_files = [name for name in names if name == "word/document.xml" or re.fullmatch(r"xl/worksheets/sheet\\d+\\.xml", name) or re.fullmatch(r"ppt/slides/slide\\d+\\.xml", name)]
    texts = []
    formulas = 0
    pictures = []
    page_breaks = 0
    frames = 0
    tables = 0
    sections = 0
    for name in sorted(document_files):
        root = ET.fromstring(archive.read(name))
        texts.extend(node.text or "" for node in root.iter() if node.tag.rsplit("}", 1)[-1] == "t")
        formulas += sum(node.tag.rsplit("}", 1)[-1] == "f" for node in root.iter())
        frames += sum(node.tag.rsplit("}", 1)[-1] == "framePr" for node in root.iter())
        tables += sum(node.tag.rsplit("}", 1)[-1] == "tbl" for node in root.iter())
        sections += sum(node.tag.rsplit("}", 1)[-1] == "sectPr" for node in root.iter())
        page_breaks += sum(node.tag.rsplit("}", 1)[-1] == "br" and any(key.endswith("}type") and value == "page" for key, value in node.attrib.items()) for node in root.iter())
        for picture in root.findall(".//{http://schemas.openxmlformats.org/presentationml/2006/main}pic"):
            extent = picture.find(".//{http://schemas.openxmlformats.org/drawingml/2006/main}xfrm/{http://schemas.openxmlformats.org/drawingml/2006/main}ext")
            pictures.append([int(extent.get("cx")), int(extent.get("cy"))])
    media = [name for name in names if name.startswith("ppt/media/")]
    background_minima = [min(low for low, high in Image.open(io.BytesIO(archive.read(name))).convert("RGB").getextrema()) for name in media]
    print(json.dumps({"names": names, "texts": texts, "formulas": formulas, "pictures": pictures, "frames": frames, "tables": tables, "sections": sections, "pageBreaks": page_breaks, "media": len(media), "backgroundMinima": background_minima, "jpegImages": all(archive.read(name).startswith(bytes([255,216])) for name in media)}))
`;
  return JSON.parse(execFileSync(pythonExecutable(), ['-c', script], {
    input: JSON.stringify({ data: result.data }), encoding: 'utf8', windowsHide: true,
  }));
}

test('PDF Word export creates positioned editable text and separate page sections', async () => {
  const result = await runPython('docx', { file: await textPdf() });
  const office = inspectOffice(result);
  assert.equal(result.pageCount, 2);
  assert.ok(office.names.includes('word/document.xml'));
  assert.match(office.texts.join(' '), /Editable document/);
  assert.match(office.texts.join(' '), /Second page content/);
  assert.equal(office.sections, 2);
  assert.equal(office.frames, 2);
});

test('PDF slides recover editable text over graphics without duplicate text in the background', async () => {
  const result = await runPython('pptx', { file: await textPdf() });
  const office = inspectOffice(result);
  assert.equal(result.pageCount, 2);
  assert.equal(office.names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 2);
  assert.equal(office.pictures.length, 2);
  assert.equal(office.media, 2);
  assert.equal(office.jpegImages, true);
  assert.match(office.texts.join(' '), /Editable document/);
  assert.match(office.texts.join(' '), /Second page content/);
  assert.ok(office.backgroundMinima.every((value) => value >= 245), 'original black PDF glyphs must be removed from the page background');
  assert.ok(Math.abs(office.pictures[0][0] / office.pictures[0][1] - 2) < 0.00001);
  assert.ok(Math.abs(office.pictures[1][0] / office.pictures[1][1] - 0.5) < 0.00001);
});

test('Excel detects borderless tables from repeated aligned text columns', async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([500, 500]);
  const rows = [['Product', 'Quantity'], ['Paper', '007'], ['Pens', '012']];
  for (const [row, values] of rows.entries()) {
    for (const [column, text] of values.entries()) page.drawText(text, { x: [40, 260][column], y: 430 - row * 30, font, size: 12 });
  }
  const result = await runPython('xlsx', { file: await fileFor(document) });
  assert.deepEqual(inspectOffice(result).texts, rows.flat());
});

test('PowerPoint removes text nested inside PDF Form XObjects before rebuilding editable text', async () => {
  const inner = await PDFDocument.create();
  const font = await inner.embedFont(StandardFonts.Helvetica);
  inner.addPage([400, 200]).drawText('Nested form text', { x: 30, y: 100, size: 18, font });
  const source = await PDFDocument.create();
  const embedded = await source.embedPage(inner.getPage(0));
  source.addPage([400, 200]).drawPage(embedded);
  const result = await runPython('pptx', { file: await fileFor(source) });
  const office = inspectOffice(result);
  assert.match(office.texts.join(' '), /Nested form text/);
  assert.ok(office.backgroundMinima.every((value) => value >= 245));
});

test('PDF table export creates real Excel cells and keeps formula-looking source text literal', async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  for (const x of [40, 280, 440]) page.drawLine({ start: { x, y: 610 }, end: { x, y: 730 }, thickness: 1 });
  for (const y of [610, 650, 690, 730]) page.drawLine({ start: { x: 40, y }, end: { x: 440, y }, thickness: 1 });
  const rows = [['Item', 'Qty'], ['Paper', '007'], ['=SUM(1,1)', 'literal']];
  for (const [rowIndex, row] of rows.entries()) {
    for (const [columnIndex, text] of row.entries()) {
      page.drawText(text, { x: [48, 288][columnIndex], y: 705 - rowIndex * 40, size: 12, font });
    }
  }
  const result = await runPython('xlsx', { file: await fileFor(document, 'table.pdf') });
  const office = inspectOffice(result);
  assert.equal(result.pageCount, 1);
  assert.equal(office.names.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length, 1);
  assert.deepEqual(office.texts, rows.flat());
  assert.equal(office.formulas, 0);
});

test('Word and Excel exports reject content they cannot actually convert', async () => {
  const blank = await PDFDocument.create();
  blank.addPage([200, 200]);
  await assert.rejects(runPython('docx', { file: await fileFor(blank) }), /no selectable text|OCR/i);
  await assert.rejects(runPython('xlsx', { file: await textPdf() }), /No extractable tables/i);
});

test('Office exports reject encrypted PDFs and enforce their advertised page limits', async () => {
  const protectedPdf = await runPython('protect', { file: await textPdf(), password: 'localfold-test-password' });
  for (const operation of ['docx', 'pptx', 'xlsx']) {
    await assert.rejects(runPython(operation, { file: { name: 'locked.pdf', data: protectedPdf.data } }), /password-protected|Unlock PDF/i);
  }
  for (const [operation, limit] of [['docx', 100], ['pptx', 20], ['xlsx', 30]]) {
    const document = await PDFDocument.create();
    for (let index = 0; index <= limit; index += 1) document.addPage([100, 100]);
    await assert.rejects(runPython(operation, { file: await fileFor(document) }), new RegExp(`up to ${limit} pages`));
  }
});
