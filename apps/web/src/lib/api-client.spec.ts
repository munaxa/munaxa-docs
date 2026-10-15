import { afterEach, describe, expect, it, vi } from 'vitest';

import { DomainError } from '@edms/domain';

import { apiFetch } from './api-client';

/**
 * The reason behind a refusal survives the trip from the API — Hetzner Phase B, findings 3 and 4.
 *
 * The API names the cause (`reason`) beside the shared code. The client keeps it on the error so a
 * server action can say it in the person's language; dropping it is what turned a storage outage
 * into "a service is unavailable" and a quarantined file into "still being checked for malware".
 */

function answering(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))),
  );
}

async function refusal(): Promise<DomainError> {
  try {
    await apiFetch({ path: '/documents/d-1/content', method: 'POST' });
  } catch (error) {
    if (error instanceof DomainError) {
      return error;
    }
    throw error;
  }
  throw new Error('the call did not fail');
}

const PROBLEM = {
  type: 'https://docs.munaxa.com/errors/dependency-unavailable',
  title: 'Dependency unavailable',
  status: 503,
  code: 'DEPENDENCY_UNAVAILABLE',
  detail: 'File storage is temporarily unavailable. Try again shortly.',
  correlationId: 'c-1',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a refusal from the API', () => {
  it('keeps the reason and its values', async () => {
    answering(503, { ...PROBLEM, reason: 'STORAGE_UNAVAILABLE' });
    const error = await refusal();
    expect(error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(error.publicReason).toEqual({ reason: 'STORAGE_UNAVAILABLE' });

    answering(422, {
      ...PROBLEM,
      status: 422,
      code: 'UNSUPPORTED_CONTENT',
      reason: 'TOO_LARGE',
      reasonValues: { limit: '32 MiB' },
    });
    expect((await refusal()).publicReason).toEqual({
      reason: 'TOO_LARGE',
      values: { limit: '32 MiB' },
    });
  });

  it('has no reason when the API stated none, as an older API would answer', async () => {
    answering(503, PROBLEM);
    expect((await refusal()).publicReason).toBeNull();
  });

  it('drops a reason it does not know, and keeps the code and the rest', async () => {
    answering(503, { ...PROBLEM, reason: 'SOMETHING_NEW' });
    const error = await refusal();
    expect(error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(error.publicReason).toBeNull();
  });
});
