import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const studioSource = await readFile(new URL('../public/studio.js', import.meta.url), 'utf8');

// Minimal DOM controls exercise the actual application script, including the
// destructive innerHTML render that previously discarded user selections.
function element(dataset = {}) {
  return {
    dataset, value: '', checked: false, listeners: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(event, callback) { this.listeners[event] = callback; },
    setAttribute() {}, removeAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    click() { return this.listeners.click?.({ target: this }); },
  };
}

function decodeAttribute(value) {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function browser(handleRequest, { healthOk = true } = {}) {
  const workspace = element();
  let markup = '';
  let fields = new Map();
  let rotations = [];
  let actions = [], tabs = [], tiles = [], runButton;
  Object.defineProperty(workspace, 'innerHTML', {
    get() { return markup; },
    set(value) {
      markup = value;
      fields = new Map();
      rotations = [];
      actions = []; tabs = []; tiles = []; runButton = null;
      for (const [, attributes] of value.matchAll(/<input\b([^>]*)>/g)) {
        const id = attributes.match(/\bid="([^"]*)"/)?.[1];
        const field = Object.assign(element(), { value: decodeAttribute(attributes.match(/\bvalue="([^"]*)"/)?.[1] || ''), checked: /\bchecked\b/.test(attributes) });
        if (id) fields.set(`#${id}`, field);
        if (/\bname="rotation"/.test(attributes)) rotations.push(field);
      }
      for (const [, attributes, options] of value.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
        const id = attributes.match(/\bid="([^"]*)"/)?.[1];
        const choices = Array.from(options.matchAll(/<option value="([^"]*)"([^>]*)>/g), ([, value, attributes]) => ({ value: decodeAttribute(value), selected: /\bselected\b/.test(attributes) }));
        const selectedOptions = choices.filter((option) => option.selected);
        if (id) fields.set(`#${id}`, Object.assign(element(), { value: selectedOptions[0]?.value || choices[0]?.value || '', selectedOptions }));
      }
      for (const [, attributes, content] of value.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
        const id = attributes.match(/\bid="([^"]*)"/)?.[1];
        if (id) fields.set(`#${id}`, Object.assign(element(), { value: decodeAttribute(content) }));
      }
      for (const [, attributes] of value.matchAll(/<button\b([^>]*)>/g)) {
        const dataset = Object.fromEntries(Array.from(attributes.matchAll(/data-([\w-]+)="([^"]*)"/g), ([, key, value]) => [key.replace(/-([a-z])/g, (_, char) => char.toUpperCase()), value]));
        const button = Object.assign(element(dataset), { disabled: /\bdisabled\b/.test(attributes) });
        if (dataset.studioAction) actions.push(button);
        if (dataset.studioTab) tabs.push(button);
        if (dataset.action === 'run') runButton = button;
      }
      for (const [, index] of value.matchAll(/<article[^>]*data-page-index="(\d+)"/g)) tiles.push(element({ pageIndex: index }));
    },
  });
  workspace.querySelector = (selector) => fields.get(selector) || (selector === '[name="rotation"]:checked' ? rotations.find((input) => input.checked) : selector === '[data-action="run"]' ? runButton : null);
  workspace.querySelectorAll = (selector) => selector === '[name="rotation"]' ? rotations : selector === '[data-studio-action]' ? actions : selector === '[data-studio-tab]' ? tabs : selector === '[data-page-index]' ? tiles : [];
  const nav = ['merge', 'split', 'rotate', 'organize', 'watermark', 'number', 'crop', 'images', 'compress', 'compressImage', 'resizeImage', 'render', 'protect', 'unlock', 'repair', 'text', 'compare', 'flatten', 'metadata', 'annotate', 'forms', 'sign', 'ocr', 'html', 'office', 'docx', 'pptx', 'xlsx'].map((mode) => element({ mode }));
  const nodes = new Map([['#workspace-body', workspace]]);
  const document = {
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
    querySelectorAll(selector) { return selector === '.nav-item' ? nav : []; },
    createElement(tag) { return tag === 'canvas' ? { getContext: () => ({ font: '', measureText: (text) => ({ width: text.length * 50 }) }) } : element(); },
  };
  const context = vm.createContext({
    document, Uint8Array, Blob, URL, TextEncoder, console,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (path, options) => path === '/api/health' ? new Response('{}', { status: healthOk ? 200 : 503 }) : handleRequest(path, JSON.parse(options.body)),
  });
  vm.runInContext(studioSource, context);
  vm.runInContext(source, context);
  return {
    workspace,
    state: () => vm.runInContext('state', context),
    mode: (mode) => nav.find((button) => button.dataset.mode === mode).click(),
    add: (files) => { context.incoming = files; return vm.runInContext('addFiles(incoming)', context); },
    signature: (file) => { context.incomingSignature = file; return vm.runInContext('document.querySelector("#signature-picker").listeners.change({ target: { files: [incomingSignature] } })', context); },
    asset: (file, target) => { context.incomingAsset = file; context.assetTarget = target; return vm.runInContext('studio.pendingAsset = assetTarget; document.querySelector("#asset-picker").listeners.change({ target: { files: [incomingAsset] } })', context); },
    action: (action, index) => actions.find((button) => button.dataset.studioAction === action && (index === undefined || Number(button.dataset.index) === index))?.click(),
    tab: (name, value) => tabs.find((button) => button.dataset.studioTab === name && button.dataset.value === value)?.click(),
    drag: (from, to) => {
      const data = new Map(); const event = { preventDefault() {}, dataTransfer: { setData: (key, value) => data.set(key, value), getData: (key) => data.get(key) } };
      tiles.find((tile) => Number(tile.dataset.pageIndex) === from).listeners.dragstart(event);
      tiles.find((tile) => Number(tile.dataset.pageIndex) === to).listeners.drop(event);
    },
    run: () => vm.runInContext('runTool()', context),
    render: () => vm.runInContext('render()', context),
    execute: (script) => vm.runInContext(script, context),
  };
}

function pdf(name, content = '%PDF test') {
  const bytes = Buffer.from(content);
  return { name, type: 'application/pdf', size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
}

function image(name, type = 'image/png', content = 'image bytes') {
  return { ...pdf(name, content), type };
}

function edit(app, selector, value) {
  const field = app.workspace.querySelector(selector);
  assert.ok(field, `Missing field ${selector}`);
  field.value = value;
  field.listeners.input({ target: field });
}

function inspected(files) {
  return Response.json({ files: files.map((file, index) => ({ name: file.name.replace(':', '-'), pageCount: index + 4 })) });
}

function changeResizeField(app, selector, value) {
  const field = app.workspace.querySelector(selector);
  assert.ok(field, `Missing field ${selector}`);
  if (typeof value === 'boolean') field.checked = value;
  else field.value = value;
  field.listeners.change({ target: field });
}

test('upload parses inspect JSON and associates normalized or duplicate names by order', async () => {
  const app = browser((path, body) => {
    assert.equal(path, '/api/inspect');
    assert.ok(body.files.every((file) => file.data));
    return inspected(body.files);
  });
  await app.add([pdf('same:name.pdf'), pdf('same:name.pdf')]);
  assert.equal(app.state().files.length, 2);
  assert.deepEqual(Array.from(app.state().files, (file) => file.pageCount), [4, 5]);
  assert.match(app.workspace.innerHTML, /4 pages/);
});

test('split submits custom ranges and preserves them after success, mode changes, and errors', async () => {
  const requests = [];
  let rejectSplit = false;
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    requests.push(body);
    if (rejectSplit) return Response.json({ error: 'Invalid range.' }, { status: 400 });
    return Response.json({ outputs: [{ name: 'selected.pdf', pageCount: 2, data: Buffer.from('%PDF selected').toString('base64') }] });
  });
  app.mode('split');
  await app.add([pdf('input.pdf')]);
  const ranges = app.workspace.querySelector('#page-ranges');
  ranges.value = '2-3';
  ranges.listeners.input({ target: ranges });
  await app.run();
  assert.equal(requests[0].ranges, '2-3');
  assert.equal(app.workspace.querySelector('#page-ranges').value, '2-3');
  assert.equal(app.state().outputs[0].name, 'selected.pdf');
  app.mode('rotate');
  app.mode('split');
  assert.equal(app.workspace.querySelector('#page-ranges').value, '2-3');
  rejectSplit = true;
  app.workspace.querySelector('#page-ranges').value = '';
  await app.run();
  assert.equal(requests[1].ranges, '');
  assert.equal(app.workspace.querySelector('#page-ranges').value, '');
  assert.equal(app.state().busy, false);
});

