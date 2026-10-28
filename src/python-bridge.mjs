import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PdfInputError } from './pdf-ops.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'python', 'engine.py');
const candidates = [process.env.LOCALFOLD_PYTHON, path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
  path.join(ROOT, '.venv', 'bin', 'python'),
  path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe')].filter(Boolean);
let active = 0;

export function pythonExecutable() {
  return candidates.find((candidate) => existsSync(candidate)) || (process.platform === 'win32' ? 'python' : 'python3');
}

export async function runPython(operation, payload = {}) {
  if (active >= 2) throw new PdfInputError('Two document tasks are already running. Try again after one finishes.', 429);
  active += 1;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(pythonExecutable(), [ENGINE], { cwd: ROOT, windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = [];
      let length = 0;
      let settled = false;
      let stderr = '';
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new PdfInputError('This document task took too long. Try fewer pages or a lower resolution.', 408));
      }, 120_000);
      child.stdout.on('data', (chunk) => {
        length += chunk.length;
        if (length > 100 * 1024 * 1024) {
          child.kill();
          finish(new PdfInputError('The document output is too large. Try fewer pages.', 413));
        } else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk) => { if (stderr.length < 2000) stderr += chunk.toString('utf8'); });
      child.on('error', () => finish(new PdfInputError('The local Python engine is unavailable. Run setup-python.ps1 in the project folder.', 503)));
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          const missing = /ModuleNotFoundError|ImportError/.test(stderr);
          finish(new PdfInputError(missing ? 'A PDF engine dependency is missing. Run setup-python.ps1 in the project folder.' : 'The local PDF engine stopped unexpectedly.', 503));
          return;
        }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!result.ok) finish(new PdfInputError(result.error || 'The document could not be processed.'));
          else finish(null, result);
        } catch { finish(new PdfInputError('The local PDF engine returned an unreadable result.', 503)); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ operation, payload }));
    });
  } finally { active -= 1; }
}

export async function pythonDocument(operation, payload) {
  const result = await runPython(operation, payload);
  return { ...result, bytes: Buffer.from(result.data, 'base64') };
}
