import {
  PDFCheckBox, PDFDict, PDFDocument, PDFDropdown, PDFName, PDFOptionList,
  PDFRadioGroup, PDFRef, PDFTextField, rgb, StandardFonts,
} from 'pdf-lib';
import { decodeFile, MAX_FILE_BYTES, PdfInputError, safeFilename } from './pdf-ops.mjs';

// Original implementations using the MIT-licensed pdf-lib API. Coordinates in
// annotation/signature operations use the unrotated CropBox's top-left corner.
async function loadPdf(file) {
  const { name, bytes } = decodeFile(file);
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    if (!document.getPageCount()) throw new Error('No pages');
    return document;
  } catch {
    throw new PdfInputError(`We could not open ${name}. It may be damaged or password-protected.`);
  }
}

async function result(document) {
  return {
    bytes: await document.save({ updateFieldAppearances: false }),
    pageCount: document.getPageCount(),
  };
}

function getStandardForm(document) {
  // getForm() silently deletes XFA in pdf-lib, so reject it before that call.
  const acroForm = document.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (acroForm?.has(PDFName.of('XFA'))) {
    throw new PdfInputError('This document uses XFA forms, which this local tool does not support.');
  }
  const form = document.getForm();
  if (form.getFields().length > 250) {
    throw new PdfInputError('This local tool supports documents with up to 250 form fields.');
  }
  return form;
}

function describeField(field) {
  const detail = { name: field.getName(), readOnly: field.isReadOnly(), type: 'unsupported', value: null, supported: false };
  if (field instanceof PDFTextField) {
    detail.type = 'text';
    try { detail.value = field.getText() || ''; } catch { return detail; }
    detail.maxLength = field.getMaxLength() ?? null;
    detail.multiline = field.isMultiline();
  } else if (field instanceof PDFCheckBox) {
    detail.type = 'checkbox';
    detail.value = field.isChecked();
  } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    detail.type = field instanceof PDFDropdown ? 'dropdown' : 'list';
    detail.value = field.getSelected();
    detail.options = field.getOptions();
    detail.multiselect = field.isMultiselect();
  } else if (field instanceof PDFRadioGroup) {
    detail.type = 'radio';
    detail.value = field.getSelected() || '';
    detail.options = field.getOptions();
  } else {
    return detail;
  }
  detail.supported = !detail.readOnly;
  return detail;
}

export async function inspectPdfForms(file) {
  const document = await loadPdf(file);
  return { pageCount: document.getPageCount(), fields: getStandardForm(document).getFields().map(describeField) };
}

function validateFieldValue(field, value) {
  const info = describeField(field);
  if (!info.supported) {
    throw new PdfInputError(`The field “${info.name}” is read-only or has an unsupported field type.`);
  }
  if (info.type === 'checkbox') {
    if (typeof value !== 'boolean') throw new PdfInputError(`Use true or false for “${info.name}”.`);
    return;
  }
  if (info.type === 'text') {
    if (typeof value !== 'string' || value.length > 4000 || (info.maxLength !== null && value.length > info.maxLength)) {
      throw new PdfInputError(`The text for “${info.name}” exceeds its limit or is not a text value.`);
    }
    return;
  }
  if (info.type === 'radio' && typeof value !== 'string') {
    throw new PdfInputError(`Choose one radio option for “${info.name}”.`);
  }
  if (value === '') return; // A blank optional choice clears its selection.
  const values = Array.isArray(value) ? value : [value];
  if ((!info.multiselect && values.length > 1) || values.some((item) => typeof item !== 'string' || !info.options.includes(item))) {
    throw new PdfInputError(`Choose a valid listed option for “${info.name}”.`);
  }
  if (info.type === 'radio' && (values.length !== 1 || !values[0])) {
    throw new PdfInputError(`Choose one radio option for “${info.name}”.`);
  }
}

export async function fillPdfForms(file, { fields, flatten = false } = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length || Object.keys(fields).length > 250) {
    throw new PdfInputError('Provide between 1 and 250 form field values.');
  }
  if (typeof flatten !== 'boolean') throw new PdfInputError('Flatten must be true or false.');
  const document = await loadPdf(file);
  const form = getStandardForm(document);
  const available = new Map(form.getFields().map((field) => [field.getName(), field]));
  for (const [name, value] of Object.entries(fields)) {
    const field = available.get(name);
    if (!field) throw new PdfInputError(`This PDF does not contain a form field named “${name}”.`);
    validateFieldValue(field, value);
  }
  const font = await document.embedFont(StandardFonts.Helvetica);
  // Validate all submitted text before changing fields or generating appearances.
  for (const value of Object.values(fields)) {
    for (const label of Array.isArray(value) ? value : [value]) {
      if (typeof label === 'string') {
        try { font.encodeText(label.replace(/[\r\n\t]/g, ' ')); } catch {
          throw new PdfInputError('This form tool currently supports Latin letters, numbers, and common punctuation.');
        }
      }
    }
  }
  for (const [name, value] of Object.entries(fields)) {
    const field = available.get(name);
    if (field instanceof PDFTextField) field.setText(value);
    else if (field instanceof PDFCheckBox) { if (value) field.check(); else field.uncheck(); }
    else if (value === '' || (Array.isArray(value) && !value.length)) field.clear();
    else field.select(value);
  }
  try {
    form.updateFieldAppearances(font);
    if (flatten) form.flatten({ updateFieldAppearances: false });
  } catch {
    throw new PdfInputError('We could not update this form’s appearance. It may contain an unsupported font or malformed field.');
  }
  return result(document);
}