test('rotation survives rerender and controls cannot change files or mode during processing', async () => {
  let complete;
  let request;
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    request = body;
    return new Promise((resolve) => { complete = resolve; });
  });
  app.mode('rotate');
  await app.add([pdf('input.pdf')]);
  app.workspace.querySelectorAll('[name="rotation"]').forEach((input) => { input.checked = input.value === '270'; });
  const pending = app.run();
  assert.equal(request.rotation, 270);
  assert.equal(app.workspace.querySelector('[name="rotation"]:checked').value, '270');
  app.mode('merge');
  app.execute('removeFile(state.files[0].id)');
  await app.add([pdf('replacement.pdf')]);
  assert.equal(app.state().mode, 'rotate');
  assert.equal(app.state().files[0].name, 'input.pdf');
  complete(new Response('%PDF rotated', { headers: { 'X-Page-Count': '4' } }));
  await pending;
  assert.equal(app.state().result.note, '4 pages · Turned 270° clockwise');
  assert.equal(app.state().rotation, 270);
});

test('single PDF tools select one dropped file and failed inspection removes the rejected input', async () => {
  let fail = false;
  const app = browser((path, body) => fail ? Response.json({ error: 'Damaged PDF.' }, { status: 400 }) : inspected(body.files));
  app.mode('split');
  await app.add([pdf('first.pdf'), pdf('second.pdf')]);
  assert.equal(app.state().files.length, 1);
  assert.equal(app.state().files[0].name, 'first.pdf');
  fail = true;
  await app.add([pdf('broken.pdf')]);
  assert.equal(app.state().files.length, 0);
});

test('arrange submits selected pages in order, keeps duplicates, and rejects invalid entries', async () => {
  const requests = [];
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    requests.push({ path, body });
    return new Response('%PDF arranged', { headers: { 'X-Page-Count': '3' } });
  });
  app.mode('organize');
  await app.add([pdf('input.pdf')]);
  edit(app, '#page-order', '4, 1, 1');
  app.render();
  assert.equal(app.workspace.querySelector('#page-order').value, '4, 1, 1');
  app.mode('rotate');
  app.mode('organize');
  await app.run();
  assert.equal(requests[0].path, '/api/organize-pages');
  assert.deepEqual(requests[0].body.pages, [{ fileIndex: 0, page: 4, rotation: 0 }, { fileIndex: 0, page: 1, rotation: 0 }, { fileIndex: 0, page: 1, rotation: 0 }]);
  assert.match(app.workspace.innerHTML, /Download PDF/);
  assert.equal(app.state().outputs[0].name, 'localfold-arranged.pdf');
  for (const invalid of ['0', '5', '1,,2', '1.5', '']) {
    edit(app, '#page-order', invalid);
    await app.run();
    assert.equal(requests.length, 1);
    assert.equal(app.state().busy, false);
  }
});

test('watermark submits custom text and opacity and preserves safely escaped text', async () => {
  const requests = [];
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    requests.push({ path, body });
    return new Response('%PDF watermark', { headers: { 'X-Page-Count': '4' } });
  });
  app.mode('watermark');
  await app.add([pdf('input.pdf')]);
  edit(app, '#watermark-text', '  Review <copy> & "draft"  ');
  edit(app, '#watermark-opacity', '0.4');
  app.render();
  assert.equal(app.workspace.querySelector('#watermark-text').value, '  Review <copy> & "draft"  ');
  assert.match(app.workspace.innerHTML, /&lt;copy&gt; &amp; &quot;draft&quot;/);
  await app.run();
  assert.equal(requests[0].path, '/api/watermark');
  assert.equal(requests[0].body.text, 'Review <copy> & "draft"');
  assert.equal(requests[0].body.opacity, 0.4);
  assert.equal(app.state().outputs[0].name, 'localfold-watermarked.pdf');
  edit(app, '#watermark-opacity', '0.01');
  await app.run();
  assert.equal(requests.length, 1);
  edit(app, '#watermark-opacity', '0.5');
  edit(app, '#watermark-text', '  ');
  await app.run();
  assert.equal(requests.length, 1);
});

test('number and crop submit numeric options, preserve input, and provide downloads', async () => {
  for (const [mode, selector, value, key, filename] of [
    ['number', '#start-number', '42', 'startNumber', 'numbered'],
    ['crop', '#crop-margin', '24', 'margin', 'cropped'],
  ]) {
    let request;
    const app = browser((path, body) => {
      if (path === '/api/inspect') return inspected(body.files);
      request = { path, body };
      return new Response('%PDF output', { headers: { 'X-Page-Count': '4' } });
    });
    app.mode(mode);
    await app.add([pdf('input.pdf')]);
    if (mode === 'crop') app.tab('cropMethod', 'margin');
    edit(app, selector, value);
    app.mode('rotate');
    app.mode(mode);
    assert.equal(app.workspace.querySelector(selector).value, value);
    if (mode === 'crop') assert.match(app.workspace.innerHTML, /Hidden content remains in the PDF/);
    await app.run();
    assert.equal(request.path, `/api/${mode}`);
    assert.equal(request.body[key], Number(value));
    assert.equal(app.state().outputs[0].name, `localfold-${filename}.pdf`);
    assert.match(app.workspace.innerHTML, /Download PDF/);
    request = null;
    edit(app, selector, '-1');
    await app.run();
    assert.equal(request, null);
  }
});

test('image uploads bypass PDF inspection and conversion respects image order', async () => {
  const requests = [];
  const app = browser((path, body) => {
    requests.push({ path, body });
    assert.equal(path, '/api/images');
    return new Response('%PDF images', { headers: { 'X-Page-Count': String(body.files.length) } });
  });
  app.mode('images');
  await app.add([image('first.png'), image('second.jpg', 'image/jpeg'), pdf('wrong.pdf'), image('wrong.svg', 'image/svg+xml')]);
  assert.equal(requests.length, 0);
  assert.equal(app.state().files.length, 2);
  assert.deepEqual(Array.from(app.state().files, (file) => file.pageCount), [1, 1]);
  app.execute('moveFile(state.files[1].id, -1)');
  await app.run();
  assert.deepEqual(requests[0].body.files.map((file) => file.name), ['second.jpg', 'first.png']);
  assert.equal(app.state().outputs[0].name, 'localfold-images.pdf');
  assert.match(app.workspace.innerHTML, /2 pages · Processed locally/);
  app.mode('merge');
  assert.equal(app.state().files.length, 0);
});

test('image batches enforce file, count and aggregate limits before reading data', async () => {
  const app = browser(() => { throw new Error('No network call expected'); });
  app.mode('images');
  await app.add([{ ...image('huge.png'), size: 17 * 1024 * 1024 }]);
  assert.equal(app.state().files.length, 0);
  await app.add(Array.from({ length: 13 }, (_, index) => image(`${index}.png`)));
  assert.equal(app.state().files.length, 0);
  await app.add(Array.from({ length: 4 }, (_, index) => ({ ...image(`${index}.png`), size: 13 * 1024 * 1024 })));
  assert.equal(app.state().files.length, 0);
});

