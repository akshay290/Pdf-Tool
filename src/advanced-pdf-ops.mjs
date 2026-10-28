import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { decodeFile, MAX_FILE_BYTES, MAX_FILES, PdfInputError, safeFilename } from './pdf-ops.mjs';

// Additional operations are independently implemented with the MIT pdf-lib API.
// Page selections are one based. Duplicate selections deliberately duplicate pages.
const MAX_OUTPUT_PAGES = 2000;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;

async function loadPdf(file) {
  const { name, bytes } = decodeFile(file);
  try {
    // Keep pdf-lib's default encrypted-document rejection; do not ignore encryption.
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    if (document.getPageCount() < 1) throw new Error('No pages');
    return document;
  } catch {
    throw new PdfInputError(`We could not open ${name}. It may be damaged or password-protected.`);
  }
}

async function result(document) {
  return { bytes: await document.save(), pageCount: document.getPageCount() };
}

export async function organizePdf(file, { pages, rotations } = {}) {
  const document = await loadPdf(file);
  const pageCount = document.getPageCount();
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > MAX_OUTPUT_PAGES) {
    throw new PdfInputError(`Choose between 1 and ${MAX_OUTPUT_PAGES} output pages.`);
  }
  if (pages.some((page) => !Number.isInteger(page) || page < 1 || page > pageCount)) {
    throw new PdfInputError(`Page numbers must be whole numbers between 1 and ${pageCount}.`);
  }
  if (rotations !== undefined && (!Array.isArray(rotations) || rotations.length !== pages.length
      || rotations.some((angle) => ![0, 90, 180, 270].includes(angle)))) {
    throw new PdfInputError('Provide one rotation of 0, 90, 180, or 270 degrees for each selected page.');
  }
  const output = await PDFDocument.create();
  const unique = [...new Set(pages)];
  const copiedPages = await output.copyPages(document, unique.map((page) => page - 1));
  const available = new Map(unique.map((pageNumber, index) => [pageNumber, copiedPages[index]]));
  for (let index = 0; index < pages.length; index += 1) {
    let page = available.get(pages[index]);
    if (page) available.delete(pages[index]);
    else [page] = await output.copyPages(document, [pages[index] - 1]);
    if (rotations) page.setRotation(degrees((page.getRotation().angle + rotations[index]) % 360));
    output.addPage(page);
  }
  return result(output);
}

export async function watermarkPdf(file, { text, opacity = 0.18 } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 100) {
    throw new PdfInputError('Enter watermark text between 1 and 100 characters.');
  }
  const alpha = Number(opacity);
  if (!Number.isFinite(alpha) || alpha < 0.05 || alpha > 1) {
    throw new PdfInputError('Watermark opacity must be between 0.05 and 1.');
  }
  const document = await loadPdf(file);
  const font = await document.embedFont(StandardFonts.HelveticaBold);
  const label = text.trim();
  let unitWidth;
  try {
    unitWidth = font.widthOfTextAtSize(label, 1);
  } catch {
    throw new PdfInputError('Use Latin letters, numbers, and common punctuation for watermark text.');
  }
  for (const page of document.getPages()) {
    const box = page.getCropBox();
    const size = Math.max(1, Math.min(56, (Math.min(box.width, box.height) * 0.8) / unitWidth));
    const angle = 35 * Math.PI / 180;
    const width = font.widthOfTextAtSize(label, size);
    // Center the rotated text in the existing visible page area.
    page.drawText(label, {
      x: box.x + box.width / 2 - width * Math.cos(angle) / 2 + size * Math.sin(angle) / 2,
      y: box.y + box.height / 2 - width * Math.sin(angle) / 2 - size * Math.cos(angle) / 2,
      font, size, rotate: degrees(35), opacity: alpha, color: rgb(0.3, 0.32, 0.36),
    });
  }
  return result(document);
}

