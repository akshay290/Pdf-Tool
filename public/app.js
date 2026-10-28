const state = { mode: 'merge', files: [], busy: false, outputs: [], result: null, rotation: 90, watermarkText: 'DRAFT', opacity: '0.18', startNumber: '1', cropMargin: '24', compression: 'target', targetSize: '500', targetUnit: 'KB', renderFormat: 'jpg', renderDpi: '144', password: '', textFormat: 'txt', annotationText: '', page: '1', x: '36', y: '36', fontSize: '18', color: '#1e805b', signatureWidth: '160', signature: null, flattenForm: true, html: '<h1>My document</h1>\n<p>A fresh page, ready for your content.</p>' };
Object.assign(state, { language: 'eng', conversionOcr: false, includeImages: false, renderMethod: 'pages', compareMethod: 'text', htmlMethod: 'paste', htmlUrl: '' });
const picker = document.querySelector('#file-picker');
const workspace = document.querySelector('#workspace-body');
const toolHeading = document.querySelector('#tool-heading');
const crumbTool = document.querySelector('#crumb-tool');
const toast = document.querySelector('#toast');
let toastTimer;
let sequence = 0;

const modes = {
  merge: { title: 'Merge PDFs', verb: 'Merge PDFs', icon: '<span class="nav-icon icon-merge"><i></i><i></i></span>', intro: 'Put your documents together, in exactly the order you want.', empty: 'Add the PDFs you want to bring together.' },
  split: { title: 'Split pages', verb: 'Split PDF', icon: '<span class="nav-icon icon-split"><i></i></span>', intro: 'Save selected page ranges as separate PDF files.', empty: 'Choose a PDF to pick out its pages.' },
  rotate: { title: 'Rotate PDF', verb: 'Rotate PDF', icon: '<span class="nav-icon icon-rotate">↻</span>', intro: 'Rotate all pages together or adjust individual pages.', empty: 'Choose a PDF to rotate its pages.' },
  organize: { title: 'Arrange pages', verb: 'Save page order', icon: '<span class="nav-icon icon-text">⇅</span>', intro: 'Drag pages to reorder them, remove or duplicate them, rotate individual pages, and insert pages from another PDF.' },
  watermark: { title: 'Add a watermark', verb: 'Add watermark', icon: '<span class="nav-icon icon-text">W</span>', intro: 'Add a text or image watermark to every page of your document.' },
  number: { title: 'Number pages', verb: 'Add page numbers', icon: '<span class="nav-icon icon-text">#</span>', intro: 'Add a running page number to the bottom of each page.' },
  crop: { title: 'Trim page edges', verb: 'Crop PDF', icon: '<span class="nav-icon icon-text">⌗</span>', intro: 'Choose a visible area on the page or trim equal margins from its edges.' },
  images: { title: 'Images to PDF', verb: 'Create PDF', icon: '<span class="nav-icon icon-text">▧</span>', intro: 'Collect JPG and PNG images into one PDF, with one image per page.' },
  compress: { title: 'Compress PDF', verb: 'Compress PDF', icon: '<span class="nav-icon icon-text">⇲</span>', intro: 'Choose the maximum file size you need, and let LocalFold try to bring your PDF under that limit.' },
  render: { title: 'PDF to images', verb: 'Export images', icon: '<span class="nav-icon icon-text">▧</span>', intro: 'Export page images, or extract the images embedded in your PDF, in one ZIP download.' },
  protect: { title: 'Protect PDF', verb: 'Protect PDF', icon: '<span class="nav-icon icon-text">⌑</span>', intro: 'Require a password to open your document, using AES-256 encryption.' },
  unlock: { title: 'Unlock PDF', verb: 'Unlock PDF', icon: '<span class="nav-icon icon-text">⚿</span>', intro: 'Remove password protection from a PDF using its existing password.' },
  repair: { title: 'Repair PDF', verb: 'Repair PDF', icon: '<span class="nav-icon icon-text">✚</span>', intro: 'Attempt to recover readable pages and rebuild a damaged PDF. Severely damaged files may not be recoverable.' },
  text: { title: 'Extract text', verb: 'Extract text', icon: '<span class="nav-icon icon-text">T</span>', intro: 'Download the text already present in your PDF as plain text or Markdown. Scanned pages need OCR first.' },
  compare: { title: 'Compare PDFs', verb: 'Compare PDFs', icon: '<span class="nav-icon icon-text">≠</span>', intro: 'Compare text or page appearance. Visual comparisons include an HTML report and difference images in a ZIP archive.' },
  flatten: { title: 'Flatten PDF', verb: 'Flatten PDF', icon: '<span class="nav-icon icon-text">▱</span>', intro: 'Make existing form values permanent on the page so they can no longer be edited as form fields.' },
  metadata: { title: 'Remove metadata', verb: 'Remove metadata', icon: '<span class="nav-icon icon-text">◇</span>', intro: 'Clear document properties such as author, title, subject, and keywords. This does not redact page content.' },
  annotate: { title: 'Edit PDF', verb: 'Save PDF edits', icon: '<span class="nav-icon icon-text">A</span>', intro: 'Place text, shapes, highlights, and images on your pages. Select supported existing text objects to replace their text.' },
  forms: { title: 'PDF forms', verb: 'Save PDF form', icon: '<span class="nav-icon icon-text">☷</span>', intro: 'Fill existing interactive fields, or create text, checkbox, dropdown, and radio fields on your PDF.' },
  sign: { title: 'Sign PDF', verb: 'Place signature', icon: '<span class="nav-icon icon-text">✎</span>', intro: 'Upload, draw, or type a signature and place it on your page. This is a visual signature, without a digital certificate.' },
  ocr: { title: 'Make scans searchable', verb: 'Recognize text', icon: '<span class="nav-icon icon-text">⊞</span>', intro: 'Add a text layer to scanned pages using six locally installed languages. Up to 50 pages; recognition can take several minutes.' },
  html: { title: 'HTML to PDF', verb: 'Create PDF', icon: '<span class="nav-icon icon-text">‹›</span>', intro: 'Paste HTML to create a PDF. Inline CSS is supported; scripts and external images, fonts, and links are not loaded.' },
  office: { title: 'Office to PDF', verb: 'Convert to PDF', icon: '<span class="nav-icon icon-text">▤</span>', intro: 'Convert Word, Excel, or PowerPoint documents to PDF using LibreOffice on this machine. DOC, DOCX, XLS, XLSX, PPT, and PPTX are supported; fonts and page breaks may vary.' },
  docx: { title: 'PDF to Word', verb: 'Export Word document', icon: '<span class="nav-icon icon-text">W</span>', intro: 'Rebuild text, tables, and images in an editable Word document, up to 100 pages. Enable OCR for scans. Complex layouts and substituted fonts may differ.' },
  pptx: { title: 'PDF to PowerPoint', verb: 'Export slides', icon: '<span class="nav-icon icon-text">P</span>', intro: 'Create slides with editable text and reconstructed page graphics, up to 20 pages. Enable OCR for scans, and review the resulting layout.' },
  xlsx: { title: 'PDF to Excel', verb: 'Extract tables', icon: '<span class="nav-icon icon-text">X</span>', intro: 'Extract detectable tables into an Excel workbook, up to 30 pages. Enable OCR for scans. Review extracted cells because recognition and table detection can vary.' },
};

