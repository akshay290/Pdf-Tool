import { degrees, PDFDict, PDFDocument, PDFName, rgb, StandardFonts } from 'pdf-lib';
import { decodeFile, MAX_FILE_BYTES, MAX_FILES, PdfInputError } from './pdf-ops.mjs';
import { runPython } from './python-bridge.mjs';

const MAX_PAGES = 2000;
const MAX_ITEMS = 200;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

async function load(file) {
  const decoded = decodeFile(file);
  try {
    const document = await PDFDocument.load(decoded.bytes, { updateMetadata: false });
    if (!document.getPageCount()) throw new Error('No pages');
    return document;
  } catch { throw new PdfInputError('This PDF could not be opened. It may be damaged or password-protected.'); }
}

async function result(document) {
  const bytes = await document.save({ updateFieldAppearances: false });
  if (bytes.length > MAX_OUTPUT_BYTES) throw new PdfInputError('The generated PDF exceeds 64 MB.', 413);
  return { bytes, pageCount: document.getPageCount() };
}

function itemsList(items, label = 'edits') {
  if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) {
    throw new PdfInputError(`Provide between 1 and ${MAX_ITEMS} ${label}.`);
  }
  if (items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) throw new PdfInputError(`Provide valid ${label}.`);
}

function number(value, fallback, minimum, maximum, label) {
  const selected = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(selected) || selected < minimum || selected > maximum) throw new PdfInputError(`${label} must be between ${minimum} and ${maximum}.`);
  return selected;
}

function targetPage(document, page = 1) {
  const selected = Number(page);
  if (!Number.isInteger(selected) || selected < 1 || selected > document.getPageCount()) {
    throw new PdfInputError(`Choose a page between 1 and ${document.getPageCount()}.`);
  }
  return document.getPage(selected - 1);
}

function effectiveBox(page) {
  const crop = page.getCropBox(), media = page.getMediaBox();
  const x = Math.max(crop.x, media.x), y = Math.max(crop.y, media.y);
  const width = Math.min(crop.x + crop.width, media.x + media.width) - x;
  const height = Math.min(crop.y + crop.height, media.y + media.height) - y;
  if (width <= 0 || height <= 0) throw new PdfInputError('This page has no visible area inside its media bounds.');
  return { x, y, width, height };
}

function area(document, item, { allowLine = false, defaultWidth, defaultHeight } = {}) {
  const page = targetPage(document, item.page);
  const box = effectiveBox(page);
  const x = number(item.x, 0, 0, box.width, 'Horizontal position');
  const y = number(item.y, 0, 0, box.height, 'Vertical position');
  const width = number(item.width, defaultWidth, allowLine ? 0 : 0.1, box.width, 'Width');
  const height = number(item.height, defaultHeight, allowLine ? 0 : 0.1, box.height, 'Height');
  if ((!width && !height) || x + width > box.width + 0.01 || y + height > box.height + 0.01) {
    throw new PdfInputError('The selected rectangle extends beyond this page.');
  }
  return { page, box, x: box.x + x, y: box.y + box.height - y - height, width, height, top: box.y + box.height - y };
}

