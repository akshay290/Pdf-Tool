import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { isPublicAddress, publicWebUrl, webToPdf } from '../src/web-ops.mjs';
import { runPython } from '../src/python-bridge.mjs';

test('web capture rejects local, private, mapped, credential and non-web destinations', async () => {
  for (const value of ['http://localhost', 'http://127.0.0.1', 'http://2130706433', 'http://10.0.0.1', 'http://169.254.169.254', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'file:///C:/Windows/win.ini', 'https://user:password@example.com', 'https://example.com:4173']) {
    assert.throws(() => publicWebUrl(value), /public|Local and private/i, value);
  }
  for (const address of ['192.168.1.1', '100.64.0.1', '224.0.0.1', '::ffff:8.8.8.8', '2001:db8::1', 'fe80::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  assert.equal(publicWebUrl('https://example.com/').hostname, 'example.com');
  await assert.rejects(webToPdf('http://localhost/'), /Local and private/);
});

test('a public webpage is captured as a readable local PDF', { timeout: 75_000 }, async () => {
  const result = await webToPdf('https://example.com/');
  assert.ok((await PDFDocument.load(result.bytes)).getPageCount() >= 1);
  const text = await runPython('text', { file: { name: 'web.pdf', data: Buffer.from(result.bytes).toString('base64') } });
  assert.match(text.text, /documentation examples/);
});