function multipleFiles() { return ['merge', 'images', 'compare', 'organize'].includes(state.mode); }
function bypassInspection() { return ['unlock', 'repair', 'office'].includes(state.mode); }
function inputFamily() { return state.mode === 'images' ? 'images' : state.mode === 'office' ? 'office' : 'pdf'; }
function inputName() { return state.mode === 'images' ? 'images' : state.mode === 'office' ? 'document' : `PDF${multipleFiles() ? 's' : ''}`; }
function readyToRun() {
  if (state.mode === 'html') return Boolean((state.htmlMethod === 'url' ? state.htmlUrl : state.html).trim());
  const loaded = state.files.every((file) => file.data && (file.pageCount || bypassInspection()));
  const count = state.mode === 'compare' ? state.files.length === 2 : state.mode === 'merge' ? state.files.length >= 2 : multipleFiles() ? state.files.length >= 1 : state.files.length === 1;
  const pageLimit = currentPageLimit();
  const cropReady = state.mode !== 'crop' || studio.cropMethod !== 'area' || (studio.cropAll ? Boolean(studio.draft().areas[studio.page]) : Object.keys(studio.draft().areas).length > 0);
  return loaded && count && cropReady && (state.mode !== 'sign' || Boolean(studio.signatureMode === 'type' ? studio.typedText.trim() : state.signature)) && (state.mode !== 'forms' || (studio.formMode === 'create' ? studio.draft().fields.length > 0 : Boolean(state.files[0]?.formFields?.some((field) => field.supported && !field.readOnly)))) && (!pageLimit || state.files.every((file) => file.pageCount <= pageLimit));
}

function currentPageLimit() {
  if (state.mode === 'compress') return ['lossless', 'target'].includes(state.compression) ? null : 40;
  return { ocr: 50, render: state.renderMethod === 'embedded' ? 200 : 40, text: 200, compare: state.compareMethod === 'visual' ? 40 : 200, docx: state.conversionOcr ? 50 : 100, pptx: state.conversionOcr ? 20 : 20, xlsx: 30 }[state.mode];
}