export async function numberPdf(file, { startNumber = 1 } = {}) {
  const start = Number(startNumber);
  if (!Number.isSafeInteger(start) || start < 1 || start > 1_000_000_000) {
    throw new PdfInputError('Start page numbering with a whole number between 1 and 1000000000.');
  }
  const document = await loadPdf(file);
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const [index, page] of document.getPages().entries()) {
    const box = page.getCropBox();
    const label = String(start + index);
    const size = Math.min(11, Math.max(1, box.height / 8), Math.max(1, box.width / (label.length + 2)));
    const width = font.widthOfTextAtSize(label, size);
    page.drawText(label, {
      x: box.x + (box.width - width) / 2,
      y: box.y + Math.min(18, box.height / 5),
      font, size, color: rgb(0.22, 0.24, 0.28),
    });
  }
  return result(document);
}

// CropBox edits only change the visible region. They do not erase hidden content.
// `margin` is measured in PDF points (72 points = one inch), on each of four sides.
export async function cropPdf(file, { margin = 18 } = {}) {
  const amount = Number(margin);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new PdfInputError('Crop margin must be a positive number of PDF points, or zero.');
  }
  const document = await loadPdf(file);
  const pages = document.getPages();
  if (pages.some((page) => {
    const box = page.getCropBox();
    return box.width - amount * 2 < 1 || box.height - amount * 2 < 1;
  })) {
    throw new PdfInputError('The crop margin is too large for one or more pages.');
  }
  for (const page of pages) {
    const box = page.getCropBox();
    page.setCropBox(box.x + amount, box.y + amount, box.width - amount * 2, box.height - amount * 2);
  }
  return result(document);
}

function decodeImage(file) {
  if (!file || typeof file !== 'object' || typeof file.data !== 'string') {
    throw new PdfInputError('Choose JPG or PNG images to continue.');
  }
  const name = safeFilename(file.name, 'image');
  const extension = /\.(jpe?g|png)$/i.exec(name)?.[1].toLowerCase();
  if (!extension) throw new PdfInputError(`${name} must have a .jpg, .jpeg, or .png filename.`);
  if (!file.data || file.data.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8) {
    throw new PdfInputError(`${name} is empty or larger than the 16 MB limit.`, 413);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) {
    throw new PdfInputError(`${name} could not be read as an image.`);
  }
  const bytes = Buffer.from(file.data, 'base64');
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) {
    throw new PdfInputError(`${name} is empty or larger than the 16 MB limit.`, 413);
  }
  const isPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if ((extension === 'png' && !isPng) || (extension !== 'png' && !isJpg)) {
    throw new PdfInputError(`${name} does not contain a valid ${extension === 'png' ? 'PNG' : 'JPG'} image.`);
  }
  return { name, bytes, kind: isPng ? 'png' : 'jpg' };
}

export async function imagesToPdf(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) {
    throw new PdfInputError(`Choose between 1 and ${MAX_FILES} JPG or PNG images.`);
  }
  const images = files.map(decodeImage);
  if (images.reduce((sum, image) => sum + image.bytes.length, 0) > MAX_TOTAL_BYTES) {
    throw new PdfInputError('Keep the combined image input size under 48 MB per task.', 413);
  }
  const document = await PDFDocument.create();
  for (const image of images) {
    let embedded;
    try {
      // Use a standalone Uint8Array so the library sees exactly this buffer slice.
      const bytes = Uint8Array.from(image.bytes);
      embedded = image.kind === 'png' ? await document.embedPng(bytes) : await document.embedJpg(bytes);
    } catch {
      throw new PdfInputError(`We could not open ${image.name}. It may be a damaged image.`);
    }
    // Fit to portrait/landscape A4, preserving the image's aspect ratio.
    const size = embedded.width > embedded.height ? [842, 595] : [595, 842];
    const page = document.addPage(size);
    const scale = Math.min((size[0] - 36) / embedded.width, (size[1] - 36) / embedded.height);
    const width = embedded.width * scale;
    const height = embedded.height * scale;
    page.drawImage(embedded, { x: (size[0] - width) / 2, y: (size[1] - height) / 2, width, height });
  }
  return result(document);
}
