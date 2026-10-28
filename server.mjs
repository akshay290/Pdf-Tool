import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectFiles, mergePdfs, PdfInputError, rotatePdf, safeFilename, splitPdf } from './src/pdf-ops.mjs';
import { cropPdf, imagesToPdf, numberPdf, organizePdf, watermarkPdf } from './src/advanced-pdf-ops.mjs';
import { annotatePdf, fillPdfForms, flattenPdf, inspectPdfForms, removeMetadataPdf, signPdf } from './src/extended-pdf-ops.mjs';
import { pythonDocument, runPython } from './src/python-bridge.mjs';
import { ocrPdf } from './src/ocr-ops.mjs';
import { htmlToPdf } from './src/html-ops.mjs';
import { officeToPdf } from './src/office-ops.mjs';
import { webToPdf } from './src/web-ops.mjs';
import { organizePages, cropAreas, editPdf, imageWatermark, createFormFields, typedSignature } from './src/studio-ops.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const MAX_BODY_BYTES = 68 * 1024 * 1024;
const MIME = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader('Cache-Control', 'no-store');
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function sendPdf(response, result, name) {
  response.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${name}"`,
    'X-Page-Count': String(result.pageCount),
  });
  response.end(Buffer.from(result.bytes));
}

function sendDocument(response, result, name) {
  const headers = {
    'Content-Type': result.mediaType || 'application/pdf',
    'Content-Disposition': `attachment; filename="${safeFilename(name || result.name || 'localfold-output.pdf')}"`,
    'X-Page-Count': String(result.pageCount),
  };
  if (result.inputBytes != null) headers['X-Input-Bytes'] = String(result.inputBytes);
  if (result.outputBytes != null) headers['X-Output-Bytes'] = String(result.outputBytes);
  if (result.rasterized != null) headers['X-Rasterized'] = String(result.rasterized);
  if (result.targetBytes != null) headers['X-Target-Bytes'] = String(result.targetBytes);
  if (result.targetReached != null) headers['X-Target-Reached'] = String(result.targetReached);
  if (result.qualityDpi != null) headers['X-Compression-Dpi'] = String(result.qualityDpi);
  if (result.qualityJpeg != null) headers['X-Compression-Quality'] = String(result.qualityJpeg);
  if (result.attempts != null) headers['X-Compression-Attempts'] = String(result.attempts);
  if (result.compressionMethod) headers['X-Compression-Method'] = result.compressionMethod;
  response.writeHead(200, headers);
  response.end(Buffer.from(result.bytes));
}

async function readJson(request) {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > MAX_BODY_BYTES) throw new PdfInputError('The request is too large. Keep each PDF under 16 MB.', 413);
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new PdfInputError('The request is too large. Keep each PDF under 16 MB.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
    return value;
  } catch {
    throw new PdfInputError('The request could not be read. Please try again.');
  }
}