function pageLimitNote() {
  const limit = currentPageLimit();
  if (!limit || !state.files.some((file) => file.pageCount > limit)) return '';
  return `<p class="crop-note">${escapeHtml(modes[state.mode].title)} supports up to ${limit} pages per PDF for these settings. Use Split pages first to create a smaller document${state.mode === 'compress' ? ', or choose Lossless compression' : ''}.</p>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function targetSizeBytes() {
  const value = Number(state.targetSize);
  const factor = { KB: 1000, MB: 1000000 }[state.targetUnit];
  const bytes = Math.floor(value * factor);
  if (!String(state.targetSize).trim() || !Number.isFinite(value) || !factor || !Number.isFinite(bytes) || bytes < 1000 || bytes > 16 * 1024 * 1024) {
    throw new Error('Choose a target from 1 KB to 16.777216 MB (1,000 to 16,777,216 bytes).');
  }
  return bytes;
}

function formatCompressionBytes(bytes) {
  return bytes >= 1000000 ? `${Number((bytes / 1000000).toFixed(6))} MB` : `${Number((bytes / 1000).toFixed(3))} KB`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4300);
}

function fileRow(file, index) {
  const canReorder = multipleFiles();
  return `<div class="file-row" data-file-id="${file.id}">
    <span class="pdf-symbol ${file.kind === 'image' ? 'image-symbol' : ''}" aria-hidden="true"><b>${file.kind === 'image' ? 'IMG' : file.kind === 'office' ? file.name.split('.').pop().toUpperCase() : 'PDF'}</b><i></i></span>
    <div class="file-info"><p class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</p><div class="file-meta"><span>${file.pageCount ? `${file.pageCount} ${file.pageCount === 1 ? 'page' : 'pages'}` : file.data && bypassInspection() ? (state.mode === 'unlock' ? 'Ready to unlock · page count checked after decryption' : state.mode === 'office' ? 'Ready to convert · page count checked after conversion' : 'Ready for recovery attempt') : 'Reading pages…'}</span><i class="meta-dot"></i><span>${formatBytes(file.size)}</span></div></div>
    <div class="file-actions" aria-label="File actions">
      ${canReorder ? `<button class="tiny-button" data-action="up" data-id="${file.id}" aria-label="Move ${escapeHtml(file.name)} up" ${state.busy || index === 0 ? 'disabled' : ''}>↑</button><button class="tiny-button" data-action="down" data-id="${file.id}" aria-label="Move ${escapeHtml(file.name)} down" ${state.busy || index === state.files.length - 1 ? 'disabled' : ''}>↓</button>` : ''}
      <button class="tiny-button remove" data-action="remove" data-id="${file.id}" aria-label="Remove ${escapeHtml(file.name)}" ${state.busy ? 'disabled' : ''}>×</button>
    </div>
  </div>`;
}

function fileQueue() {
  return `<div class="queue-top"><span class="queue-title">${state.mode === 'merge' ? 'PDFs to merge' : state.mode === 'compare' ? 'Original PDF, then revised PDF' : state.mode === 'images' ? 'Images in page order' : state.mode === 'office' ? 'Selected Office document' : 'Selected PDF'}</span><span class="queue-count">${state.files.length} ${state.files.length === 1 ? 'file' : 'files'} · ${formatBytes(state.files.reduce((sum, file) => sum + file.size, 0))}</span></div>
  <div class="file-list">${state.files.map(fileRow).join('')}</div>
  <button class="choose-button add-more" data-action="choose" ${state.busy ? 'disabled' : ''}><span>＋</span> ${multipleFiles() ? `Add another ${state.mode === 'images' ? 'image' : 'PDF'}` : state.mode === 'office' ? 'Choose a different document' : 'Choose a different PDF'}</button>`;
}

function textField(id, label, value, help, attributes = '') {
  return `<div class="tool-field"><label class="field-label" for="${id}">${label}</label><input class="range-input" id="${id}" value="${escapeHtml(value)}" ${attributes} ${state.busy ? 'disabled' : ''}><p class="range-help">${help}</p></div>`;
}

function selectField(id, label, value, options, help = '', attributes = '') {
  const selected = Array.isArray(value) ? value.map(String) : [String(value ?? '')];
  return `<div class="tool-field"><label class="field-label" for="${id}">${label}</label><select class="range-input" id="${id}" ${attributes} ${state.busy ? 'disabled' : ''}>${options.map(([key, text]) => `<option value="${escapeHtml(key)}" ${selected.includes(String(key)) ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}</select><p class="range-help">${help}</p></div>`;
}

function positionOptions() {
  return `<div class="field-grid">${textField('target-page', 'Page number', state.page, 'The first page is 1.', 'type="number" min="1" step="1"')}${textField('position-x', 'Distance from left (points)', state.x, '72 points = 1 inch.', 'type="number" min="0"')}${textField('position-y', 'Distance from top (points)', state.y, 'Coordinates use the unrotated visible page.', 'type="number" min="0"')}</div>`;
}

function formOptions(file) {
  if (!file.formFields) return '<p class="range-help">Reading interactive form fields…</p>';
  if (!file.formFields.length) return '<p class="crop-note">This PDF has no supported interactive form fields. Use Add text to place new text on a flat document.</p>';
  return `<div class="form-fields">${file.formFields.map((field, index) => {
    const id = `form-field-${index}`;
    if (!field.supported || field.readOnly) return `<p class="range-help">${escapeHtml(field.name)} · ${field.readOnly ? 'read only' : 'unsupported field'}</p>`;
    if (field.type === 'checkbox') return `<label class="check-option"><input id="${id}" data-form-field="${index}" type="checkbox" ${field.value ? 'checked' : ''} ${state.busy ? 'disabled' : ''}> ${escapeHtml(field.name)}</label>`;
    if (Array.isArray(field.options) && field.options.length) return selectField(id, escapeHtml(field.name), field.value, [...(field.multiselect ? [] : [['', 'Choose a value']]), ...field.options.map((option) => [option, option])], field.multiselect ? 'Select one or more options using Ctrl or Command.' : '', field.multiselect ? 'multiple' : '');
    if (field.multiline) return `<div class="tool-field"><label class="field-label" for="${id}">${escapeHtml(field.name)}</label><textarea class="range-input form-textarea" id="${id}" ${state.busy ? 'disabled' : ''}>${escapeHtml(field.value ?? '')}</textarea></div>`;
    return textField(id, escapeHtml(field.name), field.value ?? '', '');
  }).join('')}<label class="check-option"><input id="flatten-form" type="checkbox" ${state.flattenForm ? 'checked' : ''} ${state.busy ? 'disabled' : ''}> Make the filled values permanent (flatten form)</label></div>`;
}

function languageOptions() { return [['eng', 'English'], ['hin', 'Hindi'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['por', 'Portuguese']]; }

function conversionOptions() {
  return `<div class="range-panel"><label class="check-option"><input id="conversion-ocr" type="checkbox" ${state.conversionOcr ? 'checked' : ''} ${state.busy ? 'disabled' : ''}>Recognize scanned text before conversion</label>${selectField('ocr-language', 'Document language', state.language, languageOptions(), 'OCR runs locally. Review the result for recognition errors.')}</div>`;
}

function toolOptions() {
  const file = state.files[0];
  if (!file?.data) return '';
  const pages = file.pageCount;
  if (state.mode === 'compress') return `<div class="range-panel">${state.compression === 'target' ? `<div class="target-size-panel"><p class="field-label">Maximum file size</p><div class="target-size-fields">${textField('target-size', 'Size', state.targetSize, '', `type="number" min="${state.targetUnit === 'MB' ? '0.001' : '1'}" max="${state.targetUnit === 'MB' ? '16.777216' : '16777.216'}" step="any" inputmode="decimal"`)}${selectField('target-unit', 'Unit', state.targetUnit, [['KB', 'KB'], ['MB', 'MB']])}</div><p class="range-help">1 MB = 1,000 KB. We aim for a result at or below your target; files are not padded to an exact size.</p><p class="range-help">Some targets cannot be reached. Strong reductions may turn pages into images, removing selectable text and interactive forms. This image conversion supports up to 40 pages; longer PDFs can still try lossless optimization.</p></div>` : ''}<details class="placement-details"><summary>Advanced: compression method</summary><div class="range-panel">${selectField('compression', 'Method', state.compression, [['target', 'Target file size'], ['lossless', 'Lossless — preserve text and image quality'], ['balanced', 'Balanced — rasterize pages'], ['small', 'Smallest — lower resolution pages']], 'Lossless retains selectable text. Balanced and Smallest support up to 40 pages and turn pages into images, removing selectable text and interactive forms. Already optimized PDFs may not become smaller.')}</div></details></div>`;
  if (state.mode === 'render') return `<div class="range-panel">${selectField('render-method', 'Images to export', state.renderMethod, [['pages', 'Render every page'], ['embedded', 'Extract embedded images']], 'Embedded extraction saves original image objects instead of rendering full pages.')}<div class="field-grid">${selectField('render-format', 'Page image format', state.renderFormat, [['jpg', 'JPG'], ['png', 'PNG']], 'Page rendering: up to 40 pages per PDF.')}${selectField('render-dpi', 'Page resolution', state.renderDpi, [['72', '72 dpi — screen'], ['144', '144 dpi — standard'], ['200', '200 dpi — detailed']])}</div></div>`;
  if (['protect', 'unlock'].includes(state.mode)) return `<div class="range-panel">${textField('pdf-password', state.mode === 'protect' ? 'New document password' : 'Existing document password', state.password, state.mode === 'protect' ? 'Use at least 8 characters and at most 256 UTF-8 bytes. Keep this password safe. It is cleared after the protected file is ready.' : 'Enter the existing password, up to 256 UTF-8 bytes. It is cleared after a successful unlock.', 'type="password" autocomplete="off"')}${state.mode === 'protect' ? '<p class="range-help">Anyone opening the resulting PDF will need this password.</p>' : ''}</div>`;
  if (state.mode === 'text') return `<div class="range-panel">${selectField('text-format', 'Download format', state.textFormat, [['txt', 'Plain text (.txt)'], ['md', 'Markdown (.md)']], 'Up to 200 pages per PDF.')}<label class="check-option"><input id="include-images" type="checkbox" ${state.includeImages ? 'checked' : ''}>For Markdown, include linked images in a ZIP bundle</label></div>`;
  if (state.mode === 'compare') return `<div class="range-panel">${selectField('compare-method', 'Comparison method', state.compareMethod, [['text', 'Text differences — Markdown report'], ['visual', 'Visual differences — HTML and images ZIP']], 'Text: up to 200 pages and 200,000 extracted characters per PDF. Visual: up to 40 pages per PDF.')}</div>`;
  if (state.mode === 'ocr') return `<div class="range-panel">${selectField('ocr-language', 'Document language', state.language, languageOptions(), 'Up to 50 pages. Select the language that best matches your document.')}</div>`;
  if (['docx', 'pptx', 'xlsx'].includes(state.mode)) return conversionOptions();
  if (state.mode === 'annotate') return '';
  if (state.mode === 'forms') return studio.formMode === 'fill' ? `<div class="range-panel">${formOptions(file)}</div>` : '';
  if (state.mode === 'sign') return `<div class="range-panel tool-fields">${studio.signatureMode === 'upload' ? `<div class="signature-upload">${state.signature ? `<img class="signature-preview" src="data:${state.signature.mime};base64,${state.signature.data}" alt="Selected signature"><span>${escapeHtml(state.signature.name)}</span>` : '<p class="range-help">Choose a JPG or PNG containing your signature. A transparent PNG gives the cleanest result.</p>'}<button class="choose-button" data-action="signature" ${state.busy ? 'disabled' : ''}>${state.signature ? 'Change signature image' : 'Choose signature image'}</button></div>` : ''}<details class="placement-details"><summary>Fine-tune placement</summary><div class="range-panel">${positionOptions()}${textField('signature-width', 'Signature width (points)', state.signatureWidth, 'The image keeps its original aspect ratio.', 'type="number" min="1"')}</div></details></div>`;
  if (state.mode === 'split') {
    const midpoint = Math.ceil(pages / 2);
    if (file.ranges === null) file.ranges = pages > 1 ? `1-${midpoint}, ${midpoint + 1}-${pages}` : '1';
    return `<div class="range-panel">${textField('page-ranges', 'Page ranges', file.ranges, 'Separate each output with a comma. Example: <strong>1-3, 4-8, 9</strong>', 'autocomplete="off" spellcheck="false"')}</div>`;
  }
  if (state.mode === 'rotate') {
    if (studio.rotationScope === 'individual') return '';
    return `<fieldset class="range-panel rotation-fieldset" ${state.busy ? 'disabled' : ''}><legend class="field-label">Turn pages clockwise</legend><div class="rotation-options">${[90, 180, 270].map((rotation, index) => `<div class="rotation-choice"><input type="radio" id="rotation-${rotation}" name="rotation" value="${rotation}" ${state.rotation === rotation ? 'checked' : ''}><label for="rotation-${rotation}"><span class="rotation-glyph">${['↻', '⟳', '↺'][index]}</span> ${rotation}°</label></div>`).join('')}</div></fieldset>`;
  }
  if (state.mode === 'organize') {
    if (file.pageOrder === null) file.pageOrder = Array.from({ length: pages }, (_, index) => index + 1).join(', ');
    return `<details class="manual-order"><summary>Enter page order manually</summary><div class="range-panel">${textField('page-order', 'Pages from the first PDF, in order', file.pageOrder, `Enter page numbers from 1 to ${pages}. For example, <strong>3, 1, 2</strong>. Manual ordering replaces the thumbnail order with pages from the first PDF. Use thumbnails to combine files.`, 'autocomplete="off" spellcheck="false"')}</div></details>`;
  }
  if (state.mode === 'watermark') return studio.watermarkMode === 'text' ? `<div class="range-panel tool-fields">${textField('watermark-text', 'Watermark text', state.watermarkText, 'Up to 100 characters. Common Latin letters and punctuation are supported.', 'maxlength="100" autocomplete="off"')}${textField('watermark-opacity', 'Opacity', state.opacity, 'Use a value from 0.05 (faint) to 1 (solid).', 'type="number" min="0.05" max="1" step="0.01"')}</div>` : '';
  if (state.mode === 'number') return `<div class="range-panel">${textField('start-number', 'First page number', state.startNumber, 'Number every page in sequence, starting at this number.', 'type="number" min="1" max="999999" step="1"')}</div>`;
  if (state.mode === 'crop') return `<div class="range-panel">${studio.cropMethod === 'margin' ? textField('crop-margin', 'Margin to hide on each edge (points)', state.cropMargin, '72 points = 1 inch. The same margin applies to all four edges on every page.', 'type="number" min="0" step="1"') : ''}<p class="crop-note">Cropping changes the visible page boundary. Hidden content remains in the PDF and can be recovered. Use a redaction tool when content must be permanently removed.</p></div>`;
  if (state.mode === 'images') return '<div class="range-panel"><p class="range-help">Each image becomes one PDF page at its original aspect ratio. Use the arrows above to choose the page order.</p></div>';
  return '';
}

function render() {
  const mode = modes[state.mode];
  toolHeading.textContent = mode.title;
  crumbTool.textContent = mode.title;
  document.querySelector('#tool-badge').innerHTML = mode.icon;
  document.querySelectorAll('.nav-item').forEach((button) => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('active', active);
    button.disabled = state.busy;
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  const actionDisabled = state.busy || !readyToRun();
  const options = toolOptions();
  workspace.innerHTML = `<div class="tool-intro"><p class="subheading">${mode.title}</p><p class="subcopy">${mode.intro}</p></div>
    ${state.mode === 'html' ? `<div class="range-panel">${selectField('html-method', 'Source', state.htmlMethod, [['paste', 'Paste HTML'], ['url', 'Capture a public web page']])}${state.htmlMethod === 'url' ? textField('html-url', 'Public page URL', state.htmlUrl, 'Public HTTP or HTTPS pages only. Pages requiring sign-in and private network addresses are not supported.', 'type="url" placeholder="https://example.com"') : `<label class="field-label" for="html-source">Your HTML</label><textarea class="range-input html-source" id="html-source" maxlength="200000" spellcheck="false" ${state.busy ? 'disabled' : ''}>${escapeHtml(state.html)}</textarea><p class="range-help">Paste up to 200,000 characters. Only content included here can appear in the PDF.</p>`}</div>` : state.files.length ? `<div class="file-selection">${fileQueue()}</div>` : `<div class="dropzone" id="dropzone" role="button" tabindex="0" aria-label="Choose ${inputName()}"><span class="upload-art"><span class="upload-file"></span><span class="upload-cloud">↑</span></span><p class="drop-title">Drop your ${inputName()} here</p><p class="drop-subtitle">or choose from your device</p><button class="choose-button" data-action="choose"><span>＋</span> Choose ${inputName()}</button><p class="file-limits">Up to 16 MB per file · ${state.mode === 'images' ? 'JPG and PNG images' : state.mode === 'office' ? 'DOC, DOCX, XLS, XLSX, PPT, and PPTX documents' : 'PDF files'} only · 48 MB per task</p></div>`}
    ${options}
    ${studio.options()}
    <div id="page-limit-note">${pageLimitNote()}</div>
    <div class="workspace-bottom"><div class="bottom-hint"><span class="hint-lock">⌑</span><span>Processed on your local server.<br>No third-party uploads.</span></div><button class="primary-button" data-action="run" ${actionDisabled ? 'disabled' : ''}>${state.busy ? 'Working…' : mode.verb}<span class="button-arrow" aria-hidden="true">${state.busy ? '⋯' : '→'}</span></button></div>
    ${state.result ? renderResult() : ''}`;
  wireWorkspaceEvents();
  studio.bind();
}

function renderResult() {
  if (!state.result) return '';
  const outputs = state.outputs;
  const title = state.result.title;
  const label = state.result.note;
  const list = outputs.length > 1 ? `<div class="split-results">${outputs.map((output, index) => `<div class="split-result-row"><span>${escapeHtml(output.name)} · ${output.pageCount} ${output.pageCount === 1 ? 'page' : 'pages'}</span><button class="download-button" data-action="download" data-index="${index}">↓ Save</button></div>`).join('')}</div>` : '';
  const download = outputs.length === 1 ? `<button class="download-button" data-action="download" data-index="0">↓ Download ${escapeHtml(outputs[0].label || 'PDF')}</button>` : '';
  const partial = state.result.status === 'partial';
  return `<div class="result-panel ${partial ? 'result-partial' : ''}"><div class="result-copy"><span class="result-check">${partial ? '!' : '✓'}</span><div><p class="result-title">${escapeHtml(title)}</p><p class="result-meta">${escapeHtml(label)}</p></div></div>${download}</div>${list}`;
}

function wireWorkspaceEvents() {
  for (const selector of ['#page-ranges', '#page-order', '#watermark-text', '#watermark-opacity', '#start-number', '#crop-margin', '#compression', '#target-size', '#target-unit', '#render-format', '#render-dpi', '#pdf-password', '#text-format', '#annotation-text', '#target-page', '#position-x', '#position-y', '#annotation-size', '#annotation-color', '#signature-width', '#flatten-form', '#html-source', '#ocr-language', '#conversion-ocr', '#include-images', '#render-method', '#compare-method', '#html-method', '#html-url', ...(state.files[0]?.formFields || []).map((_, index) => `#form-field-${index}`)]) {
    const input = workspace.querySelector(selector);
    for (const event of ['input', 'change']) input?.addEventListener(event, () => {
      captureInputs();
      invalidateResults();
      const run = workspace.querySelector('[data-action="run"]');
      if (run) run.disabled = state.busy || !readyToRun();
      const note = workspace.querySelector('#page-limit-note');
      if (note) note.innerHTML = pageLimitNote();
      studio.refreshOverlay();
      if (selector === '#html-method') render();
      if (['#compression', '#target-unit'].includes(selector) && event === 'change') render();
      if (selector === '#target-page' && event === 'change' && Number.isInteger(Number(state.page)) && Number(state.page) >= 1 && Number(state.page) <= state.files[0]?.pageCount) { studio.page = Number(state.page); render(); }
    });
  }
  workspace.querySelectorAll('[name="rotation"]').forEach((input) => input.addEventListener('change', () => {
    if (input.checked) { state.rotation = Number(input.value); invalidateResults(); }
  }));
  workspace.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', async () => {
    const action = button.dataset.action;
    if (action === 'choose') openPicker();
    if (action === 'remove') removeFile(button.dataset.id);
    if (action === 'up') moveFile(button.dataset.id, -1);
    if (action === 'down') moveFile(button.dataset.id, 1);
    if (action === 'run') runTool();
    if (action === 'download') downloadOutput(Number(button.dataset.index));
    if (action === 'signature') document.querySelector('#signature-picker').click();
  }));
  const dropzone = workspace.querySelector('#dropzone');
  if (!dropzone) return;
  dropzone.addEventListener('click', (event) => { if (!event.target.closest('button')) openPicker(); });
  dropzone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPicker(); } });
  for (const eventName of ['dragenter', 'dragover']) dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.add('dragover'); });
  for (const eventName of ['dragleave', 'drop']) dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.remove('dragover'); });
  dropzone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
}

