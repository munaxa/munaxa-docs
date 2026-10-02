import { describe, expect, it, vi } from 'vitest';

import { StorageUnavailableError } from '../../core/errors/application-errors';
import { EcsTaskCredentialProvider, ecsCredentialsUrl } from './ecs-task-credentials';

/**
 * The ECS task role's credentials: one endpoint, read on first use, cached, refreshed before they
 * run out, and never long enough to sign something that outlives them.
 */

const RELATIVE_URI = '/v2/credentials/3f9c7a1e-task';
const START = new Date('2026-10-02T12:00:00.000Z');

function answer(expiration: Date, suffix = '1'): Record<string, string> {
  return {
    AccessKeyId: `ASIA-TEST-${suffix}`,
    SecretAccessKey: `secret-${suffix}`,
    Token: `token-${suffix}`,
    Expiration: expiration.toISOString(),
    RoleArn: 'arn:aws:iam::000000000000:role/test',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** What a `StorageUnavailableError` says went wrong; its message is the generic 503 text. */
async function reasonFor(pending: Promise<unknown>): Promise<string> {
  const failure = await pending.then(
    () => expect.unreachable('expected the credentials to be refused'),
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(StorageUnavailableError);
  return String((failure as StorageUnavailableError).details['reason']);
}

function inOneHour(from: Date): Date {
  return new Date(from.getTime() + 60 * 60 * 1000);
}

function provider(fetch: typeof globalThis.fetch, now: () => Date = () => START) {
  return new EcsTaskCredentialProvider({ relativeUri: RELATIVE_URI, now, fetch });
}

describe('the ECS credential endpoint', () => {
  it('is the ECS host plus the relative URI ECS set, and nothing else', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(json(answer(inOneHour(START)))),
    );
    await provider(fetch).resolve(300);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`http://169.254.170.2${RELATIVE_URI}`);
    expect(init?.method).toBe('GET');
    // A redirect is the one way the request could end up somewhere other than the task's endpoint.
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['no leading slash', 'v2/credentials/x'],
    ['a protocol-relative host', '//attacker.example/v2/credentials'],
    ['an empty value', ''],
  ])('refuses a relative URI with %s', (_label, uri) => {
    expect(() => ecsCredentialsUrl(uri)).toThrowError(StorageUnavailableError);
  });

  it.each([
    ['a userinfo-and-host suffix', '/@attacker.example/'],
    ['a port', ':8080/v2/credentials'],
  ])('never resolves %s to another host', (_label, uri) => {
    // Either refused outright, or kept as a path on the ECS host — never another host or port.
    let url: URL | null = null;
    try {
      url = new URL(ecsCredentialsUrl(uri));
    } catch (error) {
      expect(error).toBeInstanceOf(StorageUnavailableError);
    }
    if (url !== null) {
      expect(url.host).toBe('169.254.170.2');
      expect(url.username).toBe('');
    }
  });
});

describe('reading the credentials', () => {
  it('parses AccessKeyId, SecretAccessKey and Token into signing credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(json(answer(inOneHour(START)))),
    );
    await expect(provider(fetch).resolve(300)).resolves.toEqual({
      accessKeyId: 'ASIA-TEST-1',
      secretAccessKey: 'secret-1',
      sessionToken: 'token-1',
    });
  });

  it.each(['AccessKeyId', 'SecretAccessKey', 'Token', 'Expiration'])(
    'refuses an answer without %s',
    async (field) => {
      const body: Record<string, string> = answer(inOneHour(START));
      delete body[field];
      const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(json(body)));
      await expect(provider(fetch).resolve(300)).rejects.toBeInstanceOf(StorageUnavailableError);
    },
  );

  it('refuses an Expiration that is not a date', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(json({ ...answer(inOneHour(START)), Expiration: 'soon' })),
    );
    await expect(provider(fetch).resolve(300)).rejects.toBeInstanceOf(StorageUnavailableError);
  });
});

