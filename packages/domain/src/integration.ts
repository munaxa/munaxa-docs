/**
 * The integration platform's vocabulary — Phase 17.
 *
 * Three capabilities meet here and only one of them is new machinery: a **machine caller**, an
 * **outbound webhook**, and an **audit stream**. What they share is that each is a way for a
 * *system* rather than a person to be on one end of an exchange, which is the property this
 * product had never had — every route in it until now is authenticated as somebody, and
 * `RequestContext.userId` is the subject of every reach decision in the codebase.
 *
 * Pure, like every other file here: no I/O, no framework, no secret. The signing key lives in the
 * module that holds it; what is here is the *canonical string* that gets signed, which has to be
 * built identically by the sender, by a receiver's verification code, and by any future SDK.
 */

// ---------------------------------------------------------------------------------------
// Machine identity
// ---------------------------------------------------------------------------------------

/**
 * What a machine token may ask for.
 *
 * **A scope narrows and never widens**, which is the whole of
 * [ADR-0018](../../../docs/architecture/adr/0018-machine-identity-as-a-delegated-subject.md)'s
 * consequence expressed as a type. An API client is bound to a person; the effective permission
 * set is the *intersection* of that person's tenant-wide grants with the scopes on the client, so
 * a client naming `documents:write` held by somebody without `document:edit` can write nothing.
 *
 * Coarse deliberately — six values covering the surfaces a machine caller plausibly integrates
 * with, rather than a mirror of the forty-odd permission keys. A scope model that is a second copy
 * of the permission catalogue is a second copy that drifts, and the catalogue is already the
 * authority: the scope says *which family of routes this key may reach at all*, and
 * `RbacGuard` still asks the permission question afterwards, unchanged.
 */
export const ApiScope = {
  /** Read documents, revisions, folders and libraries. */
  DOCUMENTS_READ: 'documents:read',
  /** Create, edit, submit, check out and check in documents. */
  DOCUMENTS_WRITE: 'documents:write',
  /** Read approval tasks and decide them. */
  WORKFLOW: 'workflow',
  /** Run reports and request exports. */
  REPORTS_READ: 'reports:read',
  /** Read the audit trail, including the streaming cursor. */
  AUDIT_READ: 'audit:read',
  /** Administer webhooks, API clients, identity providers and audit sinks. */
  INTEGRATION_MANAGE: 'integration:manage',
} as const;

export type ApiScopeKey = (typeof ApiScope)[keyof typeof ApiScope];

export const ALL_API_SCOPES: readonly ApiScopeKey[] = Object.freeze(Object.values(ApiScope));

export function isApiScope(value: string): value is ApiScopeKey {
  return (ALL_API_SCOPES as readonly string[]).includes(value);
}

/**
 * Which permission keys a scope admits.
 *
 * Read as a **filter**, never as a grant: the effective set is
 * `held ∩ ⋃(permissionsForScopes(scopes))`. A permission absent from every scope's list is
 * unreachable by any machine token however the client is configured — which is how
 * `document:sign`, `user:manage`, `role:manage` and `settings:manage` stay out of an API key's
 * reach without anybody having to remember to exclude them.
 *
 * Signing is the clearest instance and is worth stating: 21 CFR Part 11 §11.200 requires a
 * signature to be executed by the *person*, with two identification components they alone
 * control. A key in a script is neither, so no scope admits `document:sign` and ADR-0017 stays
 * true when a machine is calling.
 */
const SCOPE_PERMISSIONS: Readonly<Record<ApiScopeKey, readonly string[]>> = Object.freeze({
  [ApiScope.DOCUMENTS_READ]: Object.freeze([
    'document:view',
    'document:download',
    'document:history:view',
    'library:view',
  ]),
  [ApiScope.DOCUMENTS_WRITE]: Object.freeze([
    'document:view',
    'document:download',
    'document:create',
    'document:edit',
    'document:submit',
    'document:checkout',
    'document:checkin',
    'document:move',
    'document:history:view',
    'library:view',
  ]),
  [ApiScope.WORKFLOW]: Object.freeze([
    'document:view',
    'document:approve',
    'document:reject',
    'document:history:view',
    'library:view',
  ]),
  [ApiScope.REPORTS_READ]: Object.freeze([
    'report:view',
    'report:manage',
    'document:view',
    'library:view',
  ]),
  [ApiScope.AUDIT_READ]: Object.freeze(['audit:view', 'audit:export']),
  [ApiScope.INTEGRATION_MANAGE]: Object.freeze(['integration:manage']),
});