function openPicker() {
  if (state.busy) return;
  picker.multiple = multipleFiles();
  picker.accept = state.mode === 'images' ? 'image/jpeg,image/png,.jpg,.jpeg,.png' : state.mode === 'office' ? '.doc,.docx,.xls,.xlsx,.ppt,.pptx' : 'application/pdf,.pdf';
  picker.value = '';
  picker.click();
}

picker.addEventListener('change', () => addFiles(picker.files));

document.querySelector('#signature-picker').addEventListener('change', async (event) => {
  if (state.busy) return;
  const file = event.target.files?.[0];
  if (!file) return;
  if (!/\.(png|jpe?g)$/i.test(file.name) || (file.type && !['image/png', 'image/jpeg'].includes(file.type))) return showToast('Choose a JPG or PNG signature image.');
  if (!file.size || file.size > 16 * 1024 * 1024) return showToast('Choose a signature image between 1 byte and 16 MB.');
  const bytes = await file.arrayBuffer();
  const signature = { name: file.name, data: bytesToBase64(bytes), mime: /\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg', ...readImageSize(bytes) };
  if (state.busy) return;
  captureInputs();
  state.signature = signature;
  invalidateResults();
  render();
});

document.querySelector('#asset-picker').addEventListener('change', async (event) => {
  if (state.busy) return;
  const file = event.target.files?.[0], target = studio.pendingAsset;
  if (!file || !['image', 'watermarkImage'].includes(target)) return;
  if (!/\.(png|jpe?g)$/i.test(file.name) || !file.size || file.size > 16 * 1024 * 1024) return showToast('Choose a JPG or PNG image under 16 MB.');
  const bytes = await file.arrayBuffer();
  const image = { name: file.name, data: bytesToBase64(bytes), ...readImageSize(bytes) };
  if (state.busy) return;
  captureInputs(); studio[target] = image; studio.changed();
});

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const size = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += size) binary += String.fromCharCode(...bytes.subarray(offset, offset + size));
  return btoa(binary);
}

