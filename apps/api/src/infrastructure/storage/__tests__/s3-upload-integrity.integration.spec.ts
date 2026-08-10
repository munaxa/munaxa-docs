import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { S3StorageAdapter } from '../s3.adapter';

/**
 * The guard on Phase 6.12's P0 — **cloud uploads that could never complete**.
 *
 * `UploadTargetInput.checksumSha256` has been on the storage port since Phase 3 and
 * `StorageService.createUploadSession` has always passed it. The S3 adapter **dropped it**, so the
 * object was written with no checksum; and `head()` never sent `x-amz-checksum-mode: ENABLED`, so
 * even an object that had one answered without it. `completeUploadSession` therefore read
 * `checksumSha256: null` and refused **every upload on every S3 and R2 deployment** with *"Storage
 * could not confirm the file's digest."* — while `LOCAL` worked, because it hashes the bytes
 * itself. A defect invisible on a single-server install and total on every cloud one.
 *
 * ## Why this is an integration test against a real store
 *
 * Because the property being asserted belongs to the store rather than to us. What makes the fix
 * *integrity* rather than bookkeeping is that S3 recomputes the digest of the bytes it receives and
 * **refuses the write** when it disagrees — so the digest stops being a claim the client made and
 * becomes a condition of the object existing. A unit test with a fake S3 would assert that our code
 * sends a header, which is exactly the assurance that was already missing.
 *
 * ADR-0007 is what makes this the only correct shape: §6 says bytes never pass through the API, so
 * the product cannot hash the object itself, and §2 makes the key *be* the digest, so a wrong digest
 * is a wrong key. The store enforcing it at write time satisfies both.
 *
 * Needs the MinIO from `infra/docker-compose.yml`.
 */

const ENDPOINT = process.env.STORAGE_ENDPOINT ?? 'http://127.0.0.1:9000';
const BUCKET = process.env.STORAGE_BUCKET ?? 'munaxa-docs';
const ACCESS_KEY = process.env.STORAGE_ACCESS_KEY_ID ?? 'edms-local';
const SECRET_KEY = process.env.STORAGE_SECRET_ACCESS_KEY ?? 'local-development-only';

/** A real, small PDF. Distinct per marker, so two objects are genuinely different bytes. */
function aPdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${marker}\n1 0 obj\n<<>>\nendobj\n`);
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let storage: S3StorageAdapter;
const written: string[] = [];

beforeAll(() => {
  storage = new S3StorageAdapter({
    driver: 'S3',
    bucket: BUCKET,
    region: 'us-east-1',
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    now: () => new Date(),
  } as never);
});

afterAll(async () => {
  for (const key of written) {
    await storage.delete(key).catch(() => undefined);
  }
});

/** A staging key of this run's own, so a re-run never collides with a previous one. */
function aKey(): string {
  return `phase-6-12/${randomUUID()}`;
}

describe('a presigned upload target with a digest', () => {
  it('stores the object and answers with the digest of the bytes that were stored', async () => {
    const content = aPdf('P612-HAPPY');
    const digest = sha256Hex(content);
    const key = aKey();
    written.push(key);

    const target = await storage.createUploadTarget({
      key,
      contentType: 'application/pdf',
      sizeBytes: content.length,
      checksumSha256: digest,
      expiresInSeconds: 300,
    });

    // The digest is returned to the client because it is *signed*: a presigned URL is a signature
    // over its headers, so the client has to send exactly these.
    expect(target.headers['x-amz-checksum-sha256']).toBe(
      Buffer.from(digest, 'hex').toString('base64'),
    );

    const put = await fetch(target.url, {
      method: target.method,
      headers: target.headers,
      body: content,
    });
    expect(put.status).toBeLessThan(300);

    // **The assertion the whole fix exists for.** Before it, this was `null` for every object in
    // every S3 deployment, and `completeUploadSession` refused the upload.
    const metadata = await storage.head(key);
    expect(metadata).not.toBeNull();
    expect(metadata?.checksumSha256).toBe(digest);
    expect(metadata?.sizeBytes).toBe(content.length);
  }, 60_000);

  /**
   * The digest is a **condition of the write**, not a label on it.
   *
   * Different bytes are sent to a target signed for one digest. The store recomputes SHA-256 over
   * what it received and refuses — which is what makes the persisted digest evidence about the
   * bytes rather than about the client's honesty.
   */
  it('is refused by the store when the bytes do not match the digest', async () => {
    const declared = aPdf('P612-DECLARED');
    const actual = aPdf('P612-SOMETHING-ELSE-ENTIRELY');
    const key = aKey();

    const target = await storage.createUploadTarget({
      key,
      contentType: 'application/pdf',
      sizeBytes: actual.length,
      checksumSha256: sha256Hex(declared),
      expiresInSeconds: 300,
    });

    const put = await fetch(target.url, {
      method: target.method,
      headers: target.headers,
      body: actual,
    });

    expect(put.status).toBeGreaterThanOrEqual(400);
    expect(await put.text()).toContain('ChecksumMismatch');
    // And nothing was stored, so a refused upload cannot become a usable document.
    expect(await storage.head(key)).toBeNull();
  }, 60_000);

  /**
   * And the client cannot simply rewrite the digest to match its own bytes.
   *
   * The header is inside the signature, so substituting one invalidates the URL — the same property
   * that makes the signed content type and content length meaningful.
   */
  it('is refused by the store when the client substitutes its own digest', async () => {
    const declared = aPdf('P612-SIGNED-FOR-THIS');
    const actual = aPdf('P612-TAMPERED');
    const key = aKey();

    const target = await storage.createUploadTarget({
      key,
      contentType: 'application/pdf',
      sizeBytes: actual.length,
      checksumSha256: sha256Hex(declared),
      expiresInSeconds: 300,
    });

    const put = await fetch(target.url, {
      method: target.method,
      headers: {
        ...target.headers,
        'x-amz-checksum-sha256': createHash('sha256').update(actual).digest('base64'),
      },
      body: actual,
    });

    expect(put.status).toBe(403);
    expect(await put.text()).toContain('SignatureDoesNotMatch');
    expect(await storage.head(key)).toBeNull();
  }, 60_000);

  /**
   * A target issued without a digest still works, and still carries no checksum.
   *
   * This is the path the audit checkpoint store and the export bundles use — they write through
   * `put`/`write` rather than through a presigned client PUT — and it is asserted so the fix is
   * shown to be additive rather than a new requirement on every caller.
   */
  it('signs no checksum header when the product has no digest to bind', async () => {
    const target = await storage.createUploadTarget({
      key: aKey(),
      contentType: 'application/pdf',
      sizeBytes: 64,
      expiresInSeconds: 300,
    });
    expect(target.headers['x-amz-checksum-sha256']).toBeUndefined();
  }, 60_000);
});