function color(value, fallback = '#202636') {
  const selected = value ?? fallback;
  if (typeof selected !== 'string' || !/^#[\da-f]{6}$/i.test(selected)) throw new PdfInputError('Choose colors in #RRGGBB format.');
  return rgb(...[1, 3, 5].map((position) => parseInt(selected.slice(position, position + 2), 16) / 255));
}

function imageData(image) {
  if (!image || typeof image.data !== 'string' || !image.data || image.data.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new PdfInputError('Choose a PNG or JPG image under 16 MB.');
  const bytes = Buffer.from(image.data, 'base64');
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new PdfInputError('Choose a PNG or JPG image under 16 MB.');
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpg) throw new PdfInputError('This file does not contain a readable PNG or JPG image.');
  let width, height;
  if (png && bytes.length >= 24) {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (jpg) {
    let offset = 2;
    const startsOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (startsOfFrame.has(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!width || !height || width > 20_000 || height > 20_000 || width * height > 12_000_000) {
    throw new PdfInputError('Use readable images with at most 12 million pixels and no side larger than 20000 pixels.');
  }
  return { bytes, png, width, height };
}

async function embedImage(document, image) {
  const decoded = imageData(image);
  try { return decoded.png ? await document.embedPng(Uint8Array.from(decoded.bytes)) : await document.embedJpg(Uint8Array.from(decoded.bytes)); }
  catch { throw new PdfInputError('The image could not be opened. It may be damaged.'); }
}

export async function organizePages({ files, pages } = {}) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new PdfInputError(`Choose between 1 and ${MAX_FILES} source PDFs.`);
  if (!Array.isArray(pages) || !pages.length || pages.length > MAX_PAGES) throw new PdfInputError(`Choose between 1 and ${MAX_PAGES} output pages.`);
  if (files.reduce((sum, file) => sum + decodeFile(file).bytes.length, 0) > 48 * 1024 * 1024) throw new PdfInputError('Keep combined source PDFs under 48 MB.', 413);
  const sources = [];
  for (const file of files) sources.push(await load(file));
  const output = await PDFDocument.create();
  for (const selected of pages) {
    if (!selected || !Number.isInteger(selected.fileIndex) || selected.fileIndex < 0 || selected.fileIndex >= sources.length) throw new PdfInputError('Every selected page must identify its source PDF.');
    const source = sources[selected.fileIndex];
    if (!Number.isInteger(selected.page) || selected.page < 1 || selected.page > source.getPageCount()) throw new PdfInputError('A selected page is outside its source PDF.');
    const rotation = selected.rotation ?? 0;
    if (![0, 90, 180, 270].includes(rotation)) throw new PdfInputError('Choose page rotations of 0, 90, 180, or 270 degrees.');
    const [page] = await output.copyPages(source, [selected.page - 1]);
    page.setRotation(degrees((page.getRotation().angle + rotation) % 360));
    output.addPage(page);
  }
  return result(output);
}

export async function cropAreas({ file, areas } = {}) {
  itemsList(areas, 'crop areas');
  const document = await load(file);
  const seen = new Set();
  const selected = areas.map((item) => {
    const pageNumber = Number(item.page ?? 1);
    if (seen.has(pageNumber)) throw new PdfInputError('Use one crop rectangle per page.');
    seen.add(pageNumber);
    return area(document, item);
  });
  for (const item of selected) item.page.setCropBox(item.x, item.y, item.width, item.height);
  // Cropping changes visibility, and does not erase content outside the crop.
  return result(document);
}

function wrappedText(text, font, size, width) {
  const lines = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let current = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) { current = candidate; continue; }
      if (current) { lines.push(current); current = ''; }
      for (const character of word) {
        if (font.widthOfTextAtSize(character, size) > width) throw new PdfInputError('The text box is too narrow for this font size.');
        if (font.widthOfTextAtSize(current + character, size) > width) { lines.push(current); current = ''; }
        current += character;
      }
    }
    lines.push(current);
  }
  return lines;
}