function readImageSize(buffer) {
  const bytes = new Uint8Array(buffer);
  const word = (position) => bytes[position] * 256 + bytes[position + 1];
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) {
    const integer = (position) => bytes[position] * 16777216 + bytes[position + 1] * 65536 + bytes[position + 2] * 256 + bytes[position + 3];
    const width = integer(16), height = integer(20);
    return width > 0 && height > 0 ? { width, height } : {};
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    const frames = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset += 1;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 216) continue;
      if (offset + 2 > bytes.length) break;
      const length = word(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (frames.has(marker) && length >= 8) {
        const width = word(offset + 5), height = word(offset + 3);
        return width > 0 && height > 0 ? { width, height } : {};
      }
      offset += length;
    }
  }
  return {};
}

async function addFiles(fileList) {
  if (state.busy) return;
  const incoming = Array.from(fileList || []);
  if (!incoming.length) return;
  const images = state.mode === 'images';
  const office = state.mode === 'office';
  const accepted = incoming.filter((file) => office ? /\.(docx?|xlsx?|pptx?)$/i.test(file.name) : images
    ? /\.(jpe?g|png)$/i.test(file.name) && (!file.type || ['image/jpeg', 'image/png'].includes(file.type))
    : file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
  if (accepted.length !== incoming.length) showToast(office ? 'Choose a DOC, DOCX, XLS, XLSX, PPT, or PPTX document.' : images ? 'Choose JPG or PNG image files.' : 'Only PDF files can be added.');
  const tooLarge = accepted.filter((file) => file.size > 16 * 1024 * 1024);
  if (tooLarge.length) showToast(`${tooLarge[0].name} is over the 16 MB per-file limit.`);
  let valid = accepted.filter((file) => file.size > 0 && file.size <= 16 * 1024 * 1024);
  if (accepted.some((file) => file.size === 0)) showToast('Empty files cannot be added.');
  if (!valid.length) return;
  const merging = multipleFiles();
  if (!merging && valid.length > 1) {
    valid = valid.slice(0, 1);
    showToast(`This tool processes one ${office ? 'document' : 'PDF'} at a time. The first file was selected.`);
  }
  const existing = merging ? state.files : [];
  const maxFiles = state.mode === 'compare' ? 2 : 12;
  if (existing.length + valid.length > maxFiles) {
    showToast(`This task can contain up to ${maxFiles} files.`);
    return;
  }
  if ([...existing, ...valid].reduce((sum, file) => sum + file.size, 0) > 48 * 1024 * 1024) {
    showToast('Keep the combined input size under 48 MB per task.');
    return;
  }
  const added = valid.map((file) => ({ id: `file-${++sequence}`, file, name: file.name, size: file.size, kind: office ? 'office' : images ? 'image' : 'pdf', data: '', pageCount: 0, ranges: null, pageOrder: null, formFields: null }));
  state.files = [...existing, ...added];
  if (!merging) { state.page = '1'; studio.page = 1; studio.activeObject = null; studio.objects = []; }
  state.outputs = [];
  state.result = null;
  state.busy = true;
  render();
  try {
    await Promise.all(added.map(async (item) => { item.data = bytesToBase64(await item.file.arrayBuffer()); }));
    if (images) {
      added.forEach((item) => { item.pageCount = 1; });
      render();
      return;
    }
    if (bypassInspection()) { render(); return; }
    const response = await api('/api/inspect', { files: added.map(({ name, data }) => ({ name, data })) });
    const result = await response.json();
    if (!Array.isArray(result.files) || result.files.length !== added.length || result.files.some((info) => !Number.isInteger(info.pageCount) || info.pageCount < 1)) {
      throw new Error('The server returned an invalid PDF inspection result.');
    }
    // Inspection preserves request order; filenames may be normalized by the server.
    result.files.forEach((info, index) => { added[index].pageCount = info.pageCount; });
    if (state.mode === 'forms') await loadFormFields(added[0]);
    render();
  } catch (error) {
    state.files = state.files.filter((item) => !added.includes(item));
    render();
    showToast(error.message || 'We could not read that PDF.');
  } finally {
    state.busy = false;
    render();
  }
}

async function api(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    let message = 'The PDF could not be processed.';
    try { message = (await response.json()).error || message; } catch { /* keep the useful fallback */ }
    throw new Error(message);
  }
  return response;
}