test('encrypted and damaged uploads bypass inspection and never invent a page count', async () => {
  for (const mode of ['unlock', 'repair']) {
    const requests = [];
    let fail = mode === 'unlock';
    const app = browser((path, body) => {
      requests.push({ path, body });
      assert.equal(path, `/api/${mode}`);
      if (fail) return Response.json({ error: 'Incorrect password.' }, { status: 400 });
      return new Response('%PDF recovered', { headers: { 'X-Page-Count': '3' } });
    });
    app.mode(mode);
    await app.add([pdf(`${mode}.pdf`)]);
    assert.equal(requests.length, 0);
    assert.equal(app.state().files[0].pageCount, 0);
    assert.doesNotMatch(app.workspace.innerHTML, />1 page</);
    if (mode === 'unlock') {
      assert.match(app.workspace.innerHTML, /page count checked after decryption/);
      edit(app, '#pdf-password', 'known password');
      await app.run();
      assert.equal(app.state().outputs.length, 0);
      assert.equal(app.state().password, 'known password');
      fail = false;
    }
    await app.run();
    assert.equal(app.state().outputs[0].pageCount, 3);
    if (mode === 'unlock') {
      assert.equal(requests[0].body.password, 'known password');
      assert.equal(app.state().password, '');
      assert.equal(app.workspace.querySelector('#pdf-password').value, '');
    }
    app.mode('rotate');
    assert.equal(app.state().files.length, 0, 'Uninspected input must not be reused by normal PDF operations');
  }
});

test('protect sends its password only with the processing request and clears it on success', async () => {
  const requests = [];
  const app = browser((path, body) => {
    requests.push({ path, body });
    if (path === '/api/inspect') return inspected(body.files);
    return new Response('%PDF protected', { headers: { 'X-Page-Count': '4' } });
  });
  app.mode('protect');
  await app.add([pdf('input.pdf')]);
  await app.run();
  assert.equal(requests.length, 1, 'Protect rejects an empty new password');
  edit(app, '#pdf-password', 'a sufficiently useful password');
  app.render();
  await app.run();
  assert.equal(requests[1].path, '/api/protect');
  assert.equal(requests[1].body.password, 'a sufficiently useful password');
  assert.equal(app.state().password, '');
  assert.ok(!('password' in requests[0].body));
});

test('image and text exports preserve options and label their actual download type', async () => {
  for (const [mode, fields, expected, extension, label] of [
    ['render', [['#render-format', 'png'], ['#render-dpi', '200']], { format: 'png', dpi: 200 }, 'zip', 'ZIP'],
    ['text', [['#text-format', 'md']], { format: 'md' }, 'md', 'Markdown'],
  ]) {
    let request;
    const app = browser((path, body) => {
      if (path === '/api/inspect') return inspected(body.files);
      request = { path, body };
      return new Response('result', { headers: { 'X-Page-Count': '4', 'Content-Disposition': `attachment; filename="export.${extension}"` } });
    });
    app.mode(mode);
    await app.add([pdf('input.pdf')]);
    fields.forEach(([selector, value]) => edit(app, selector, value));
    app.render();
    await app.run();
    assert.equal(request.path, `/api/${mode}`);
    for (const [key, value] of Object.entries(expected)) assert.equal(request.body[key], value);
    assert.equal(app.state().outputs[0].name, `export.${extension}`);
    assert.equal(app.state().outputs[0].label, label);
    assert.match(app.workspace.innerHTML, new RegExp(`Download ${label}`));
    assert.doesNotMatch(app.workspace.innerHTML, /Download PDF/);
  }
});

test('compression communicates rasterization and reports measured size changes', async () => {
  let request;
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    request = { path, body };
    return new Response('%PDF compressed', { headers: { 'X-Page-Count': '4', 'X-Input-Bytes': '10000', 'X-Output-Bytes': '5000' } });
  });
  app.mode('compress');
  await app.add([pdf('input.pdf')]);
  assert.match(app.workspace.innerHTML, /removing selectable text and interactive forms/);
  edit(app, '#compression', 'lossless');
  app.mode('rotate');
  app.mode('compress');
  await app.run();
  assert.equal(request.body.compression, 'lossless');
  assert.match(app.state().result.note, /50% smaller/);
});

test('comparison requires exactly two PDFs, respects order, and downloads a Markdown report', async () => {
  const requests = [];
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    requests.push({ path, body });
    return new Response('# Text differences');
  });
  app.mode('compare');
  await app.add([pdf('original.pdf')]);
  await app.run();
  assert.equal(requests.length, 0);
  await app.add([pdf('revised.pdf')]);
  await app.add([pdf('extra.pdf')]);
  assert.equal(app.state().files.length, 2);
  await app.run();
  assert.equal(requests[0].path, '/api/compare');
  assert.deepEqual(requests[0].body.files.map((file) => file.name), ['original.pdf', 'revised.pdf']);
  assert.equal(app.state().outputs[0].name, 'localfold-comparison.md');
  assert.match(app.workspace.innerHTML, /Download report/);
  assert.match(app.state().result.note, /Visual differences are not included/);
});

test('annotation and signature submit page coordinates and preserve signature image data', async () => {
  let request;
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    request = { path, body };
    return new Response('%PDF edited', { headers: { 'X-Page-Count': '4' } });
  });
  app.mode('annotate');
  await app.add([pdf('input.pdf')]);
  edit(app, '#annotation-text', 'Approved');
  edit(app, '#target-page', '2');
  edit(app, '#position-x', '72');
  edit(app, '#position-y', '90');
  edit(app, '#annotation-size', '24');
  edit(app, '#annotation-color', '#ff0000');
  await app.run();
  assert.equal(request.path, '/api/edit');
  assert.equal(request.body.items[0].text, 'Approved');
  assert.equal(request.body.items[0].page, 2);
  assert.equal(request.body.items[0].x, 72);
  assert.equal(request.body.items[0].y, 90);
  assert.equal(request.body.items[0].fontSize, 24);
  assert.equal(request.body.items[0].color, '#ff0000');
  request = null;
  edit(app, '#target-page', '5');
  await app.run();
  assert.equal(request, null);
  app.mode('sign');
  edit(app, '#target-page', '1');
  await app.signature(image('signature.png'));
  edit(app, '#signature-width', '180');
  await app.run();
  assert.equal(request.path, '/api/sign');
  assert.equal(request.body.image.name, 'signature.png');
  assert.ok(request.body.image.data);
  assert.equal(request.body.width, 180);
  assert.match(app.workspace.innerHTML, /without a digital certificate/);
});

test('form filling inspects fields, retains edits, and excludes readonly or unsupported fields', async () => {
  let request;
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    if (path === '/api/forms-inspect') return Response.json({ pageCount: 4, fields: [
      { name: 'Name <field>', type: 'text', value: 'Original', supported: true, readOnly: false },
      { name: 'Agree', type: 'checkbox', value: false, supported: true, readOnly: false },
      { name: 'Choice', type: 'dropdown', value: 'A', options: ['A', 'B'], supported: true, readOnly: false },
      { name: 'Locked', type: 'text', value: 'do not send', supported: false, readOnly: true },
    ] });
    request = { path, body };
    return new Response('%PDF filled', { headers: { 'X-Page-Count': '4' } });
  });
  app.mode('forms');
  await app.add([pdf('form.pdf')]);
  assert.match(app.workspace.innerHTML, /Name &lt;field&gt;/);
  edit(app, '#form-field-0', 'Taylor');
  const check = app.workspace.querySelector('#form-field-1');
  check.checked = true;
  check.listeners.change();
  edit(app, '#form-field-2', 'B');
  app.mode('rotate');
  await app.mode('forms');
  assert.equal(app.workspace.querySelector('#form-field-0').value, 'Taylor');
  await app.run();
  assert.equal(request.path, '/api/forms-fill');
  assert.deepEqual(request.body.fields, { 'Name <field>': 'Taylor', Agree: true, Choice: 'B' });
  assert.equal(request.body.flatten, true);
});

