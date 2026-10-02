import { describe, expect, it, vi } from 'vitest';

import { StorageUnavailableError } from '../../core/errors/application-errors';
import type { SigningCredentialProvider } from './ecs-task-credentials';
import { S3StorageAdapter, type S3AdapterOptions } from './s3.adapter';

/**
 * The adapter's credentials can be a fixed key pair or a provider of temporary ones (the ECS task
 * role). Temporary credentials only work if their session token travels with every signature — in
 * the query of a presigned URL and in the headers of a control call — and a provider is asked for
 * credentials that outlive what is being signed.
 */

const NOW = new Date('2026-10-02T12:00:00.000Z');

function adapter(
  credentials: S3AdapterOptions['credentials'],
  fetch: typeof globalThis.fetch = () => Promise.resolve(new Response(null, { status: 404 })),
): S3StorageAdapter {
  return new S3StorageAdapter({
    driver: 'S3',
    bucket: 'edms-test',
    region: 'me-central-1',
    endpoint: 'https://s3.me-central-1.amazonaws.com',
    forcePathStyle: false,
    credentials,
    now: () => NOW,
    fetch,
  });
}

function temporary(): SigningCredentialProvider & { resolve: ReturnType<typeof vi.fn> } {
  return {
    resolve: vi.fn((_validForSeconds: number) =>
      Promise.resolve({
        accessKeyId: 'ASIA-TEST',
        secretAccessKey: 'secret',
        sessionToken: 'token-from-the-task-role',
      }),
    ),
  };
}

describe('signing with credentials from a provider', () => {
  it('puts the session token in a presigned download URL', async () => {
    const credentials = temporary();
    const signed = await adapter(credentials).createDownloadUrl('acme/doc.pdf', {
      expiresInSeconds: 300,
    });

    const url = new URL(signed.url);
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('token-from-the-task-role');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^ASIA-TEST\//);
    // Asked for credentials that will still be valid when the URL is redeemed.
    expect(credentials.resolve).toHaveBeenCalledWith(300);
  });

  it('puts the session token in a presigned upload URL', async () => {
    const credentials = temporary();
    const target = await adapter(credentials).createUploadTarget({
      key: 'acme/doc.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      expiresInSeconds: 900,
    });

    expect(new URL(target.url).searchParams.get('X-Amz-Security-Token')).toBe(
      'token-from-the-task-role',
    );
    expect(credentials.resolve).toHaveBeenCalledWith(900);
  });

  it('sends the session token as a header on a control call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    );
    await adapter(temporary(), fetch).head('acme/doc.pdf');

    const headers = fetch.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['x-amz-security-token']).toBe('token-from-the-task-role');
    expect(headers['authorization']).toMatch(/Credential=ASIA-TEST\//);
  });

  it('resolves credentials again for each operation, so rotated ones are picked up', async () => {
    const credentials = temporary();
    const s3 = adapter(credentials);
    await s3.createDownloadUrl('acme/a.pdf', { expiresInSeconds: 60 });
    await s3.createDownloadUrl('acme/b.pdf', { expiresInSeconds: 60 });

    expect(credentials.resolve).toHaveBeenCalledTimes(2);
  });

  it('signs nothing and sends nothing when the provider cannot supply credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const failing: SigningCredentialProvider = {
      resolve: () => Promise.reject(new StorageUnavailableError('no credentials')),
    };
    const s3 = adapter(failing, fetch);

    await expect(
      s3.createDownloadUrl('acme/doc.pdf', { expiresInSeconds: 60 }),
    ).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(s3.head('acme/doc.pdf')).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('signing with a fixed key pair', () => {
  it('is unchanged: no session token unless one is configured', async () => {
    const signed = await adapter({
      accessKeyId: 'AKIA-STATIC',
      secretAccessKey: 'static-secret',
    }).createDownloadUrl('acme/doc.pdf', { expiresInSeconds: 300 });

    const url = new URL(signed.url);
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AKIA-STATIC\//);
    expect(url.searchParams.has('X-Amz-Security-Token')).toBe(false);
    expect(signed.expiresAt).toEqual(new Date(NOW.getTime() + 300 * 1000));
  });
});
