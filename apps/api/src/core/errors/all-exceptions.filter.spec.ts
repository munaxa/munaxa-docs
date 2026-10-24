import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '@edms/domain';

import type { Logger } from '../observability/logger';
import { AllExceptionsFilter, malformedIdentifierCode } from './all-exceptions.filter';

/**
 * A malformed identifier — finding D-10.
 *
 * `/documents/undefined` reached the database as given, Prisma raised `P2023` converting it to a
 * UUID, and the filter answered 500. The release smoke met it on a real stack. A malformed
 * reference must be answered as an unknown one is: 404 in the path, 422 in a body or query.
 */

/** What Prisma raises for `WHERE id = 'undefined'` on a `uuid` column, by shape. */
function prismaUuidError(): Error {
  return Object.assign(
    new Error(
      'Inconsistent column data: Error creating UUID, invalid character: expected an optional ' +
        'prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `u` at 1',
    ),
    { name: 'PrismaClientKnownRequestError', code: 'P2023' },
  );
}

const VALID = '019489f0-0000-7000-8000-00000000d0c5';

describe('malformedIdentifierCode', () => {
  it('answers NOT_FOUND when an id in the path is malformed', () => {
    expect(malformedIdentifierCode(prismaUuidError(), { id: 'undefined' })).toBe(
      ErrorCode.NOT_FOUND,
    );
    expect(malformedIdentifierCode(prismaUuidError(), { id: VALID, revisionId: 'x' })).toBe(
      ErrorCode.NOT_FOUND,
    );
  });

  it('answers VALIDATION_FAILED when every id in the path is well formed (a body or query reference)', () => {
    expect(malformedIdentifierCode(prismaUuidError(), { id: VALID })).toBe(
      ErrorCode.VALIDATION_FAILED,
    );
    expect(malformedIdentifierCode(prismaUuidError(), {})).toBe(ErrorCode.VALIDATION_FAILED);
    // A parameter that is not an identifier is not read as one.
    expect(malformedIdentifierCode(prismaUuidError(), { locale: 'en', typeKey: 'memo' })).toBe(
      ErrorCode.VALIDATION_FAILED,
    );
  });

  it('leaves every other failure alone, including another P2023', () => {
    expect(malformedIdentifierCode(new Error('the database went away'), { id: 'x' })).toBeNull();
    const otherColumn = Object.assign(new Error('Inconsistent column data: Conversion failed'), {
      code: 'P2023',
    });
    expect(malformedIdentifierCode(otherColumn, { id: 'x' })).toBeNull();
    const otherCode = Object.assign(new Error('Error creating UUID'), { code: 'P2002' });
    expect(malformedIdentifierCode(otherCode, { id: 'x' })).toBeNull();
    expect(malformedIdentifierCode('Error creating UUID', { id: 'x' })).toBeNull();
  });
});

describe('AllExceptionsFilter on a malformed identifier', () => {
  it('answers 404 NOT_FOUND for a malformed id in the path, not 500, and logs no stack', () => {
    const { status, body, logged } = respond(prismaUuidError(), { id: 'undefined' });

    expect(status).toBe(404);
    expect(body['code']).toBe(ErrorCode.NOT_FOUND);
    expect(JSON.stringify(body)).not.toContain('UUID');
    expect(logged.error).toBe(0);
  });

  it('answers 422 VALIDATION_FAILED for a malformed reference outside the path', () => {
    const { status, body } = respond(prismaUuidError(), { id: VALID });

    expect(status).toBe(422);
    expect(body['code']).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('still answers 500 for a failure it does not recognise', () => {
    const { status, body, logged } = respond(new Error('the database went away'), { id: VALID });

    expect(status).toBe(500);
    expect(body['code']).toBe(ErrorCode.INTERNAL);
    expect(logged.error).toBe(1);
  });
});

function respond(
  exception: unknown,
  params: Record<string, string>,
): { status: number; body: Record<string, unknown>; logged: { error: number } } {
  const logged = { error: 0 };
  const logger = {
    error() {
      logged.error += 1;
    },
    warn() {},
    info() {},
    debug() {},
    child() {
      return logger;
    },
  } as unknown as Logger;

  const sent: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
  const response = {
    status(code: number) {
      sent.status = code;
      return response;
    },
    type() {
      return response;
    },
    json(payload: Record<string, unknown>) {
      sent.body = payload;
      return response;
    },
  };
  const request = { method: 'GET', path: '/api/v1/documents/x', headers: {}, params };
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter(logger).catch(exception, host);
  return { ...sent, logged };
}