async function loadFormFields(file) {
  const response = await api('/api/forms-inspect', { file: { name: file.name, data: file.data } });
  const result = await response.json();
  if (!Array.isArray(result.fields)) throw new Error('The server returned an invalid form inspection result.');
  file.formFields = result.fields;
}

function invalidateResults() {
  state.result = null;
  state.outputs = [];
  workspace.querySelectorAll('.result-panel, .split-results').forEach((element) => element.remove());
}

function captureInputs() {
  const file = state.files[0];
  const read = (selector, fallback) => workspace.querySelector(selector)?.value ?? fallback;
  if (file && state.mode === 'split') file.ranges = read('#page-ranges', file.ranges ?? '');
  if (file && state.mode === 'organize') {
    const order = read('#page-order', file.pageOrder ?? '');
    if (order !== file.pageOrder) {
      file.manualOrderInvalid = !/^\d+(?:\s*,\s*\d+)*$/.test(order.trim()) || order.split(',').length > 2000 || order.split(',').some((value) => Number(value) < 1 || Number(value) > file.pageCount);
      studio.manualOrder(order);
    }
    file.pageOrder = order;
  }
  if (state.mode === 'rotate') state.rotation = Number(read('[name="rotation"]:checked', state.rotation));
  if (state.mode === 'watermark') {
    state.watermarkText = read('#watermark-text', state.watermarkText);
    state.opacity = read('#watermark-opacity', state.opacity);
  }
  if (state.mode === 'number') state.startNumber = read('#start-number', state.startNumber);
  if (state.mode === 'crop') state.cropMargin = read('#crop-margin', state.cropMargin);
  const options = { compression: '#compression', targetSize: '#target-size', targetUnit: '#target-unit', renderFormat: '#render-format', renderDpi: '#render-dpi', password: '#pdf-password', textFormat: '#text-format', annotationText: '#annotation-text', page: '#target-page', x: '#position-x', y: '#position-y', fontSize: '#annotation-size', color: '#annotation-color', signatureWidth: '#signature-width', html: '#html-source', language: '#ocr-language', renderMethod: '#render-method', compareMethod: '#compare-method', htmlMethod: '#html-method', htmlUrl: '#html-url' };
  for (const [key, selector] of Object.entries(options)) state[key] = read(selector, state[key]);
  for (const [key, id] of [['conversionOcr', 'conversion-ocr'], ['includeImages', 'include-images']]) state[key] = workspace.querySelector(`#${id}`)?.checked ?? state[key];
  studio.capture();
  if (state.mode === 'forms' && file?.formFields) {
    file.formFields.forEach((field, index) => {
      if (!field.supported || field.readOnly) return;
      const input = workspace.querySelector(`#form-field-${index}`);
      if (input) field.value = field.type === 'checkbox' ? input.checked : field.multiselect ? Array.from(input.selectedOptions || [], (option) => option.value) : input.value;
    });
    state.flattenForm = workspace.querySelector('#flatten-form')?.checked ?? state.flattenForm;
  }
}

