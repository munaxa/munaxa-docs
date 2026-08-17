-- Operational read access: `configuration:view` and `directory:view` for the roles that already
-- had the reach, plus the one system role the defect was actually about.
--
-- ## What was broken
--
-- A document controller holds `document:create` and `document:edit`. Exercising either means
-- choosing a document type, a category and a confidentiality level, and filling in whatever
-- metadata fields the type defines — and every one of those lists lived behind `settings:manage`,
-- `user:manage` or `org:manage`, which `08-permission-model.md` §6 marks `—` for that column. So
-- the role whose whole job is filing documents got the route's error boundary instead of the
-- workspace. Measured against the running stack: only a tenant administrator could open
-- `/documents` at all.
--
-- The application fix is two read-only permissions gating two narrow read models. The seed change
-- reaches new tenants; this reaches the ones that already exist, and without it the defect stays
-- shipped for every current customer.
--
-- ## Why these three rules and no others
--
-- **Nobody gains reach they did not already have.** Rules 1 and 2 grant a read key only to roles
-- that already hold the *management* key over the same data — they could read all of it, and more
-- of it, before this ran. That is what makes those two rules safe to apply to tenant-authored
-- roles: in terms of what any caller can see, they are a no-op.
--
-- **Rule 3 is the exception, and it is deliberate.** The seeded `DOCUMENT_CONTROLLER` gains two
-- keys it did not hold. Nothing else would fix the defect for an existing tenant, and the grant is
-- read-only, narrow (the `/configuration` and `/directory` projections, never the administrative
-- responses) and confined to `is_system = true` — a tenant that built its own controller-shaped
-- role is left alone, because that role is theirs and its permission set is a decision they made.
--
-- **The auditor is named nowhere.** It holds no management key, so rules 1 and 2 pass it over, and
-- rule 3 names one role key. Reading documents does not require the catalogue they were filed
-- against, and fixing one role by widening another is how a permission model stops meaning
-- anything.
--
-- ## Why one statement
--
-- The permission-version bump has to see *what this run actually granted*, and a separate `UPDATE`
-- could not: on a second execution the users would still hold roles carrying the new keys, so it
-- would bump every counter again and invalidate every live session for nothing. Chaining the
-- `INSERT`'s `RETURNING` into the `UPDATE` makes the whole thing genuinely idempotent — a re-run
-- inserts no rows, `granted` is empty, and no counter moves. That matters here more than usual:
-- under ADR-0015 there is one database per tenant, `scripts/migrate-tenants.mjs` visits them in
-- sequence and fails fast, so a re-run after a mid-sequence failure has to be safe.
--
-- Nothing is removed and no existing permission is touched.

WITH granted AS (
  INSERT INTO role_permission (tenant_id, role_id, permission)
  -- 1. Roles that may already administer the vocabulary may now also consume it through the narrow
  --    read model. The seeded tenant administrator, and any tenant-authored role holding
  --    `settings:manage`. `RbacGuard` requires *all* declared permissions rather than any, so
  --    holding the management key is not by itself enough to call a route declaring the read key —
  --    which is exactly why this rule is needed rather than redundant.
  SELECT DISTINCT rp.tenant_id, rp.role_id, 'configuration:view'
  FROM role_permission rp
  WHERE rp.permission = 'settings:manage'

  UNION

  -- 2. The same, for the two management keys behind the directory read model. A role holding either
  --    could already enumerate the tenant's people or its organisation chart in full.
  SELECT DISTINCT rp.tenant_id, rp.role_id, 'directory:view'
  FROM role_permission rp
  WHERE rp.permission IN ('user:manage', 'org:manage')

  UNION

  -- 3. The seeded document controller, which is the role the defect was about. `is_system` bounds
  --    this to the role the product created and refers to by key; a custom role of the same shape
  --    is the tenant's own and is not touched. Deleted roles are skipped — restoring one restores
  --    the permissions it had, and this is not a statement about roles nobody holds.
  SELECT r.tenant_id, r.id, p.permission
  FROM role r
  CROSS JOIN (VALUES ('configuration:view'), ('directory:view')) AS p(permission)
  WHERE r.key = 'DOCUMENT_CONTROLLER'
    AND r.is_system = true
    AND r.deleted_at IS NULL

  ON CONFLICT (role_id, permission) DO NOTHING
  RETURNING role_id
)
-- 4. Re-evaluate everybody whose grants just changed.
--
-- The same mechanism the product already uses, not a new one: `RoleAdminService.update` calls
-- `bumpPermissionVersion(userIdsWithRole(id))` inside the transaction that replaces a role's
-- permissions, *"so there is no window in which the role says one thing and the tokens still in
-- flight say another"*. A migration that changed grants without it would be the one code path in
-- the product that skips the step every other one takes.
--
-- What the bump does and does not do, exactly. `permission_version` travels in the access token as
-- `permVersion`; the permission *set* an outstanding token carries was baked in when it was minted,
-- and that is the set `RbacGuard` reads. Refreshing re-reads the grants from the database —
-- `AuthenticationService.refresh` takes `credential.permissions` fresh — so the new keys reach a
-- live session at its next refresh, bounded by `JWT_ACCESS_TTL_SECONDS` (default 900). That is
-- precisely the behaviour of a role edit made through the API, and there is no stronger revocation
-- path in this repository to reach for.
--
-- The counter is not version-guarded, for the reason the repository gives: it is not an edit
-- anybody can lose a race over, only a number whose job is to differ from what outstanding tokens
-- carry.
UPDATE "user" u
SET permission_version = permission_version + 1
WHERE u.deleted_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM user_role ur
    JOIN granted g ON g.role_id = ur.role_id
    WHERE ur.user_id = u.id
  );
