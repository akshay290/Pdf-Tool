import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFString, StandardFonts, rgb } from 'pdf-lib';
import { pythonExecutable, runPython } from '../src/python-bridge.mjs';

function pngChunk(type, bytes) {
  const name = Buffer.from(type);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, bytes])) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, name, bytes, checksum]);
}

function colorPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Uint8Array.from(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 0, 0, 255]))), pngChunk('IEND', Buffer.alloc(0))]));
}

async function richPdf() {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const page = document.addPage([612, 792]);
  page.drawText('Quarterly report', { x: 40, y: 740, font: bold, size: 24, color: rgb(0.1, 0.2, 0.6) });
  page.drawText('A formatted body paragraph.', { x: 40, y: 700, font: regular, size: 11 });
  page.drawText('Open source link', { x: 40, y: 675, font: regular, size: 11 });
  const annotation = document.context.register(document.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [40, 672, 140, 688], Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.org/source') },
  }));
  page.node.set(document.context.obj('Annots'), document.context.obj([annotation]));
  for (const x of [40, 240, 400]) page.drawLine({ start: { x, y: 480 }, end: { x, y: 600 }, thickness: 1 });
  for (const y of [480, 520, 560, 600]) page.drawLine({ start: { x: 40, y }, end: { x: 400, y }, thickness: 1 });
  for (const [row, values] of [['Item', 'Count'], ['Paper', '007'], ['Pens', '012']].entries()) {
    for (const [column, text] of values.entries()) page.drawText(text, { x: [48, 248][column], y: 575 - row * 40, size: 11, font: regular });
  }
  page.drawImage(await document.embedPng(colorPng()), { x: 440, y: 650, width: 80, height: 40 });
  return { name: 'report.pdf', data: Buffer.from(await document.save()).toString('base64') };
}

function inspectArchive(result) {
  const script = `
import base64, io, json, sys, zipfile
from xml.etree import ElementTree as ET
from PIL import Image
with zipfile.ZipFile(io.BytesIO(base64.b64decode(json.load(sys.stdin)["data"]))) as archive:
    names = archive.namelist()
    text = archive.read("document.md").decode("utf8") if "document.md" in names else ""
    images = [name for name in names if name.startswith("images/") or name.startswith("word/media/")]
    sizes = [Image.open(io.BytesIO(archive.read(name))).size for name in images]
    frames = tables = bold = 0
    links = []
    if "word/document.xml" in names:
        root = ET.fromstring(archive.read("word/document.xml"))
        frames = sum(node.tag.endswith("}framePr") for node in root.iter())
        tables = sum(node.tag.endswith("}tbl") for node in root.iter())
        bold = sum(node.tag.endswith("}b") for node in root.iter())
        relations = ET.fromstring(archive.read("word/_rels/document.xml.rels"))
        links = [node.get("Target") for node in relations if node.get("Type", "").endswith("/hyperlink")]
    print(json.dumps({"names": names, "text": text, "imageSizes": sizes, "frames": frames, "tables": tables, "bold": bold, "links": links}))
`;
  return JSON.parse(execFileSync(pythonExecutable(), ['-c', script], {
    input: JSON.stringify({ data: result.data }), encoding: 'utf8', windowsHide: true,
  }));
}

test('Markdown recovers headings, native tables, inline links, and optional image assets', async () => {
  const result = await runPython('text', { file: await richPdf(), format: 'md', includeImages: true });
  assert.equal(result.mediaType, 'application/zip');
  const archive = inspectArchive(result);
  assert.match(archive.text, /^#.*Quarterly report/m);
  assert.match(archive.text, /\| Item \| Count \|/);
  assert.match(archive.text, /\| Paper \| 007 \|/);
  assert.equal((archive.text.match(/Paper/g) || []).length, 1, 'table text must not be duplicated in body paragraphs');
  assert.match(archive.text, /\[Open source link\]\(https:\/\/example.org\/source\)/);
  assert.match(archive.text, /!\[Page 1 image 1\]\(images\/page-1-image-1.png\)/);
  assert.deepEqual(archive.imageSizes, [[160, 80]]);
  assert.ok(archive.names.includes('document.md'));
});

test('Word layout recovery preserves native table cells, styled text, links and embedded images', async () => {
  const result = await runPython('docx', { file: await richPdf() });
  const archive = inspectArchive(result);
  assert.equal(archive.tables, 1);
  assert.ok(archive.frames >= 4);
  assert.ok(archive.bold >= 1);
  assert.deepEqual(archive.links, ['https://example.org/source']);
  assert.deepEqual(archive.imageSizes, [[160, 80]]);
});

test('Markdown plain download remains UTF-8 and rejects empty documents', async () => {
  const result = await runPython('text', { file: await richPdf(), format: 'md' });
  assert.equal(result.mediaType, 'text/markdown; charset=utf-8');
  assert.match(Buffer.from(result.data, 'base64').toString('utf8'), /Quarterly report/);
  const document = await PDFDocument.create();
  document.addPage([100, 100]); document.addPage([100, 100]);
  await assert.rejects(runPython('text', { file: { name: 'empty.pdf', data: Buffer.from(await document.save()).toString('base64') }, format: 'md' }), /no extractable text or images/i);
});
