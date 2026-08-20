import { Permission, type PermissionKey, SystemRole, type SystemRoleKey } from '@edms/domain';

/**
 * The permissions each seeded role starts with.
 *
 * Here rather than in `@edms/domain` deliberately: the catalogue of *what a permission is* belongs
 * to the shared package, because the API gates on it and the web client renders it. What each role
 * *starts with* is a seed — Identity owns roles, so Identity owns the seed — and it is tenant data
 * the moment it is written. A tenant whose approvers must also publish edits the role; nobody waits
 * for a release (`08-permission-model.md` §5).
 *
 * ## Reading the matrix
 *
 * `08-permission-model.md` §6 marks every cell one of four ways, and the difference between two of
 * them is the difference between a working permission model and a broken one:
 *
 * - **`✓` granted by default.** Held tenant-wide. Seeded here.
 * - **`S` scoped — only where explicitly granted on a node.** *Not* seeded here, and this is the
 *   important one. An ACL entry on a node is what grants it, and step 6 of the resolution algorithm
 *   falls back to "the role grant at tenant level" when no ACL entry matches — so seeding an `S`
 *   permission as a tenant-level grant would make it apply **everywhere**, to every library manager,
 *   in a tenant that has configured no ACLs at all. `document:delete` is an `S` for
 *   `LIBRARY_MANAGER`; seeding it would let one delete any document in the tenant.
 * - **`T` only on a task assigned to them.** Not a grant at all: approval authority comes from being
 *   assigned a task, which is why even a tenant administrator cannot approve.
 * - **`own`.** Self-scoped rather than node-scoped — "manage *my* delegations". Seeded, because the
 *   use case can enforce "own" without an ACL, exactly as `document:edit` enforces "own draft".
 *
 * The consequence, stated plainly because it looks like an omission and is not: `LIBRARY_MANAGER`,
 * `AUTHOR`, `READER` and `GUEST` are seeded with almost nothing. That is the matrix working. Their
 * reach comes from ACL entries on the nodes they are responsible for, and administering those is the
 * permissions phase's, not this one's — until then those roles confer what the matrix says they
 * confer tenant-wide, which is nothing.
 */

/**
 * Everything except approval and signature, neither of which is conferred by seniority.
 *
 * Approval is §6's first deliberate row and has been excluded since Phase 1: it is a `T`, held by
 * being assigned a task. Phase 16 excludes `document:sign` for the same reason one step further
 * out — a signature is a personal attestation about exact bytes, and the whole point of having a
 * grant separate from `document:approve` is lost if the widest role in the tenant acquires it by
 * default. It is an `S`: an ACL entry on the node somebody is accountable for grants it.
 */
const TENANT_ADMIN_PERMISSIONS: readonly PermissionKey[] = Object.freeze(
  Object.values(Permission).filter(
    (permission) =>
      permission !== Permission.DOCUMENT_APPROVE &&
      permission !== Permission.DOCUMENT_REJECT &&
      permission !== Permission.DOCUMENT_SIGN,
  ),
);

/**
 * The compliance operator: owns numbering, types, retention and libraries.
 *
 * Everything the matrix marks `✓` for this column — which is every document and library capability
 * plus the control ones — and none of the four the matrix marks `—`: users, roles, the organisation
 * and settings belong to the tenant administrator.
 */
