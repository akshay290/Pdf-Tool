import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { runPython } from '../src/python-bridge.mjs';

async function fixture(text = 'Local document test') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([320, 240]).drawText(text, { x: 20, y: 150, font, size: 14 });
  return { name: 'fixture.pdf', data: Buffer.from(await doc.save({ useObjectStreams: false })).toString('base64') };
}

test('AES-256 protection requires the supplied password and unlock restores readable text', async () => {
  const protectedPdf = await runPython('protect', { file: await fixture(), password: 'document-pass-123' });
  const file = { name: 'locked.pdf', data: protectedPdf.data };
  const raw = Buffer.from(file.data, 'base64').toString('latin1');
  assert.match(raw, /\/Encrypt/);
  assert.match(raw, /\/AESV3/);
  await assert.rejects(runPython('unlock', { file, password: 'wrong-password' }), /password does not open/);
  await assert.rejects(runPython('text', { file }), /Unlock|password/i);
  const unlocked = await runPython('unlock', { file, password: 'document-pass-123' });
  const document = await PDFDocument.load(Buffer.from(unlocked.data, 'base64'));
  assert.equal(document.getPageCount(), 1);
  assert.equal(document.isEncrypted, false);
  const text = await runPython('text', { file: { name: 'unlocked.pdf', data: unlocked.data } });
  assert.match(text.text, /Local document test/);
  await assert.rejects(runPython('protect', { file: await fixture(), password: 'short' }), /at least 8/);
});

test('compression never increases the download and lossless mode retains selectable text', async () => {
  const file = await fixture();
  for (const compression of ['lossless', 'balanced', 'small']) {
    const result = await runPython('compress', { file, compression });
    assert.ok(result.outputBytes <= result.inputBytes);
    assert.equal(Buffer.from(result.data, 'base64').length, result.outputBytes);
    assert.equal((await PDFDocument.load(Buffer.from(result.data, 'base64'))).getPageCount(), 1);
    if (compression === 'lossless') {
      const text = await runPython('text', { file: { name: 'compressed.pdf', data: result.data } });
      assert.match(text.text, /Local document test/);
    }
  }
});

test('page rendering returns an actual ZIP containing JPG or PNG image bytes', async () => {
  for (const [format, signature] of [['jpg', [255, 216, 255]], ['png', [137, 80, 78, 71]]]) {
    const result = await runPython('render', { file: await fixture(), format, dpi: 72 });
    const zip = Buffer.from(result.data, 'base64');
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    const nameLength = zip.readUInt16LE(26), extraLength = zip.readUInt16LE(28);
    assert.equal(zip.subarray(30, 30 + nameLength).toString(), `page-0001.${format}`);
    assert.deepEqual([...zip.subarray(30 + nameLength + extraLength, 30 + nameLength + extraLength + signature.length)], signature);
    assert.equal(result.mediaType, 'application/zip');
  }
  await assert.rejects(runPython('render', { file: await fixture(), dpi: 900 }), /supported resolution/);
});

test('text extraction and comparison return source content and a meaningful change report', async () => {
  const before = await fixture('Invoice total 100');
  const after = await fixture('Invoice total 120');
  const text = await runPython('text', { file: before, format: 'md' });
  assert.match(text.mediaType, /text\/markdown/);
  assert.match(Buffer.from(text.data, 'base64').toString(), /Invoice total 100/);
  const result = await runPython('compare', { files: [before, after] });
  assert.match(result.text, /-Invoice total 100/);
  assert.match(result.text, /\+Invoice total 120/);
  const same = await runPython('compare', { files: [before, before] });
  assert.match(same.text, /No differences/);
});

test('repair rebuilds recoverable PDF cross references and rejects unreadable input', async () => {
  const file = await fixture();
  const damaged = Buffer.from(file.data, 'base64').toString('latin1').replace(/startxref\s+\d+/, 'startxref\n1');
  const result = await runPython('repair', { file: { name: 'recoverable.pdf', data: Buffer.from(damaged, 'latin1').toString('base64') } });
  assert.equal((await PDFDocument.load(Buffer.from(result.data, 'base64'))).getPageCount(), 1);
  const text = await runPython('text', { file: { name: 'repaired.pdf', data: result.data } });
  assert.match(text.text, /Local document test/);
  await assert.rejects(runPython('repair', { file: { name: 'bad.pdf', data: Buffer.from('not a PDF').toString('base64') } }), /damaged|cannot be opened/i);
});
