import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { MAX_FILE_BYTES, PdfInputError, safeFilename } from './pdf-ops.mjs';
import { runPython } from './python-bridge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'localfold-office-';
let outstanding = 0;
let queue = Promise.resolve();

function decodeOfficeFile(file) {
  if (!file || typeof file.name !== 'string' || typeof file.data !== 'string') {
    throw new PdfInputError('Choose a Word, Excel, or PowerPoint file to convert.');
  }
  const name = safeFilename(file.name, 'document');
  const extension = path.extname(name).toLowerCase();
  if (!['.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt'].includes(extension)) {
    throw new PdfInputError('Choose DOC/DOCX, XLS/XLSX, or PPT/PPTX. Macro-enabled formats are not supported.');
  }
  if (!file.data || file.data.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) {
    throw new PdfInputError('Choose a valid Office file smaller than 16 MB.');
  }
  const bytes = Buffer.from(file.data, 'base64');
  const expected = ['.doc', '.xls', '.ppt'].includes(extension) ? 'd0cf11e0' : '504b0304';
  if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.subarray(0, 4).toString('hex') !== expected) {
    throw new PdfInputError('This is not a readable Office file under 16 MB.');
  }
  return { name, extension, bytes };
}

async function libreOfficeExecutable() {
  const candidates = [process.env.LOCALFOLD_LIBREOFFICE,
    path.join(ROOT, 'runtime', 'libreoffice', 'program', 'soffice.com'),
    path.join(ROOT, 'runtime', 'libreoffice', 'program', 'soffice.exe'),
    'C:\\Program Files\\LibreOffice\\program\\soffice.com',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/libreoffice', '/usr/bin/soffice',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); if ((await stat(candidate)).isFile()) return candidate; } catch { /* Try the next installation. */ }
  }
  throw new PdfInputError('The local LibreOffice engine is unavailable. Set LOCALFOLD_LIBREOFFICE to its soffice executable.', 503);
}

// Every job uses a fresh profile, with no trusted script locations or user data.
// Configuration keys and enum values are documented in LibreOffice's official
// Common.xcs, Writer.xcs and Calc.xcs configuration schemas.
const PROFILE_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
    <prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="DisableOLEAutomation" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="SecureURL" oor:op="fuse"><value/></prop>
  </item>
  <item oor:path="/org.openoffice.Office.Writer/Content/Update">
    <prop oor:name="Link" oor:op="fuse"><value>2</value></prop>
    <prop oor:name="Field" oor:op="fuse"><value>false</value></prop>
    <prop oor:name="Chart" oor:op="fuse"><value>false</value></prop>
  </item>
  <item oor:path="/org.openoffice.Office.Calc/Content/Update">
    <prop oor:name="Link" oor:op="fuse"><value>1</value></prop>
  </item>
</oor:items>`;

async function terminateTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
      const fallback = setTimeout(() => { child.kill(); resolve(); }, 5000);
      const finish = () => { clearTimeout(fallback); resolve(); };
      killer.on('error', () => { child.kill(); finish(); });
      killer.on('close', finish);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

async function runLibreOffice(executable, input, outputDirectory, profileDirectory) {
  let child;
  let running = true;
  try {
    await new Promise((resolve, reject) => {
      child = spawn(executable, [
        `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
        '--headless', '--nologo', '--nodefault', '--norestore', '--nofirststartwizard',
        '--convert-to', 'pdf', '--outdir', outputDirectory, input,
      ], {
        cwd: outputDirectory, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore'],
      });
      let timedOut = false;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminateTree(child).finally(() => finish(new PdfInputError('Office conversion exceeded the 90-second local processing limit.', 408)));
      }, 90_000);
      child.on('error', () => {
        running = false;
        finish(new PdfInputError('The local LibreOffice engine could not be started.', 503));
      });
      child.on('close', (code) => {
        running = false;
        finish(timedOut
          ? new PdfInputError('Office conversion exceeded the 90-second local processing limit.', 408)
          : code === 0 ? undefined : new PdfInputError('LibreOffice could not convert this document. It may be damaged or password-protected.'));
      });
    });
  } finally {
    if (child && running) await terminateTree(child);
  }
}

async function removeOwnedTemporaryDirectory(taskDirectory, tempRoot) {
  // Resolve and verify the exact directory immediately before recursive removal.
  const actual = await realpath(taskDirectory);
  const relative = path.relative(tempRoot, actual);
  if (!relative || path.isAbsolute(relative) || relative.startsWith('..')
      || path.dirname(relative) !== '.' || !path.basename(relative).startsWith(PREFIX)) {
    throw new PdfInputError('Temporary Office cleanup stopped because the task folder is outside its expected location.', 503);
  }
  await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function convertOffice(input) {
  const check = await runPython('office-check', { file: { name: input.name, data: input.bytes.toString('base64') } });
  if (String(check.extension).replace(/^\./, '') !== input.extension.slice(1)) {
    throw new PdfInputError('The Office filename does not match its document package.');
  }
  const executable = await libreOfficeExecutable();
  const tempRoot = await realpath(os.tmpdir());
  const taskDirectory = await mkdtemp(path.join(tempRoot, PREFIX));
  try {
    const id = randomUUID();
    const inputPath = path.join(taskDirectory, `${id}${input.extension}`);
    const outputDirectory = path.join(taskDirectory, 'output');
    const profileDirectory = path.join(taskDirectory, 'profile');
    await mkdir(outputDirectory);
    await mkdir(path.join(profileDirectory, 'user'), { recursive: true });
    await writeFile(path.join(profileDirectory, 'user', 'registrymodifications.xcu'), PROFILE_CONFIG, 'utf8');
    await writeFile(inputPath, input.bytes, { flag: 'wx' });
    await runLibreOffice(executable, inputPath, outputDirectory, profileDirectory);
    const outputPath = path.join(outputDirectory, `${id}.pdf`);
    let size;
    try { size = (await stat(outputPath)).size; } catch {
      throw new PdfInputError('LibreOffice did not produce a PDF. The document may be damaged, unsupported, or password-protected.');
    }
    if (!size || size > 64 * 1024 * 1024) throw new PdfInputError('The converted PDF is empty or exceeds the 64 MB output limit.', 413);
    const bytes = await readFile(outputPath);
    let document;
    try { document = await PDFDocument.load(bytes, { updateMetadata: false }); } catch {
      throw new PdfInputError('LibreOffice produced an unreadable PDF.');
    }
    const pageCount = document.getPageCount();
    if (pageCount < 1 || pageCount > 200) throw new PdfInputError('Office conversion supports between 1 and 200 output pages.', 413);
    return { bytes, pageCount };
  } finally {
    await removeOwnedTemporaryDirectory(taskDirectory, tempRoot);
  }
}

export async function officeToPdf(file) {
  const input = decodeOfficeFile(file);
  // One running conversion and at most one waiting task keep local CPU/memory
  // bounded and prevent overlapping LibreOffice process startup/lock handling.
  if (outstanding >= 2) throw new PdfInputError('Two Office tasks are already running or waiting. Try again after one finishes.', 429);
  outstanding += 1;
  const task = queue.then(() => convertOffice(input));
  queue = task.catch(() => {});
  try { return await task; } finally { outstanding -= 1; }
}
