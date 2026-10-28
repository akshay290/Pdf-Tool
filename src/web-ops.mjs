import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, BlockList } from 'node:net';
import { promisify } from 'node:util';
import { brotliDecompress, gunzip, inflate } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { chromium } from 'playwright-core';
import { browserExecutable } from './html-ops.mjs';
import { PdfInputError } from './pdf-ops.mjs';

const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(network, prefix, 'ipv4');
const publicV6 = new BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');
for (const [network, prefix] of [['2001::',23], ['2001:db8::',32], ['2002::',16], ['3fff::',20]]) blocked.addSubnet(network, prefix, 'ipv6');
const gunzipAsync = promisify(gunzip), inflateAsync = promisify(inflate), brotliAsync = promisify(brotliDecompress);

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    return publicV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
  }
  return false;
}

export function publicWebUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new PdfInputError('Enter a full public webpage URL beginning with https:// or http://.'); }
  if (typeof value !== 'string' || value.length > 8000 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)) {
    throw new PdfInputError('Use a public HTTP or HTTPS URL without a login or a custom port.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || isIP(host) && !isPublicAddress(host)) {
    throw new PdfInputError('Local and private-network addresses cannot be captured. Paste HTML to print local content.');
  }
  return url;
}

async function pinnedResponse(value, budget, depth = 0) {
  if (budget.signal.aborted) throw new PdfInputError('Webpage capture was stopped.', 408);
  const url = publicWebUrl(value);
  if (++budget.requests > 100) throw new PdfInputError('This webpage requests too many resources. Try a simpler page.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (budget.signal.aborted) throw new PdfInputError('Webpage capture was stopped.', 408);
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) throw new PdfInputError('This webpage resolves to a private or unsupported network address.');
  const selected = addresses.find((entry) => entry.family === 4) || addresses[0];
  const result = await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      family: selected.family,
      signal: budget.signal,
      // Pin the validated address for this connection to prevent DNS rebinding.
      lookup: (_hostname, options, callback) => options.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
      timeout: 12_000,
      headers: { 'User-Agent': 'LocalFold-WebCapture/1.0', Accept: 'text/html,text/css,image/*,font/*;q=0.8,*/*;q=0.5', 'Accept-Encoding': 'identity' },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        budget.bytes += chunk.length;
        if (size > 8 * 1024 * 1024 || budget.bytes > 40 * 1024 * 1024) {
          request.destroy(new PdfInputError('The webpage resources exceed the local capture limit.'));
        } else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), url: url.href }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new PdfInputError('The webpage took too long to respond.', 408)));
    request.on('error', reject);
  });
  if (result.status >= 300 && result.status < 400 && result.headers.location) {
    if (depth >= 5) throw new PdfInputError('The webpage redirects too many times.');
    return pinnedResponse(new URL(result.headers.location, url).href, budget, depth + 1);
  }
  const encoding = result.headers['content-encoding'];
  if (encoding) {
    const decode = { gzip: gunzipAsync, deflate: inflateAsync, br: brotliAsync }[encoding];
    if (!decode) throw new PdfInputError('This webpage uses an unsupported compression format.');
    const compressedLength = result.body.length;
    result.body = await decode(result.body, { maxOutputLength: 8 * 1024 * 1024 });
    budget.bytes += Math.max(0, result.body.length - compressedLength);
    if (budget.bytes > 40 * 1024 * 1024) throw new PdfInputError('The decoded webpage resources exceed the 40 MB capture limit.');
  }
  return result;
}

let active = 0;
export async function webToPdf(value) {
  const url = publicWebUrl(value);
  if (active >= 2) throw new PdfInputError('Two webpage tasks are running. Try again after one finishes.', 429);
  active++;
  let browser, expired;
  const controller = new AbortController();
  try {
    const conversion = (async () => {
      const budget = { requests: 0, bytes: 0, signal: controller.signal };
      const first = await pinnedResponse(url.href, budget);
      if (first.status < 200 || first.status >= 300) throw new PdfInputError('The webpage could not be opened publicly. Login-only and blocked pages cannot be captured.');
      if (!/text\/html|application\/xhtml\+xml/i.test(first.headers['content-type'] || '')) throw new PdfInputError('This URL does not return an HTML webpage.');
      if (controller.signal.aborted) throw new PdfInputError('Webpage capture was stopped.', 408);
      const executablePath = await browserExecutable();
      if (controller.signal.aborted) throw new PdfInputError('Webpage capture was stopped.', 408);
      const launched = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, timeout: 15_000 });
      if (controller.signal.aborted) { await launched.close(); throw new PdfInputError('Webpage capture was stopped.', 408); }
      browser = launched;
      const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
      const page = await context.newPage();
      let initial = true;
      await context.route('**/*', async (route) => {
        const request = route.request();
        if (request.method() !== 'GET' || ['script', 'websocket', 'media'].includes(request.resourceType()) || request.isNavigationRequest() && request.frame() !== page.mainFrame()) {
          await route.abort(); return;
        }
        try {
          let result;
          if (initial && request.isNavigationRequest()) { result = first; initial = false; }
          else result = await pinnedResponse(request.url(), budget);
          const headers = { 'content-type': String(result.headers['content-type'] || 'application/octet-stream'),
            'content-security-policy': "script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'" };
          await route.fulfill({ status: result.status, headers, body: result.body });
        } catch { await route.abort().catch(() => {}); }
      });
      await page.goto(first.url, { waitUntil: 'load', timeout: 25_000 });
      await page.emulateMedia({ media: 'print' });
      const bytes = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      if (bytes.length > 32 * 1024 * 1024) throw new PdfInputError('The captured PDF exceeds 32 MB.');
      const document = await PDFDocument.load(bytes);
      if (document.getPageCount() > 100) throw new PdfInputError('The captured webpage exceeds 100 PDF pages.');
      return { bytes, pageCount: document.getPageCount() };
    })();
    const timeout = new Promise((_, reject) => { expired = setTimeout(() => { controller.abort(); reject(new PdfInputError('Webpage capture exceeded 60 seconds.', 408)); }, 60_000); });
    return await Promise.race([conversion, timeout]);
  } catch (error) {
    if (error instanceof PdfInputError) throw error;
    const failure = new PdfInputError('This public webpage could not be captured. Try pasted HTML for pages that require a login, scripts or block automated access.');
    failure.cause = error;
    throw failure;
  } finally {
    clearTimeout(expired);
    controller.abort();
    if (browser) await browser.close().catch(() => {});
    active--;
  }
}
