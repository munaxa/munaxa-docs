import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StorageDriver, TenantStatus, type TenantId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { TenantPlacement } from '../../../core/tenancy/tenant-placement';
import type { TenantRegistry } from '../../../core/tenancy/tenant-registry.port';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import type { StoragePort } from '../../../ports/storage.port';
import { TenantScopedStorage } from '../../tenancy/tenant-scoped-storage';
import { LocalStorageAdapter } from '../local.adapter';
import { S3StorageAdapter } from '../s3.adapter';
import { decodeTransferToken } from '../local-transfer-token';
import { type S3CompatibleServer, startS3CompatibleServer } from './s3-compatible-server';

/**
 * The storage port, against real backends, through the tenant scoping.
 *
 * This is the first suite in the product to run `TenantScopedStorage` over something that actually
 * stores bytes rather than over a spy. Phase 2.5 built the scoping and asserted it against a double,
 * which could establish that the wrapper prefixes and unprefixes — but not that a prefixed key is a
 * key a real backend accepts, nor that two tenants writing the same logical key end up with two
 * objects. Both of those are properties of the adapter and the store together, and only this can ask
 * about them.
 *
 * Both drivers run the same assertions. That is the claim the storage port makes — "adding a
 * provider is an adapter and a configuration value, no use-case changes" — and a suite that
 * exercised one driver would be a suite in which that claim is an aspiration.
 *
 * There is no MinIO here and no network. The S3 side runs against an in-process store that
 * re-derives every signature from the request as received, so an adapter that signs one URL and
 * emits another fails, exactly as it would at AWS. `sigv4.spec.ts` is what ties the algorithm to
 * AWS's own published vectors; this ties the adapter to the algorithm.
 */

const ACME = asId<TenantId>(uuidv7());
const RIVAL = asId<TenantId>(uuidv7());

const CREDENTIALS = {
  accessKeyId: 'storage-suite-key',
  secretAccessKey: 'storage-suite-secret-not-a-real-credential',
  region: 'eu-west-2',
};
const BUCKET = 'munaxa-docs-test';

const FIXED_NOW = new Date('2026-08-04T09:00:00.000Z');
const now = (): Date => new Date(FIXED_NOW);

/** The bytes and the key a content-addressed store would give them. */
const CONTENT = Buffer.from('Procedure QA-014, revision 3.\n');
const DIGEST = createHash('sha256').update(CONTENT).digest('hex');
const KEY = `blobs/${DIGEST.slice(0, 2)}/${DIGEST.slice(2, 4)}/${DIGEST}`;

function placementFor(id: TenantId, slug: string): TenantPlacement {
  return {
    id,
    slug,
    status: TenantStatus.ACTIVE,
    database: { url: 'postgresql://unused/unused' },
    storage: { driver: StorageDriver.LOCAL, container: BUCKET, prefix: `tenants/${slug}` },
    search: { index: slug },
  };
}

const REGISTRY: TenantRegistry = {
  bySlug: (slug) =>
    Promise.resolve(
      slug === 'acme'
        ? placementFor(ACME, 'acme')
        : slug === 'rival'
          ? placementFor(RIVAL, 'rival')
          : null,
    ),
  byId: (tenantId) =>
    Promise.resolve(
      tenantId === ACME
        ? placementFor(ACME, 'acme')
        : tenantId === RIVAL
          ? placementFor(RIVAL, 'rival')
          : null,
    ),
  all: () => Promise.resolve([placementFor(ACME, 'acme'), placementFor(RIVAL, 'rival')]),
};

function contextFor(tenantId: TenantId): RequestContext {
  return {
    tenantId,
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId: 'storage-adapters',
    permissionVersion: 1,
    locale: 'en',
  };
}

function as<T>(tenantId: TenantId, work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(tenantId), work);
}

let root: string;
let s3: S3CompatibleServer;
let localAdapter: LocalStorageAdapter;
let s3Adapter: S3StorageAdapter;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'munaxa-storage-'));
  s3 = await startS3CompatibleServer(CREDENTIALS, BUCKET);
  localAdapter = new LocalStorageAdapter({
    root,
    transferUrl: 'http://localhost:3001/api/v1/storage/local',
    signingSecret: 'a-deployment-secret-of-at-least-thirty-two-characters',
    now,
  });
  s3Adapter = new S3StorageAdapter({
    driver: 'S3',
    bucket: BUCKET,
    region: CREDENTIALS.region,
    endpoint: s3.url,
    // Path style, which is what MinIO and most self-hosted stores use — and what makes the bucket
    // visible in the path the suite asserts on.
    forcePathStyle: true,
    credentials: CREDENTIALS,
    now,
  });
});

