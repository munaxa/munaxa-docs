import { z } from 'zod';

import { uuidSchema } from '../common/identifiers';
import { optionListQuerySchema } from './option-query';

/**
 * The tenant's people and organisational units, as a metadata picker needs them.
 *
 * ## Why not `/admin/users` and `/admin/departments`
 *
 * Because of what those return. The administrative user record carries the address, the account
 * status, MFA enrolment, last sign-in, whether a password is set, every role held and every
 * department joined — an operations view of an account. The administrative department record
 * carries its entity and branch ancestry and a headcount. Both are right for the screens that
 * administer them, and both are far more than a `USER` or `DEPARTMENT` metadata field needs, which
 * is an identifier and something to show in a list.
 *
 * Widening those endpoints so a dropdown could be filled would have made every holder of the new
 * read key an auditor of the tenant's staff: who has not enrolled in MFA, who has never signed in,
 * who holds which role. So the endpoints are untouched, `user:manage` and `org:manage` still gate
 * them, and these two shapes carry the two fields that were actually measured to be consumed.
 *
 * `directory-read.spec.ts` asserts the excluded fields are absent by name. An omission nothing
 * checks is an omission somebody restores.
 */

/**
 * A person, as somebody choosing one sees them.
 *
 * Active accounts only, and that is the endpoint's behaviour rather than a filter a caller may
 * turn off: a picker offering a disabled account offers an assignment that resolves to nobody.
 * The administration screens keep their status filter, because managing an account and choosing
 * a person are different questions.
 */
export const personOptionSchema = z.object({
  id: uuidSchema,
  displayName: z.string(),
});

export const departmentOptionSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  name: z.string(),
  /** Materialised ancestry, so two departments called `Quality` are distinguishable in a list. */
  path: z.string(),
});

export const personOptionQuerySchema = optionListQuerySchema(['displayName']);

export const departmentOptionQuerySchema = optionListQuerySchema(['name', 'code', 'path']);

export type PersonOption = z.infer<typeof personOptionSchema>;
export type DepartmentOption = z.infer<typeof departmentOptionSchema>;
export type PersonOptionQuery = z.infer<typeof personOptionQuerySchema>;
export type DepartmentOptionQuery = z.infer<typeof departmentOptionQuerySchema>;
