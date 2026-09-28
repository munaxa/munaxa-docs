import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../../core/config/configuration';
import { ProviderNotConfiguredError } from '../../../core/errors/application-errors';
import { antivirusAdapterFor } from '../../infrastructure.module';
import { UnconfiguredAntivirusAdapter } from '../unconfigured.adapters';
import { IcapAntivirusAdapter } from './icap-antivirus.adapter';

/**
 * What production is bound to, and what it can never be bound to — RC D-3's regression guard.
 *
 * The RC found `ANTIVIRUS_PORT` bound to the unconfigured adapter whatever `AV_DRIVER` said, and
 * validated every content path with a documented, ledgered, test-only database update marking blobs
 * `CLEAN` under the scanner name `TEST-ONLY-D3-SUBSTITUTION`. That substitution lived outside this
 * repository. These tests pin that it stays there, and that the composition root selects a scanner
 * that actually scans.
 */

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://app:secret@localhost:5432/edms',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  TENANT_ID: '019489f0-0000-7000-8000-000000000001',
  TENANT_SLUG: 'acme',
} satisfies NodeJS.ProcessEnv;

const storage = { read: () => Promise.resolve(null) } as never;

describe('the adapter AV_DRIVER selects', () => {
  it('ICAP selects the ICAP adapter — a real scanner client, not the refusal', () => {
    const config = loadConfig({
      ...env,
      AV_DRIVER: 'ICAP',
      AV_ICAP_URL: 'icap://scanner:1344/avscan',
    });
    const adapter = antivirusAdapterFor(config, storage);
    expect(adapter).toBeInstanceOf(IcapAntivirusAdapter);
    expect(adapter).not.toBeInstanceOf(UnconfiguredAntivirusAdapter);
  });

  it('NONE selects the refusal, which never answers with a verdict', async () => {
    const adapter = antivirusAdapterFor(loadConfig({ ...env }), storage);
    expect(adapter).toBeInstanceOf(UnconfiguredAntivirusAdapter);
    await expect(
      adapter.scan({ storageKey: 'k', sizeBytes: 1, declaredMimeType: 'x', timeoutMs: 1 }),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(adapter.probe).toBeUndefined();
  });

  it('HOSTED selects nothing: there is no adapter, so it refuses rather than binding a placeholder', () => {
    const config = loadConfig({ ...env });
    const hosted = { ...config, providers: { ...config.providers, antivirus: 'HOSTED' as const } };
    expect(() => antivirusAdapterFor(hosted, storage)).toThrow(/HOSTED has no adapter/);
  });
});

describe('the RC test-only substitution', () => {
  // `__dirname`, because this package compiles to CommonJS.
  const root = join(__dirname, '..', '..', '..', '..', '..', '..');
  const MARKER = ['TEST-ONLY', 'D3', 'SUBSTITUTION'].join('-');

  /** Every non-test source file the product builds or runs from. */
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (
        ['node_modules', 'dist', '.next', '__tests__', 'test', 'testing', '__fixtures__'].includes(
          entry,
        )
      ) {
        return [];
      }
      if (statSync(path).isDirectory()) {
        return sources(path);
      }
      return /\.(ts|tsx|mjs|js|sql|sh|ya?ml|json)$/.test(entry) && !/\.(spec|test)\./.test(entry)
        ? [path]
        : [];
    });
  }

  it('appears in no production source, script, SQL or deployment file', () => {
    const scanned = [
      'apps/api/src',
      'apps/worker/src',
      'apps/web/src',
      'packages',
      'infra',
      'scripts',
      'prisma',
      '.github',
    ].flatMap((dir) => sources(join(root, dir)));
    expect(scanned.length).toBeGreaterThan(500);
    const carrying = scanned.filter((file) => readFileSync(file, 'utf8').includes(MARKER));
    expect(carrying.map((file) => relative(root, file))).toEqual([]);
  });
});
