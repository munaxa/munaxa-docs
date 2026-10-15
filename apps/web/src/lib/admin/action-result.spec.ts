import { describe, expect, it } from 'vitest';

import { DomainError, ErrorCode } from '@edms/domain';
import { ar, en } from '@edms/i18n';

import { toActionResult } from './action-result';

/**
 * What a failed write tells the screen — Hetzner Phase B, findings 3 and 4.
 *
 * A code is shared by unlike causes, and the screens show `detail` when it is set and the code's
 * sentence otherwise. Before, `detail` was kept only for `VALIDATION_FAILED`, so a storage outage
 * read "A service this action needs is unavailable." with no advice to try again, and a
 * quarantined file read "This file is still being checked for malware.".
 */

const storageDown = new DomainError(
  ErrorCode.DEPENDENCY_UNAVAILABLE,
  'File storage is temporarily unavailable. Try again shortly.',
  { correlationId: 'c-1' },
  { reason: 'STORAGE_UNAVAILABLE' },
);

const quarantined = new DomainError(
  ErrorCode.CONTENT_NOT_SCANNED,
  'This file failed its integrity check and cannot be opened.',
  { correlationId: 'c-2' },
  { reason: 'INTEGRITY_FAILED' },
);

describe('a refusal with a stated reason', () => {
  it('keeps the retry advice when storage is unavailable', () => {
    expect(toActionResult(storageDown, 'en')).toEqual({
      ok: false,
      code: 'DEPENDENCY_UNAVAILABLE',
      detail: en.errorReason.STORAGE_UNAVAILABLE,
    });
    expect(en.errorReason.STORAGE_UNAVAILABLE).toMatch(/try again/i);
  });

  it('says a quarantined file failed its integrity check, not that it is being scanned', () => {
    const result = toActionResult(quarantined, 'en');
    expect(result).toMatchObject({ code: 'CONTENT_NOT_SCANNED' });
    expect(result.ok === false && result.detail).toBe(en.errorReason.INTEGRITY_FAILED);
    expect(result.ok === false && result.detail).not.toMatch(/malware/i);
  });

  it('answers in the person’s language, not the API’s', () => {
    expect(toActionResult(storageDown, 'ar')).toMatchObject({
      detail: ar.errorReason.STORAGE_UNAVAILABLE,
    });
    expect(toActionResult(quarantined, 'ar')).toMatchObject({
      detail: ar.errorReason.INTEGRITY_FAILED,
    });
  });

  it('fills the values the sentence names', () => {
    const tooLarge = new DomainError(
      ErrorCode.UNSUPPORTED_CONTENT,
      'x',
      {},
      { reason: 'TOO_LARGE', values: { limit: '32 MiB' } },
    );
    expect(toActionResult(tooLarge, 'en')).toMatchObject({
      detail: en.errorReason.TOO_LARGE.replace('{limit}', '32 MiB'),
    });
  });
});

describe('a refusal without one', () => {
  it('leaves detail empty, so the screen shows the code’s own sentence', () => {
    expect(
      toActionResult(new DomainError(ErrorCode.DEPENDENCY_UNAVAILABLE, 'internal'), 'en'),
    ).toEqual({ ok: false, code: 'DEPENDENCY_UNAVAILABLE', detail: null });
  });

  it('never shows a non-validation error’s own message', () => {
    const result = toActionResult(new DomainError(ErrorCode.DUPLICATE, 'row 42 in tenant x'), 'en');
    expect(result).toMatchObject({ detail: null });
  });

  it('keeps the server’s explanation of a validation failure, as before', () => {
    expect(
      toActionResult(new DomainError(ErrorCode.VALIDATION_FAILED, 'Rank 3 is taken.'), 'en'),
    ).toMatchObject({ detail: 'Rank 3 is taken.' });
  });

  it('reports anything that is not a DomainError as INTERNAL, without its message', () => {
    expect(toActionResult(new Error('postgres://secret'), 'en')).toEqual({
      ok: false,
      code: 'INTERNAL',
      detail: null,
    });
  });
});
