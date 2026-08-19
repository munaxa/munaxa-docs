import { z } from 'zod';

import { uuidSchema } from '../common/identifiers';
import { optionListQuerySchema } from './option-query';

/**
 * The roles an ACL entry may name, as somebody writing one sees them — Slice 12.
 *
 * ## Why this is not `/admin/roles` with a softer guard
 *
 * `AclSubjectType` is `USER | ROLE | DEPARTMENT`, so a role is a first-class permission subject and
 * choosing one needs a list. The only role list in the product was `/admin/roles`, behind
 * `role:manage` — the tenant administrator alone — so the seeded **document controller**, which the
 * permissions controller names as an intended user of `document:permission:manage`, could not name
 * a role in an entry it is explicitly meant to write.
 *
 * `Role` carries the key, the description, the system flag, **every permission the role grants** and
 * its member count. That last pair is the tenant's authority map: who can approve, who can delete,
 * how many people hold it. A picker needs an identifier and a label, so that is what this is, and
 * `/admin/roles` keeps `role:manage` untouched.
 *
 * ## Why the guard is `document:permission:manage`
 *
 * Not `directory:view`. That key is documented as *"the tenant's people and organisational units"* —
 * roles are capability, not directory, and stretching it would broaden a permission this slice has
 * no mandate to broaden.
 *
 * The operation's own key is the honest one. Whoever may write `subjectType: ROLE` on a node is
 * exactly whoever needs to know which roles there are to write, and `validate` already accepts any
 * identifier — so seeing the names of the roles you may already grant to is strictly less than the
 * write you could already perform. It introduces no permission and widens none.
 */
export const roleOptionSchema = z.object({
  id: uuidSchema,
  name: z.string(),
});

export const roleOptionQuerySchema = optionListQuerySchema(['name']);

export type RoleOption = z.infer<typeof roleOptionSchema>;
export type RoleOptionQuery = z.infer<typeof roleOptionQuerySchema>;