async function sendStatic(pathname, response) {
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(PUBLIC, requested);
  if (!file.startsWith(`${PUBLIC}${path.sep}`) && file !== path.join(PUBLIC, 'index.html')) {
    response.writeHead(404); response.end('Not found'); return;
  }
  try {
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    response.end(content);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

export function createServer() {
  return createHttpServer(async (request, response) => {
    securityHeaders(response);
    const url = new URL(request.url || '/', 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, service: 'LocalFold', storage: 'local-processing', temporaryFiles: 'office-conversion-only' });
        return;
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
        const body = await readJson(request);
        if (url.pathname === '/api/inspect') {
          sendJson(response, 200, { files: await inspectFiles(body.files) });
          return;
        }
        if (url.pathname === '/api/merge') {
          const result = await mergePdfs(body.files);
          sendPdf(response, result, 'localfold-merged.pdf');
          return;
        }
        if (url.pathname === '/api/split') {
          const outputs = await splitPdf(body.file, body.ranges);
          sendJson(response, 200, { outputs: outputs.map((output) => ({
            name: safeFilename(output.name), pageCount: output.pageCount, data: Buffer.from(output.bytes).toString('base64'),
          })) });
          return;
        }
        if (url.pathname === '/api/rotate') {
          const result = await rotatePdf(body.file, body.rotation);
          sendPdf(response, result, 'localfold-rotated.pdf');
          return;
        }
        if (url.pathname === '/api/forms-inspect') {
          sendJson(response, 200, await inspectPdfForms(body.file));
          return;
        }
        if (url.pathname === '/api/preview' || url.pathname === '/api/text-objects') {
          sendJson(response, 200, await runPython(url.pathname === '/api/preview' ? 'preview' : 'studio-text-objects', body));
          return;
        }
        const advancedTools = {
          '/api/organize': { run: () => organizePdf(body.file, { pages: body.pages, rotations: body.rotations }), name: 'localfold-organized.pdf' },
          '/api/watermark': { run: () => watermarkPdf(body.file, { text: body.text, opacity: body.opacity }), name: 'localfold-watermarked.pdf' },
          '/api/number': { run: () => numberPdf(body.file, { startNumber: body.startNumber }), name: 'localfold-numbered.pdf' },
          '/api/crop': { run: () => cropPdf(body.file, { margin: body.margin }), name: 'localfold-cropped.pdf' },
          '/api/images': { run: () => imagesToPdf(body.files), name: 'localfold-images.pdf' },
          '/api/flatten': { run: () => flattenPdf(body.file), name: 'localfold-flattened.pdf' },
          '/api/metadata': { run: () => removeMetadataPdf(body.file), name: 'localfold-cleaned.pdf' },
          '/api/annotate': { run: () => annotatePdf(body.file, body), name: 'localfold-annotated.pdf' },
          '/api/sign': { run: () => signPdf(body.file, body), name: 'localfold-signed.pdf' },
          '/api/forms-fill': { run: () => fillPdfForms(body.file, body), name: 'localfold-filled.pdf' },
          '/api/ocr': { run: () => ocrPdf(body.file, { language: body.language || 'eng' }), name: 'localfold-searchable.pdf' },
          '/api/html': { run: () => htmlToPdf(body.html), name: 'localfold-html.pdf' },
          '/api/html-url': { run: () => webToPdf(body.url), name: 'localfold-webpage.pdf' },
          '/api/office': { run: () => officeToPdf(body.file), name: 'localfold-office.pdf' },
          '/api/organize-pages': { run: () => organizePages(body), name: 'localfold-organized.pdf' },
          '/api/crop-area': { run: () => cropAreas(body), name: 'localfold-cropped.pdf' },
          '/api/edit': { run: () => editPdf(body), name: 'localfold-edited.pdf' },
          '/api/image-watermark': { run: () => imageWatermark(body), name: 'localfold-watermarked.pdf' },
          '/api/forms-create': { run: () => createFormFields(body), name: 'localfold-form.pdf' },
          '/api/typed-signature': { run: () => typedSignature(body), name: 'localfold-signed.pdf' },
        };
        if (Object.hasOwn(advancedTools, url.pathname)) {
          const tool = advancedTools[url.pathname];
          sendPdf(response, await tool.run(), tool.name);
          return;
        }
        const pythonTools = new Set(['compress', 'render', 'protect', 'unlock', 'repair', 'text', 'compare', 'docx', 'pptx', 'xlsx', 'extract-images', 'compare-visual']);
        const operation = url.pathname.slice('/api/'.length);
        if (pythonTools.has(operation)) {
          let payload = body;
          if (['docx', 'pptx', 'xlsx'].includes(operation) && body.ocr === true) {
            const searchable = await ocrPdf(body.file, { language: body.language || 'eng' });
            payload = { ...body, file: { name: 'searchable.pdf', data: Buffer.from(searchable.bytes).toString('base64') } };
          }
          sendDocument(response, await pythonDocument(operation, payload));
          return;
        }
        sendJson(response, 404, { error: 'That tool is not available.' });
        return;
      }
      if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
        await sendStatic(url.pathname, response);
        return;
      }
      sendJson(response, 405, { error: 'That request is not available.' });
    } catch (error) {
      const status = error instanceof PdfInputError ? error.status : 400;
      if (!response.headersSent) sendJson(response, status, { error: error instanceof PdfInputError ? error.message : 'This document could not be processed. Try a simpler file or another operation.' });
      else response.destroy();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 4173);
  const server = createServer();
  server.listen(port, host, () => console.log(`LocalFold is running at http://${host}:${port}`));
}
