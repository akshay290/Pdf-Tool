import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { createWorker } from 'tesseract.js';
import { decodeFile, PdfInputError } from './pdf-ops.mjs';
import { runPython } from './python-bridge.mjs';

const require = createRequire(import.meta.url);
const languageDirectory = fileURLToPath(new URL('../runtime/tessdata/', import.meta.url));
const MAX_OCR_PAGES = 50;
export const OCR_LANGUAGES = Object.freeze({ eng: 'English', hin: 'Hindi', spa: 'Spanish', fra: 'French', deu: 'German', por: 'Portuguese' });
const MAX_WAITING_JOBS = 2;
let queuedJobs = 0;
let jobQueue = Promise.resolve();

// Node loads the worker and WASM from the installed packages. Supplying the
// language directory explicitly prevents Tesseract's default CDN download.
export function localOcrOptions() {
  return {
    langPath: languageDirectory,
    workerPath: require.resolve('tesseract.js/src/worker-script/node/index.js'),
    corePath: dirname(require.resolve('tesseract.js-core/package.json')),
    gzip: false,
    cacheMethod: 'none',
    logger: () => {},
    errorHandler: () => {},
  };
}

async function recognizePage(worker, data, pageSegmentation = '3') {
  let timer;
  try {
    return await Promise.race([
      worker.recognize(Buffer.from(data, 'base64'), {
        pdfTitle: 'LocalFold searchable document', pdfTextOnly: false,
        tessedit_pageseg_mode: pageSegmentation,
      }, { text: true, pdf: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PdfInputError('OCR took too long. Try fewer pages or a clearer scan.', 408)), 60_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function processPdf(file, options = {}) {
  const language = options?.language ?? 'eng';
  if (!Object.hasOwn(OCR_LANGUAGES, language)) {
    throw new PdfInputError('Choose English, Hindi, Spanish, French, German, or Portuguese for OCR.');
  }
  const decoded = decodeFile(file);
  let source;
  try {
    source = await PDFDocument.load(decoded.bytes, { updateMetadata: false });
  } catch {
    throw new PdfInputError('Choose an unprotected, readable PDF for OCR.');
  }
  if (source.getPageCount() < 1 || source.getPageCount() > MAX_OCR_PAGES) {
    throw new PdfInputError(`OCR currently supports 1 to ${MAX_OCR_PAGES} pages per task. Split a longer PDF first.`);
  }
  if (!existsSync(new URL(`../runtime/tessdata/${language}.traineddata`, import.meta.url))) {
    throw new PdfInputError(`The local ${OCR_LANGUAGES[language]} OCR model is missing. Run the project setup to install it.`, 503);
  }
  const output = await PDFDocument.create();
  let worker;
  try {
    worker = await createWorker(language, 1, localOcrOptions());
    await worker.setParameters({ user_defined_dpi: '144', tessedit_pageseg_mode: '3' });
    // Render five pages at a time so long documents do not retain every
    // full-resolution page image in memory while recognition proceeds.
    for (let pageStart = 1; pageStart <= source.getPageCount(); pageStart += 5) {
      const pageEnd = Math.min(source.getPageCount(), pageStart + 4);
      const raster = await runPython('ocr-raster', { file, pageStart, pageEnd });
      if (!Array.isArray(raster.pages) || raster.pages.length !== pageEnd - pageStart + 1
          || raster.pageCount !== source.getPageCount()) {
        throw new PdfInputError('We could not render all the PDF pages for OCR.');
      }
      for (const image of raster.pages) {
        const data = image.data ?? image.jpegData;
        if (typeof data !== 'string' || !data || !Number.isFinite(image.width)
            || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) {
          throw new PdfInputError('One of the PDF pages could not be prepared for OCR.');
        }
        // AUTO handles tables and multiple blocks; Tesseract's implicit single
        // block mode can return nothing for otherwise clear ruled tables.
        let recognized = await recognizePage(worker, data);
        if ((recognized.data.text?.trim().length ?? 0) < 2 || recognized.data.confidence < 20) {
          const sparse = await recognizePage(worker, data, '11');
          if ((sparse.data.text?.trim().length ?? 0) > (recognized.data.text?.trim().length ?? 0)) recognized = sparse;
        }
        if (!recognized.data.pdf?.length) throw new PdfInputError('OCR could not create a searchable PDF page.');
        const recognizedDocument = await PDFDocument.load(Uint8Array.from(recognized.data.pdf), { updateMetadata: false });
        const [page] = await output.copyPages(recognizedDocument, [0]);
        // Tesseract can infer a different DPI from the image. Scale both the
        // image and hidden text back to the original PDF page dimensions.
        page.scale(image.width / page.getWidth(), image.height / page.getHeight());
        output.addPage(page);
      }
    }
    output.setTitle('Searchable PDF');
    output.setProducer('LocalFold · Tesseract OCR');
    const bytes = await output.save();
    if (bytes.length > 64 * 1024 * 1024) throw new PdfInputError('The searchable PDF exceeds 64 MB. Split the document into fewer pages first.', 413);
    return { bytes, pageCount: output.getPageCount(), language };
  } catch (error) {
    if (error instanceof PdfInputError) throw error;
    throw new PdfInputError(`OCR could not finish this document. Try a clearer scan with printed ${OCR_LANGUAGES[language]} text.`);
  } finally {
    if (worker) await worker.terminate();
  }
}

export function ocrPdf(file, options = {}) {
  // Avoid simultaneous WASM engines consuming large amounts of local memory.
  if (queuedJobs >= MAX_WAITING_JOBS) {
    return Promise.reject(new PdfInputError('OCR is busy. Wait for the current documents to finish.', 429));
  }
  queuedJobs += 1;
  const task = jobQueue.then(() => processPdf(file, options));
  jobQueue = task.catch(() => {});
  return task.finally(() => { queuedJobs -= 1; });
}