test('HTML works without an uploaded file, preserves source, and OCR enforces its page limit', async () => {
  const requests = [];
  const app = browser((path, body) => {
    if (path === '/api/inspect') return Response.json({ files: body.files.map((file) => ({ name: file.name, pageCount: 51 })) });
    requests.push({ path, body });
    return new Response('%PDF document', { headers: { 'X-Page-Count': '1' } });
  });
  app.mode('html');
  edit(app, '#html-source', '<h1>Invoice & details</h1>');
  app.mode('rotate');
  app.mode('html');
  assert.equal(app.workspace.querySelector('#html-source').value, '<h1>Invoice & details</h1>');
  await app.run();
  assert.equal(requests[0].path, '/api/html');
  assert.deepEqual(requests[0].body, { html: '<h1>Invoice & details</h1>' });
  app.mode('ocr');
  await app.add([pdf('fifty-one-pages.pdf')]);
  await app.run();
  assert.equal(requests.length, 1);
  assert.match(app.workspace.innerHTML, /six locally installed languages/);
  assert.match(app.workspace.innerHTML, /Up to 50 pages/);
});

test('Office conversion accepts modern and legacy documents and defers page counting until conversion', async () => {
  const requests = [];
  const app = browser((path, body) => {
    requests.push({ path, body });
    assert.equal(path, '/api/office');
    return new Response('%PDF converted', { headers: { 'X-Page-Count': '8' } });
  });
  app.mode('office');
  await app.add([pdf('wrong.pdf'), image('wrong.png'), { ...pdf('macro.docm'), type: '' }]);
  assert.equal(app.state().files.length, 0);
  const extensions = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'];
  for (const extension of extensions) {
    await app.add([{ ...pdf(`document.${extension}`, 'Office document bytes'), type: '' }]);
    assert.equal(requests.length, extensions.indexOf(extension));
    assert.equal(app.state().files[0].pageCount, 0);
    assert.match(app.workspace.innerHTML, /page count checked after conversion/);
    await app.run();
    assert.equal(requests.at(-1).body.file.name, `document.${extension}`);
    assert.equal(app.state().outputs[0].pageCount, 8);
    assert.match(app.workspace.innerHTML, /Download PDF/);
  }
  app.mode('rotate');
  assert.equal(app.state().files.length, 0, 'Office inputs must not be reused as PDF bytes');
});

test('PDF Office exports submit PDF bytes and use the correct file extensions and download labels', async () => {
  for (const [mode, label, description] of [
    ['docx', 'Word', /Editable text, tables, and images/],
    ['pptx', 'Slides', /Editable text and page graphics/],
    ['xlsx', 'Spreadsheet', /Review extracted cells/],
  ]) {
    let request;
    const app = browser((path, body) => {
      if (path === '/api/inspect') return inspected(body.files);
      request = { path, body };
      return new Response('Office output', { headers: { 'X-Page-Count': '4', 'Content-Disposition': `attachment; filename="my-export.${mode}"` } });
    });
    app.mode(mode);
    await app.add([pdf('source.pdf')]);
    await app.run();
    assert.equal(request.path, `/api/${mode}`);
    assert.equal(request.body.file.name, 'source.pdf');
    assert.ok(request.body.file.data);
    assert.equal(app.state().outputs[0].name, `my-export.${mode}`);
    assert.equal(app.state().outputs[0].label, label);
    assert.match(app.workspace.innerHTML, new RegExp(`Download ${label}`));
    assert.match(app.state().result.note, description);
    assert.doesNotMatch(app.workspace.innerHTML, /Download PDF/);
  }
});

test('password controls enforce engine character and UTF-8 byte limits without truncating existing passwords', async () => {
  const requests = [];
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    requests.push({ path, body });
    return new Response('%PDF result', { headers: { 'X-Page-Count': '4' } });
  });
  app.mode('protect');
  await app.add([pdf('input.pdf')]);
  for (const password of ['short', '🔑'.repeat(7), '界'.repeat(86)]) {
    edit(app, '#pdf-password', password);
    await app.run();
  }
  assert.equal(requests.length, 0, 'Short passwords and passwords over 256 UTF-8 bytes are rejected');
  edit(app, '#pdf-password', '🔑'.repeat(8));
  await app.run();
  assert.equal(requests.length, 1);
  app.mode('unlock');
  edit(app, '#pdf-password', 'a'.repeat(200));
  assert.doesNotMatch(app.workspace.innerHTML, /maxlength="128"/);
  await app.run();
  assert.equal(requests[1].body.password.length, 200);
  edit(app, '#pdf-password', 'a'.repeat(257));
  await app.run();
  assert.equal(requests.length, 2);
});

test('annotation font sizes match the engine limits of 6 to 96 points', async () => {
  const sizes = [];
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    sizes.push(body.items[0].fontSize);
    return new Response('%PDF edited', { headers: { 'X-Page-Count': '4' } });
  });
  app.mode('annotate');
  await app.add([pdf('input.pdf')]);
  edit(app, '#annotation-text', 'A note');
  for (const size of ['4', '5', '97', '144']) {
    edit(app, '#annotation-size', size);
    await app.run();
  }
  assert.equal(sizes.length, 0);
  for (const size of ['6', '96']) {
    app.execute('studio.draft().items = []');
    edit(app, '#annotation-size', size);
    await app.run();
  }
  assert.deepEqual(sizes, [6, 96]);
});

test('page limits match image, text and comparison engines and lossless compression stays available', async () => {
  const requests = [];
  const app = browser((path, body) => {
    if (path === '/api/inspect') return Response.json({ files: body.files.map((file) => ({ name: file.name, pageCount: 201 })) });
    requests.push({ path, body });
    return new Response('%PDF output', { headers: { 'X-Page-Count': '201' } });
  });
  app.mode('render');
  await app.add([pdf('many-pages.pdf')]);
  await app.run();
  assert.match(app.workspace.innerHTML, /up to 40 pages per PDF/);
  app.mode('text');
  await app.run();
  assert.match(app.workspace.innerHTML, /up to 200 pages per PDF/);
  app.mode('compare');
  await app.add([pdf('other-many-pages.pdf')]);
  await app.run();
  assert.equal(requests.length, 0);
  app.mode('compress');
  edit(app, '#compression', 'balanced');
  app.render();
  await app.run();
  assert.equal(requests.length, 0);
  assert.match(app.workspace.innerHTML, /choose Lossless compression/);
  edit(app, '#compression', 'lossless');
  await app.run();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.compression, 'lossless');
});

test('connection status reflects failed and successful health responses', async () => {
  for (const healthOk of [true, false]) {
    const app = browser(() => { throw new Error('No processing call expected'); }, { healthOk });
    await new Promise(setImmediate);
    assert.equal(app.execute('document.querySelector("#server-status-label").textContent'), healthOk ? 'Local server connected' : 'Local server unavailable');
  }
});

test('thumbnail drag, page buttons, and inserted PDFs produce the visual organizer payload', async () => {
  let request;
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    request = { path, body };
    return new Response('%PDF organized', { headers: { 'X-Page-Count': '8' } });
  });
  app.mode('organize');
  await app.add([pdf('first.pdf')]);
  await app.add([pdf('insert.pdf')]);
  assert.match(app.workspace.innerHTML, /draggable="true"/);
  app.drag(4, 0);
  await app.action('page-rotate', 0);
  await app.action('page-copy', 0);
  await app.action('page-remove', 8);
  await app.action('page-right', 1);
  await app.run();
  assert.equal(request.path, '/api/organize-pages');
  assert.deepEqual(request.body.files.map((file) => file.name), ['first.pdf', 'insert.pdf']);
  assert.equal(request.body.pages.length, 8);
  assert.deepEqual(request.body.pages[0], { fileIndex: 1, page: 1, rotation: 90 });
  assert.deepEqual(request.body.pages[2], { fileIndex: 1, page: 1, rotation: 90 });
  assert.equal(request.body.pages.filter((page) => page.fileIndex === 0).length, 4);
});

