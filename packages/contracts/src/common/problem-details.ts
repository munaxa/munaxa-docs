import { z } from 'zod';

import { ErrorCode } from '@edms/domain';

/**
 * The error body of every failed request, shaped as RFC 7807 problem details plus the
 * product's own machine-readable `code` (`docs/architecture/15-api-architecture.md` §4).
 *
 * What it must never carry: a stack trace, a SQL fragment, a file path, or any data
 * belonging to another user or tenant.
 */
export const fieldErrorSchema = z.object({
  field: z.string(),
  message: z.string(),
});

export const problemDetailsSchema = z.object({
  /** A stable URL documenting the error class. */
  type: z.string().url(),
  /** Short, human-readable summary. Never interpolates untrusted input. */
  title: z.string(),
  status: z.number().int().min(400).max(599),
  /** The machine-readable code clients branch on. */
  code: z.nativeEnum(ErrorCode),
  /** What went wrong and what the caller can do about it. */
  detail: z.string(),
  errors: z.array(fieldErrorSchema).optional(),
  correlationId: z.string(),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export const PROBLEM_TYPE_BASE = 'https://docs.munaxa.com/errors' as const;

/** Turns a code into its documentation URL, so `type` is never hand-written per call site. */
export function problemTypeFor(code: keyof typeof ErrorCode): string {
  return `${PROBLEM_TYPE_BASE}/${code.toLowerCase().replace(/_/g, '-')}`;
}