function singleFileRequest() {
  const file = { name: state.files[0].name, data: state.files[0].data };
  if (state.mode === 'rotate') return { file, rotation: state.rotation };
  if (state.mode === 'organize') {
    const order = state.files[0].pageOrder.trim();
    if (!/^\d+(?:\s*,\s*\d+)*$/.test(order)) throw new Error('Enter page numbers separated by commas, such as 3, 1, 2.');
    const pages = order.split(',').map((value) => Number(value.trim()));
    if (pages.length > 2000 || pages.some((page) => !Number.isInteger(page) || page < 1 || page > state.files[0].pageCount)) throw new Error(`Choose up to 2,000 page entries between 1 and ${state.files[0].pageCount}.`);
    return { file, pages };
  }
  if (state.mode === 'watermark') {
    const text = state.watermarkText.trim();
    const opacity = Number(state.opacity);
    if (!text || text.length > 100) throw new Error('Enter watermark text between 1 and 100 characters.');
    if (!Number.isFinite(opacity) || opacity < 0.05 || opacity > 1) throw new Error('Choose an opacity from 0.05 to 1.');
    return { file, text, opacity };
  }
  if (state.mode === 'number') {
    const startNumber = Number(state.startNumber);
    if (!Number.isInteger(startNumber) || startNumber < 1 || startNumber > 999999) throw new Error('Choose a whole starting number from 1 to 999999.');
    return { file, startNumber };
  }
  if (state.mode === 'crop') {
    const margin = Number(state.cropMargin);
    if (!String(state.cropMargin).trim() || !Number.isFinite(margin) || margin < 0) throw new Error('Enter a margin of zero or more points.');
    return { file, margin };
  }
  if (state.mode === 'compress') return { file, compression: state.compression, ...(state.compression === 'target' ? { targetBytes: targetSizeBytes() } : {}) };
  if (state.mode === 'render') return { file, format: state.renderFormat, dpi: Number(state.renderDpi) };
  if (state.mode === 'protect' || state.mode === 'unlock') {
    if (state.mode === 'protect' && Array.from(state.password).length < 8) throw new Error('Choose a password with at least 8 characters.');
    if (new TextEncoder().encode(state.password).length > 256) throw new Error('Use a password of at most 256 UTF-8 bytes. Non-Latin characters can use more than one byte.');
    return { file, password: state.password };
  }
  if (state.mode === 'text') return { file, format: state.textFormat, includeImages: state.textFormat === 'md' && state.includeImages };
  if (state.mode === 'ocr') return { file, language: state.language };
  if (['docx', 'pptx', 'xlsx'].includes(state.mode)) return { file, ocr: state.conversionOcr, language: state.language };
  if (state.mode === 'forms') return { file, fields: Object.fromEntries(state.files[0].formFields.filter((field) => field.supported && !field.readOnly).map((field) => [field.name, field.value])), flatten: state.flattenForm };
  if (state.mode === 'annotate' || state.mode === 'sign') {
    const page = Number(state.page), x = Number(state.x), y = Number(state.y);
    if (!Number.isInteger(page) || page < 1 || page > state.files[0].pageCount) throw new Error(`Choose a page from 1 to ${state.files[0].pageCount}.`);
    if (!String(state.x).trim() || !String(state.y).trim() || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw new Error('Enter positions of zero or more points.');
    if (state.mode === 'sign') {
      const width = Number(state.signatureWidth);
      if (!state.signature || !Number.isFinite(width) || width <= 0) throw new Error('Choose a signature image and a width greater than zero.');
      return { file, image: { name: state.signature.name, data: state.signature.data }, page, x, y, width };
    }
    const text = state.annotationText.trim(), fontSize = Number(state.fontSize);
    if (!text || text.length > 1000) throw new Error('Enter between 1 and 1,000 characters to add.');
    if (!Number.isFinite(fontSize) || fontSize < 6 || fontSize > 96) throw new Error('Choose a text size from 6 to 96 points.');
    return { file, text, page, x, y, fontSize, color: state.color };
  }
  return { file };
}

async function runTool() {
  if (state.busy) return;
  if (!readyToRun()) return;
  // Capture inputs before render replaces the controls with their busy state.
  captureInputs();
  let request;
  let studioRequest;
  try {
    if (['sign', 'annotate', 'forms'].includes(state.mode) && Number.isInteger(Number(state.page))) studio.page = Number(state.page);
    if (state.mode === 'organize' && state.files[0]?.manualOrderInvalid) throw new Error('Enter valid page numbers for the first PDF, or reset the thumbnail order.');
    studioRequest = studio.request();
    request = studioRequest?.body || (state.mode === 'html' ? state.htmlMethod === 'url' ? { url: state.htmlUrl } : { html: state.html } : multipleFiles() ? { files: state.files.map(({ name, data }) => ({ name, data })) } : singleFileRequest());
  } catch (error) {
    showToast(error.message);
    return;
  }
  state.busy = true;
  state.result = null;
  state.outputs = [];
  render();
  try {
    let outputs = [];
    if (state.mode === 'merge') {
      const response = await api('/api/merge', request);
      outputs = [{ name: 'localfold-merged.pdf', pageCount: Number(response.headers.get('X-Page-Count')), blob: await response.blob() }];
      state.result = { title: 'Your merged PDF is ready', note: `${outputs[0].pageCount} pages · Processed locally` };
    } else if (state.mode === 'split') {
      const ranges = state.files[0].ranges;
      const response = await api('/api/split', { file: { name: state.files[0].name, data: state.files[0].data }, ranges });
      const result = await response.json();
      outputs = result.outputs.map((output) => ({ ...output, blob: base64ToBlob(output.data) }));
      state.result = { title: `${outputs.length} ${outputs.length === 1 ? 'PDF is' : 'PDFs are'} ready`, note: 'Each page range is a separate file · Processed locally' };
    } else if (state.mode === 'rotate' && !studioRequest) {
      const rotation = state.rotation;
      const response = await api('/api/rotate', request);
      outputs = [{ name: 'localfold-rotated.pdf', pageCount: Number(response.headers.get('X-Page-Count')), blob: await response.blob() }];
      state.result = { title: 'Your rotated PDF is ready', note: `${outputs[0].pageCount} pages · Turned ${rotation}° clockwise` };
    } else {
      const endpoint = state.mode === 'forms' ? 'forms-fill' : state.mode === 'render' && state.renderMethod === 'embedded' ? 'extract-images' : state.mode === 'compare' && state.compareMethod === 'visual' ? 'compare-visual' : state.mode === 'html' && state.htmlMethod === 'url' ? 'html-url' : state.mode;
      const response = await api(studioRequest?.path || `/api/${endpoint}`, request);
      const filenames = { organize: 'arranged', watermark: 'watermarked', number: 'numbered', crop: 'cropped', images: 'images', compress: 'compressed', protect: 'protected', unlock: 'unlocked', repair: 'repaired', flatten: 'flattened', metadata: 'cleaned', annotate: 'annotated', forms: 'filled', sign: 'signed', ocr: 'searchable', html: 'document' };
      const extension = ['docx', 'pptx', 'xlsx'].includes(state.mode) ? state.mode : state.mode === 'render' || state.mode === 'compare' && state.compareMethod === 'visual' || state.mode === 'text' && state.textFormat === 'md' && state.includeImages ? 'zip' : state.mode === 'text' ? state.textFormat : state.mode === 'compare' ? 'md' : 'pdf';
      const fallback = ['docx', 'pptx', 'xlsx'].includes(state.mode) ? 'export' : state.mode === 'office' ? 'converted' : state.mode === 'render' ? 'pages' : state.mode === 'text' ? 'text' : state.mode === 'compare' ? 'comparison' : filenames[state.mode];
      const disposition = response.headers.get('Content-Disposition') || '';
      const suppliedName = disposition.match(/filename="?([^";]+)"?/)?.[1];
      const name = suppliedName && !/[\\/]/.test(suppliedName) ? suppliedName : `localfold-${fallback}.${extension}`;
      const label = extension === 'docx' ? 'Word' : extension === 'pptx' ? 'Slides' : extension === 'xlsx' ? 'Spreadsheet' : extension === 'zip' ? 'ZIP' : extension === 'txt' ? 'text' : extension === 'md' ? (state.mode === 'compare' ? 'report' : 'Markdown') : 'PDF';
      outputs = [{ name, label, pageCount: Number(response.headers.get('X-Page-Count')), blob: await response.blob() }];
      const titles = { organize: 'Your arranged PDF is ready', watermark: 'Your watermarked PDF is ready', number: 'Your numbered PDF is ready', crop: 'Your cropped PDF is ready', images: 'Your image PDF is ready', compress: 'Your compressed PDF is ready', render: 'Your page images are ready', protect: 'Your protected PDF is ready', unlock: 'Your unlocked PDF is ready', repair: 'Your recovered PDF is ready', text: 'Your extracted text is ready', compare: 'Your text comparison report is ready', flatten: 'Your flattened PDF is ready', metadata: 'Your cleaned PDF is ready', annotate: 'Your annotated PDF is ready', forms: 'Your filled PDF is ready', sign: 'Your signature has been placed', ocr: 'Your searchable PDF is ready', html: 'Your document PDF is ready' };
      let title = state.mode === 'rotate' ? 'Your rotated PDF is ready' : titles[state.mode];
      let resultStatus;
      let note = outputs[0].pageCount ? `${outputs[0].pageCount} ${outputs[0].pageCount === 1 ? 'page' : 'pages'} · Processed locally` : 'Processed locally';
      if (state.mode === 'render') note = `${outputs[0].pageCount} page images · ${state.renderFormat.toUpperCase()} · ZIP archive`;
      if (state.mode === 'compare') note = 'Text differences · Markdown report · Visual differences are not included';
      if (state.mode === 'text') note = `${state.textFormat === 'txt' ? 'Plain text' : 'Markdown'} · Text layer extracted locally`;
      if (state.mode === 'render' && state.renderMethod === 'embedded') note = 'Original embedded image objects · ZIP archive';
      if (state.mode === 'compare' && state.compareMethod === 'visual') note = 'Page appearance differences · HTML report and diff images ZIP';
      if (state.mode === 'text' && state.includeImages && state.textFormat === 'md') note = 'Markdown and linked images · ZIP bundle';
      if (state.mode === 'compress') {
        const before = Number(response.headers.get('X-Input-Bytes')) || state.files[0].size;
        const after = Number(response.headers.get('X-Output-Bytes')) || outputs[0].blob.size;
        const target = Number(response.headers.get('X-Target-Bytes')) || request.targetBytes;
        note = `${formatCompressionBytes(before)} → ${formatCompressionBytes(after)}`;
        if (request.compression === 'target') {
          const reached = response.headers.get('X-Target-Reached');
          const met = reached === 'true' && after <= target;
          const missed = reached === 'false' || after > target;
          title = met ? 'Your PDF meets the target' : missed ? 'Closest available result' : 'Your compression result';
          resultStatus = met ? 'success' : 'partial';
          note += ` · Target: ${formatCompressionBytes(target)} · ${met ? 'Target met' : missed ? 'Target not reached' : 'Target status unavailable'}`;
          if (met && before <= target) note += ' · Original already within target';
        } else note += ` · ${after < before ? `${Math.round((1 - after / before) * 100)}% smaller` : 'No size reduction for this file'}`;
        if (response.headers.get('X-Rasterized') === 'true') {
          note += ' · Pages converted to images; selectable text and forms removed';
          const dpi = Number(response.headers.get('X-Compression-Dpi')), quality = Number(response.headers.get('X-Compression-Quality'));
          if (dpi > 0) note += ` · ${dpi} dpi`;
          if (quality > 0) note += ` · JPEG quality ${quality}`;
        }
      }
      state.result = { title, note, ...(resultStatus ? { status: resultStatus } : {}) };
      if (['office', 'docx', 'pptx', 'xlsx'].includes(state.mode)) {
        const exportCopy = { office: ['Your converted PDF is ready', 'Converted locally with LibreOffice'], docx: ['Your Word document is ready', 'Editable text, tables, and images · Review complex layouts'], pptx: ['Your PowerPoint slides are ready', 'Editable text and page graphics · Review slide layout'], xlsx: ['Your Excel workbook is ready', 'Detected tables · Review extracted cells before use'] };
        state.result = { title: exportCopy[state.mode][0], note: exportCopy[state.mode][1] };
      }
      if (['protect', 'unlock'].includes(state.mode)) state.password = '';
    }
    state.outputs = outputs;
  } catch (error) {
    showToast(error.message || 'The PDF could not be processed.');
  } finally {
    state.busy = false;
    render();
  }
}