const DOCUMENT_CONTROLLER_PERMISSIONS: readonly PermissionKey[] = Object.freeze([
  Permission.DOCUMENT_VIEW,
  Permission.DOCUMENT_DOWNLOAD,
  Permission.DOCUMENT_PRINT,
  Permission.DOCUMENT_CREATE,
  Permission.DOCUMENT_EDIT,
  Permission.DOCUMENT_SUBMIT,
  Permission.DOCUMENT_PUBLISH,
  Permission.DOCUMENT_CHECKOUT,
  Permission.DOCUMENT_CHECKIN,
  Permission.DOCUMENT_FORCE_CHECKIN,
  Permission.DOCUMENT_MOVE,
  Permission.DOCUMENT_ARCHIVE,
  Permission.DOCUMENT_DELETE,
  Permission.DOCUMENT_RESTORE,
  Permission.DOCUMENT_HISTORY_VIEW,
  Permission.DOCUMENT_PERMISSION_MANAGE,
  Permission.LIBRARY_VIEW,
  Permission.LIBRARY_MANAGE,
  Permission.FOLDER_MANAGE,
  Permission.WORKFLOW_MANAGE,
  Permission.DELEGATION_MANAGE,
  Permission.NUMBERING_MANAGE,
  Permission.RETENTION_MANAGE,
  Permission.LEGAL_HOLD_MANAGE,
  Permission.AUDIT_VIEW,
  Permission.AUDIT_EXPORT,
  Permission.SEARCH_ALL,
  Permission.REPORT_VIEW,
  Permission.REPORT_MANAGE,
  // Phase 16. The controller is the compliance operator, and a template is a controlled starting
  // point — the same kind of thing as a document type or a numbering rule, which this column
  // already owns. `document:sign` is deliberately not here: see the tenant administrator's note.
  Permission.TEMPLATE_MANAGE,
  /*
   * The two read keys that make the four `—` cells above survivable.
   *
   * This column is deliberately denied `user:manage`, `org:manage` and `settings:manage`, and that
   * denial is right — but it was also, until this phase, a denial of everything those keys gated,
   * including *reading* the vocabulary this role files documents against. The result was measured
   * rather than argued: `/documents` rendered the route's error boundary for a document controller,
   * because choosing a document type meant reading `/admin/document-types`, and only the tenant
   * administrator could.
   *
   * Consuming configuration is not administering it. These two grant the narrow `/configuration`
   * and `/directory` read models and nothing else; every mutation and every administrative response
   * stays exactly where the matrix put it.
   */
  Permission.CONFIGURATION_VIEW,
  Permission.DIRECTORY_VIEW,
  /*
   * Its own inbox, and its own authenticator — Slice 21.
   *
   * `08-permission-model.md` §6 marks `notification:manage` **`own` for every column**, and calls
   * that the only row granted to everybody where that is not a mistake. This column and the
   * auditor's were the two that did not have it, and both are defined as named constants above the
   * map while the six that did have it are spelled inline — which is how the gap survived.
   *
   * What it cost is not a missing menu item. `NotificationEventService.retentionDue` resolves its
   * recipients as `holdersOfPermission(RETENTION_MANAGE)` and `chainBroken` as
   * `holdersOfPermission(AUDIT_VIEW)`; this role holds both, so the product was writing it
   * retention reviews and audit-chain-broken alerts into an inbox it was then refused. 18 §3 makes
   * the in-app inbox authoritative, which is what makes that a compliance defect rather than an
   * inconvenience. `MfaController` carries the same key for the reason its docstring gives, so the
   * role could not enrol a second factor either.
   */
  Permission.NOTIFICATION_MANAGE,
]);

/** Reads everything in scope plus the trail, and may never mutate anything, at any scope (§6). */
const AUDITOR_PERMISSIONS: readonly PermissionKey[] = Object.freeze([
  Permission.DOCUMENT_VIEW,
  Permission.DOCUMENT_DOWNLOAD,
  Permission.DOCUMENT_PRINT,
  Permission.DOCUMENT_HISTORY_VIEW,
  Permission.LIBRARY_VIEW,
  Permission.AUDIT_VIEW,
  Permission.AUDIT_EXPORT,
  Permission.SEARCH_ALL,
  Permission.REPORT_VIEW,
  /*
   * The one grant on this row that is not a read of the tenant's, and therefore not an exception
   * to "never mutates anything" — Slice 21.
   *
   * Marking a notification read and enrolling an authenticator are acts on the auditor's own
   * account, not on anything of the tenant's, and the `own` scope is enforced by absence: no route
   * under `/notifications` or `/auth/mfa` takes a recipient or a user identifier. The alternative
   * was an auditor who receives `chainBroken` — which goes to `holdersOfPermission(AUDIT_VIEW)`,
   * this row's own key — and cannot open the inbox it lands in.
   */
  Permission.NOTIFICATION_MANAGE,
]);

