import { describe, expect, it } from 'vitest';

import { StorageDriver, TenantStatus } from '@edms/domain';

import { runWithContext, type RequestContext } from '../../core/tenancy/tenant-context';
import type { TenantPlacement } from '../../core/tenancy/tenant-placement';
import type { TenantRegistry } from '../../core/tenancy/tenant-registry.port';
import type { StoragePort, UploadTarget } from '../../ports/storage.port';
import { TenantScopedStorage } from './tenant-scoped-storage';

/**
 * The storage isolation layer.
 *
 * A `StorageKey` is a string, so the type system cannot stop a use case from addressing another
 * tenant's bytes — and one such key, once, is a breach. These are the tests for the layer that makes it
 * impossible, and they are unit tests on purpose: the property holds regardless of which vendor adapter
 * is underneath, so it should be provable without one.
 */

const ACME = '019489f0-0000-7000-8000-0000000000a1';
const RIVAL = '019489f0-0000-7000-8000-0000000000b2';

function placement(id: string, prefix: string): TenantPlacement {
  return {
    id,
    slug: prefix,
    status: TenantStatus.ACTIVE,
    database: { url: 'postgresql://app@localhost:5432/edms' },
    storage: { driver: StorageDriver.S3, container: 'shared-bucket', prefix },
    search: { index: prefix },
  };
}

const registry: TenantRegistry = {
  bySlug: () => Promise.resolve(null),
  byId: (id) =>
    Promise.resolve(
      id === ACME ? placement(ACME, 'acme') : id === RIVAL ? placement(RIVAL, 'rival') : null,
    ),
  all: () => Promise.resolve([]),
};

function contextFor(tenantId: string): RequestContext {
  return {
    tenantId: tenantId as RequestContext['tenantId'],
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId: 'storage-scope',
    permissionVersion: 0,
    locale: 'en',
  };
}

/** Records what the adapter underneath was actually asked for. */
function spyAdapter(answerKey?: string): StoragePort & { keys: string[] } {
  const keys: string[] = [];
  const target = (key: string): UploadTarget => ({
    key: answerKey ?? key,
    url: 'https://example.test/upload',
    method: 'PUT',
    headers: {},
    expiresAt: new Date('2026-01-01T00:00:00Z'),
  });
  return {
    keys,
    driver: StorageDriver.S3,
    createUploadTarget: (input) => {
      keys.push(input.key);
      return Promise.resolve(target(input.key));
    },
    completeUpload: (key) => {
      keys.push(key);
      return Promise.resolve({
        key: answerKey ?? key,
        sizeBytes: 1,
        contentType: 'application/pdf',
        checksumSha256: null,
        lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
      });
    },
    createDownloadUrl: (key) => {
      keys.push(key);
      return Promise.resolve({
        url: 'https://example.test/download',
        expiresAt: new Date('2026-01-01T00:00:00Z'),
      });
    },
    head: (key) => {
      keys.push(key);
      return Promise.resolve(null);
    },
    copy: (from, to) => {
      keys.push(from, to);
      return Promise.resolve();
    },
    delete: (key) => {
      keys.push(key);
      return Promise.resolve();
    },
  };
}

function upload(key: string) {
  return {
    key,
    contentType: 'application/pdf',
    sizeBytes: 12,
    expiresInSeconds: 60,
  };
}

