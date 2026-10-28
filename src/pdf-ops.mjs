import { degrees, PDFDocument } from 'pdf-lib';

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_FILES = 12;

export class PdfInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PdfInputError';
    this.status = status;
  }
}

export function safeFilename(value, fallback = 'document.pdf') {
  const leaf = String(value || fallback).split(/[\\/]/).pop();
  const cleaned = leaf.replace(/[<>:"|?*\u0000-\u001f]/g, '-').trim();
  return cleaned || fallback;
}

export function decodeFile(file) {
  if (!file || typeof file !== 'object' || typeof file.data !== 'string') {
    throw new PdfInputError('Choose a PDF file to continue.');
  }
  const name = safeFilename(file.name);
  if (!name.toLowerCase().endsWith('.pdf')) {
    throw new PdfInputError(`${name} does not have a .pdf filename.`);
  }
  if (!file.data || file.data.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8) {
    throw new PdfInputError(`${name} is larger than the 16 MB limit.`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) {
    throw new PdfInputError(`${name} could not be read as a PDF.`);
  }
  const bytes = Buffer.from(file.data, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
    throw new PdfInputError(`${name} is empty or larger than the 16 MB limit.`);
  }
  return { name, bytes };
}

async function loadPdf(file) {
  const { name, bytes } = decodeFile(file);
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    if (document.getPageCount() < 1) throw new Error('The PDF has no pages.');
    return { name, bytes, document };
  } catch {
    throw new PdfInputError(`We could not open ${name}. It may be damaged or password-protected.`);
  }
}

export async function inspectFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) {
    throw new PdfInputError(`Choose between 1 and ${MAX_FILES} PDF files.`);
  }
  validateTotalSize(files);
  const inspected = [];
  for (const file of files) {
    const loaded = await loadPdf(file);
    inspected.push({ name: loaded.name, pageCount: loaded.document.getPageCount(), size: loaded.bytes.length });
  }
  return inspected;
}

function validateFiles(files, min = 1) {
  if (!Array.isArray(files) || files.length < min || files.length > MAX_FILES) {
    throw new PdfInputError(min === 2
      ? 'Add at least two PDFs to merge.'
      : `Choose between 1 and ${MAX_FILES} PDF files.`);
  }
  validateTotalSize(files);
}

function validateTotalSize(files) {
  const estimatedBytes = files.reduce((total, file) => {
    if (typeof file?.data !== 'string') return total;
    const padding = file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0;
    return total + Math.floor(file.data.length * 3 / 4) - padding;
  }, 0);
  if (estimatedBytes > 48 * 1024 * 1024) {
    throw new PdfInputError('Keep the combined PDF input size under 48 MB per task.', 413);
  }
}

export async function mergePdfs(files) {
  validateFiles(files, 2);
  const merged = await PDFDocument.create();
  for (const file of files) {
    const source = await loadPdf(file);
    const pages = await merged.copyPages(source.document, source.document.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  merged.setTitle('Merged PDF');
  return { bytes: await merged.save(), pageCount: merged.getPageCount() };
}

function parseRanges(ranges, pageCount) {
  if (typeof ranges !== 'string' || !ranges.trim()) {
    throw new PdfInputError('Enter one or more page ranges, such as 1-3, 4-8, 9.');
  }
  const groups = ranges.split(',').map((part) => part.trim());
  if (groups.length > pageCount) throw new PdfInputError('There are more ranges than pages in this PDF.');
  return groups.map((group) => {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(group);
    if (!match) throw new PdfInputError(`“${group}” is not a valid page range.`);
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    if (first < 1 || last < first || last > pageCount) {
      throw new PdfInputError(`Page range “${group}” must stay between 1 and ${pageCount}.`);
    }
    return { label: first === last ? `${first}` : `${first}-${last}`, indices: Array.from({ length: last - first + 1 }, (_, index) => first - 1 + index) };
  });
}

export async function splitPdf(file, ranges) {
  const source = await loadPdf(file);
  const groups = parseRanges(ranges, source.document.getPageCount());
  const outputs = [];
  for (const group of groups) {
    const output = await PDFDocument.create();
    const pages = await output.copyPages(source.document, group.indices);
    for (const page of pages) output.addPage(page);
    outputs.push({
      name: `${source.name.replace(/\.pdf$/i, '')}-pages-${group.label}.pdf`,
      pageCount: pages.length,
      bytes: await output.save(),
    });
  }
  return outputs;
}

export async function rotatePdf(file, rotation) {
  const angle = Number(rotation);
  if (![90, 180, 270].includes(angle)) {
    throw new PdfInputError('Choose a rotation of 90, 180, or 270 degrees.');
  }
  const source = await loadPdf(file);
  for (const page of source.document.getPages()) {
    const current = page.getRotation().angle;
    page.setRotation(degrees((current + angle) % 360));
  }
  return { bytes: await source.document.save(), pageCount: source.document.getPageCount() };
}
