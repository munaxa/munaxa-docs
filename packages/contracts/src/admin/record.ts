import { z } from 'zod';

import { isoDateTimeSchema, uuidSchema, versionSchema } from '../common/identifiers';

/**
 * The stamps every administered record carries on the wire.
 *
 * Separate from `auditStampSchema` because the actor columns here are **nullable**, and that is
 * a fact rather than laxity: the scope-tree root and the first administrator role are written by
 * provisioning, before any user exists to attribute them to. A schema that required an actor
 * would be a schema the product's own first rows could not satisfy.
 *
 * `deletedAt` is present rather than omitted for a live record. A recycle bin has to distinguish
 * "not deleted" from "the server did not tell me", and `undefined` cannot do both.
 */
export const administeredRecordSchema = z.object({
  id: uuidSchema,
  /** Send this back in `If-Match` on the next write; a mismatch is a 409, never an overwrite. */
  version: versionSchema,
  createdAt: isoDateTimeSchema,
  createdBy: uuidSchema.nullable(),
  updatedAt: isoDateTimeSchema,
  updatedBy: uuidSchema.nullable(),
  deletedAt: isoDateTimeSchema.nullable(),
  deletedBy: uuidSchema.nullable(),
});

export type AdministeredRecord = z.infer<typeof administeredRecordSchema>;

/** Adds the stamps to a resource's own fields, so no contract restates them. */
export function administered<TShape extends z.ZodRawShape>(shape: TShape) {
  return administeredRecordSchema.extend(shape);
}

/**
 * An organisational or configuration code.
 *
 * The rule is `isUsableCode` in `@edms/domain` — letters, digits and hyphen, not starting with
 * the hyphen, short enough to read aloud — restated as a schema so the web form and the API
 * reject the same strings without the browser importing a validator it cannot tree-shake.
 *
 * Kept in step by `code.spec.ts`, which asserts the two agree on the same inputs. Two
 * definitions of one rule are a defect unless something checks they say the same thing.
 */
export const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]*$/,
    'A code is letters, digits and hyphens, not starting with a hyphen.',
  );

/** A human-facing name. Trimmed and bounded; whitespace is collapsed server-side. */
export const nameSchema = z.string().trim().min(1).max(200);

export const descriptionSchema = z.string().trim().max(2000);

/**
 * A stable machine key a tenant chooses — a role key, a metadata field key, a workflow key.
 *
 * Lower-case and dotted rather than free text, because these appear in stored configuration,
 * exported reports and workflow definitions, where a key that differs only by case is two keys
 * to everything except the person who typed it.
 */
export const configurationKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/,
    'A key is lower-case letters and digits, separated by dots or hyphens.',
  );
