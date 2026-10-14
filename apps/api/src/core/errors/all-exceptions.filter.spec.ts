import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ScanStatus } from '@edms/domain';

import type { Logger } from '../observability/logger';
import { AllExceptionsFilter } from './all-exceptions.filter';
import {
  ContentNotScannedError,
  ContentQuarantinedError,
  ScannerBusyError,
  StorageUnavailableError,
  UnsupportedContentError,
  UploadExpiredError,
  UploadNotReceivedError,
  ValidationError,
} from './application-errors';

/**
 * What a refusal tells the caller — ADR-0026 §10, Phase A.
 *
 * Phase A found every upload refusal answering "That file type is not accepted." and an integrity
 * quarantine described as a malware check in progress. The status and the code are the error's
 * class's, as before; the sentence is the reason's when the cause is known, from the catalogue,
 * and never the internal message (which can name a key, a driver or a configuration variable).
 */

interface Sent {
  status: number;
  body: Record<string, unknown>;
}

function answer(exception: unknown, locale = 'en'): Sent {
  const sent: Sent = { status: 0, body: {} };
  const response = {
    status(code: number) {
      sent.status = code;
      return response;
    },
    type() {
      return response;
    },
    json(body: Record<string, unknown>) {
      sent.body = body;
      return response;
    },
  };
  const request = { headers: { 'accept-language': locale }, path: '/test', method: 'POST' };
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
  const quiet = { error: () => undefined, warn: () => undefined } as unknown as Logger;
  new AllExceptionsFilter(quiet).catch(exception, host);
  return sent;
}

describe('a refusal with a known cause says what it is, at the status it always had', () => {
  it.each([
    [
      'a file over its type’s limit',
      new UnsupportedContentError(
        'A PDF document may be up to 128 MiB.',
        { reason: 'TOO_LARGE' },
        { reason: 'TOO_LARGE', values: { limit: '128 MiB' } },
      ),
      415,
      'UNSUPPORTED_CONTENT',
      'This file is too large. The limit for this kind of file is 128 MiB.',
    ],
    [
      'a type that is not allowed',
      new UnsupportedContentError('x', {}, { reason: 'TYPE_NOT_ALLOWED' }),
      415,
      'UNSUPPORTED_CONTENT',
      'That file type is not accepted.',
    ],
    [
      'a fingerprint that was never confirmed',
      new UnsupportedContentError('x', {}, { reason: 'DIGEST_UNCONFIRMED' }),
      415,
      'UNSUPPORTED_CONTENT',
      'The file’s fingerprint could not be confirmed, so it was not accepted. Upload it again from an up-to-date browser over a secure connection.',
    ],
    [
      'an expired upload link',
      new UploadExpiredError(),
      422,
      'VALIDATION_FAILED',
      'The upload link expired before the file arrived. Start the upload again.',
    ],
    [
      'bytes that have not arrived yet',
      new UploadNotReceivedError(),
      422,
      'VALIDATION_FAILED',
      'The file has not finished uploading yet. Try again when the transfer is complete.',
    ],
    [
      'an integrity quarantine',
      new ContentQuarantinedError('MISMATCH'),
      409,
      'CONTENT_NOT_SCANNED',
      'This file failed its integrity check and cannot be opened. An administrator needs to restore it.',
    ],
    [
      'a malware verdict',
      new ContentNotScannedError(ScanStatus.INFECTED),
      409,
      'CONTENT_NOT_SCANNED',
      'This file did not pass the malware check and cannot be opened.',
    ],
    [
      'a busy scanner',
      new ScannerBusyError(),
      503,
      'DEPENDENCY_UNAVAILABLE',
      'The malware scanner is busy. Nothing was lost — try finishing the upload again in a minute.',
    ],
    [
      'storage that is down',
      new StorageUnavailableError('Object storage refused to read the object (HTTP 500).'),
      503,
      'DEPENDENCY_UNAVAILABLE',
      'File storage is temporarily unavailable. Try again shortly.',
    ],
  ])('%s', (_case, error, status, code, detail) => {
    const { status: sent, body } = answer(error);
    expect(sent).toBe(status);
    expect(body).toMatchObject({ status, code, detail });
  });

  it('never shows the internal message, which can name keys and settings', () => {
    const { body } = answer(
      new StorageUnavailableError('Object storage refused to read the object (HTTP 500).'),
    );
    expect(JSON.stringify(body)).not.toContain('HTTP 500');
  });

  it('answers in the caller’s language, with the same values', () => {
    const { body } = answer(
      new UnsupportedContentError('x', {}, { reason: 'TOO_LARGE', values: { limit: '32 MiB' } }),
      'ar',
    );
    expect(body['detail']).toBe(
      'هذا الملف كبير جدًا. الحد المسموح لهذا النوع من الملفات هو 32 MiB.',
    );
  });

  it('keeps the code’s own sentence for a refusal with no stated reason', () => {
    const { body } = answer(new ValidationError('internal wording'));
    expect(body).toMatchObject({ status: 422, detail: 'Some of the details are not valid.' });
  });
});
