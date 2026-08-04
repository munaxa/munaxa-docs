import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { Header } from '@edms/contracts';

import { ValidationError } from '../errors/application-errors';

/**
 * The two things every administration endpoint reads off a request that are not its body.
 */

/**
 * The `If-Match` version, as a number.
 *
 * A malformed value is rejected rather than treated as absent. Absent means "I am not
 * participating in optimistic locking"; `If-Match: banana` means a client believes it *is* and is
 * wrong, and silently promoting that to a blind write is how a lost update gets shipped.
 *
 * Quotes are tolerated because RFC 9110 spells an entity tag `"3"` and HTTP clients add them
 * unprompted. Refusing a syntactically correct `If-Match` would be pedantry with a 422 attached.
 */
export function parseIfMatch(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const unquoted = raw
    .trim()
    .replace(/^W\//, '')
    .replace(/^"(.*)"$/, '$1');
  if (!/^\d+$/.test(unquoted)) {
    throw new ValidationError('If-Match must be the version number you last read.', [
      { field: Header.IF_MATCH, message: 'not a version' },
    ]);
  }
  return Number(unquoted);
}

/**
 * The aggregate version the caller believes it is changing, from `If-Match`.
 *
 * A parameter decorator rather than a helper each controller calls, so the header name appears
 * once and every endpoint reads it the same way.
 */
export const IfMatch = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  parseIfMatch(context.switchToHttp().getRequest<Request>().header(Header.IF_MATCH)),
);
