/* Visual document workflows. All coordinates use PDF points from the top left. */
const studio = {
  cache: new Map(), pending: new Map(), organizer: null, organizerKey: '', offset: 0, organizerMode: '', organizers: {},
  page: 1, cropMethod: 'area', cropAll: false, rotationScope: 'all', formMode: 'fill',
  watermarkMode: 'text', signatureMode: 'upload', typedText: '', fontStyle: 'italic',
  editTool: 'text', editWidth: '180', editHeight: '48', editOpacity: '1',
  formType: 'text', formName: 'Field 1', formChoices: 'First option, Second option',
  image: null, watermarkImage: null, watermarkWidth: '180', watermarkRotation: '0',
  activeObject: null, objects: [], objectPage: '', pendingAsset: '',

  file() { return state.files[0]; },
  draft(file = this.file()) {
    if (!file) return { items: [], areas: {}, fields: [] };
    return file.visualDraft ||= { items: [], areas: {}, fields: [] };
  },
  fileBody(file = this.file()) { return { name: file.name, data: file.data }; },
  escape(value) { return escapeHtml(value); },
  usesPreview() { return ['organize', 'rotate', 'crop', 'annotate', 'forms', 'sign'].includes(state.mode); },
  key(file, page) { return `${file.id}:${page}`; },
  ensureOrganizer() {
    const mode = state.mode === 'rotate' ? 'rotate' : 'organize';
    if (this.organizerMode !== mode) {
      if (this.organizerMode) this.organizers[this.organizerMode] = { entries: this.organizer, key: this.organizerKey, offset: this.offset };
      const saved = this.organizers[mode]; this.organizer = saved?.entries || []; this.organizerKey = saved?.key || ''; this.offset = saved?.offset || 0; this.organizerMode = mode;
    }
    const files = state.files.filter((file) => file.pageCount);
    const key = files.map((file) => file.id).join(',');
    if (key === this.organizerKey && this.organizer) return;
    const previous = this.organizer || [];
    const oldIds = new Set(this.organizerKey.split(','));
    this.organizer = previous.filter((entry) => files.some((file) => file.id === entry.fileId));
    for (const file of files) if (!oldIds.has(file.id)) {
      for (let page = 1; page <= file.pageCount; page++) this.organizer.push({ fileId: file.id, page, rotation: 0 });
    }
    this.organizerKey = key;
    this.offset = Math.min(this.offset, Math.max(0, this.organizer.length - 1));
  },
  manualOrder(value) {
    if (!/^\d+(?:\s*,\s*\d+)*$/.test(value.trim())) return;
    const file = this.file();
    const pages = value.split(',').map(Number);
    if (!file || pages.length > 2000 || pages.some((page) => page < 1 || page > file.pageCount)) return;
    this.organizer = pages.map((page) => ({ fileId: file.id, page, rotation: 0 }));
    this.organizerKey = state.files.map((item) => item.id).join(',');
  },
  tabs(name, current, options) {
    return `<div class="studio-tabs" role="group" aria-label="${name}">${options.map(([value, label]) => `<button type="button" data-studio-tab="${name}" data-value="${value}" class="${current === value ? 'selected' : ''}" ${state.busy ? 'disabled' : ''}>${label}</button>`).join('')}</div>`;
  },
  button(action, label, attributes = '') {
    return `<button type="button" class="choose-button" data-studio-action="${action}" ${attributes} ${state.busy ? 'disabled' : ''}>${label}</button>`;
  },
  organizerHtml() {
    this.ensureOrganizer();
    const entries = this.organizer || [];
    const start = Math.floor(this.offset / 20) * 20;
    return `<section class="visual-panel"><div class="studio-bar"><div><strong>Arrange your pages</strong><p>Drag a thumbnail to move it. Add another PDF above to insert its pages, then drag them into place.</p></div>${this.button('reset-pages', 'Reset page order')}</div><div class="page-grid">${entries.slice(start, start + 20).map((entry, local) => {
      const index = start + local;
      const file = state.files.find((item) => item.id === entry.fileId);
      const preview = this.cache.get(this.key(file, entry.page));
      const displayedRotation = (entry.rotation + (Number(preview?.rotation) || 0)) % 360;
      return `<article class="page-tile" draggable="${!state.busy}" data-page-index="${index}" aria-label="Output page ${index + 1}, ${this.escape(file.name)} page ${entry.page}"><div class="thumbnail"><img ${preview ? `src="data:image/png;base64,${preview.data}"` : ''} data-preview-key="${this.key(file, entry.page)}" data-rotation="${displayedRotation}" alt="${this.escape(file.name)} page ${entry.page}"><span class="thumbnail-loading" ${preview ? 'hidden' : ''}>Loading preview…</span></div><p class="tile-label"><strong>${index + 1}.</strong> ${this.escape(file.name)} · p${entry.page}</p><div class="tile-actions">${this.button('page-left', '←', `data-index="${index}" aria-label="Move output page ${index + 1} earlier"`)}${this.button('page-right', '→', `data-index="${index}" aria-label="Move output page ${index + 1} later"`)}${this.button('page-rotate', '↻', `data-index="${index}" aria-label="Rotate output page ${index + 1}"`)}${this.button('page-copy', '＋', `data-index="${index}" aria-label="Duplicate output page ${index + 1}"`)}${this.button('page-remove', '×', `data-index="${index}" aria-label="Remove output page ${index + 1}"`)}</div></article>`;
    }).join('')}</div>${!entries.length ? '<p class="range-help">All pages have been removed. Reset the order to start again.</p>' : ''}<div class="studio-pagination">${this.button('grid-prev', '← Previous 20', start === 0 ? 'disabled' : '')}<span>Pages ${entries.length ? start + 1 : 0}–${Math.min(start + 20, entries.length)} of ${entries.length}</span>${this.button('grid-next', 'Next 20 →', start + 20 >= entries.length ? 'disabled' : '')}</div></section>`;
  },
  currentPreview() { return this.file() && this.cache.get(this.key(this.file(), this.page)); },
  signatureTextLayout(width) {
    const fonts = {
      italic: ['"Times New Roman", Times, serif', 'italic', 0.5],
      serif: ['"Times New Roman", Times, serif', 'italic', 0.5],
      sans: ['Arial, Helvetica, sans-serif', 'oblique', 0.5],
      monospace: ['"Courier New", Courier, monospace', 'oblique', 0.6],
    };
    const [family, style, fallbackWidth] = fonts[this.fontStyle] || fonts.italic;
    const text = this.typedText.trim();
    let unitWidth = Math.max(1, text.length) * fallbackWidth;
    try {
      const context = document.createElement?.('canvas')?.getContext?.('2d');
      if (context?.measureText) {
        context.font = `${style} 100px ${family}`;
        const measured = context.measureText(text).width / 100;
        if (Number.isFinite(measured) && measured > 0) unitWidth = measured;
      }
    } catch { /* Approximate text bounds when a canvas is unavailable. */ }
    return { text, family, style, size: Math.min(48, width / unitWidth) };
  },
  pageHtml() {
    const file = this.file();
    if (!file?.pageCount) return '';
    this.page = Math.min(Math.max(1, this.page), file.pageCount);
    const preview = this.currentPreview();
    const width = preview?.width || 612, height = preview?.height || 792;
    return `<section class="visual-panel"><div class="studio-bar"><div><strong>Page preview</strong><p>${state.mode === 'crop' ? 'Drag a rectangle around the area you want to keep.' : state.mode === 'forms' && this.formMode === 'create' ? 'Drag on the page to place a new form field.' : state.mode === 'sign' ? 'Click on the page to position your signature.' : 'Click to place text or images; drag to draw shapes. Coordinates follow the unrotated page.'}</p></div><div class="studio-pagination">${this.button('prev-page', '←', this.page <= 1 ? 'disabled' : '')}<span>Page ${this.page} / ${file.pageCount}</span>${this.button('next-page', '→', this.page >= file.pageCount ? 'disabled' : '')}</div></div><div class="page-stage" id="page-stage" data-width="${width}" data-height="${height}">${preview ? `<img src="data:image/png;base64,${preview.data}" alt="PDF page ${this.page}">` : '<p class="preview-status">Loading page preview…</p>'}<svg class="page-overlay" id="page-overlay" viewBox="0 0 ${width} ${height}" aria-label="Visual placement area">${this.overlay(width, height)}</svg></div><p class="range-help">Preview edits appear here before saving. Review the downloaded document after processing.</p></section>`;
  },
  overlay(width, height) {
    const draft = this.draft();
    if (state.mode === 'crop') {
      const area = draft.areas[this.page];
      return area ? `<rect x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}" class="crop-outline"/>` : '';
    }
    if (state.mode === 'forms' && this.formMode === 'create') return draft.fields.filter((item) => item.page === this.page).map((item) => `<g><rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" class="form-outline"/><text x="${item.x + 3}" y="${item.y + 13}" font-size="10">${this.escape(item.name)}</text></g>`).join('');
    if (state.mode === 'sign') {
      const x = Number(state.x), y = Number(state.y), w = Number(state.signatureWidth) || 160;
      if (this.signatureMode === 'type') {
        const text = this.signatureTextLayout(w);
        return `<text x="${x}" y="${y + text.size}" font-size="${text.size}" font-family="${this.escape(text.family)}" font-style="${text.style}" fill="#141f33">${this.escape(text.text)}</text>`;
      }
      const height = state.signature ? w * (state.signature.height || 1) / (state.signature.width || 1) : 0;
      return state.signature ? `<image href="data:${state.signature.mime};base64,${state.signature.data}" x="${x}" y="${y}" width="${w}" height="${height}" preserveAspectRatio="xMinYMin meet"/>` : '';
    }
    if (state.mode !== 'annotate') return '';
    const objects = this.objects.filter((object) => this.objectPage === this.key(this.file(), this.page));
    const existing = objects.map((object) => `<rect data-text-object="${object.objectIndex}" x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" class="text-object ${object.editable === false ? 'unsupported' : ''}"><title>${this.escape(object.editable === false ? object.reason || 'This text object cannot be replaced.' : object.text)}</title></rect>`).join('');
    const items = draft.items.filter((item) => item.page === this.page).map((item) => {
      const { x, y, width: w, height: h, color = '#1e805b', opacity = 1 } = item;
      if (item.type === 'text' || item.type === 'replace-text') return `<g>${item.type === 'replace-text' ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff"/>` : ''}<text x="${x}" y="${y + Number(item.fontSize)}" font-size="${item.fontSize}" fill="${color}" opacity="${opacity}">${this.escape(item.text)}</text></g>`;
      if (item.type === 'image') {
        const naturalWidth = item.image.width || 1, naturalHeight = item.image.height || 1;
        const scale = Math.min(w / naturalWidth, h / naturalHeight), width = naturalWidth * scale, height = naturalHeight * scale;
        return `<image href="data:${/\.png$/i.test(item.image.name) ? 'image/png' : 'image/jpeg'};base64,${item.image.data}" x="${x + (w - width) / 2}" y="${y + (h - height) / 2}" width="${width}" height="${height}" opacity="${opacity}" preserveAspectRatio="xMidYMid meet"/>`;
      }
      if (item.type === 'line') return `<line x1="${x}" y1="${y}" x2="${item.x2 ?? x + w}" y2="${item.y2 ?? y + h}" stroke="${color}" stroke-width="2" opacity="${opacity}"/>`;
      if (item.type === 'ellipse') return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" stroke="${color}" fill="none" stroke-width="2" opacity="${opacity}"/>`;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" stroke="${color}" fill="${item.type === 'highlight' ? color : 'none'}" stroke-width="2" opacity="${item.type === 'highlight' ? Math.min(opacity, 0.35) : opacity}"/>`;
    }).join('');
    return existing + items;
  },
  options() {
    if (!this.file()?.pageCount) return '';
    if (state.mode === 'organize') return this.organizerHtml();
    if (state.mode === 'rotate') return this.tabs('rotationScope', this.rotationScope, [['all', 'Rotate every page'], ['individual', 'Rotate individual pages']]) + (this.rotationScope === 'individual' ? this.organizerHtml() : '');
    if (state.mode === 'crop') return this.tabs('cropMethod', this.cropMethod, [['margin', 'Equal margins'], ['area', 'Select an area']]) + (this.cropMethod === 'area' ? `<label class="check-option"><input id="crop-all-pages" type="checkbox" ${this.cropAll ? 'checked' : ''}>Apply the selected rectangle to every page (same coordinates)</label>${this.pageHtml()}` : '');
    if (state.mode === 'annotate') return `<div class="range-panel"><div class="editor-toolbar"><div class="editor-controls">${selectField('edit-tool', 'Tool', this.editTool, [['text', 'Add text'], ['replace-text', 'Replace selected text'], ['rectangle', 'Rectangle'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['highlight', 'Highlight'], ['image', 'Place image']])}${textField('annotation-size', 'Size', state.fontSize, '', 'type="number" min="6" max="96" aria-label="Text size in points"')}${textField('annotation-color', 'Color', state.color, '', 'type="color"')}</div>${textField('annotation-text', 'Text', state.annotationText, '', 'maxlength="1000" placeholder="Text to add or use as a replacement"')}<div class="studio-inline">${this.button('load-text', 'Select existing text')}${this.button('asset', this.image ? 'Change image' : 'Choose image', 'data-asset="image"')}${this.button('add-item', this.editTool === 'replace-text' ? 'Queue text replacement' : 'Add at coordinates')}${this.button('undo-edit', 'Undo last edit')}</div></div><details class="placement-details"><summary>Fine-tune placement</summary><div class="range-panel">${positionOptions()}<div class="field-grid">${textField('edit-width', 'Item width', this.editWidth, 'PDF points.', 'type="number" min="1"')}${textField('edit-height', 'Item height', this.editHeight, 'PDF points.', 'type="number" min="1"')}${textField('edit-opacity', 'Item opacity', this.editOpacity, '0.05 to 1.', 'type="number" min="0.05" max="1" step="0.05"')}</div></div></details><p class="range-help">${this.activeObject ? `Selected existing text: ${this.escape(this.activeObject.text)}` : 'Use Select existing text, then click an outlined text object to replace it.'} Replacements remove the selected text object. Font substitution may change appearance.</p>${this.pageHtml()}<p class="draft-count">${this.draft().items.length} edits queued</p></div>`;
    if (state.mode === 'forms') return this.tabs('formMode', this.formMode, [['fill', 'Fill existing fields'], ['create', 'Create form fields']]) + (this.formMode === 'create' ? `<div class="range-panel field-grid">${selectField('new-field-type', 'Field type', this.formType, [['text', 'Text'], ['checkbox', 'Checkbox'], ['dropdown', 'Dropdown'], ['radio', 'Radio group']])}${textField('new-field-name', 'Field name', this.formName, 'Choose a unique name.')}${textField('new-field-options', 'Choice options', this.formChoices, 'Comma-separated options for dropdowns and radio groups.')}</div><div class="studio-inline">${this.button('add-form', 'Add field at coordinates')}${this.button('undo-form', 'Remove last field')}</div>${positionOptions()}<div class="field-grid">${textField('edit-width', 'Field width', this.editWidth, 'PDF points.', 'type="number" min="1"')}${textField('edit-height', 'Field height', this.editHeight, 'PDF points.', 'type="number" min="1"')}</div>${this.pageHtml()}<p class="draft-count">${this.draft().fields.length} new fields queued</p>` : '');
    if (state.mode === 'watermark') return this.tabs('watermarkMode', this.watermarkMode, [['text', 'Text watermark'], ['image', 'Image watermark']]) + (this.watermarkMode === 'image' ? `<div class="range-panel">${this.button('asset', this.watermarkImage ? `Change ${this.escape(this.watermarkImage.name)}` : 'Choose watermark image', 'data-asset="watermarkImage"')}<div class="field-grid">${textField('watermark-image-width', 'Image width (points)', this.watermarkWidth, 'Centered on every page.', 'type="number" min="1"')}${textField('watermark-image-rotation', 'Rotation (degrees)', this.watermarkRotation, 'Clockwise angle.', 'type="number"')}${textField('watermark-opacity', 'Opacity', state.opacity, '0.05 to 1.', 'type="number" min="0.05" max="1" step="0.01"')}</div></div>` : '');
    if (state.mode === 'sign') return this.tabs('signatureMode', this.signatureMode, [['upload', 'Upload'], ['draw', 'Draw'], ['type', 'Type']]) + (this.signatureMode === 'draw' ? `<div class="signature-drawing"><canvas id="signature-pad" width="700" height="180" aria-label="Draw your signature"></canvas><div class="studio-inline">${this.button('clear-signature', 'Clear drawing')}${this.button('use-signature', 'Use this drawing')}</div></div>` : this.signatureMode === 'type' ? `<div class="range-panel">${textField('typed-signature', 'Type your name', this.typedText, 'A visual signature, without a digital certificate.', 'maxlength="100"')}</div>` : '') + this.pageHtml();
    return '';
  },
  capture() {
    const read = (id, fallback) => workspace.querySelector(`#${id}`)?.value ?? fallback;
    const mapping = { editTool: 'edit-tool', editWidth: 'edit-width', editHeight: 'edit-height', editOpacity: 'edit-opacity', formType: 'new-field-type', formName: 'new-field-name', formChoices: 'new-field-options', watermarkWidth: 'watermark-image-width', watermarkRotation: 'watermark-image-rotation', typedText: 'typed-signature' };
    for (const [key, id] of Object.entries(mapping)) this[key] = read(id, this[key]);
    this.cropAll = workspace.querySelector('#crop-all-pages')?.checked ?? this.cropAll;
  },
  refreshOverlay() {
    const overlay = workspace.querySelector('#page-overlay'), preview = this.currentPreview();
    if (overlay && preview) overlay.innerHTML = this.overlay(preview.width, preview.height);
  },
  changed() {
    if (state.mode === 'organize' && this.file()) { this.file().manualOrderInvalid = false; this.file().pageOrder = (this.organizer || []).filter((entry) => entry.fileId === this.file().id).map((entry) => entry.page).join(', '); }
    invalidateResults(); render();
  },
  movePage(from, to) {
    this.ensureOrganizer();
    if (from < 0 || to < 0 || from >= this.organizer.length || to >= this.organizer.length || from === to) return;
    const [entry] = this.organizer.splice(from, 1);
    this.organizer.splice(to, 0, entry);
  },
  addItem(rect) {
    this.capture();
    const type = this.editTool;
    const page = this.page;
    if (!Number.isInteger(page) || page < 1 || page > this.file().pageCount) throw new Error('Choose a valid page before adding an edit.');
    if (Object.values(rect).some((value) => !Number.isFinite(value)) || rect.x < 0 || rect.y < 0 || (type === 'line' ? rect.width < 0 || rect.height < 0 || rect.width + rect.height === 0 : rect.width <= 0 || rect.height <= 0)) throw new Error('Enter valid positions and positive dimensions.');
    const item = { type, page, x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: state.color, opacity: Number(this.editOpacity), fontSize: Number(state.fontSize) };
    if (type === 'line') { item.x2 = rect.x2 ?? rect.x + rect.width; item.y2 = rect.y2 ?? rect.y + rect.height; }
    if (['text', 'replace-text'].includes(type)) {
      if (!state.annotationText.trim()) throw new Error('Enter the text to place or replace.');
      if (!Number.isFinite(Number(state.fontSize)) || Number(state.fontSize) < 6 || Number(state.fontSize) > 96) throw new Error('Choose a text size from 6 to 96 points.');
      item.text = state.annotationText;
      if (type === 'replace-text') {
        if (!this.activeObject || this.objectPage !== this.key(this.file(), page)) throw new Error('Select an editable existing text object first.');
        Object.assign(item, this.activeObject, { type, text: state.annotationText, page, color: state.color, fontSize: Number(state.fontSize), opacity: Number(this.editOpacity) });
      }
    }
    if (type === 'image') {
      if (!this.image) throw new Error('Choose a JPG or PNG to place on the page.');
      item.image = { name: this.image.name, data: this.image.data, width: this.image.width, height: this.image.height };
    }
    const replaced = type === 'replace-text' ? this.draft().items.findIndex((entry) => entry.type === type && entry.page === page && entry.objectIndex === item.objectIndex) : -1;
    if (replaced >= 0) this.draft().items[replaced] = item; else this.draft().items.push(item);
  },
  addForm(rect) {
    this.capture();
    if (!this.formName.trim()) throw new Error('Give the new field a name.');
    if (this.draft().fields.some((field) => field.name === this.formName.trim()) || this.file().formFields?.some((field) => field.name === this.formName.trim())) throw new Error('Choose a unique form field name.');
    const field = { name: this.formName.trim(), type: this.formType, page: this.page, ...rect };
    if (['dropdown', 'radio'].includes(field.type)) {
      field.options = this.formChoices.split(',').map((option) => option.trim()).filter(Boolean);
      if (!field.options.length) throw new Error('Enter at least one choice option.');
      if (field.type === 'radio' && (field.options.length < 2 || field.options.length > 20 || field.height < field.options.length * 16)) throw new Error('Radio groups need 2–20 options and at least 16 points of height per option.');
    }
    this.draft().fields.push(field);
    this.formName = `Field ${this.draft().fields.length + 1}`;
  },
  request() {
    const file = this.file();
    if (!file) return null;
    const base = { file: this.fileBody() };
    if (state.mode === 'organize' || state.mode === 'rotate' && this.rotationScope === 'individual') {
      this.ensureOrganizer();
      if (!this.organizer.length) throw new Error('Keep at least one page in your output.');
      return { path: '/api/organize-pages', body: { files: state.files.map((item) => this.fileBody(item)), pages: this.organizer.map((entry) => ({ fileIndex: state.files.findIndex((item) => item.id === entry.fileId), page: entry.page, rotation: entry.rotation })) } };
    }
    if (state.mode === 'crop' && this.cropMethod === 'area') {
      const draft = this.draft();
      const area = draft.areas[this.page];
      const areas = this.cropAll && area ? Array.from({ length: file.pageCount }, (_, index) => ({ ...area, page: index + 1 })) : Object.entries(draft.areas).map(([page, rect]) => ({ page: Number(page), ...rect }));
      if (!areas.length) throw new Error('Drag a rectangle on the preview to choose the area to keep.');
      return { path: '/api/crop-area', body: { ...base, areas } };
    }
    if (state.mode === 'annotate') {
      if (!Number.isInteger(Number(state.page)) || Number(state.page) < 1 || Number(state.page) > file.pageCount) throw new Error(`Choose a page from 1 to ${file.pageCount}.`);
      if (['text', 'replace-text'].includes(this.editTool) && (!Number.isFinite(Number(state.fontSize)) || Number(state.fontSize) < 6 || Number(state.fontSize) > 96)) throw new Error('Choose a text size from 6 to 96 points.');
      const items = this.draft().items.map((item) => ({ ...item }));
      if (!items.length && state.annotationText.trim()) this.addItem({ x: Number(state.x), y: Number(state.y), width: Number(this.editWidth), height: Number(this.editHeight) });
      if (!this.draft().items.length) throw new Error('Add an edit on the preview or with Add at coordinates.');
      return { path: '/api/edit', body: { ...base, items: this.draft().items } };
    }
    if (state.mode === 'forms' && this.formMode === 'create') {
      if (!this.draft().fields.length) throw new Error('Draw or add at least one new form field.');
      return { path: '/api/forms-create', body: { ...base, fields: this.draft().fields } };
    }
    if (state.mode === 'watermark' && this.watermarkMode === 'image') {
      if (!this.watermarkImage) throw new Error('Choose a watermark image first.');
      return { path: '/api/image-watermark', body: { ...base, image: { name: this.watermarkImage.name, data: this.watermarkImage.data }, opacity: Number(state.opacity), width: Number(this.watermarkWidth), rotation: Number(this.watermarkRotation) } };
    }
    if (state.mode === 'sign' && this.signatureMode === 'type') {
      if (!this.typedText.trim()) throw new Error('Type the name to use for your signature.');
      return { path: '/api/typed-signature', body: { ...base, text: this.typedText, page: Number(state.page), x: Number(state.x), y: Number(state.y), width: Number(state.signatureWidth), fontStyle: this.fontStyle } };
    }
    return null;
  },
  async mount() {
    const container = workspace.querySelector('.visual-panel');
    if (!container) return;
    const mode = state.mode, file = this.file();
    if (!file?.pageCount) return;
    const grouped = new Map();
    if (mode === 'organize' || mode === 'rotate' && this.rotationScope === 'individual') {
      this.ensureOrganizer();
      for (const entry of this.organizer.slice(Math.floor(this.offset / 20) * 20, Math.floor(this.offset / 20) * 20 + 20)) {
        const source = state.files.find((item) => item.id === entry.fileId);
        if (!this.cache.has(this.key(source, entry.page))) {
          if (!grouped.has(source)) grouped.set(source, new Set());
          grouped.get(source).add(entry.page);
        }
      }
    } else if (!this.cache.has(this.key(file, this.page))) grouped.set(file, new Set([this.page]));
    for (const [source, pages] of grouped) {
      if (state.mode !== mode || this.file() !== file) return;
      const requestKey = `${source.id}:${[...pages].join(',')}`;
      try {
        let pending = this.pending.get(requestKey);
        if (!pending) {
          pending = api('/api/preview', { file: this.fileBody(source), pages: [...pages], dpi: 72 }).then((response) => response.json());
          this.pending.set(requestKey, pending);
        }
        const result = await pending;
        if (!Array.isArray(result.pages)) throw new Error('The local preview response was invalid.');
        result.pages.forEach((page) => this.cache.set(this.key(source, page.page), page));
        this.pending.delete(requestKey);
      } catch (error) {
        this.pending.delete(requestKey);
        if (state.mode === mode && this.file() === file) {
          workspace.querySelectorAll('.preview-status, .thumbnail-loading').forEach((node) => { node.textContent = error.message || 'Preview unavailable. Coordinate controls remain available.'; });
        }
        return;
      }
    }
    if (grouped.size && state.mode === mode && this.file() === file) render();
  },
  bind() {
    workspace.querySelectorAll('[data-studio-tab]').forEach((button) => button.addEventListener('click', () => {
      if (state.busy) return;
      captureInputs(); this[button.dataset.studioTab] = button.dataset.value;
      this.changed();
    }));
    for (const id of ['edit-tool', 'edit-width', 'edit-height', 'edit-opacity', 'new-field-type', 'new-field-name', 'new-field-options', 'typed-signature', 'watermark-image-width', 'watermark-image-rotation', 'crop-all-pages']) {
      for (const event of ['input', 'change']) workspace.querySelector(`#${id}`)?.addEventListener(event, () => { this.capture(); invalidateResults(); this.refreshOverlay(); const run = workspace.querySelector('[data-action="run"]'); if (run) run.disabled = state.busy || !readyToRun(); });
    }
    workspace.querySelectorAll('[data-studio-action]').forEach((button) => button.addEventListener('click', async () => {
      if (state.busy || button.disabled) return;
      captureInputs();
      const index = Number(button.dataset.index), action = button.dataset.studioAction;
      try {
        if (action === 'asset') { this.pendingAsset = button.dataset.asset; document.querySelector('#asset-picker').value = ''; document.querySelector('#asset-picker').click(); return; }
        if (action === 'page-left') this.movePage(index, index - 1);
        if (action === 'page-right') this.movePage(index, index + 1);
        if (action === 'page-rotate') this.organizer[index].rotation = (this.organizer[index].rotation + 90) % 360;
        if (action === 'page-copy') this.organizer.splice(index + 1, 0, { ...this.organizer[index] });
        if (action === 'page-remove') this.organizer.splice(index, 1);
        if (action === 'reset-pages') { this.organizerKey = ''; this.organizer = []; this.ensureOrganizer(); }
        if (action === 'grid-prev') this.offset = Math.max(0, this.offset - 20);
        if (action === 'grid-next') this.offset += 20;
        if (action === 'prev-page') this.page = Math.max(1, this.page - 1);
        if (action === 'next-page') this.page = Math.min(this.file().pageCount, this.page + 1);
        if (action === 'undo-edit') this.draft().items.pop();
        if (action === 'undo-form') this.draft().fields.pop();
        if (action === 'add-item') this.addItem({ x: Number(state.x), y: Number(state.y), width: Number(this.editWidth), height: Number(this.editHeight) });
        if (action === 'add-form') this.addForm({ x: Number(state.x), y: Number(state.y), width: Number(this.editWidth), height: Number(this.editHeight) });
        if (action === 'load-text') {
          const source = this.file(), page = this.page;
          const response = await api('/api/text-objects', { file: this.fileBody(source), page });
          const result = await response.json();
          if (state.mode !== 'annotate' || this.file() !== source || this.page !== page) return;
          this.objects = result.objects || []; this.objectPage = this.key(source, page);
        }
        if (action === 'clear-signature') { const canvas = workspace.querySelector('#signature-pad'); canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); return; }
        if (action === 'use-signature') {
          const canvas = workspace.querySelector('#signature-pad');
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          if (!pixels.some((value, pixel) => pixel % 4 === 3 && value)) throw new Error('Draw your signature before saving it.');
          state.signature = { name: 'drawn-signature.png', data: canvas.toDataURL('image/png').split(',')[1], mime: 'image/png', width: canvas.width, height: canvas.height };
        }
        state.page = String(this.page);
        this.changed();
      } catch (error) { showToast(error.message); }
    }));
    let dragging;
    workspace.querySelectorAll('[data-page-index]').forEach((tile) => {
      tile.addEventListener('dragstart', (event) => { if (state.busy) return event.preventDefault(); dragging = Number(tile.dataset.pageIndex); event.dataTransfer.setData('text/plain', String(dragging)); event.dataTransfer.effectAllowed = 'move'; tile.classList.add('dragging'); });
      tile.addEventListener('dragend', () => tile.classList.remove('dragging'));
      tile.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; });
      tile.addEventListener('drop', (event) => { event.preventDefault(); if (state.busy) return; const transferred = event.dataTransfer.getData('text/plain'); if (dragging === undefined && !transferred) return; const from = dragging ?? Number(transferred); if (!Number.isInteger(from)) return; this.movePage(from, Number(tile.dataset.pageIndex)); this.changed(); });
    });
    workspace.querySelectorAll('[data-rotation]').forEach((image) => { image.style.transform = `rotate(${Number(image.dataset.rotation)}deg)`; });
    this.bindStage(); this.bindDrawing();
    this.mount();
  },
  bindStage() {
    const stage = workspace.querySelector('#page-stage');
    if (!stage) return;
    stage.style.aspectRatio = `${stage.dataset.width}/${stage.dataset.height}`;
    let start, temporary;
    const point = (event) => {
      const box = stage.getBoundingClientRect();
      return { x: Math.max(0, Math.min(Number(stage.dataset.width), (event.clientX - box.left) / box.width * Number(stage.dataset.width))), y: Math.max(0, Math.min(Number(stage.dataset.height), (event.clientY - box.top) / box.height * Number(stage.dataset.height))) };
    };
    stage.addEventListener('pointerdown', (event) => {
      if (state.busy || !this.currentPreview()) return;
      const object = event.target.closest?.('[data-text-object]');
      if (object) {
        const selected = this.objects.find((item) => item.objectIndex === Number(object.dataset.textObject));
        if (selected?.editable === false) { showToast(selected.reason || 'This text object cannot be replaced.'); return; }
        this.activeObject = selected; this.editTool = 'replace-text'; state.annotationText = selected.text; state.fontSize = String(selected.fontSize); this.changed(); return;
      }
      captureInputs(); start = point(event); stage.setPointerCapture(event.pointerId);
      temporary = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      temporary.setAttribute('class', 'placement-outline'); stage.querySelector('svg').append(temporary);
    });
    stage.addEventListener('pointermove', (event) => {
      if (!start || !temporary) return;
      const end = point(event); for (const [key, value] of Object.entries({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) })) temporary.setAttribute(key, value);
    });
    stage.addEventListener('pointerup', (event) => {
      if (!start) return;
      const origin = start, end = point(event), rect = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
      start = null; temporary?.remove(); temporary = null;
      try {
        if (state.mode === 'crop' && this.cropMethod === 'area') {
          if (rect.width < 3 || rect.height < 3) return;
          this.draft().areas[this.page] = rect;
        } else if (state.mode === 'forms' && this.formMode === 'create') {
          if (rect.width < 5 || rect.height < 5) return;
          this.addForm(rect);
        } else if (state.mode === 'sign') { state.x = String(Math.round(rect.x)); state.y = String(Math.round(rect.y)); state.page = String(this.page); }
        else if (state.mode === 'annotate') {
          if (rect.width < 3 && rect.height < 3) { rect.width = Number(this.editWidth); rect.height = Number(this.editHeight); }
          else if (this.editTool === 'line') Object.assign(rect, { x: origin.x, y: origin.y, x2: end.x, y2: end.y });
          this.addItem(rect);
        } else return;
        this.changed();
      } catch (error) { showToast(error.message); }
    });
    stage.addEventListener('pointercancel', () => { start = null; temporary?.remove(); });
  },
  bindDrawing() {
    const canvas = workspace.querySelector('#signature-pad');
    if (!canvas) return;
    const context = canvas.getContext('2d'); let drawing = false;
    context.strokeStyle = '#202f28'; context.lineWidth = 3; context.lineCap = 'round'; context.lineJoin = 'round';
    const point = (event) => { const box = canvas.getBoundingClientRect(); return [(event.clientX - box.left) / box.width * canvas.width, (event.clientY - box.top) / box.height * canvas.height]; };
    canvas.addEventListener('pointerdown', (event) => { if (state.busy) return; drawing = true; canvas.setPointerCapture(event.pointerId); context.beginPath(); context.moveTo(...point(event)); });
    canvas.addEventListener('pointermove', (event) => { if (!drawing) return; context.lineTo(...point(event)); context.stroke(); });
    canvas.addEventListener('pointerup', () => { drawing = false; }); canvas.addEventListener('pointercancel', () => { drawing = false; });
  },
};
