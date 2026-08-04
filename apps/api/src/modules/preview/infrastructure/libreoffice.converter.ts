import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RenderFailedError } from '../../../ports/preview.port';
import type { OfficeConversionLimits, OfficeConverter } from '../application/office-converter.port';

/**
 * LibreOffice, headless, as the office-to-PDF engine — `OFFICE_DRIVER=LIBREOFFICE`.
 *
 * One conversion is one short-lived subprocess against 14 §5's table:
 *
 * - **Wall-clock**: killed at the limit; an exceeded budget is a failed artefact, never a stuck
 *   worker.
 * - **No macros**: a headless `--convert-to` never executes document macros — there is no event
 *   loop for them to attach to — and the throwaway profile carries no trusted locations.
 * - **Isolated profile**: `-env:UserInstallation` points at a per-conversion temp directory, so
 *   conversions share no state and a poisoned profile lives exactly one job.
 * - **Output cap**: a rendition above the ceiling is discarded, not stored.
 * - **No credentials**: the subprocess sees the bytes on disk and nothing else — no environment
 *   beyond `PATH` and `HOME`, no database URL, no storage secret.
 *
 * Network egress is the deployment's to deny (the worker tier's container has none, `20` §2);
 * a converter cannot verify the firewall it runs behind.
 */
export class LibreOfficeConverter implements OfficeConverter {
  readonly available = true;

  constructor(private readonly binary: string) {}

  async convertToPdf(
    bytes: Buffer,
    extension: string,
    limits: OfficeConversionLimits,
  ): Promise<Buffer> {
    const workdir = await mkdtemp(join(tmpdir(), 'edms-office-'));
    try {
      const input = join(workdir, `source${extension}`);
      const profile = join(workdir, 'profile');
      await writeFile(input, bytes);

      await this.run(
        [
          '--headless',
          '--invisible',
          '--nodefault',
          '--norestore',
          '--nolockcheck',
          `-env:UserInstallation=${pathToFileURL(profile).toString()}`,
          '--convert-to',
          'pdf',
          '--outdir',
          workdir,
          input,
        ],
        limits.timeoutMs,
      );

      const output = await readFile(join(workdir, 'source.pdf')).catch(() => null);
      if (output === null) {
        throw new RenderFailedError('The converter produced no PDF.');
      }
      if (output.length > limits.maxOutputBytes) {
        throw new RenderFailedError(
          `The rendition is ${String(output.length)} bytes; the cap is ${String(limits.maxOutputBytes)}.`,
        );
      }
      return output;
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  private run(args: readonly string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        stdio: 'ignore',
        // A minimal environment, deliberately: the conversion needs a PATH to exist and a HOME
        // for its profile machinery, and it must not inherit the database URL, the storage
        // secret or anything else this process holds.
        env: {
          ...(process.env['PATH'] !== undefined && { PATH: process.env['PATH'] }),
          HOME: tmpdir(),
        },
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new RenderFailedError(`The conversion exceeded its ${String(timeoutMs)} ms budget.`),
        );
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new RenderFailedError(`The converter could not start: ${error.message}`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new RenderFailedError(`The converter exited with code ${String(code ?? -1)}.`));
        }
      });
    });
  }
}

/** `OFFICE_DRIVER=NONE`: no engine, honestly. Renderers degrade to extracted text. */
export class NoOfficeConverter implements OfficeConverter {
  readonly available = false;

  convertToPdf(): Promise<Buffer> {
    return Promise.reject(
      new RenderFailedError('No office converter is configured (OFFICE_DRIVER=NONE).'),
    );
  }
}