test('individual rotation and crop rectangles use dedicated geometry endpoints', async () => {
  const requests = [];
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    requests.push({ path, body });
    return new Response('%PDF geometry', { headers: { 'X-Page-Count': '4' } });
  });
  app.mode('rotate');
  await app.add([pdf('input.pdf')]);
  app.tab('rotationScope', 'individual');
  await app.action('page-rotate', 2);
  await app.run();
  assert.equal(requests[0].path, '/api/organize-pages');
  assert.deepEqual(requests[0].body.pages.map((page) => page.rotation), [0, 0, 90, 0]);
  app.mode('crop');
  app.tab('cropMethod', 'area');
  app.execute('studio.draft().areas[1] = {x:10,y:20,width:300,height:400}');
  const all = app.workspace.querySelector('#crop-all-pages'); all.checked = true; all.listeners.change();
  await app.run();
  assert.equal(requests[1].path, '/api/crop-area');
  assert.deepEqual(requests[1].body.areas, [1, 2, 3, 4].map((page) => ({ page, x: 10, y: 20, width: 300, height: 400 })));
});

test('editor buttons queue shapes, uploaded images, and actual selected text replacement', async () => {
  let request;
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    if (path === '/api/text-objects') return Response.json({ objects: [{ objectIndex: 7, text: 'Old wording', x: 20, y: 40, width: 100, height: 20, fontSize: 12, editable: true }] });
    request = { path, body };
    return new Response('%PDF edits', { headers: { 'X-Page-Count': '4' } });
  });
  app.mode('annotate'); await app.add([pdf('input.pdf')]);
  for (const type of ['rectangle', 'ellipse', 'line', 'highlight']) {
    edit(app, '#edit-tool', type); await app.action('add-item');
  }
  await app.asset(image('stamp.png'), 'image'); edit(app, '#edit-tool', 'image'); await app.action('add-item');
  await app.action('load-text');
  app.execute('studio.activeObject = studio.objects[0]');
  edit(app, '#edit-tool', 'replace-text'); edit(app, '#annotation-text', 'New wording'); await app.action('add-item');
  await app.run();
  assert.equal(request.path, '/api/edit');
  assert.deepEqual(request.body.items.map((item) => item.type), ['rectangle', 'ellipse', 'line', 'highlight', 'image', 'replace-text']);
  assert.equal(request.body.items[4].image.name, 'stamp.png');
  assert.equal(request.body.items[5].objectIndex, 7);
  assert.equal(request.body.items[5].text, 'New wording');
  assert.equal(request.body.items[5].x, 20);
  assert.equal(request.body.items[5].y, 40);
});

test('new form fields, image watermarks, and typed signatures have functioning request paths', async () => {
  const requests = [];
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    if (path === '/api/forms-inspect') return Response.json({ fields: [], pageCount: 4 });
    requests.push({ path, body });
    return new Response('%PDF result', { headers: { 'X-Page-Count': '4' } });
  });
  app.mode('forms'); await app.add([pdf('input.pdf')]);
  app.tab('formMode', 'create'); edit(app, '#new-field-name', 'Customer'); await app.action('add-form');
  await app.run();
  assert.equal(requests[0].path, '/api/forms-create');
  assert.equal(requests[0].body.fields[0].name, 'Customer');
  assert.equal(requests[0].body.fields[0].type, 'text');
  app.mode('watermark'); app.tab('watermarkMode', 'image');
  await app.asset(image('logo.png'), 'watermarkImage'); edit(app, '#watermark-image-width', '120'); edit(app, '#watermark-image-rotation', '30');
  await app.run();
  assert.equal(requests[1].path, '/api/image-watermark');
  assert.equal(requests[1].body.image.name, 'logo.png');
  assert.equal(requests[1].body.width, 120);
  assert.equal(requests[1].body.rotation, 30);
  app.mode('sign'); app.tab('signatureMode', 'type'); edit(app, '#typed-signature', 'Casey Example');
  assert.equal(app.workspace.querySelector('[data-action="run"]').disabled, false);
  await app.run();
  assert.equal(requests[2].path, '/api/typed-signature');
  assert.equal(requests[2].body.text, 'Casey Example');
  assert.equal(requests[2].body.fontStyle, 'italic');
});

test('language, OCR conversion, embedded images, visual comparison, and URL capture serialize current choices', async () => {
  const requests = [];
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    requests.push({ path, body });
    return new Response('output', { headers: { 'X-Page-Count': '4' } });
  });
  app.mode('ocr'); await app.add([pdf('input.pdf')]); edit(app, '#ocr-language', 'hin'); await app.run();
  assert.equal(requests[0].body.language, 'hin');
  app.mode('docx'); const checkbox = app.workspace.querySelector('#conversion-ocr'); checkbox.checked = true; checkbox.listeners.change(); await app.run();
  assert.equal(requests[1].body.ocr, true); assert.equal(requests[1].body.language, 'hin');
  app.mode('render'); edit(app, '#render-method', 'embedded'); await app.run();
  assert.equal(requests[2].path, '/api/extract-images'); assert.equal(app.state().outputs[0].label, 'ZIP');
  app.mode('text'); edit(app, '#text-format', 'md'); const include = app.workspace.querySelector('#include-images'); include.checked = true; include.listeners.change(); await app.run();
  assert.equal(requests[3].body.includeImages, true); assert.equal(app.state().outputs[0].name, 'localfold-text.zip');
  app.mode('compare'); await app.add([pdf('other.pdf')]); edit(app, '#compare-method', 'visual'); await app.run();
  assert.equal(requests[4].path, '/api/compare-visual'); assert.equal(app.state().outputs[0].label, 'ZIP');
  app.mode('html'); edit(app, '#html-method', 'url'); edit(app, '#html-url', 'https://example.com/page'); await app.run();
  assert.equal(requests[5].path, '/api/html-url'); assert.deepEqual(requests[5].body, { url: 'https://example.com/page' });
});

test('line edits retain actual endpoints for reverse diagonals, horizontal, and vertical strokes', async () => {
  let request;
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    request = body;
    return new Response('%PDF lines', { headers: { 'X-Page-Count': '4' } });
  });
  app.mode('annotate'); await app.add([pdf('input.pdf')]);
  edit(app, '#edit-tool', 'line');
  app.execute('studio.addItem({x:200,y:20,width:150,height:150,x2:50,y2:170})');
  app.execute('studio.addItem({x:20,y:20,width:100,height:0,x2:120,y2:20})');
  app.execute('studio.addItem({x:20,y:20,width:0,height:100,x2:20,y2:120})');
  await app.run();
  assert.deepEqual(request.items.map(({ x, y, x2, y2 }) => ({ x, y, x2, y2 })), [
    { x: 200, y: 20, x2: 50, y2: 170 }, { x: 20, y: 20, x2: 120, y2: 20 }, { x: 20, y: 20, x2: 20, y2: 120 },
  ]);
});

test('target compression defaults to 500 decimal KB and retains its value and unit across renders and modes', async () => {
  const requests = [];
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    requests.push({ path, body });
    return new Response(new Uint8Array(900000), { headers: { 'X-Input-Bytes': '2000000', 'X-Output-Bytes': '900000', 'X-Target-Bytes': String(body.targetBytes), 'X-Target-Reached': 'true', 'X-Rasterized': 'false' } });
  });
  app.mode('compress'); await app.add([pdf('input.pdf')]);
  assert.equal(app.state().compression, 'target');
  assert.equal(app.workspace.querySelector('#target-size').value, '500');
  assert.equal(app.workspace.querySelector('#target-unit').value, 'KB');
  assert.match(app.workspace.innerHTML, /1 MB = 1,000 KB/);
  assert.match(app.workspace.innerHTML, /files are not padded to an exact size/);
  assert.match(app.workspace.innerHTML, /Some targets cannot be reached/);
  edit(app, '#target-size', '1.23456789'); edit(app, '#target-unit', 'MB');
  app.render(); app.mode('rotate'); app.mode('compress');
  assert.equal(app.workspace.querySelector('#target-size').value, '1.23456789');
  assert.equal(app.workspace.querySelector('#target-unit').value, 'MB');
  await app.run();
  assert.equal(requests[0].path, '/api/compress');
  assert.equal(requests[0].body.compression, 'target');
  assert.equal(requests[0].body.targetBytes, 1234567);
  assert.equal(app.state().result.title, 'Your PDF meets the target');
  assert.match(app.state().result.note, /900 KB/);
  assert.match(app.state().result.note, /Target: 1.234567 MB · Target met/);
  assert.doesNotMatch(app.state().result.note, /converted to images|forms removed/);
  assert.equal(app.workspace.querySelector('#target-size').value, '1.23456789');
});

