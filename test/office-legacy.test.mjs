import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { officeToPdf } from '../src/office-ops.mjs';
import { runPython } from '../src/python-bridge.mjs';

test('legacy DOC, XLS and PPT files convert locally with their original text', { timeout: 300_000 }, async () => {
  for (const [extension, label] of [['doc', 'Word'], ['xls', 'Excel'], ['ppt', 'PowerPoint']]) {
    const bytes = await readFile(new URL(`fixtures/legacy.${extension}`, import.meta.url));
    assert.equal(bytes.subarray(0, 4).toString('hex'), 'd0cf11e0');
    const file = { name: `legacy.${extension}`, data: bytes.toString('base64') };
    const check = await runPython('office-check', { file });
    assert.equal(check.extension, extension);
    const result = await officeToPdf(file);
    assert.ok((await PDFDocument.load(result.bytes)).getPageCount() >= 1);
    const extracted = await runPython('text', { file: { name: 'converted.pdf', data: result.bytes.toString('base64') } });
    assert.match(extracted.text.replace(/\s+/g, ' '), new RegExp(`LocalFold legacy ${label} conversion canary`));
  }
});
