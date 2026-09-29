import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * The scanner image's start-up signature check — staging finding STG-8.
 *
 * `infra/antivirus/entrypoint.sh` starts on the signatures already in its volume when the
 * start-time `freshclam` fails, and refuses to start only when there are none. Its check was
 * `ls DIR/*.cvd DIR/*.cld`, which exits non-zero when either pattern matches nothing — so the
 * `.cvd`-only volume a first download produces read as empty, and in staging the scanner
 * restarted 21 times on valid signatures while its mirror was unreachable. The check is now
 * `has-signatures.sh`; these run it exactly as the image does.
 */
const IMAGE = resolve(__dirname, '../../../../../../infra/antivirus');
const SCRIPT = resolve(IMAGE, 'has-signatures.sh');
const dirs: string[] = [];

function volume(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'clamav-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

function hasSignatures(dir: string): boolean {
  try {
    execFileSync('sh', [SCRIPT, dir], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe('has-signatures.sh', () => {
  it('finds signatures in a volume with only .cvd files — a first freshclam download', () => {
    expect(hasSignatures(volume({ 'main.cvd': 'x', 'daily.cvd': 'x', 'bytecode.cvd': 'x' }))).toBe(
      true,
    );
  });

  it('finds signatures in a volume with only .cld files, or a mixture', () => {
    expect(hasSignatures(volume({ 'daily.cld': 'x' }))).toBe(true);
    expect(hasSignatures(volume({ 'main.cvd': 'x', 'daily.cld': 'x' }))).toBe(true);
  });

  it('refuses an empty volume, one with other files only, and empty database files', () => {
    expect(hasSignatures(volume({}))).toBe(false);
    expect(hasSignatures(volume({ 'freshclam.dat': 'x', 'main-63.cvd.sign': 'x' }))).toBe(false);
    expect(hasSignatures(volume({ 'main.cvd': '', 'daily.cld': '' }))).toBe(false);
  });
});

/**
 * The scanner comes back after an unclean stop — staging finding STG-9.
 *
 * c-icap will not start while its PidFile exists and exits 0 instead, so a container killed
 * uncleanly (a host or daemon restart) restarted for ever under `--restart unless-stopped` and never
 * scanned again. The entrypoint clears the runtime files the configuration names before starting
 * either daemon; this holds it to exactly the paths the configs declare, so the two cannot drift.
 */
describe('entrypoint.sh clears stale runtime files before starting the daemons', () => {
  const entrypoint = readFileSync(resolve(IMAGE, 'entrypoint.sh'), 'utf8');
  const declared = (file: string, directive: string): string => {
    const line = readFileSync(resolve(IMAGE, file), 'utf8')
      .split('\n')
      .find((candidate) => candidate.startsWith(`${directive} `));
    if (line === undefined) {
      throw new Error(`${file} declares no ${directive}`);
    }
    return line.slice(directive.length + 1).trim();
  };

  it.each([
    ['c-icap.conf', 'PidFile'],
    ['c-icap.conf', 'CommandsSocket'],
    ['clamd.conf', 'PidFile'],
  ])('%s %s is removed before clamd and c-icap start', (file, directive) => {
    const path = declared(file, directive);
    const removal = entrypoint.search(new RegExp(`^rm -f .*${path.replaceAll('.', '\\.')}`, 'm'));
    expect(removal).toBeGreaterThan(-1);
    expect(removal).toBeLessThan(entrypoint.indexOf('clamd -c'));
    expect(removal).toBeLessThan(entrypoint.indexOf('exec c-icap'));
  });
});