test('target size validation enforces byte bounds and finite numbers while preserving valid presets', async () => {
  const requests = [];
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    requests.push(body);
    return new Response('%PDF output', { headers: { 'X-Output-Bytes': '1000', 'X-Target-Bytes': String(body.targetBytes || 0), 'X-Target-Reached': 'true' } });
  });
  app.mode('compress'); await app.add([pdf('input.pdf')]);
  for (const value of ['', '0', '-1', '0.999', 'Infinity', 'NaN', 'abc', '16777.217']) {
    edit(app, '#target-size', value); await app.run();
  }
  assert.equal(requests.length, 0);
  edit(app, '#target-size', '1'); await app.run();
  assert.equal(requests[0].targetBytes, 1000);
  edit(app, '#target-unit', 'MB'); edit(app, '#target-size', '0.001'); await app.run();
  assert.equal(requests[1].targetBytes, 1000);
  edit(app, '#target-size', '16.777216'); await app.run();
  assert.equal(requests[2].targetBytes, 16777216);
  edit(app, '#target-unit', 'GB'); await app.run();
  assert.equal(requests.length, 3);
  for (const preset of ['lossless', 'balanced', 'small']) {
    edit(app, '#compression', preset); await app.run();
    assert.equal(requests.at(-1).compression, preset);
    assert.equal(Object.hasOwn(requests.at(-1), 'targetBytes'), false);
  }
});

test('missed targets return an honest closest result with measured decimal sizes and rasterization metadata', async () => {
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    return new Response(new Uint8Array(500001), { headers: { 'X-Input-Bytes': '2000000', 'X-Output-Bytes': '500001', 'X-Target-Bytes': '500000', 'X-Target-Reached': 'false', 'X-Rasterized': 'true', 'X-Compression-Dpi': '72', 'X-Compression-Quality': '35', 'X-Compression-Attempts': '8' } });
  });
  app.mode('compress'); await app.add([pdf('input.pdf')]); await app.run();
  assert.equal(app.state().result.title, 'Closest available result');
  assert.equal(app.state().result.status, 'partial');
  assert.match(app.state().result.note, /2 MB → 500.001 KB · Target: 500 KB · Target not reached/);
  assert.match(app.state().result.note, /Pages converted to images; selectable text and forms removed/);
  assert.match(app.state().result.note, /72 dpi · JPEG quality 35/);
  assert.match(app.workspace.innerHTML, /result-partial/);
  assert.match(app.workspace.innerHTML, /Download PDF/);
  assert.doesNotMatch(app.state().result.title, /ready|meets/);
});

test('target mode accepts long PDFs and targets above the original without inventing target success', async () => {
  let reached = 'true';
  let request;
  const app = browser((path, body) => {
    if (path === '/api/inspect') return Response.json({ files: body.files.map((file) => ({ name: file.name, pageCount: 100 })) });
    request = body;
    const headers = { 'X-Input-Bytes': '10000', 'X-Output-Bytes': '10000', 'X-Target-Bytes': String(body.targetBytes), 'X-Rasterized': 'false' };
    if (reached !== null) headers['X-Target-Reached'] = reached;
    return new Response(new Uint8Array(10000), { headers });
  });
  app.mode('compress'); await app.add([pdf('long-small.pdf')]); await app.run();
  assert.equal(request.targetBytes, 500000);
  assert.equal(app.state().result.title, 'Your PDF meets the target');
  assert.match(app.state().result.note, /Original already within target/);
  assert.doesNotMatch(app.state().result.note, /converted to images/);
  reached = null; await app.run();
  assert.equal(app.state().result.title, 'Your compression result');
  assert.match(app.state().result.note, /Target status unavailable/);
  assert.doesNotMatch(app.state().result.note, /Target met/);
  reached = 'true'; edit(app, '#target-size', '1'); await app.run();
  assert.equal(app.state().result.title, 'Closest available result', 'Measured output above the limit must not be called successful even if a header is inconsistent');
});

test('area cropping waits for a selection and apply-all requires a rectangle on the current page', async () => {
  const requests = [];
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    requests.push({ path, body });
    return new Response('%PDF cropped', { headers: { 'X-Page-Count': '4' } });
  });
  app.mode('crop');
  await app.add([pdf('input.pdf')]);
  assert.equal(app.execute('studio.cropMethod'), 'area');
  assert.equal(app.workspace.querySelector('[data-action="run"]').disabled, true);
  await app.run();
  assert.equal(requests.length, 0);
  app.execute('studio.draft().areas[1] = {x:10,y:20,width:300,height:400}');
  app.render();
  assert.equal(app.workspace.querySelector('[data-action="run"]').disabled, false);
  app.execute('studio.page = 2; state.page = "2"; studio.cropAll = true');
  app.render();
  assert.equal(app.workspace.querySelector('[data-action="run"]').disabled, true);
  await app.run();
  assert.equal(requests.length, 0);
  app.execute('studio.draft().areas[2] = {x:15,y:25,width:280,height:360}');
  app.render();
  assert.equal(app.workspace.querySelector('[data-action="run"]').disabled, false);
  await app.run();
  assert.equal(requests[0].path, '/api/crop-area');
  assert.deepEqual(requests[0].body.areas, [1, 2, 3, 4].map((page) => ({ page, x: 15, y: 25, width: 280, height: 360 })));
  app.execute('studio.draft().areas = {}; studio.cropAll = false');
  app.render();
  assert.equal(app.workspace.querySelector('[data-action="run"]').disabled, true);
  app.tab('cropMethod', 'margin');
  assert.equal(app.workspace.querySelector('[data-action="run"]').disabled, false);
});

test('signature and editor image previews retain source aspect ratio and match their PDF placement boxes', async () => {
  const app = browser((path, body) => path === '/api/inspect' ? inspected(body.files) : new Response('%PDF result'));
  const square = image('square.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=', 'base64'));
  app.mode('sign'); await app.add([pdf('input.pdf')]); await app.signature(square);
  assert.equal(app.state().signature.width, 1);
  assert.equal(app.state().signature.height, 1);
  let overlay = app.execute('studio.overlay(600, 800)');
  assert.match(overlay, /x="36" y="36" width="160" height="160"/);
  app.execute('state.signature = {...state.signature, width:700, height:180}; studio.signatureMode="draw"');
  overlay = app.execute('studio.overlay(600, 800)');
  assert.equal(Number(overlay.match(/height="([^"]+)"/)[1]), 160 * 180 / 700);
  app.mode('annotate'); await app.asset(square, 'image');
  edit(app, '#edit-tool', 'image'); edit(app, '#edit-width', '200'); edit(app, '#edit-height', '100');
  await app.action('add-item');
  overlay = app.execute('studio.overlay(600, 800)');
  assert.match(overlay, /x="86" y="36" width="100" height="100"/);
  assert.match(overlay, /preserveAspectRatio="xMidYMid meet"/);
  assert.equal(app.execute('studio.draft().items[0].image.width'), 1);
  assert.equal(app.execute('studio.draft().items[0].image.height'), 1);
});

