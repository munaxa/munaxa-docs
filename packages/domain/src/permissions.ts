/**
 * The permission catalogue — the single definition of every permission the product knows.
 *
 * A permission that is not here does not exist: the API may not gate on one, and the web
 * client may not invent one. Adding a permission is one commit that touches this file, the
 * permission matrix in `docs/architecture/08-permission-model.md`, the endpoint that gates
 * on it, the affordance that renders it, and the role seed that grants it.
 */
export const Permission = {
  DOCUMENT_VIEW: 'document:view',
  DOCUMENT_DOWNLOAD: 'document:download',
  DOCUMENT_PRINT: 'document:print',
  DOCUMENT_CREATE: 'document:create',
  DOCUMENT_EDIT: 'document:edit',
  DOCUMENT_SUBMIT: 'document:submit',
  DOCUMENT_APPROVE: 'document:approve',
  DOCUMENT_REJECT: 'document:reject',
  DOCUMENT_PUBLISH: 'document:publish',
  DOCUMENT_CHECKOUT: 'document:checkout',
  DOCUMENT_CHECKIN: 'document:checkin',
  DOCUMENT_FORCE_CHECKIN: 'document:force-checkin',
  DOCUMENT_MOVE: 'document:move',
  DOCUMENT_ARCHIVE: 'document:archive',
  DOCUMENT_DELETE: 'document:delete',
  DOCUMENT_RESTORE: 'document:restore',
  DOCUMENT_HISTORY_VIEW: 'document:history:view',
  DOCUMENT_PERMISSION_MANAGE: 'document:permission:manage',
  /**
   * Signing a revision — Phase 16, and deliberately **not** `document:approve`.
   *
   * [ADR-0017](../../../docs/architecture/adr/0017-electronic-signature-as-witnessed-attestation.md)
   * decides that a signature in this product is a Part 11-style *electronic signature*: a named
   * person, at a named instant, affirming a stated meaning over an exact content digest. An
   * approval is a workflow decision that moves a document; a signature is an attestation about
   * bytes, and the two answer different questions to an auditor — "who let this through" and "who
   * put their name to it". They are frequently the same person and occasionally, deliberately, not.
   *
   * Reusing `document:approve` would have made every approver a signatory by construction, in a
   * product whose whole reason for a signature is that signing is a *narrower* act than approving.
   *
   * **Seeded to no role, including the tenant administrator**, which is 08 §6's first deliberate
   * row applied a second time. Approval is a `T` — it comes from being assigned a task, so even a
   * tenant administrator cannot approve — and a signature is an `S`: it comes from an ACL entry on
   * the node somebody is accountable for. A signatory conferred by seniority is the failure mode
   * an electronic-signature regime exists to prevent, and a fresh tenant with a signatory nobody
   * chose would ship exactly that.
   */
  DOCUMENT_SIGN: 'document:sign',
  /**
   * Authoring the controlled starting points documents are created from — Phase 16.
   *
   * A template is tenant *configuration* that produces documents, which is why it is neither
   * `document:create` (using a template is that, and every author holds it) nor `settings:manage`
   * (which would make the person who edits quiet hours the person who decides what a new SOP
   * starts as). It ends in `:manage`, so it crosses a broken inheritance like every other
   * administrative grant — a template lives beside the tenant, not inside a folder subtree.
   */
  TEMPLATE_MANAGE: 'template:manage',
  LIBRARY_VIEW: 'library:view',
  LIBRARY_MANAGE: 'library:manage',
  FOLDER_MANAGE: 'folder:manage',
  WORKFLOW_MANAGE: 'workflow:manage',
  DELEGATION_MANAGE: 'delegation:manage',
  /**
   * A person's own notifications — Phase 12's addition, and the widest `own` scope in the
   * catalogue.
   *
   * It exists because 15 §5's boot-time assertion is right: every mutating route declares a
   * permission or a stated reason for being public, and marking "mark my notification read"
   * public would be marking it *unauthenticated*, which it emphatically is not. There was no
   * existing permission to gate it on. `document:view` was the near miss — it is what the
   * approvals and search rows use — and it is wrong: a person with no document permission still
   * receives the security notifications 18 §4 says they must, and could then not read them.
   *
   * Seeded to **every** role, including `GUEST`, and that is the point rather than an oversight:
   * everybody who can receive a notification must be able to read it, and 18 §3 calls the in-app
   * inbox authoritative. Its scope is `own` and enforced by absence — no route under
   * `/notifications` takes a user identifier, so there is no request by which one person could
   * reach another's inbox, whatever they hold.
   */
  NOTIFICATION_MANAGE: 'notification:manage',
  NUMBERING_MANAGE: 'numbering:manage',
  RETENTION_MANAGE: 'retention:manage',
  LEGAL_HOLD_MANAGE: 'legal-hold:manage',
  AUDIT_VIEW: 'audit:view',
  AUDIT_EXPORT: 'audit:export',
  SEARCH_ALL: 'search:all',
  REPORT_VIEW: 'report:view',
  REPORT_MANAGE: 'report:manage',
  USER_MANAGE: 'user:manage',
  ROLE_MANAGE: 'role:manage',
  ORG_MANAGE: 'org:manage',
  SETTINGS_MANAGE: 'settings:manage',
  /**
   * The integration platform — Phase 17: API clients, outbound webhooks, the tenant's identity
   * provider and its audit sink.
   *
   * **One key for four surfaces, and splitting it would be the wrong precision.** They are not
   * four independent decisions: whoever may mint an API key may mint one bound to a subject who
   * holds `audit:view`, and whoever may point a webhook at a URL may exfiltrate the same events a
   * sink would carry. Four keys would suggest four boundaries that do not exist, and an
   * administrator holding three of them could obtain the fourth's effect through the ones they
   * hold. `08-permission-model.md` §2's rule — a permission is a decision somebody can actually be
   * trusted with separately — decides it.
   *
   * It ends in `:manage`, so like every other administrative grant it crosses a broken
   * inheritance: an integration is configured beside the tenant, never inside a folder subtree.
   * Seeded to `TENANT_ADMIN` alone.
   */
  INTEGRATION_MANAGE: 'integration:manage',
  /**
   * Consuming the tenant's document vocabulary, as against administering it.
   *
   * **The distinction this key exists to draw is management versus consumption.** A document
   * controller creates and edits documents; doing so means choosing a document type, a category
   * and a confidentiality level, and filling in the metadata fields the type defines. Every one of
   * those was reachable only through `settings:manage` — the key that also *creates and deletes*
   * them — so the role whose whole job is filing documents could not open the workspace at all.
   * `/documents` rendered the route's error boundary for it, measured against the running stack.
   *
   * The split is the one Phase 6.3 made for libraries and `588d851` made for folders, applied a
   * third time: reads move to a narrower key, every mutation keeps the management key, and the
   * management key is unchanged. Here it goes one step further, because the administrative
   * responses carry more than a picker needs — so this gates *new, narrower* routes under
   * `/configuration` rather than relaxing `/admin/document-types` and its siblings, which keep
   * `settings:manage` exactly as they had it.
   *
   * **One key rather than four.** Document types reference categories, confidentiality levels and
   * metadata fields by id and echo their names; a role that may read types but not the fields
   * attached to them renders a type picker whose metadata section is empty. That is one decision,
   * not four, and §2's rule — a permission is a decision somebody can actually be trusted with
   * separately — is what decides it. `integration:manage` above makes the same argument.
   *
   * **Not `document:view`.** Reusing it would have cost nothing to seed and would have been
   * wrong twice over: it couples "may read documents" to "may read tenant configuration", and
   * because `RbacGuard` reads tenant-wide grants only, it would have handed the auditor the
   * vocabulary as a side effect of a key it already holds.
   *
   * **Not `settings:view`.** `/admin/settings` — the password policy, session timeouts, audit
   * thresholds — stays on `settings:manage`, and a key named for settings that deliberately does
   * not read them would promise the wrong thing. This is named for what it reads: the module,
   * service and kind enumeration behind these three resources are all called *configuration*.
   *
   * Seeded to `TENANT_ADMIN` and `DOCUMENT_CONTROLLER`. Not to the auditor: reading documents does
   * not require the catalogue they were filed against.
   */
  CONFIGURATION_VIEW: 'configuration:view',
  /**
   * The tenant's people and organisational units, as a picker needs them and no further.
   *
   * A document type may define a metadata field of type `USER` or `DEPARTMENT`, and filling one in
   * needs a list to choose from. Today that list comes from `/admin/users` and
   * `/admin/departments` — `user:manage` and `org:manage` — so the same document controller that
   * cannot read its own vocabulary also cannot fill in a field the tenant configured.
   *
   * **A separate key from `configuration:view`, because it is a separate decision.** Different
   * administrative owner, different sensitivity: one is the filing vocabulary, the other is who
   * works here. A tenant that wants a role to file documents against its own catalogue without
   * seeing the staff list can express exactly that.
   *
   * **It does not widen `/admin/users` or `/admin/departments`, and must never be made to.** The
   * administrative user record carries email, account status, MFA enrolment, last sign-in,
   * password state, role membership and department membership; the administrative department
   * record carries entity and branch ancestry and a headcount. A picker needs an identifier and a
   * label. So this gates new routes that return an identifier and a label, and the administrative
   * routes keep their management keys untouched.
   *
   * Seeded to `TENANT_ADMIN` and `DOCUMENT_CONTROLLER`. Not to the auditor.
   */
  DIRECTORY_VIEW: 'directory:view',
} as const;

export type PermissionKey = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly PermissionKey[] = Object.freeze(Object.values(Permission));

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(ALL_PERMISSIONS);

/** Narrows an untrusted string — a stored `role_permission` row, an API filter — to the catalogue. */
export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_SET.has(value);
}

/**
 * Administrative permissions are never blocked by a folder that breaks ACL inheritance.
 * Otherwise a user could hide a subtree from the administrators accountable for it
 * (`docs/architecture/08-permission-model.md` §3).
 */
export const INHERITANCE_PROOF_PERMISSIONS: readonly PermissionKey[] = Object.freeze(
  ALL_PERMISSIONS.filter((key) => key.endsWith(':manage') || key.startsWith('audit:')),
);

const INHERITANCE_PROOF_SET: ReadonlySet<string> = new Set<string>(INHERITANCE_PROOF_PERMISSIONS);

export function survivesBrokenInheritance(permission: PermissionKey): boolean {
  return INHERITANCE_PROOF_SET.has(permission);
}
