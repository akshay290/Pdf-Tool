import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PDFDocument } from 'pdf-lib';
import { htmlToPdf } from '../src/html-ops.mjs';
import { PdfInputError } from '../src/pdf-ops.mjs';
import { runPython } from '../src/python-bridge.mjs';

async function pdfText(bytes) {
  const output = await runPython('text', { file: { name: 'test.pdf', data: Buffer.from(bytes).toString('base64') }, format: 'txt' });
  return output.text;
}

test('pasted HTML prints to a real PDF with embedded CSS and page breaks', { timeout: 45_000 }, async () => {
  const output = await htmlToPdf('<style>@page{size:A4;margin:20mm}h1{color:#1848aa}.next{break-before:page}</style><h1>Local HTML report</h1><p>Visible first-page text.</p><section class="next">Second-page content.</section>');
  assert.equal(output.pageCount, 2);
  const document = await PDFDocument.load(output.bytes);
  assert.equal(document.getPageCount(), 2);
  assert.ok(Math.abs(document.getPage(0).getWidth() - 595.28) < 2);
  const text = await pdfText(output.bytes);
  assert.match(text, /Local HTML report/);
  assert.match(text, /Second-page content/);
});

test('scripts, refresh navigation and external/local-file resources cannot replace or fetch content', { timeout: 45_000 }, async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('NETWORK_CANARY_SHOULD_NOT_APPEAR');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const localUrl = `http://127.0.0.1:${server.address().port}/canary`;
    const output = await htmlToPdf(`<meta http-equiv="refresh" content="0;url=${localUrl}"><script>document.body.innerHTML='SCRIPT_CANARY_SHOULD_NOT_APPEAR';fetch('${localUrl}')</script><style>@import url('${localUrl}');body{background-image:url('${localUrl}')}</style><h1>Original safe content</h1><img src="${localUrl}"><img src="file:///C:/Windows/win.ini"><iframe src="${localUrl}"></iframe><object data="file:///C:/Windows/win.ini"></object>`);
    const text = await pdfText(output.bytes);
    assert.match(text, /Original safe content/);
    assert.doesNotMatch(text, /SCRIPT_CANARY|NETWORK_CANARY|\[fonts\]|\[extensions\]/);
    assert.equal(requests, 0, 'The isolated browser must not reach even this local test server.');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('HTML input and generated page limits return useful input errors', { timeout: 45_000 }, async () => {
  for (const html of ['', ' ', null, 'a'.repeat(200_001)]) {
    await assert.rejects(() => htmlToPdf(html), PdfInputError);
  }
  const pages = Array.from({ length: 101 }, (_, index) => `<section style="break-before:page">Page ${index + 1}</section>`).join('');
  await assert.rejects(() => htmlToPdf(pages), /exceeds 100 pages/);
});