/** The union of what the named scopes admit. An empty scope list admits nothing. */
export function permissionsForScopes(scopes: readonly string[]): readonly string[] {
  const admitted = new Set<string>();
  for (const scope of scopes) {
    if (isApiScope(scope)) {
      for (const permission of SCOPE_PERMISSIONS[scope]) {
        admitted.add(permission);
      }
    }
  }
  return Object.freeze([...admitted]);
}

/**
 * The effective permissions of a machine caller: the subject's own grants, filtered by scope.
 *
 * Intersection rather than union, and the direction is the security property. A client whose
 * subject loses a role loses it here on the next authentication, because the subject's grants are
 * read at that moment rather than copied onto the client when it was minted — which is Phase 11's
 * rule for delegation applied to a key, for the same reason.
 */
export function effectiveApiPermissions(
  subjectPermissions: readonly string[],
  scopes: readonly string[],
): readonly string[] {
  const admitted = new Set(permissionsForScopes(scopes));
  return Object.freeze(subjectPermissions.filter((permission) => admitted.has(permission)));
}

/**
 * The visible prefix of an API key, and the whole reason a key can be shown in a list.
 *
 * A key is `mdk.<prefix>.<secret>`: the prefix is stored in clear and indexed, the secret is
 * stored only as a digest. That is the same construction as a refresh token — opaque, revocable,
 * never a JWT — with one addition: the lookup has to find *which* client a presented key belongs
 * to without scanning every row and verifying each, so the prefix is the selector and the digest
 * is the proof.
 *
 * **The separator is `.` and not `_`, and that is a defect the Phase 17 integration suite found
 * rather than a preference.** Both segments are `base64url`, whose alphabet is `A-Za-z0-9-_` — so
 * a key written `mdk_<prefix>_<secret>` splits into an unpredictable number of parts as soon as
 * either segment happens to contain an underscore, which is roughly one key in three. The
 * authenticator refused those keys as malformed, and the failure was intermittent in exactly the
 * way that survives a unit test written by whoever chose the format. `.` is outside `base64url`
 * entirely, so the split is unambiguous by construction.
 */
export const API_KEY_PREFIX = 'mdk' as const;
export const API_KEY_PREFIX_LENGTH = 12;

/** Outside the `base64url` alphabet, so the split can never be ambiguous. See above. */
export const API_KEY_SEPARATOR = '.' as const;

export interface ParsedApiKey {
  readonly prefix: string;
  readonly secret: string;
}

/**
 * Splits a presented key, or `null` if it is not one of ours.
 *
 * Returning `null` rather than throwing keeps the authenticator's shape honest: a caller
 * presenting a JWT to the key path and a caller presenting rubbish are the same non-event, and
 * neither is worth an exception.
 */
export function parseApiKey(presented: string): ParsedApiKey | null {
  const parts = presented.split(API_KEY_SEPARATOR);
  if (parts.length !== 3 || parts[0] !== API_KEY_PREFIX) {
    return null;
  }
  const prefix = parts[1] ?? '';
  const secret = parts[2] ?? '';
  if (prefix.length !== API_KEY_PREFIX_LENGTH || secret.length < 32) {
    return null;
  }
  return { prefix, secret };
}

// ---------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------

/**
 * Where a delivery has got to.
 *
 * Its own type rather than a share with `DeliveryState` — Phase 15 and Phase 16 each declined the
 * same share for the same reason, and it holds harder here: a notification's states include
 * `SUPPRESSED`, `HELD` and `DIGESTED`, none of which mean anything for an endpoint, and a
 * webhook's `DEAD` has no notification counterpart.
 */
export const WebhookDeliveryState = {
  PENDING: 'PENDING',
  /** Delivered and acknowledged with a 2xx. */
  DELIVERED: 'DELIVERED',
  /** The attempt failed and another is scheduled. `nextAttemptAt` says when. */
  RETRYING: 'RETRYING',
  /**
   * Out of attempts. The row survives with its payload, which is the point: 18 §8's "never
   * silently dropped" applied to a system recipient, and the reason a dead delivery can be
   * replayed by hand rather than reconstructed.
   */
  DEAD: 'DEAD',
} as const;

export type WebhookDeliveryStateKey =
  (typeof WebhookDeliveryState)[keyof typeof WebhookDeliveryState];

/** The signature header set a receiver verifies. Named here so an SDK and the sender agree. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Munaxa-Signature' as const;
export const WEBHOOK_TIMESTAMP_HEADER = 'X-Munaxa-Timestamp' as const;
export const WEBHOOK_DELIVERY_HEADER = 'X-Munaxa-Delivery' as const;
export const WEBHOOK_EVENT_HEADER = 'X-Munaxa-Event' as const;

/** The scheme, versioned in the value rather than in the header name. */
export const WEBHOOK_SIGNATURE_VERSION = 'v1' as const;