export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<SystemRoleKey, readonly PermissionKey[]>> =
  Object.freeze({
    [SystemRole.TENANT_ADMIN]: TENANT_ADMIN_PERMISSIONS,
    [SystemRole.DOCUMENT_CONTROLLER]: DOCUMENT_CONTROLLER_PERMISSIONS,
    // Every cell in this column is `S`, `T` or `—`. Reach comes from ACL entries on the libraries
    // this role is responsible for; nothing is conferred tenant-wide — except `notification:manage`,
    // which **every one of the eight** holds for the reason its catalogue entry gives: everybody who
    // can receive a notification must be able to read it, and its scope is their own inbox. It used
    // to say "every role below", which was true of the four spelled out beneath it and quietly
    // false of the two hoisted into constants above; `role-seed.spec.ts` now asserts the row rather
    // than a comment describing it.
    [SystemRole.LIBRARY_MANAGER]: Object.freeze([Permission.NOTIFICATION_MANAGE]),
    // `delegation:manage` is `own`: an author may delegate their own approvals, and the use case
    // enforces the subject. Everything else in the column is `S`.
    [SystemRole.AUTHOR]: Object.freeze([
      Permission.DELEGATION_MANAGE,
      Permission.NOTIFICATION_MANAGE,
    ]),
    [SystemRole.APPROVER]: Object.freeze([
      Permission.DELEGATION_MANAGE,
      Permission.NOTIFICATION_MANAGE,
    ]),
    [SystemRole.READER]: Object.freeze([Permission.NOTIFICATION_MANAGE]),
    [SystemRole.AUDITOR]: AUDITOR_PERMISSIONS,
    // Time-boxed, explicitly granted access to one document or folder. Nothing by default, by
    // definition — beyond their own inbox, which is not access to anything of the tenant's.
    [SystemRole.GUEST]: Object.freeze([Permission.NOTIFICATION_MANAGE]),
  });

/** The name each seeded role is created with. A tenant renames them freely; the keys are fixed. */
export const DEFAULT_ROLE_NAMES: Readonly<Record<SystemRoleKey, string>> = Object.freeze({
  [SystemRole.TENANT_ADMIN]: 'Tenant administrator',
  [SystemRole.DOCUMENT_CONTROLLER]: 'Document controller',
  [SystemRole.LIBRARY_MANAGER]: 'Library manager',
  [SystemRole.AUTHOR]: 'Author',
  [SystemRole.APPROVER]: 'Approver',
  [SystemRole.READER]: 'Reader',
  [SystemRole.AUDITOR]: 'Auditor',
  [SystemRole.GUEST]: 'Guest',
});

export const DEFAULT_ROLE_DESCRIPTIONS: Readonly<Record<SystemRoleKey, string>> = Object.freeze({
  [SystemRole.TENANT_ADMIN]: 'Full administration of this organisation. Cannot approve documents.',
  [SystemRole.DOCUMENT_CONTROLLER]:
    'Owns numbering, document types, retention and libraries. The compliance operator.',
  [SystemRole.LIBRARY_MANAGER]:
    'Manages the libraries, folders and permissions granted to them on specific nodes.',
  [SystemRole.AUTHOR]: 'Creates and revises documents in the folders they are granted.',
  [SystemRole.APPROVER]: 'Decides the approval tasks assigned to them.',
  [SystemRole.READER]: 'Reads, and where allowed downloads, what they are granted.',
  [SystemRole.AUDITOR]: 'Reads everything in scope plus the audit trail. Never mutates anything.',
  [SystemRole.GUEST]: 'Time-boxed access to a single document or folder.',
});