describe('scoping storage to the ambient tenant', () => {
  it('puts the tenant prefix on every key the adapter is given', async () => {
    const adapter = spyAdapter();
    const storage = new TenantScopedStorage(adapter, registry);

    await runWithContext(contextFor(ACME), async () => {
      await storage.createUploadTarget(upload('revisions/2026/report.pdf'));
      await storage.createDownloadUrl('revisions/2026/report.pdf', { expiresInSeconds: 60 });
      await storage.head('revisions/2026/report.pdf');
      await storage.delete('revisions/2026/report.pdf');
    });

    expect(adapter.keys).toEqual(Array(4).fill('acme/revisions/2026/report.pdf'));
  });

  it('gives two tenants different keys for the same logical object', async () => {
    // The whole point. Two customers naming the same path is the ordinary case, not the exotic one.
    const adapter = spyAdapter();
    const storage = new TenantScopedStorage(adapter, registry);

    await runWithContext(contextFor(ACME), () => storage.head('policies/qa.pdf'));
    await runWithContext(contextFor(RIVAL), () => storage.head('policies/qa.pdf'));

    expect(adapter.keys).toEqual(['acme/policies/qa.pdf', 'rival/policies/qa.pdf']);
  });

  it('strips the prefix on the way back out', async () => {
    // A document row stores `revisions/…`, not `acme/revisions/…`: the prefix is where the bytes live,
    // not part of what the document is, so a tenant moving container does not rewrite its rows.
    const storage = new TenantScopedStorage(spyAdapter(), registry);

    const target = await runWithContext(contextFor(ACME), () =>
      storage.createUploadTarget(upload('revisions/report.pdf')),
    );

    expect(target.key).toBe('revisions/report.pdf');
  });

  it('refuses a key that traverses out of the tenant', async () => {
    // For an object store `..` is a strange key. For the filesystem adapter an on-premise install
    // runs, it is a path out of the tenant's directory — so the check lives where every driver
    // inherits it, not in the one adapter where it happens to be exploitable.
    const adapter = spyAdapter();
    const storage = new TenantScopedStorage(adapter, registry);

    await runWithContext(contextFor(ACME), async () => {
      await expect(storage.head('../rival/policies/qa.pdf')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(storage.head('revisions/../../rival/x.pdf')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    expect(adapter.keys).toEqual([]);
  });

  it('refuses a key that already carries a tenant prefix', async () => {
    // Including its *own*: `acme/acme/x` is a second spelling of one object, and a caller evidently
    // holding a scoped key is better told than quietly served a duplicate location.
    const storage = new TenantScopedStorage(spyAdapter(), registry);

    await runWithContext(contextFor(ACME), async () => {
      await expect(storage.head('acme/policies/qa.pdf')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });

  it('refuses an empty key', async () => {
    const storage = new TenantScopedStorage(spyAdapter(), registry);
    await runWithContext(contextFor(ACME), async () => {
      await expect(storage.head('')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(storage.head('/')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  it('scopes both ends of a copy', async () => {
    // So a copy cannot be the way bytes leave a tenant.
    const adapter = spyAdapter();
    const storage = new TenantScopedStorage(adapter, registry);

    await runWithContext(contextFor(ACME), () => storage.copy('a/x.pdf', 'b/x.pdf'));

    expect(adapter.keys).toEqual(['acme/a/x.pdf', 'acme/b/x.pdf']);
  });

  it('refuses an answer about an object outside the tenant', async () => {
    // An adapter that answered about somebody else's object is a bug in the adapter, and passing the
    // key to a caller who cannot tell would turn it into a leak.
    const storage = new TenantScopedStorage(spyAdapter('rival/policies/qa.pdf'), registry);

    await runWithContext(contextFor(ACME), async () => {
      await expect(storage.createUploadTarget(upload('policies/qa.pdf'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });

  it('refuses to act with no tenant context at all', async () => {
    const storage = new TenantScopedStorage(spyAdapter(), registry);
    await expect(storage.head('policies/qa.pdf')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('refuses a tenant this deployment no longer serves', async () => {
    const storage = new TenantScopedStorage(spyAdapter(), registry);
    await runWithContext(contextFor('019489f0-0000-7000-8000-0000000000ff'), async () => {
      await expect(storage.head('policies/qa.pdf')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  it('reports the driver underneath, so nothing above has to know it was wrapped', () => {
    // A use case asks the port which driver it is talking to — for an upload-size limit, for a
    // multipart threshold. The wrapper is not a driver, so it answers with the one it wraps.
    expect(new TenantScopedStorage(spyAdapter(), registry).driver).toBe(StorageDriver.S3);
  });
});