describe('caching and refreshing', () => {
  it('serves later requests from the cache while the credentials have time left', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(json(answer(inOneHour(START)))),
    );
    const credentials = provider(fetch);
    await credentials.resolve(300);
    await credentials.resolve(300);
    await credentials.resolve(0);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fetches again before the cached credentials expire, not after', async () => {
    let now = START;
    let call = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      call += 1;
      return Promise.resolve(json(answer(inOneHour(now), String(call))));
    });
    const credentials = provider(fetch, () => now);
    expect((await credentials.resolve(0)).accessKeyId).toBe('ASIA-TEST-1');

    // 54 minutes in: six minutes left, more than the five-minute margin — still cached.
    now = new Date(START.getTime() + 54 * 60 * 1000);
    expect((await credentials.resolve(0)).accessKeyId).toBe('ASIA-TEST-1');

    // 56 minutes in: four minutes left, inside the margin — refreshed while still valid.
    now = new Date(START.getTime() + 56 * 60 * 1000);
    expect((await credentials.resolve(0)).accessKeyId).toBe('ASIA-TEST-2');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refreshes when the cached credentials would expire before a presigned URL does', async () => {
    let now = START;
    let call = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      call += 1;
      return Promise.resolve(json(answer(inOneHour(now), String(call))));
    });
    const credentials = provider(fetch, () => now);
    await credentials.resolve(0);

    // 40 minutes in: twenty minutes left. Enough for a one-minute URL plus the margin, not for a
    // twenty-minute one — so that one is signed with fresh credentials instead.
    now = new Date(START.getTime() + 40 * 60 * 1000);
    expect((await credentials.resolve(60)).accessKeyId).toBe('ASIA-TEST-1');
    expect((await credentials.resolve(1200)).accessKeyId).toBe('ASIA-TEST-2');
  });

  it('refuses to sign something that would outlive even fresh credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(json(answer(new Date(START.getTime() + 10 * 60 * 1000)))),
    );
    expect(await reasonFor(provider(fetch).resolve(3600))).toMatch(/expire too soon/);
  });

  it('sends one request for many concurrent callers', async () => {
    let release: (response: Response) => void = () => undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const credentials = provider(fetch);
    const waiting = Promise.all([
      credentials.resolve(300),
      credentials.resolve(60),
      credentials.resolve(0),
    ]);
    release(json(answer(inOneHour(START))));
    const resolved = await waiting;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Set(resolved.map((c) => c.accessKeyId))).toEqual(new Set(['ASIA-TEST-1']));
  });

  it('retries on the next request after a failed refresh, rather than keeping the failure', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValueOnce(json(answer(inOneHour(START))));
    const credentials = provider(fetch);

    await expect(credentials.resolve(0)).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(credentials.resolve(0)).resolves.toMatchObject({ accessKeyId: 'ASIA-TEST-1' });
  });
});

describe('when the endpoint fails', () => {
  it('reports a network failure as storage being unavailable', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    expect(await reasonFor(provider(fetch).resolve(0))).toMatch(/did not answer/);
  });

  it('reports a non-success status without the response body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('body-that-must-not-leak', { status: 403 })),
    );
    const reason = await reasonFor(provider(fetch).resolve(0));

    expect(reason).toMatch(/answered 403/);
    expect(reason).not.toContain('body-that-must-not-leak');
  });

  it('reports a body that is not JSON', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('<html>', { status: 200 })),
    );
    expect(await reasonFor(provider(fetch).resolve(0))).toMatch(/not JSON/);
  });

  it('never puts a credential it received in an error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(json({ AccessKeyId: 'ASIA-LEAK', SecretAccessKey: 'secret-leak' })),
    );
    const failure = await provider(fetch)
      .resolve(0)
      .catch((error: unknown) => error);
    const said = JSON.stringify({
      message: (failure as StorageUnavailableError).message,
      details: (failure as StorageUnavailableError).details,
    });

    expect(said).not.toContain('ASIA-LEAK');
    expect(said).not.toContain('secret-leak');
  });
});