export async function editPdf({ file, items } = {}) {
  itemsList(items);
  const permitted = ['text', 'rectangle', 'ellipse', 'line', 'highlight', 'image', 'replace-text'];
  if (items.some((item) => !item || !permitted.includes(item.type))) throw new PdfInputError('Choose supported text, shape, image, or existing-text edits.');
  let document;
  const replacements = items.filter((item) => item.type === 'replace-text');
  if (replacements.length) {
    // The Python engine mutates/removes the existing content object. Additions
    // are applied only after actual text replacement has completed successfully.
    const replaced = await runPython('studio-replace-text', { file, items: replacements });
    const bytes = Buffer.from(replaced.data, 'base64');
    if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES) throw new PdfInputError('The edited PDF exceeds the local output limit.');
    document = await PDFDocument.load(bytes, { updateMetadata: false });
  } else document = await load(file);
  const font = await document.embedFont(StandardFonts.Helvetica);
  let imageBytes = 0, imagePixels = 0;
  for (const item of items.filter((entry) => entry.type !== 'replace-text')) {
    const opacity = number(item.opacity, item.type === 'highlight' ? 0.3 : 1, 0, 1, 'Opacity');
    const ink = color(item.color, item.type === 'highlight' ? '#ffe05a' : '#202636');
    if (item.type === 'line' && (item.x2 !== undefined || item.y2 !== undefined)) {
      const page = targetPage(document, item.page), box = effectiveBox(page);
      if (item.x2 === undefined || item.y2 === undefined) throw new PdfInputError('Provide both line endpoint coordinates.');
      const x1 = number(item.x, 0, 0, box.width, 'Line start X');
      const y1 = number(item.y, 0, 0, box.height, 'Line start Y');
      const x2 = number(item.x2, undefined, 0, box.width, 'Line end X');
      const y2 = number(item.y2, undefined, 0, box.height, 'Line end Y');
      if (x1 === x2 && y1 === y2) throw new PdfInputError('Drag a line with two different endpoints.');
      page.drawLine({ start: { x: box.x + x1, y: box.y + box.height - y1 }, end: { x: box.x + x2, y: box.y + box.height - y2 }, thickness: 2, color: ink, opacity });
      continue;
    }
    const placed = area(document, item, { allowLine: item.type === 'line', defaultWidth: 180, defaultHeight: 40 });
    if (item.type === 'text') {
      if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 4000) throw new PdfInputError('Enter between 1 and 4000 characters for added text.');
      const size = number(item.fontSize, 14, 4, 144, 'Font size');
      let lines;
      try { lines = wrappedText(item.text, font, size, placed.width); }
      catch (error) { if (error instanceof PdfInputError) throw error; throw new PdfInputError('Added text supports Latin letters and common punctuation.'); }
      const lineHeight = size * 1.2;
      if (size + (lines.length - 1) * lineHeight > placed.height) throw new PdfInputError('The text does not fit inside its box. Enlarge the box or reduce its font size.');
      placed.page.drawText(lines.join('\n'), { x: placed.x, y: placed.top - size, size, font, lineHeight, color: ink, opacity });
    } else if (item.type === 'line') {
      placed.page.drawLine({ start: { x: placed.x, y: placed.top }, end: { x: placed.x + placed.width, y: placed.y }, thickness: 2, color: ink, opacity });
    } else if (item.type === 'image') {
      const inputImage = imageData(item.image);
      imageBytes += inputImage.bytes.length;
      imagePixels += inputImage.width * inputImage.height;
      if (imageBytes > 48 * 1024 * 1024) throw new PdfInputError('Keep combined edit images under 48 MB.', 413);
      if (imagePixels > 48_000_000) throw new PdfInputError('Keep combined edit images under 48 million pixels.', 413);
      const image = await embedImage(document, item.image);
      const factor = Math.min(placed.width / image.width, placed.height / image.height);
      const width = image.width * factor, height = image.height * factor;
      placed.page.drawImage(image, { x: placed.x + (placed.width - width) / 2, y: placed.y + (placed.height - height) / 2, width, height, opacity });
    } else if (item.type === 'ellipse') {
      placed.page.drawEllipse({ x: placed.x + placed.width / 2, y: placed.y + placed.height / 2, xScale: placed.width / 2, yScale: placed.height / 2,
        borderColor: ink, borderWidth: 1.5, borderOpacity: opacity, ...(item.fill ? { color: ink, opacity } : {}) });
    } else {
      const filled = item.type === 'highlight' || item.fill;
      placed.page.drawRectangle({ x: placed.x, y: placed.y, width: placed.width, height: placed.height,
        ...(filled ? { color: ink, opacity, borderWidth: 0 } : { borderColor: ink, borderWidth: 1.5, borderOpacity: opacity }) });
    }
  }
  return result(document);
}

export async function imageWatermark({ file, image, opacity = 0.2, width = 180, rotation = 0 } = {}) {
  const document = await load(file);
  const embedded = await embedImage(document, image);
  const alpha = number(opacity, 0.2, 0, 1, 'Opacity');
  const selectedWidth = number(width, 180, 1, 2000, 'Watermark width');
  const angle = number(rotation, 0, -180, 180, 'Watermark rotation');
  const height = selectedWidth * embedded.height / embedded.width;
  const radians = angle * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  for (const page of document.getPages()) {
    const box = effectiveBox(page);
    if (Math.abs(cosine) * selectedWidth + Math.abs(sine) * height > box.width || Math.abs(sine) * selectedWidth + Math.abs(cosine) * height > box.height) {
      throw new PdfInputError('The rotated watermark is too large for a page. Reduce its width.');
    }
    page.drawImage(embedded, { x: box.x + box.width / 2 - (selectedWidth * cosine - height * sine) / 2,
      y: box.y + box.height / 2 - (selectedWidth * sine + height * cosine) / 2,
      width: selectedWidth, height, opacity: alpha, rotate: degrees(angle) });
  }
  return result(document);
}