function base64ToBlob(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: 'application/pdf' });
}

function downloadOutput(index) {
  const output = state.outputs[index];
  if (!output) return;
  const url = URL.createObjectURL(output.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = output.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function removeFile(id) {
  if (state.busy) return;
  state.files = state.files.filter((file) => file.id !== id);
  state.result = null;
  state.outputs = [];
  render();
}

function moveFile(id, direction) {
  if (state.busy) return;
  const index = state.files.findIndex((file) => file.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= state.files.length) return;
  [state.files[index], state.files[target]] = [state.files[target], state.files[index]];
  state.result = null;
  state.outputs = [];
  render();
}

const toolGroups = [
  ['Organize', ['merge', 'split', 'organize', 'rotate', 'crop']],
  ['Convert', ['images', 'render', 'office', 'docx', 'pptx', 'xlsx', 'text', 'html']],
  ['Edit & improve', ['compress', 'watermark', 'number', 'annotate', 'sign', 'forms', 'flatten', 'ocr']],
  ['Security & recovery', ['protect', 'unlock', 'metadata', 'repair']],
  ['Review', ['compare']],
];
document.querySelector('#tool-nav').innerHTML = toolGroups.map(([title, keys]) => `<div class="nav-group"><p class="nav-group-title">${title}</p>${keys.map((key) => `<button class="nav-item" data-mode="${key}" aria-label="${modes[key].title}" title="${modes[key].title}">${modes[key].icon}<span>${modes[key].title}</span></button>`).join('')}</div>`).join('');
document.querySelector('#tool-count').textContent = `${Object.keys(modes).length} tools, one private workspace`;
document.querySelector('#tool-search').addEventListener('input', (event) => {
  const query = event.target.value.toLowerCase().trim();
  document.querySelectorAll('.nav-item').forEach((button) => { const mode = modes[button.dataset.mode]; button.hidden = Boolean(query) && !`${mode.title} ${mode.intro}`.toLowerCase().includes(query); });
  document.querySelectorAll('.nav-group').forEach((group) => { group.hidden = Array.from(group.querySelectorAll('.nav-item')).every((button) => button.hidden); });
  document.querySelector('#no-tools').hidden = Array.from(document.querySelectorAll('.nav-item')).some((button) => !button.hidden);
});

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', async () => {
  if (state.busy) return;
  if (!modes[button.dataset.mode]) return;
  captureInputs();
  const previousFamily = inputFamily();
  state.mode = button.dataset.mode;
  state.result = null;
  state.outputs = [];
  if (previousFamily !== inputFamily()) state.files = [];
  if (!multipleFiles() && state.files.length > 1) state.files = [state.files[0]];
  if (!bypassInspection() && state.files.some((file) => !file.pageCount)) state.files = [];
  render();
  if (state.mode === 'forms' && state.files[0] && !state.files[0].formFields) {
    state.busy = true;
    render();
    try { await loadFormFields(state.files[0]); } catch (error) { showToast(error.message); }
    finally { state.busy = false; render(); }
  }
}));

fetch('/api/health').then((response) => {
  if (!response.ok) throw new Error();
  document.querySelector('#server-status-label').textContent = 'Local server connected';
  document.querySelector('#server-status').classList.remove('offline');
}).catch(() => {
  document.querySelector('#server-status-label').textContent = 'Local server unavailable';
  document.querySelector('#server-status').classList.add('offline');
  showToast('Local server connection was lost. Refresh this page after restarting LocalFold.');
});
render();