/**
 * What gets signed.
 *
 * `v1:{timestamp}:{body}` — the timestamp is **inside** the signed string, which is what makes
 * the replay window enforceable: a receiver that checks only the body signature will happily
 * accept a captured request forever, because the signature over an unchanged body stays valid.
 * Stripe's construction, and it is the right one for the same reason it is there.
 *
 * The body is the exact bytes sent, not a re-serialisation. A receiver that parses the JSON and
 * re-encodes it before verifying will get a different string and a failed signature — which is
 * a documented property rather than a bug, and is why the header set is named here.
 */
export function webhookSigningString(timestampSeconds: number, body: string): string {
  return `${WEBHOOK_SIGNATURE_VERSION}:${timestampSeconds}:${body}`;
}

/** How the signature is presented, so a receiver can find the version it knows how to check. */
export function webhookSignatureHeader(hexDigest: string): string {
  return `${WEBHOOK_SIGNATURE_VERSION}=${hexDigest}`;
}

/**
 * Whether an endpoint subscribes to an event.
 *
 * An **empty list means every event**, and that is the deliberate default rather than an
 * oversight. The alternative — an empty list subscribing to nothing — makes the useful
 * configuration the one somebody has to get right, and a new event family added by a later phase
 * would reach nobody until every tenant edited every endpoint. This way a later phase's events
 * arrive at the endpoints that asked for everything, which is what an integration wants and is
 * the exact failure the outbox routing table has had twice.
 *
 * A named subscription matches on a **prefix boundary**: `document` matches `document.published`
 * and not `documentation.x`, and `document.published` matches only itself.
 */
export function webhookSubscribes(eventTypes: readonly string[], eventType: string): boolean {
  if (eventTypes.length === 0) {
    return true;
  }
  return eventTypes.some(
    (subscribed) => eventType === subscribed || eventType.startsWith(`${subscribed}.`),
  );
}

/**
 * When the next attempt is due.
 *
 * Exponential from a base with full jitter and a cap, which is the same shape as the outbox's
 * backoff and different in one respect that matters: a webhook's peer is somebody else's server.
 * Without jitter, an endpoint that goes down while a hundred deliveries are in flight gets all
 * hundred retries at the same instant, repeatedly — a synchronised thundering herd aimed at a
 * system that is already unwell.
 */
export function webhookBackoffMs(attempt: number, random: number): number {
  const base = Math.min(3_600_000, 5_000 * 2 ** Math.min(attempt, 10));
  // Full jitter: uniform in [base/2, base]. Half the delay is guaranteed so a failing endpoint is
  // never hammered, and the other half is spread so a fleet of deliveries does not synchronise.
  return Math.floor(base / 2 + (base / 2) * Math.min(Math.max(random, 0), 0.999999));
}

/**
 * How many consecutive failures disable an endpoint.
 *
 * An endpoint that has been refusing for days is a URL somebody decommissioned without telling
 * anyone, and continuing to post to it is an outbound request per event forever. Disabling is
 * recorded and reversible; deleting would lose the configuration somebody has to rebuild.
 */
export const WEBHOOK_FAILURE_DISABLE_THRESHOLD = 20;

// ---------------------------------------------------------------------------------------
// Federation
// ---------------------------------------------------------------------------------------

/**
 * How a tenant federates.
 *
 * **One value, and that is the phase's first decision rather than an unfinished enum.** The brief
 * names SSO, Azure AD and Google Workspace as separate items; they are one adapter. Azure AD and
 * Google Workspace are OIDC providers that differ in their discovery URL and in which claim
 * carries the groups — configuration, not code — and building three adapters would be building
 * one adapter three times.
 *
 * SAML is absent for a reason a command answered rather than a preference: verifying a SAML
 * assertion needs XML canonicalisation and XML-DSig, there is no XML parser in this lockfile at
 * any level, and the lockfile cannot gain one. Hand-writing C14N in a security product is the
 * trade Phase 14 refused for WebAuthn's CBOR, and it is refused here for the same reason.
 * `IdentityProviderKind` has one value so that adding `SAML` later is a migration rather than a
 * redesign, and 17 §2's "OIDC/SAML" is honestly half-built until then.
 */
export const IdentityProviderKind = {
  OIDC: 'OIDC',
} as const;

export type IdentityProviderKindKey =
  (typeof IdentityProviderKind)[keyof typeof IdentityProviderKind];

/** Where an identity came from. `LOCAL` is the password path Phase 1 built. */
export const IdentitySource = {
  LOCAL: 'LOCAL',
  FEDERATED: 'FEDERATED',
} as const;

export type IdentitySourceKey = (typeof IdentitySource)[keyof typeof IdentitySource];