export async function createFormFields({ file, fields } = {}) {
  itemsList(fields, 'form fields');
  const document = await load(file);
  if (document.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.has(PDFName.of('XFA'))) throw new PdfInputError('This document uses unsupported XFA form fields.');
  const form = document.getForm();
  const names = new Set(form.getFields().map((field) => field.getName()));
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const item of fields) {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || names.has(item.name)) throw new PdfInputError('Give every form field a unique name between 1 and 100 characters.');
    if (!['text', 'checkbox', 'dropdown', 'radio'].includes(item.type)) throw new PdfInputError('Choose text, checkbox, dropdown, or radio fields.');
    names.add(item.name);
    const placed = area(document, item, { defaultWidth: item.type === 'checkbox' ? 20 : 180, defaultHeight: item.type === 'checkbox' ? 20 : 30 });
    const common = { x: placed.x, y: placed.y, width: placed.width, height: placed.height, borderWidth: 1, font };
    try {
      if (item.type === 'text') form.createTextField(item.name).addToPage(placed.page, common);
      else if (item.type === 'checkbox') form.createCheckBox(item.name).addToPage(placed.page, common);
      else {
        if (!Array.isArray(item.options) || item.options.length < (item.type === 'radio' ? 2 : 1) || item.options.length > 20
            || item.options.some((option) => typeof option !== 'string' || !option || option.length > 100) || new Set(item.options).size !== item.options.length) {
          throw new PdfInputError('Provide unique option labels, between 1 and 20 for dropdowns or 2 and 20 for radio groups.');
        }
        for (const option of item.options) font.encodeText(option);
        if (item.type === 'dropdown') {
          const field = form.createDropdown(item.name);
          field.setOptions(item.options);
          field.addToPage(placed.page, common);
        } else {
          if (placed.height < item.options.length * 16 || placed.width < 40) throw new PdfInputError('Radio groups need at least 16 PDF points of height per option and 40 points of width.');
          const field = form.createRadioGroup(item.name);
          const row = placed.height / item.options.length;
          for (const [index, option] of item.options.entries()) {
            const size = Math.min(16, row - 2);
            const y = placed.top - (index + 1) * row + (row - size) / 2;
            field.addOptionToPage(option, placed.page, { x: placed.x, y, width: size, height: size, borderWidth: 1 });
            const labelSize = Math.min(11, (placed.width - size - 5) / font.widthOfTextAtSize(option, 1));
            placed.page.drawText(option, { x: placed.x + size + 5, y: y + (size - labelSize) / 2, size: labelSize, font });
          }
        }
      }
    } catch (error) {
      if (error instanceof PdfInputError) throw error;
      throw new PdfInputError('This field could not be created. Use a valid unique name and Latin option labels.');
    }
  }
  try { form.updateFieldAppearances(font); } catch { throw new PdfInputError('The new field appearances could not be generated.'); }
  return result(document);
}

export async function typedSignature({ file, text, page = 1, x = 36, y = 36, width = 180, fontStyle = 'italic' } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100) throw new PdfInputError('Enter a signature name between 1 and 100 characters.');
  const fonts = { italic: StandardFonts.TimesRomanItalic, serif: StandardFonts.TimesRomanItalic, sans: StandardFonts.HelveticaOblique, monospace: StandardFonts.CourierOblique };
  if (!fonts[fontStyle]) throw new PdfInputError('Choose an italic, serif, sans, or monospace signature style.');
  const document = await load(file);
  const font = await document.embedFont(fonts[fontStyle]);
  const selectedWidth = number(width, 180, 1, 2000, 'Signature width');
  let size;
  try { size = Math.min(48, selectedWidth / font.widthOfTextAtSize(text.trim(), 1)); }
  catch { throw new PdfInputError('Typed signatures currently support Latin letters and common punctuation.'); }
  if (size < 4) throw new PdfInputError('Enlarge the signature width or use a shorter name.');
  const placed = area(document, { page, x, y, width: selectedWidth, height: size * 1.2 });
  placed.page.drawText(text.trim(), { x: placed.x, y: placed.top - size, font, size, color: rgb(0.08, 0.12, 0.2) });
  // Typed and drawn signatures are visual marks, not certificate signatures.
  return result(document);
}