export async function flattenPdf(file) {
  const document = await loadPdf(file);
  const form = getStandardForm(document);
  try {
    // Existing appearance streams are preserved; missing ones are generated.
    form.flatten();
  } catch {
    throw new PdfInputError('This form could not be flattened. Its fields may have unsupported fonts or missing appearances.');
  }
  return result(document);
}

export async function removeMetadataPdf(file) {
  const document = await loadPdf(file);
  const info = document.context.trailerInfo.Info;
  const xmp = document.catalog.get(PDFName.of('Metadata'));
  // Remove the actual metadata objects too: deleting only their references can
  // leave their strings recoverable in the serialized PDF's object table.
  if (info instanceof PDFRef) document.context.delete(info);
  if (xmp instanceof PDFRef) document.context.delete(xmp);
  document.context.trailerInfo.Info = undefined;
  document.context.trailerInfo.ID = undefined;
  document.catalog.delete(PDFName.of('Metadata'));
  // This targets document Info/XMP. Page content, attachments, annotations and
  // metadata inside embedded images are intentionally outside this operation.
  return result(document);
}

function placement(document, { page = 1, x = 36, y = 36 } = {}) {
  const pageNumber = Number(page);
  const left = Number(x);
  const top = Number(y);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.getPageCount()) {
    throw new PdfInputError(`Choose a page between 1 and ${document.getPageCount()}.`);
  }
  const target = document.getPage(pageNumber - 1);
  const box = target.getCropBox();
  if (!Number.isFinite(left) || !Number.isFinite(top) || left < 0 || top < 0 || left >= box.width || top >= box.height) {
    throw new PdfInputError('Choose a position inside the page’s visible area.');
  }
  return { target, box, left, top };
}

function wrapText(text, font, size, width) {
  const lines = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) { lines.push(line); line = ''; }
      for (const character of word) {
        if (font.widthOfTextAtSize(character, size) > width) {
          throw new PdfInputError('There is not enough width for the text at this position and size.');
        }
        if (font.widthOfTextAtSize(line + character, size) > width) { lines.push(line); line = ''; }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

export async function annotatePdf(file, options = {}) {
  const { text, fontSize = 18, color = '#202636' } = options;
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
    throw new PdfInputError('Enter between 1 and 4000 characters to add to the PDF.');
  }
  const size = Number(fontSize);
  if (!Number.isFinite(size) || size < 6 || size > 96) throw new PdfInputError('Choose a text size between 6 and 96 PDF points.');
  if (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) throw new PdfInputError('Choose a color in #RRGGBB format.');
  const document = await loadPdf(file);
  const { target, box, left, top } = placement(document, options);
  const font = await document.embedFont(StandardFonts.Helvetica);
  let lines;
  try { lines = wrapText(text, font, size, box.width - left - 4); } catch (error) {
    if (error instanceof PdfInputError) throw error;
    throw new PdfInputError('Added text currently supports Latin letters, numbers, and common punctuation.');
  }
  const lineHeight = size * 1.25;
  if (top + size + (lines.length - 1) * lineHeight > box.height) {
    throw new PdfInputError('The text does not fit below this position. Move it up or choose a smaller size.');
  }
  const channels = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16) / 255);
  target.drawText(lines.join('\n'), {
    x: box.x + left, y: box.y + box.height - top - size, font, size, lineHeight,
    color: rgb(...channels),
  });
  return result(document);
}

function signatureImage(file) {
  if (!file || typeof file.data !== 'string' || !file.data || file.data.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8) {
    throw new PdfInputError('Choose a PNG or JPG signature image under 16 MB.');
  }
  const name = safeFilename(file.name, 'signature');
  if (!/\.(png|jpe?g)$/i.test(name) || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) {
    throw new PdfInputError('Choose a PNG or JPG signature image.');
  }
  const bytes = Buffer.from(file.data, 'base64');
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new PdfInputError('Choose a signature image under 16 MB.');
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpg) throw new PdfInputError('The signature file does not contain a valid PNG or JPG image.');
  return { bytes, png };
}

export async function signPdf(file, options = {}) {
  const { image, width = 180 } = options;
  const imageFile = signatureImage(image);
  const requestedWidth = Number(width);
  if (!Number.isFinite(requestedWidth) || requestedWidth < 1 || requestedWidth > 2000) {
    throw new PdfInputError('Choose a signature width between 1 and 2000 PDF points.');
  }
  const document = await loadPdf(file);
  const { target, box, left, top } = placement(document, options);
  let embedded;
  try {
    const bytes = Uint8Array.from(imageFile.bytes);
    embedded = imageFile.png ? await document.embedPng(bytes) : await document.embedJpg(bytes);
  } catch {
    throw new PdfInputError('We could not open the signature image. It may be damaged.');
  }
  const height = requestedWidth * embedded.height / embedded.width;
  if (left + requestedWidth > box.width || top + height > box.height) {
    throw new PdfInputError('The signature does not fit inside the page at this position. Reduce its width or move it.');
  }
  target.drawImage(embedded, {
    x: box.x + left, y: box.y + box.height - top - height, width: requestedWidth, height,
  });
  // This places a signature image. It does not create a certificate signature.
  return result(document);
}
