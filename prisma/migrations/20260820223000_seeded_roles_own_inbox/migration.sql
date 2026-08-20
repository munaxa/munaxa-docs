-- `notification:manage` for the two seeded roles that were left out of the one row every column
-- holds.
--
-- ## What was broken
--
-- `08-permission-model.md` §6 marks `notification:manage` **`own` in all eight columns** and calls
-- it "the only row in this matrix that is granted to everybody, and the only one where that is not
-- a mistake". The seed granted it to six. `DOCUMENT_CONTROLLER` and `AUDITOR` are the two roles
-- whose permission lists are named constants above the map — the other six are spelled inline
-- beneath a comment claiming "every role below holds it", which was true of the four under it and
-- quietly false of the two over it.
--
-- The consequence is not a hidden menu item. Two producers resolve their recipients by permission
-- rather than by role:
--
--   * `NotificationEventService.chainBroken` sends the audit-chain-broken alert to
--     `holdersOfPermission('audit:view')` — the administrator, the controller and the auditor.
--   * `NotificationEventService.retentionDue` sends retention reviews to
--     `holdersOfPermission('retention:manage')`, which the controller holds.
--
-- So the product wrote rows into two inboxes and then refused their owners `/v1/notifications`,
-- while `18-notification-architecture.md` §3 makes the in-app inbox the authoritative channel. The
-- same key gates `/v1/auth/mfa`, for the reason `MfaController`'s docstring gives — it is the only
-- existing permission meaning "this person's own arrangements about their own account, held by
-- everybody including GUEST" — so neither role could enrol a second factor either.
--
-- The seed change reaches new tenants. `ProvisioningService` calls `createSystemRoles` once, at
-- provisioning, and nothing re-syncs a role afterwards; without this statement the defect stays
-- shipped for every customer that already exists.
--
-- ## Why these two roles and nobody else
--
-- Bounded by `key`, which is exact: `20260803162912_identity` creates `uq_role_tenant_key`, a plain
-- unconditional unique index on `(tenant_id, key)`, so within a tenant these two keys can only ever
-- name the rows the product seeded. A role a customer built and named for itself carries the
-- permission set they chose — even for a row the product grants to all of its own — and the
-- constraint is what guarantees this statement cannot reach one.
--
-- `is_system = true` is carried over from `20260817120000_operational_read_permissions` and is
-- belt-and-braces here rather than a second rule: that migration's third rule matched a role
-- *shape* and needed it, this one matches a key the index reserves. Kept because a redundant clause
-- that states the intent costs nothing, and because the index is not declared on the Prisma model —
-- a reader checking `schema.prisma` alone would not find it.
--
-- The other six seeded roles are named nowhere: they already hold the key, so naming them would be
-- a statement this migration has no business making, and `ON CONFLICT` would swallow it silently
-- rather than visibly.
--
-- Deleted roles are skipped for the same reason the earlier migration skips them: restoring a role
-- restores the permissions it had, and this is not a statement about roles nobody holds.
--
-- Nothing is removed and no existing permission is touched.
--
-- ## Why one statement
--
-- The permission-version bump has to see what *this run* granted. A separate `UPDATE` could not
-- tell "granted now" from "granted previously", so a re-run would bump every counter again and
-- invalidate every live session in the estate for nothing. Chaining the `INSERT`'s `RETURNING` into
-- the `UPDATE` makes a second execution a genuine no-op — which matters because ADR-0015 is one
-- database per tenant and `scripts/migrate-tenants.mjs` visits them in sequence and fails fast, so
-- an operator whose fifteenth tenant failed re-runs the command over the first fourteen.

WITH granted AS (
  INSERT INTO role_permission (tenant_id, role_id, permission)
  SELECT r.tenant_id, r.id, 'notification:manage'
  FROM role r
  WHERE r.key IN ('DOCUMENT_CONTROLLER', 'AUDITOR')
    AND r.is_system = true
    AND r.deleted_at IS NULL

  ON CONFLICT (role_id, permission) DO NOTHING
  RETURNING role_id
)
-- Re-evaluate everybody whose grants just changed.
--
-- The same step `RoleAdminService.update` takes when a role's permissions are replaced, so there is
-- no window in which the role says one thing and the tokens still in flight say another.
-- `permission_version` travels in the access token as `permVersion`; the permission *set* an
-- outstanding token carries was baked in when it was minted, and that is the set `RbacGuard` reads.
-- `AuthenticationService.refresh` re-reads the grants from the database, so the new key reaches a
-- live session at its next refresh, bounded by `JWT_ACCESS_TTL_SECONDS` (default 900).
UPDATE "user" u
SET permission_version = permission_version + 1
WHERE u.deleted_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM user_role ur
    JOIN granted g ON g.role_id = ur.role_id
    WHERE ur.user_id = u.id
  );