test('typed signature previews use selected font families and fit measured text within the requested width', async () => {
  const app = browser((path, body) => path === '/api/inspect' ? inspected(body.files) : new Response('%PDF result'));
  app.mode('sign'); await app.add([pdf('input.pdf')]);
  app.tab('signatureMode', 'type'); edit(app, '#typed-signature', 'Ada');
  let layout = app.execute('studio.signatureTextLayout(160)');
  assert.equal(layout.size, 48);
  assert.match(layout.family, /Times New Roman/);
  assert.match(app.execute('studio.overlay(600,800)'), /y="84" font-size="48"/);
  edit(app, '#typed-signature', 'A'.repeat(40));
  layout = app.execute('studio.signatureTextLayout(160)');
  assert.equal(layout.size, 8);
  assert.match(app.execute('studio.overlay(600,800)'), /y="44" font-size="8"/);
  app.execute('studio.fontStyle="sans"');
  assert.match(app.execute('studio.signatureTextLayout(160).family'), /Arial/);
  app.execute('studio.fontStyle="monospace"');
  assert.match(app.execute('studio.signatureTextLayout(160).family'), /Courier New/);
});

test('PDF image downsampling reports retained text and forms with reduced image resolution', async () => {
  const app = browser((path, body) => {
    if (path === '/api/inspect') return inspected(body.files);
    return new Response(new Uint8Array(14000), { headers: {
      'X-Input-Bytes': '200000', 'X-Output-Bytes': '14000',
      'X-Target-Bytes': String(body.targetBytes), 'X-Target-Reached': 'true',
      'X-Rasterized': 'false', 'X-Compression-Method': 'image-jpeg', 'X-Image-Scale': '0.7',
    } });
  });
  app.mode('compress'); await app.add([pdf('clear-text.pdf')]);
  edit(app, '#target-size', '20'); await app.run();
  assert.equal(app.state().result.title, 'Your PDF meets the target');
  assert.match(app.state().result.note, /Selectable text and forms retained/);
  assert.match(app.state().result.note, /Embedded image resolution reduced/);
  assert.doesNotMatch(app.state().result.note, /Pages converted to images|forms removed/);
});

test('image compression accepts common raster inputs without PDF inspection and preserves target choices', async () => {
  const requests = [];
  const app = browser((path, body) => {
    requests.push({ path, body });
    return new Response(new Uint8Array(12000), { headers: {
      'Content-Type': 'image/webp', 'Content-Disposition': 'attachment; filename="clear.webp"',
      'X-Target-Reached': 'true', 'X-Image-Format': 'WEBP', 'X-Image-Width': '1200', 'X-Image-Height': '800',
      'X-Image-Frames': '1', 'X-Image-Resized': 'false', 'X-Image-Quality': '91',
    } });
  });
  app.mode('compressImage');
  app.execute('openPicker()');
  assert.match(app.execute('picker.accept'), /image\/\*/);
  assert.match(app.execute('picker.accept'), /\.heic,\.heif/);
  assert.equal(app.execute('picker.multiple'), false);
  for (const name of ['photo.heic', 'photo.heif', 'photo.qoi', 'cursor.cur', 'photo.tiff']) {
    await app.add([image(name, '', 'synthetic raster')]);
    assert.equal(app.state().files[0].name, name);
  }
  assert.equal(requests.length, 0, 'Image inputs must not go through the PDF inspector');
  assert.equal(app.state().files[0].kind, 'image');
  assert.equal(app.workspace.querySelector('[data-action="run"]').disabled, false);
  assert.match(app.workspace.innerHTML, /Selected image/);
  edit(app, '#target-size', '0.025'); edit(app, '#target-unit', 'MB'); edit(app, '#image-output-format', 'webp');
  app.render();
  assert.equal(app.workspace.querySelector('#image-output-format').value, 'webp');
  await app.run();
  assert.deepEqual(requests[0], { path: '/api/compress-image', body: { file: { name: 'photo.tiff', data: Buffer.from('synthetic raster').toString('base64') }, targetBytes: 25000, outputFormat: 'webp' } });
  assert.equal(app.state().outputs[0].name, 'clear.webp');
  assert.equal(app.state().outputs[0].label, 'image');
  assert.equal(app.state().outputs[0].blob.type, 'image/webp');
  assert.equal(app.state().result.title, 'Your image meets the target');
  assert.match(app.state().result.note, /12 KB · Target: 25 KB · Target met · WEBP · 1200 × 800 px/);
  assert.match(app.state().result.note, /Original dimensions retained · Encoding quality 91/);
  assert.match(app.workspace.innerHTML, /Download image/);
  app.mode('images');
  assert.equal(app.state().files.length, 0, 'The JPG/PNG-only Images to PDF workflow must not inherit TIFF inputs');
  app.execute('openPicker()');
  assert.equal(app.execute('picker.accept'), 'image/jpeg,image/png,.jpg,.jpeg,.png');
  app.mode('compress');
  assert.equal(app.state().imageOutputFormat, 'webp');
  assert.equal(app.state().compression, 'target');
});

test('image results use measured download size and report missed targets, animation and resizing honestly', async () => {
  const app = browser(() => new Response(new Uint8Array(2001), { headers: {
    'Content-Type': 'image/webp', 'X-Output-Bytes': '999', 'X-Target-Reached': 'true',
    'X-Image-Format': 'WEBP', 'X-Image-Width': '320', 'X-Image-Height': '240',
    'X-Image-Frames': '3', 'X-Image-Resized': 'true',
  } }));
  app.mode('compressImage'); await app.add([image('animated.gif', 'image/gif')]);
  edit(app, '#target-size', '2'); await app.run();
  assert.equal(app.state().outputs[0].name, 'localfold-compressed-image.webp');
  assert.equal(app.state().result.status, 'partial');
  assert.equal(app.state().result.title, 'Closest available image');
  assert.match(app.state().result.note, /2.001 KB · Target: 2 KB · Target not reached/);
  assert.match(app.state().result.note, /320 × 240 px · 3 frames retained · Dimensions reduced/);
  assert.doesNotMatch(app.state().result.note, /Target met|1 page|undefined|NaN/);
  assert.match(app.workspace.innerHTML, /Download image/);
});

test('image compression validates target and output format before sending and keeps backend errors useful', async () => {
  const requests = [];
  const app = browser((path, body) => {
    requests.push({ path, body });
    return Response.json({ error: 'JPEG output would discard transparency. Choose Auto, PNG, WebP, or AVIF.' }, { status: 400 });
  });
  app.mode('compressImage'); await app.add([image('transparent.png')]);
  for (const value of ['', '0.999', 'Infinity', '-10', '16777.217']) { edit(app, '#target-size', value); await app.run(); }
  assert.equal(requests.length, 0);
  edit(app, '#target-size', '20'); edit(app, '#image-output-format', 'invalid'); await app.run();
  assert.equal(requests.length, 0);
  edit(app, '#image-output-format', 'jpeg'); await app.run();
  assert.equal(requests[0].body.outputFormat, 'jpeg');
  assert.equal(app.state().busy, false);
  assert.equal(app.state().outputs.length, 0);
  assert.equal(app.state().result, null);
  assert.match(app.execute('toast.textContent'), /would discard transparency/);
});