afterAll(async () => {
  await s3.close();
  await rm(root, { recursive: true, force: true });
});

/** Puts bytes where a browser would have put them, for each driver. */
async function transfer(driver: 'LOCAL' | 'S3', url: string, body: Buffer): Promise<void> {
  if (driver === 'S3') {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(body.length) },
      body: new Uint8Array(body),
    });
    expect(response.status).toBe(200);
    return;
  }
  // The `LOCAL` driver's transfer endpoint, reduced to what it does: verify the capability, write
  // to a partial name, rename into place. The controller adds streaming and a byte ceiling; the
  // part this suite is about is that the URL the adapter minted names the right key.
  const token = new URL(url).searchParams.get('token') ?? '';
  const decoded = decodeTransferToken(
    'a-deployment-secret-of-at-least-thirty-two-characters',
    token,
    'PUT',
    now(),
  );
  expect('grant' in decoded).toBe(true);
  if (!('grant' in decoded)) {
    return;
  }
  await localAdapter.beginWrite(decoded.grant.key);
  await writeFile(localAdapter.partialPathFor(decoded.grant.key), body);
  await localAdapter.finishWrite(decoded.grant.key);
}

const DRIVERS: readonly ['LOCAL' | 'S3', () => StoragePort][] = [
  ['LOCAL', () => localAdapter],
  ['S3', () => s3Adapter],
];

