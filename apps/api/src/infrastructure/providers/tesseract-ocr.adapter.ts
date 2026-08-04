import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { OcrPort, OcrRequest, OcrResult } from '../../ports/ocr.port';

const execFileAsync = promisify(execFile);

/** The raster formats the Tesseract CLI reads directly. A PDF is not one of them. */
const READABLE = ['image/png', 'image/jpeg', 'image/tiff', 'image/bmp', 'image/webp', 'image/gif'];

/**
 * Tesseract, as a subprocess — `OCR_DRIVER=TESSERACT`, the first engine 14 §6 names.
 *
 * A subprocess rather than a WASM build, deliberately: the WASM distributions fetch their
 * engine and language data from a CDN at runtime, which is exactly what an air-gapped
 * deployment cannot do, while a system package is something an installer pins. The binary's
 * path and languages are configuration (`OCR_TESSERACT_PATH`, `OCR_LANGUAGES`, default
 * `ara+eng`), the process is killed at the caller's wall-clock budget, and it inherits nothing
 * but a PATH — no database URL, no storage secret, the same posture as the office converter.
 *
 * Output is read as TSV so the confidence is the engine's own word-level number, averaged —
 * never a score somebody invented. What this adapter deliberately does not do is read PDFs:
 * rasterising a PDF page is a rendering job this product does not perform server-side, so an
 * image-only PDF stays unread and the limitation is recorded rather than worked around badly.
 */
export class TesseractOcrAdapter implements OcrPort {
  readonly engine = 'tesseract';

  constructor(private readonly binary: string) {}

  supports(mimeType: string): boolean {
    return READABLE.includes(mimeType);
  }

  async extract(request: OcrRequest): Promise<OcrResult> {
    const workdir = await mkdtemp(join(tmpdir(), 'edms-ocr-'));
    try {
      const input = join(workdir, 'source');
      await writeFile(input, request.bytes);
      await this.run(
        [input, join(workdir, 'out'), '-l', request.languages, 'tsv'],
        request.timeoutMs,
      );
      const tsv = await readFile(join(workdir, 'out.tsv'), 'utf8');
      const { text, confidence } = parseTsv(tsv, request.maxTextBytes);
      return {
        text,
        language: request.languages,
        confidence,
        engine: this.engine,
        engineVersion: await this.version(),
      };
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  private run(args: readonly string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        stdio: 'ignore',
        env: { ...(process.env['PATH'] !== undefined && { PATH: process.env['PATH'] }) },
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`OCR exceeded its ${String(timeoutMs)} ms budget.`));
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`The OCR engine could not start: ${error.message}`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`The OCR engine exited with code ${String(code ?? -1)}.`));
        }
      });
    });
  }

  private async version(): Promise<string> {
    if (this.cachedVersion === null) {
      const { stderr, stdout } = await execFileAsync(this.binary, ['--version']);
      // `tesseract 5.3.4` on the first line, historically on stderr, latterly on stdout.
      const first = (stdout + stderr).split('\n')[0] ?? '';
      this.cachedVersion = /tesseract\s+(\S+)/.exec(first)?.[1] ?? 'unknown';
    }
    return this.cachedVersion;
  }

  private cachedVersion: string | null = null;
}

/**
 * Words and their confidences out of the engine's TSV.
 *
 * Column 11 is the word confidence (−1 for structural rows), column 12 the text. Line and
 * paragraph boundaries come from the level column, so the extracted text keeps the shape a
 * paragraph diff can work with.
 */
function parseTsv(tsv: string, maxTextBytes: number): { text: string; confidence: number } {
  const pieces: string[] = [];
  const confidences: number[] = [];
  let bytes = 0;
  for (const line of tsv.split('\n').slice(1)) {
    const columns = line.split('\t');
    if (columns.length < 12) {
      continue;
    }
    const level = columns[0];
    if (level === '4') {
      pieces.push('\n');
      continue;
    }
    if (level !== '5') {
      continue;
    }
    const confidence = Number(columns[10]);
    const word = (columns[11] ?? '').trim();
    if (word.length === 0 || confidence < 0) {
      continue;
    }
    const piece = `${word} `;
    bytes += Buffer.byteLength(piece, 'utf8');
    if (bytes > maxTextBytes) {
      break;
    }
    pieces.push(piece);
    confidences.push(confidence);
  }
  const text = pieces
    .join('')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const confidence =
    confidences.length === 0
      ? 0
      : confidences.reduce((sum, value) => sum + value, 0) / confidences.length / 100;
  return { text, confidence };
}