/**
 * The claim names a provider uses, because the two the brief names use different ones.
 *
 * Entra ID puts group object ids in `groups` and the user's name in `name`; Google Workspace has
 * no groups claim at all on an ID token and puts the domain in `hd`. Okta is configurable and
 * usually `groups`. So the mapping is **data on the provider row**, defaulted to the most common
 * names, and the difference between "Azure AD" and "Google Workspace" is two rows in a table.
 */
export interface ClaimMapping {
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
  /** Null where the provider issues no group claim — Google Workspace's ID token, for instance. */
  readonly groups: string | null;
}

export const DEFAULT_CLAIM_MAPPING: ClaimMapping = Object.freeze({
  subject: 'sub',
  email: 'email',
  displayName: 'name',
  groups: 'groups',
});

/**
 * Which roles a federated sign-in provisions to.
 *
 * 17 §2 says *"JIT provisioning to pre-mapped roles"*, and the two words that carry the weight are
 * **pre-mapped**: the provider asserts group membership and the tenant decides, in advance, what
 * each group means here. Nothing in a claim names a Munaxa role, and a provider that could would
 * be a provider that can grant itself `user:manage`.
 *
 * An unmapped group contributes nothing — silently, because an assertion carrying forty Entra
 * groups of which one is mapped is the ordinary case rather than an error.
 */
export interface RoleMapping {
  /** The value as the provider asserts it — a group object id, a name, whatever they send. */
  readonly claimValue: string;
  readonly roleKey: string;
}

/**
 * The roles a set of asserted groups maps to, plus the provider's defaults.
 *
 * Defaults exist because the common configuration is "everybody in this directory is a reader,
 * and the mapped groups add to that". A provider with no defaults and no matching group
 * provisions somebody who can sign in and reach nothing, which is a correct and confusing
 * outcome — so the *deployment* chooses, and the provider row says which.
 */
export function rolesForClaims(
  assertedGroups: readonly string[],
  mappings: readonly RoleMapping[],
  defaultRoleKeys: readonly string[],
): readonly string[] {
  const asserted = new Set(assertedGroups);
  const roles = new Set(defaultRoleKeys);
  for (const mapping of mappings) {
    if (asserted.has(mapping.claimValue)) {
      roles.add(mapping.roleKey);
    }
  }
  return Object.freeze([...roles]);
}

/**
 * Whether an email address belongs to a domain the provider claims.
 *
 * 17 §2: *"the tenant's domain determines the provider"*. Matched on the whole label after the
 * `@`, never as a substring: `evil-acme.com` must not match a provider claiming `acme.com`, and
 * `endsWith` alone would let it.
 */
export function domainMatches(email: string, domains: readonly string[]): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) {
    return false;
  }
  const domain = email.slice(at + 1).toLowerCase();
  return domains.some((claimed) => {
    const candidate = claimed.trim().toLowerCase().replace(/^@/, '');
    return candidate.length > 0 && (domain === candidate || domain.endsWith(`.${candidate}`));
  });
}

// ---------------------------------------------------------------------------------------
// Audit streaming
// ---------------------------------------------------------------------------------------

/**
 * How a tenant's security events reach their SIEM.
 *
 * **Both, and they are not alternatives.** 13 §6 calls the sink *"optional per tenant"*, and the
 * two shapes answer different operational questions:
 *
 * - `PULL` is a cursor the customer's collector polls. It needs no outbound request from this
 *   product at all, so it works for a customer whose collector is inside their own network — which
 *   is most of them — and it cannot be the source of an SSRF.
 * - `PUSH` posts batches to an HTTPS collector on the outbound allow-list. It costs a configured
 *   URL and the whole of 17 §6's SSRF row, and it is what a customer without a poller wants.
 *
 * The cursor is the same object in both: `audit_event.sequence` is per-tenant, monotonic and
 * **gap-free**, which is a stronger guarantee than most SIEM integrations can offer — a consumer
 * that has seen sequence N and receives N+2 knows it missed one, rather than hoping a timestamp
 * window caught everything.
 */
export const AuditSinkKind = {
  PULL: 'PULL',
  PUSH: 'PUSH',
} as const;

export type AuditSinkKindKey = (typeof AuditSinkKind)[keyof typeof AuditSinkKind];

/**
 * Which actions a sink carries when it is filtered to security events.
 *
 * 13 §6 says *"streaming of security events"* rather than of the whole trail, and the distinction
 * is worth keeping: a tenant that streams every `DOCUMENT_VIEWED` row into a SIEM priced by
 * ingested volume has bought a large bill for the read-audit buffer's output. A sink names the
 * actions it wants; an empty list means the whole trail, on the same reasoning as a webhook's
 * empty event list.
 */
export function sinkCarries(actions: readonly string[], action: string): boolean {
  return actions.length === 0 || actions.includes(action);
}
