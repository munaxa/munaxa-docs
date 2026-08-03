import 'server-only';

import type { ZodIssue, ZodType } from 'zod';

import { ErrorCode } from '@edms/domain';

import { type ActionResult, failed } from './action-result';

/**
 * Validates a server action's input before it goes anywhere.
 *
 * A server action is an HTTP endpoint. Next.js gives it a function's shape, but anything on the
 * network can call it with any body, so the arguments are untrusted in exactly the way a controller's
 * are — and the same rule applies: parse at the boundary, never trust the caller's word about the
 * shape (`docs/architecture/15-api-architecture.md` §5).
 *
 * The API validates again, and that is not redundant. This one is what lets a form show which field
 * is wrong before a request is made, and the API's is the one that actually protects the data. Both
 * read the same schema from `@edms/contracts`, so they cannot disagree about what is valid.
 *
 * The message is the first issue's path and text rather than the whole list. A dialogue showing eight
 * sentences at once is a dialogue nobody reads; the first thing wrong is the thing to fix.
 */
export async function validated<TInput, TResult>(
  schema: ZodType<TInput>,
  raw: unknown,
  run: (input: TInput) => Promise<ActionResult<TResult>>,
): Promise<ActionResult<TResult>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return failed<TResult>(ErrorCode.VALIDATION_FAILED, describe(parsed.error.issues));
  }
  return run(parsed.data);
}

function describe(issues: readonly ZodIssue[]): string {
  const first = issues[0];
  if (first === undefined) {
    return 'The details are not valid.';
  }
  const field = first.path.filter((segment) => typeof segment === 'string').join('.');
  return field === '' ? first.message : `${field}: ${first.message}`;
}
