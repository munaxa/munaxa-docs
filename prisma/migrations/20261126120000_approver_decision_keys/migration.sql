-- `document:approve` and `document:reject` for the two seeded roles whose matrix column marks them
-- `T`: `APPROVER` and `LIBRARY_MANAGER`.
--
-- ## What was broken
--
-- `08-permission-model.md` §6 marks both keys `T` ("only on a task assigned to them") for these two
-- roles and `—` for every other column. The seed gave them to no role. But
-- `POST /approval-tasks/{id}/decision` is gated on `document:approve` by `RbacGuard`, which reads the
-- permission set in the access token, so the `T` cell could never be reached: a person holding only
-- seeded roles was refused every decision with 403, including on a task assigned to them. Found on
-- Testing on 26 Nov 2026, where the administrator added the Approver role and was still refused.
--
-- The "only on an assigned task" half of `T` is enforced where it always was: `WorkflowEngine.decide`
-- refuses a task whose assignee is not the caller unless a live delegation covers it. Holding the
-- key widens nothing beyond that.
--
-- The seed change reaches new tenants; nothing re-syncs a role after provisioning, so without this
-- statement every existing tenant keeps the defect.
--
-- ## Scope, and why one statement
--
-- Same shape and the same reasoning as `20260820223000_seeded_roles_own_inbox`: bounded by `key`
-- (unique per tenant through `uq_role_tenant_key`, so a customer-built role cannot be reached),
-- `is_system = true` kept as a stated intent, deleted roles skipped, nothing removed. `TENANT_ADMIN`
-- is deliberately not named: approval is not conferred by seniority. The `INSERT`'s `RETURNING` feeds
-- the permission-version bump, so a re-run grants nothing and bumps nobody.

WITH granted AS (
  INSERT INTO role_permission (tenant_id, role_id, permission)
  SELECT r.tenant_id, r.id, p.permission
  FROM role r
  CROSS JOIN (VALUES ('document:approve'), ('document:reject')) AS p(permission)
  WHERE r.key IN ('APPROVER', 'LIBRARY_MANAGER')
    AND r.is_system = true
    AND r.deleted_at IS NULL

  ON CONFLICT (role_id, permission) DO NOTHING
  RETURNING role_id
)
-- Holders of a role that just gained a key are re-evaluated at their next request, as
-- `RoleAdminService.update` does when a role's permissions are replaced.
UPDATE "user" u
SET permission_version = permission_version + 1
WHERE u.deleted_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM user_role ur
    JOIN granted g ON g.role_id = ur.role_id
    WHERE ur.user_id = u.id
  );
