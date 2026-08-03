import 'reflect-metadata';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type TenantId, Settings, asId } from '@edms/domain';

import type { Logger } from '../../../core/observability/logger';
import { runWithContext } from '../../../core/tenancy/tenant-context';
import { FakeCache } from '../../../testing/fake-ports';
import type { TenantSettingsRepository } from '../application/ports';
import { CachedSettingsReader } from './cached-settings.reader';

const TENANT = asId<TenantId>('01900000-0000-7000-8000-00000000000a');

function withTenant<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(
    {
      tenantId: TENANT,
      userId: null,
      roles: [],
      permissions: [],
      sessionId: null,
      correlationId: 'settings-test',
      permissionVersion: 0,
      locale: 'en',
    },
    work,
  );
}

describe('CachedSettingsReader', () => {
  let repository: TenantSettingsRepository;
  let cache: FakeCache;
  let logger: Logger;
  let reader: CachedSettingsReader;

  beforeEach(() => {
    repository = {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
      readAll: vi.fn().mockResolvedValue({}),
    };
    cache = new FakeCache();
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    reader = new CachedSettingsReader(repository, cache, logger);
  });

  it('returns the product default when the tenant has stored nothing', async () => {
    const value = await withTenant(() => reader.get(Settings.DEFAULT_LOCALE));

    expect(value).toBe('en');
  });

  it('returns the tenant’s value when it has one', async () => {
    vi.mocked(repository.readAll).mockResolvedValue({ 'locale.default': 'ar' });

    const value = await withTenant(() => reader.get(Settings.DEFAULT_LOCALE));

    expect(value).toBe('ar');
  });

  it('reads once and serves the rest from cache', async () => {
    await withTenant(async () => {
      await reader.get(Settings.DEFAULT_LOCALE);
      await reader.get(Settings.TIMEZONE);
      await reader.get(Settings.PASSWORD_MINIMUM_LENGTH);
    });

    // Settings are read together, so one query serves whatever a request asks for.
    expect(repository.readAll).toHaveBeenCalledTimes(1);
  });

  it('reads again once the tenant’s cache entry is dropped', async () => {
    await withTenant(async () => {
      await reader.get(Settings.DEFAULT_LOCALE);
      await reader.invalidate(TENANT);
      await reader.get(Settings.DEFAULT_LOCALE);
    });

    expect(repository.readAll).toHaveBeenCalledTimes(2);
  });

  it('falls back to the default for a stored value that cannot be used, and warns', async () => {
    vi.mocked(repository.readAll).mockResolvedValue({ 'security.password.minimumLength': 3 });

    const value = await withTenant(() => reader.get(Settings.PASSWORD_MINIMUM_LENGTH));

    expect(value).toBe(12);
    expect(logger.warn).toHaveBeenCalledWith(
      'Stored setting could not be used; default applied',
      expect.objectContaining({ key: 'security.password.minimumLength' }),
    );
  });

  it('warns about a stored key the catalogue no longer declares', async () => {
    vi.mocked(repository.readAll).mockResolvedValue({ 'locale.retired': 'x' });

    await withTenant(() => reader.get(Settings.DEFAULT_LOCALE));

    expect(logger.warn).toHaveBeenCalledWith(
      'Stored setting is not in the catalogue',
      expect.objectContaining({ key: 'locale.retired' }),
    );
  });

  it('serves defaults rather than failing when settings cannot be read at all', async () => {
    vi.mocked(repository.readAll).mockRejectedValue(new Error('connection refused'));

    const value = await withTenant(() => reader.get(Settings.DEFAULT_LOCALE));

    // A request served with defaults is degraded; a request not served is an outage.
    expect(value).toBe('en');
    expect(logger.error).toHaveBeenCalled();
  });

  it('does not let one tenant’s cache entry answer for another', async () => {
    vi.mocked(repository.readAll).mockResolvedValue({ 'locale.default': 'ar' });
    await withTenant(() => reader.get(Settings.DEFAULT_LOCALE));

    vi.mocked(repository.readAll).mockResolvedValue({});
    const other = asId<TenantId>('01900000-0000-7000-8000-00000000000b');
    const value = await runWithContext(
      {
        tenantId: other,
        userId: null,
        roles: [],
        permissions: [],
        sessionId: null,
        correlationId: 'settings-test',
        permissionVersion: 0,
        locale: 'en',
      },
      () => reader.get(Settings.DEFAULT_LOCALE),
    );

    expect(value).toBe('en');
  });
});