describe.each(DRIVERS)('the %s driver, through the tenant scoping', (driver, adapterOf) => {
  const scoped = (): StoragePort => new TenantScopedStorage(adapterOf(), REGISTRY);

  it('stores and reads back what it was given, and reports the digest the bytes actually have', async () => {
    const key = `${KEY}-${driver}-roundtrip`;
    await as(ACME, async () => {
      const target = await scoped().createUploadTarget({
        key,
        contentType: 'application/pdf',
        sizeBytes: CONTENT.length,
        expiresInSeconds: 300,
      });
      // The key comes back *unprefixed*: what a document row stores is `blobs/…`, not
      // `tenants/acme/blobs/…`. The prefix says where the bytes live, not what the blob is.
      expect(target.key).toBe(key);
      expect(target.expiresAt).toEqual(new Date(FIXED_NOW.getTime() + 300_000));

      await transfer(driver, target.url, CONTENT);

      const metadata = await scoped().completeUpload(key, []);
      expect(metadata.key).toBe(key);
      expect(metadata.sizeBytes).toBe(CONTENT.length);
      // The store's own answer, not the client's claim. An upload that completed with different
      // bytes than it announced is caught by comparing these, and this is the half that has to be
      // true for that comparison to mean anything.
      expect(metadata.checksumSha256).toBe(DIGEST);
    });
  });

  it('puts the tenant prefix on the object the backend actually holds', async () => {
    const key = `${KEY}-${driver}-prefix`;
    await as(ACME, async () => {
      const target = await scoped().createUploadTarget({
        key,
        contentType: 'application/pdf',
        sizeBytes: CONTENT.length,
        expiresInSeconds: 300,
      });
      await transfer(driver, target.url, CONTENT);
    });

    if (driver === 'LOCAL') {
      // On disk, under the tenant's directory — and nowhere else.
      expect(await readFile(join(root, 'tenants/acme', key))).toEqual(CONTENT);
    } else {
      expect(s3.objects.has(`tenants/acme/${key}`)).toBe(true);
      expect(s3.objects.has(key)).toBe(false);
    }
  });

  it('keeps two tenants apart when they store identical bytes under one key', async () => {
    // The case content addressing makes ordinary: two customers holding the same standard form
    // compute the same digest and therefore the same key. Dedupe must not cross the boundary, and
    // here it cannot — the prefix makes them two objects.
    const key = `${KEY}-${driver}-shared`;
    const acmeBytes = Buffer.from('Acme copy.\n');
    const rivalBytes = Buffer.from('Rival copy — different content, same key.\n');

    for (const [tenant, bytes] of [
      [ACME, acmeBytes],
      [RIVAL, rivalBytes],
    ] as const) {
      await as(tenant, async () => {
        const target = await scoped().createUploadTarget({
          key,
          contentType: 'application/pdf',
          sizeBytes: bytes.length,
          expiresInSeconds: 300,
        });
        await transfer(driver, target.url, bytes);
      });
    }

    await as(ACME, async () => {
      expect((await scoped().head(key))?.sizeBytes).toBe(acmeBytes.length);
    });
    await as(RIVAL, async () => {
      expect((await scoped().head(key))?.sizeBytes).toBe(rivalBytes.length);
    });
  });

  it('answers null for an object this tenant does not have, even when another tenant does', async () => {
    const key = `${KEY}-${driver}-only-acme`;
    await as(ACME, async () => {
      const target = await scoped().createUploadTarget({
        key,
        contentType: 'application/pdf',
        sizeBytes: CONTENT.length,
        expiresInSeconds: 300,
      });
      await transfer(driver, target.url, CONTENT);
      expect(await scoped().head(key)).not.toBeNull();
    });
    await as(RIVAL, async () => {
      expect(await scoped().head(key)).toBeNull();
    });
  });

  it('refuses a key that traverses out of the tenant, before the backend ever sees it', async () => {
    await as(ACME, async () => {
      await expect(scoped().head('../rival/secrets')).rejects.toThrow(/traverse/i);
      await expect(scoped().head('blobs/../../rival/secrets')).rejects.toThrow(/traverse/i);
    });
  });

  it('refuses a key that already carries the prefix, rather than nesting it', async () => {
    await as(ACME, async () => {
      await expect(scoped().head('tenants/acme/blobs/x')).rejects.toThrow(/tenant prefix/i);
    });
  });

  it('refuses to act for a tenant this deployment does not serve', async () => {
    await as(asId<TenantId>(uuidv7()), async () => {
      await expect(scoped().head(KEY)).rejects.toThrow();
    });
  });

  it('copies within a tenant and never between two', async () => {
    const from = `${KEY}-${driver}-copy-source`;
    const to = `${KEY}-${driver}-copy-target`;
    await as(ACME, async () => {
      const target = await scoped().createUploadTarget({
        key: from,
        contentType: 'application/pdf',
        sizeBytes: CONTENT.length,
        expiresInSeconds: 300,
      });
      await transfer(driver, target.url, CONTENT);
      await scoped().copy(from, to);
      expect((await scoped().head(to))?.sizeBytes).toBe(CONTENT.length);
    });
    // Both ends of a copy are scoped, so there is no spelling of a key that reaches out of the
    // tenant — the destination Rival would need is one the scoping refuses outright.
    await as(RIVAL, async () => {
      expect(await scoped().head(to)).toBeNull();
    });
  });

  it('deletes, and is content for a second delete to find nothing', async () => {
    const key = `${KEY}-${driver}-delete`;
    await as(ACME, async () => {
      const target = await scoped().createUploadTarget({
        key,
        contentType: 'application/pdf',
        sizeBytes: CONTENT.length,
        expiresInSeconds: 300,
      });
      await transfer(driver, target.url, CONTENT);
      await scoped().delete(key);
      expect(await scoped().head(key)).toBeNull();
      // Retention retries after a failure; the retry must succeed rather than raise.
      await expect(scoped().delete(key)).resolves.toBeUndefined();
    });
  });

  it('issues a download URL that expires and names the file it is for', async () => {
    const key = `${KEY}-${driver}-download`;
    await as(ACME, async () => {
      const target = await scoped().createUploadTarget({
        key,
        contentType: 'application/pdf',
        sizeBytes: CONTENT.length,
        expiresInSeconds: 300,
      });
      await transfer(driver, target.url, CONTENT);
      const signed = await scoped().createDownloadUrl(key, {
        expiresInSeconds: 120,
        filename: 'QA-014 Rev 3.pdf',
      });
      expect(signed.expiresAt).toEqual(new Date(FIXED_NOW.getTime() + 120_000));
      expect(signed.url).toMatch(/^http:\/\//);
    });
  });
});

describe('the S3 driver specifically', () => {
  const scoped = (): StoragePort => new TenantScopedStorage(s3Adapter, REGISTRY);

  it('serves the bytes to a browser holding the signed URL, with the disposition it asked for', async () => {
    const key = `${KEY}-signed-get`;
    await as(ACME, async () => {
      const target = await scoped().createUploadTarget({
        key,
        contentType: 'application/pdf',
        sizeBytes: CONTENT.length,
        expiresInSeconds: 300,
      });
      await transfer('S3', target.url, CONTENT);

      const signed = await scoped().createDownloadUrl(key, {
        expiresInSeconds: 120,
        filename: 'QA-014.pdf',
      });
      const response = await fetch(signed.url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe('attachment; filename="QA-014.pdf"');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(CONTENT);
    });
  });

  it('stops verifying the moment the URL is edited to name another object', async () => {
    // The property the whole signing exercise exists for. A signed URL for Acme's object, with the
    // path repointed at Rival's, is refused by the store rather than served.
    await as(ACME, async () => {
      const signed = await scoped().createDownloadUrl(`${KEY}-signed-get`, {
        expiresInSeconds: 120,
      });
      const tampered = signed.url.replace('tenants/acme', 'tenants/rival');
      expect((await fetch(tampered)).status).toBe(403);
    });
  });

  it('stops verifying when the signature itself is altered', async () => {
    await as(ACME, async () => {
      const signed = await scoped().createDownloadUrl(`${KEY}-signed-get`, {
        expiresInSeconds: 120,
      });
      const url = new URL(signed.url);
      const signature = url.searchParams.get('X-Amz-Signature') ?? '';
      url.searchParams.set(
        'X-Amz-Signature',
        signature.replace(/.$/, (last) => (last === 'a' ? 'b' : 'a')),
      );
      expect((await fetch(url)).status).toBe(403);
    });
  });

  it('authorises its own control calls with a header rather than a query signature', () => {
    // A header signature is not in the URL and therefore not in a proxy log or a referrer. Only the
    // two calls a browser makes are presigned.
    const heads = s3.requests.filter((request) => request.method === 'HEAD');
    expect(heads.length).toBeGreaterThan(0);
    expect(heads.every((request) => request.authorized === 'header')).toBe(true);
  });

  it('offers a resumable transfer for a large upload, and a single PUT for a small one', async () => {
    await as(ACME, async () => {
      const small = await scoped().createUploadTarget({
        key: `${KEY}-small`,
        contentType: 'application/pdf',
        sizeBytes: 1024,
        expiresInSeconds: 300,
      });
      expect(small.parts).toBeUndefined();

      const large = await scoped().createUploadTarget({
        key: `${KEY}-large`,
        contentType: 'application/pdf',
        sizeBytes: 200 * 1024 * 1024,
        expiresInSeconds: 300,
        multipart: true,
      });
      expect(large.parts?.length).toBe(13);
      // Every part carries the store's handle for the session, so completion can name it without
      // the API holding state between two requests.
      expect(large.parts?.every((part) => part.uploadId !== undefined)).toBe(true);
    });
  });
});

describe('the LOCAL driver specifically', () => {
  const scoped = (): StoragePort => new TenantScopedStorage(localAdapter, REGISTRY);

  it('never leaves a half-written file where a complete one should be', async () => {
    // Content-addressed storage makes a truncated blob worse than a missing one: its bytes do not
    // match the digest that names it, so every later integrity check reports it as tampering.
    const key = `${KEY}-abandoned`;
    await as(ACME, async () => {
      const target = await scoped().createUploadTarget({
        key,
        contentType: 'application/pdf',
        sizeBytes: CONTENT.length,
        expiresInSeconds: 300,
      });
      const grant = decodeTransferToken(
        'a-deployment-secret-of-at-least-thirty-two-characters',
        new URL(target.url).searchParams.get('token') ?? '',
        'PUT',
        now(),
      );
      expect('grant' in grant).toBe(true);
      if (!('grant' in grant)) {
        return;
      }
      await localAdapter.beginWrite(grant.grant.key);
      await writeFile(localAdapter.partialPathFor(grant.grant.key), CONTENT.subarray(0, 4));
      await localAdapter.abandonWrite(grant.grant.key);

      expect(await scoped().head(key)).toBeNull();
    });
  });

  it('refuses a path that escapes the storage root even if scoping were bypassed', () => {
    // Belt and braces on purpose: the wrapper checks the key as a string, this checks the resolved
    // path. For a filesystem there is no version of "wrote outside the root" that is merely untidy.
    expect(() => localAdapter.pathFor(`../../${randomUUID()}`)).toThrow(/outside storage/i);
  });
});