test('resize image reuses broad image input without PDF inspection and sends dimensions without an unwanted size target', async () => {
  const requests = [];
  const app = browser((path, body) => {
    requests.push({ path, body });
    return new Response(new Uint8Array(9000), { headers: {
      'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="resized.png"',
      'X-Image-Format': 'png', 'X-Image-Width': '1280', 'X-Image-Height': '640', 'X-Image-Frames': '1',
    } });
  });
  app.mode('compressImage'); await app.add([image('phone.heic', '', 'raster bytes')]);
  app.mode('resizeImage');
  assert.equal(app.state().files[0].name, 'phone.heic');
  assert.equal(requests.length, 0);
  assert.equal(app.state().resizeAspect, true);
  assert.equal(app.state().resizeCompress, false);
  assert.equal(app.workspace.querySelector('#resize-target-size'), null);
  assert.match(app.workspace.innerHTML, /Maintain aspect ratio/);
  assert.match(app.workspace.innerHTML, /Fit inside this width × height box/);
  app.execute('openPicker()');
  assert.match(app.execute('picker.accept'), /\.heic,\.heif/);
  assert.equal(app.execute('picker.multiple'), false);
  await app.run();
  assert.deepEqual(requests[0], { path: '/api/resize-image', body: {
    file: { name: 'phone.heic', data: Buffer.from('raster bytes').toString('base64') },
    width: 1280, height: 1280, unit: 'px', dpi: 300, maintainAspectRatio: true, outputFormat: 'auto',
  } });
  assert.equal(app.state().outputs[0].name, 'resized.png');
  assert.equal(app.state().outputs[0].label, 'image');
  assert.equal(app.state().result.title, 'Your resized image is ready');
  assert.match(app.state().result.note, /1280 × 640 px · 9 KB · PNG · Aspect ratio maintained/);
  assert.doesNotMatch(app.state().result.note, /Target|undefined|NaN/);
  app.mode('compressImage');
  assert.equal(app.state().files[0].name, 'phone.heic');
  assert.equal(app.state().targetSize, '500');
  app.mode('images');
  assert.equal(app.state().files.length, 0);
});

test('resize size compression is optional and reports a missed target without claiming altered dimensions', async () => {
  const requests = [];
  const app = browser((path, body) => {
    requests.push({ path, body });
    return new Response(new Uint8Array(120001), { headers: {
      'Content-Type': 'image/png', 'X-Image-Format': 'png', 'X-Image-Width': '300', 'X-Image-Height': '200',
      'X-Output-Bytes': '999', 'X-Target-Reached': 'true',
    } });
  });
  app.mode('resizeImage'); await app.add([image('input.png')]);
  edit(app, '#resize-width', '300'); edit(app, '#resize-height', '200');
  changeResizeField(app, '#resize-aspect', false);
  changeResizeField(app, '#resize-compress', true);
  edit(app, '#resize-output-format', 'png');
  assert.equal(app.workspace.querySelector('#resize-target-size').value, '100');
  await app.run();
  assert.equal(requests[0].body.targetBytes, 100000);
  assert.equal(requests[0].body.maintainAspectRatio, false);
  assert.equal(requests[0].body.width, 300);
  assert.equal(requests[0].body.height, 200);
  assert.equal(requests[0].body.outputFormat, 'png');
  assert.equal(app.state().result.status, 'partial');
  assert.equal(app.state().result.title, 'Image resized; size target not reached');
  assert.match(app.state().result.note, /300 × 200 px · 120.001 KB/);
  assert.match(app.state().result.note, /Exact requested dimensions · Target: 100 KB · Target not reached · Resized pixel dimensions kept fixed/);
  assert.doesNotMatch(app.state().result.note, /Target met|Dimensions reduced to approach target/);
  changeResizeField(app, '#resize-compress', false);
  assert.equal(app.workspace.querySelector('#resize-target-size'), null);
  await app.run();
  assert.equal(Object.hasOwn(requests[1].body, 'targetBytes'), false);
  assert.equal(app.state().result.status, 'success');
  assert.doesNotMatch(app.state().result.note, /Target:/);
});

test('resize centimetres use explicit DPI and show the actual fitted physical dimensions', async () => {
  const requests = [];
  const app = browser((path, body) => {
    requests.push({ path, body });
    return new Response(new Uint8Array(4000), { headers: {
      'Content-Type': 'image/webp', 'X-Image-Format': 'webp', 'X-Image-Width': '1200', 'X-Image-Height': '600',
      'X-Image-Dpi': '600', 'X-Target-Reached': 'true',
    } });
  });
  app.mode('resizeImage'); await app.add([image('input.webp', 'image/webp')]);
  edit(app, '#resize-width', '600'); edit(app, '#resize-height', '600');
  changeResizeField(app, '#resize-unit', 'cm');
  assert.equal(app.workspace.querySelector('#resize-width').value, '5.08');
  assert.equal(app.workspace.querySelector('#resize-height').value, '5.08');
  assert.equal(app.workspace.querySelector('#resize-dpi').value, '300');
  edit(app, '#resize-dpi', '600');
  changeResizeField(app, '#resize-compress', true);
  edit(app, '#resize-target-size', '0.005'); changeResizeField(app, '#resize-target-unit', 'MB');
  app.render(); await app.run();
  assert.equal(requests[0].body.unit, 'cm');
  assert.equal(requests[0].body.dpi, 600);
  assert.equal(requests[0].body.width, 5.08);
  assert.equal(requests[0].body.height, 5.08);
  assert.equal(requests[0].body.targetBytes, 5000);
  assert.equal(app.state().result.title, 'Your resized image meets the target');
  assert.match(app.state().result.note, /1200 × 600 px · 4 KB · WEBP · Aspect ratio maintained · 5.08 × 2.54 cm at 600 DPI/);
  changeResizeField(app, '#resize-unit', 'px');
  assert.equal(app.workspace.querySelector('#resize-width').value, '1200');
  assert.equal(app.workspace.querySelector('#resize-height').value, '1200');
  assert.equal(app.workspace.querySelector('#resize-dpi'), null);
});

test('resize validates dimensions and optional size independently before making a request', async () => {
  const requests = [];
  const app = browser((path, body) => {
    requests.push({ path, body });
    return new Response(new Uint8Array(1000), { headers: { 'X-Image-Format': 'png', 'X-Image-Width': '100', 'X-Image-Height': '100' } });
  });
  app.mode('resizeImage'); await app.add([image('input.png')]);
  for (const width of ['', '0', '-1', '1.5', 'Infinity', '30001']) { edit(app, '#resize-width', width); await app.run(); }
  assert.equal(requests.length, 0);
  edit(app, '#resize-width', '100'); edit(app, '#resize-height', '100');
  changeResizeField(app, '#resize-aspect', false);
  edit(app, '#resize-width', '10000'); edit(app, '#resize-height', '10000'); await app.run();
  assert.equal(requests.length, 0);
  edit(app, '#resize-width', '100'); edit(app, '#resize-height', '100');
  changeResizeField(app, '#resize-unit', 'cm');
  for (const dpi of ['', '35', '1201', '300.5', 'NaN']) { edit(app, '#resize-dpi', dpi); await app.run(); }
  assert.equal(requests.length, 0);
  edit(app, '#resize-dpi', '300');
  changeResizeField(app, '#resize-compress', true);
  for (const value of ['', '0.5', 'Infinity', '16777.217']) { edit(app, '#resize-target-size', value); await app.run(); }
  assert.equal(requests.length, 0);
  changeResizeField(app, '#resize-compress', false);
  await app.run();
  assert.equal(requests.length, 1, 'An invalid hidden target must not block ordinary resizing');
  assert.equal(Object.hasOwn(requests[0].body, 'targetBytes'), false);
});

test('resize keeps backend errors useful and allows returning to the existing image compressor', async () => {
  const requests = [];
  const app = browser((path, body) => {
    requests.push({ path, body });
    return Response.json({ error: 'This animation cannot be resized without changing its loop behavior.' }, { status: 400 });
  });
  app.mode('resizeImage'); await app.add([image('animated.avif', 'image/avif')]);
  edit(app, '#resize-width', '320'); edit(app, '#resize-height', '240');
  await app.run();
  assert.equal(requests[0].path, '/api/resize-image');
  assert.equal(app.state().busy, false);
  assert.equal(app.state().outputs.length, 0);
  assert.equal(app.state().files[0].name, 'animated.avif');
  assert.match(app.execute('toast.textContent'), /loop behavior/);
  app.mode('compressImage');
  assert.equal(app.state().files[0].name, 'animated.avif');
  assert.equal(app.state().resizeWidth, '320');
  assert.equal(app.state().imageOutputFormat, 'auto');
});
