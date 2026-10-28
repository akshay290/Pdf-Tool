import { access } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { chromium } from 'playwright-core';
import { PdfInputError } from './pdf-ops.mjs';

const MAX_HTML_CHARACTERS = 200_000;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 30_000;

export async function browserExecutable() {
  const candidates = [
    process.env.LOCALFOLD_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try the next installed browser. */ }
  }
  throw new PdfInputError('HTML conversion requires an installed Edge or Chromium browser. Set LOCALFOLD_BROWSER to its executable path.', 503);
}

export async function htmlToPdf(html) {
  if (typeof html !== 'string' || !html.trim() || html.length > MAX_HTML_CHARACTERS) {
    throw new PdfInputError('Paste HTML between 1 and 200000 characters.');
  }
  const executablePath = await browserExecutable();
  let browser;
  let timeoutId;
  const expired = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new PdfInputError('HTML conversion exceeded the 30-second local processing limit.', 408)), CONVERSION_TIMEOUT_MS);
    timeoutId.unref?.();
  });
  try {
    return await Promise.race([expired, (async () => {
      browser = await chromium.launch({
        executablePath, headless: true, chromiumSandbox: true, timeout: 15_000,
      });
      // Every conversion receives a new temporary profile and browser context.
      const context = await browser.newContext({
        javaScriptEnabled: false, serviceWorkers: 'block', offline: true,
        acceptDownloads: false,
      });
      await context.route('**/*', (route) => route.abort('blockedbyclient'));
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.setDefaultNavigationTimeout(15_000);
      // DOMParser creates an inert document. Strip navigation/container tags
      // before setContent so refresh metadata cannot replace the pasted page.
      // Offline mode and request interception are active during parsing too.
      const prepared = await page.evaluate((source) => {
        const document = new DOMParser().parseFromString(source, 'text/html');
        document.querySelectorAll('script, iframe, frame, frameset, object, embed, base, link, meta[http-equiv]').forEach((node) => node.remove());
        const policy = document.createElement('meta');
        policy.httpEquiv = 'Content-Security-Policy';
        policy.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
        document.head.prepend(policy);
        return `<!doctype html>\n${document.documentElement.outerHTML}`;
      }, html);
      await page.setContent(prepared, { waitUntil: 'load', timeout: 15_000 });
      await page.emulateMedia({ media: 'print' });
      const bytes = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      if (bytes.length > MAX_PDF_BYTES) {
        throw new PdfInputError('The generated PDF exceeds the 32 MB local output limit. Shorten the HTML.', 413);
      }
      const document = await PDFDocument.load(bytes, { updateMetadata: false });
      const pageCount = document.getPageCount();
      if (pageCount > 100) throw new PdfInputError('The generated PDF exceeds 100 pages. Shorten the HTML.', 413);
      return { bytes, pageCount };
    })()]);
  } catch (error) {
    if (error instanceof PdfInputError) throw error;
    throw new PdfInputError('The pasted HTML could not be printed locally. Check that the installed browser is available and simplify the HTML.', 422);
  } finally {
    clearTimeout(timeoutId);
    if (browser) await browser.close().catch(() => {});
  }
}
