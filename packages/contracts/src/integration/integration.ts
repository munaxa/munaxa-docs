import { z } from 'zod';

import { ALL_API_SCOPES, AuditSinkKind, IdentityProviderKind } from '@edms/domain';

import type { AdministeredRecord } from '../admin/record';
import { isoDateTimeSchema, uuidSchema } from '../common/identifiers';
import { pageQuerySchema } from '../common/pagination';

/**
 * Phase 17 — the integration platform.
 *
 * Four resources behind one permission, and what each shape deliberately cannot say.
 *
 * **An API client names a subject and cannot name a permission.** There is no permission field
 * anywhere in this file. What a key may do is the *intersection* of its scopes with what its
 * subject holds, computed server-side on every request — so a client that could name a permission
 * could grant itself one, which is the whole failure mode
 * [ADR-0018](../../../../docs/architecture/adr/0018-machine-identity-as-a-delegated-subject.md)
 * exists to prevent.
 *
 * **A minted key's secret appears in exactly one response and no schema anywhere else.** `ApiClient`
 * has no secret field; `MintedApiClient` has one and is the body of a `POST` and of nothing else.
 * A client cannot ask for it back, because there is no request that would return it.
 *
 * **There is no update body for an API client.** Changing a key's scopes or its subject silently
 * changes what a running integration can do, and the failure surfaces as somebody's nightly job
 * starting to `403` with nothing in their own logs to explain it. Revoke and mint is one more step
 * and is a fact both sides can see.
 *
 * **A webhook endpoint's secret is write-only in both directions.** It is accepted on create — a
 * receiver may already have one — and it is never in a response, on the same reasoning as a
 * password hash: the read path exists for administrators looking at configuration, and a
 * configuration screen that shows the signing key turns every screen-share into a disclosure.
 *
 * **An identity provider maps groups to roles and never the reverse.** `roleMappings` is a list of
 * *provider value* → *Munaxa role key*, so nothing a provider asserts can name a role directly.
 * 17 §2's "pre-mapped" is the word doing the work: a provider that could name a role would be a
 * provider that can grant itself `user:manage`.
 *
 * **An audit sink's cursor is a string.** `sequence` is a `BIGINT` in the database and exceeds
 * `Number.MAX_SAFE_INTEGER` at scale; the audit contract has carried it as a string since Phase 9
 * for the same reason, and a stream whose cursor silently loses precision would skip events and
 * report itself gap-free.
 */

export const apiScopeSchema = z.enum(ALL_API_SCOPES as unknown as [string, ...string[]]);

export const auditSinkKindSchema = z.nativeEnum(AuditSinkKind);
export const identityProviderKindSchema = z.nativeEnum(IdentityProviderKind);

// --- API clients ------------------------------------------------------------------------

/**
 * One machine credential, as every list and detail screen renders it. There is no secret here.
 *
 * It carries `AdministeredRecord`'s stamps like every other administered resource, and its
 * `deletedAt` is the **revocation**: a revoked key is not deleted, it is withdrawn, and the two
 * are the same fact for a screen that renders "no longer usable". That is what lets the ordinary
 * list component render it with no special case — and the reason `revokedAt` is also present is
 * that the *word* matters to an administrator reading an access review, where "deleted" would
 * suggest the row could have gone.
 */
export interface ApiClient extends AdministeredRecord {
  readonly name: string;
  readonly description: string | null;
  /** The visible selector, so an administrator can match a row to a key somebody is holding. */
  readonly keyPrefix: string;
  readonly subjectUserId: string;
  readonly subjectDisplayName: string | null;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/**
 * The one response that carries a secret, and the only one.
 *
 * `secret` is the full key. It is not stored, not recoverable and not in the audit payload — the
 * trail records that a key was created, for which subject and with which scopes, which is
 * everything an investigation needs and none of what would let it sign in as one.
 */
export interface MintedApiClient {
  readonly client: ApiClient;
  readonly secret: string;
}

export const createApiClientSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    /**
     * Whose reach this key has. Required, with no default — a default would make the *least*
     * deliberate configuration the one that happens by accident, and the accident here is a key
     * bound to whoever the server picked.
     */
    subjectUserId: uuidSchema,
    scopes: z.array(apiScopeSchema).min(1).max(ALL_API_SCOPES.length),
    expiresAt: isoDateTimeSchema.optional(),
  })
  .strict();

export type CreateApiClientBody = z.infer<typeof createApiClientSchema>;

export const apiClientListQuerySchema = pageQuerySchema;

// --- Webhooks ---------------------------------------------------------------------------

export interface WebhookEndpoint extends AdministeredRecord {
  readonly name: string;
  readonly url: string;
  /** Empty means every event — the default, and argued for in `webhookSubscribes`. */
  readonly eventTypes: readonly string[];
  readonly enabled: boolean;
  readonly failureCount: number;
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
}

export interface WebhookDelivery {
  readonly id: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly state: 'PENDING' | 'DELIVERED' | 'RETRYING' | 'DEAD';
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly deliveredAt: string | null;
  readonly responseStatus: number | null;
  readonly lastError: string | null;
  readonly createdAt: string;
}

/**
 * An event family, or a specific event.
 *
 * Free-form rather than an enum of the product's current event types, and that is deliberate: a
 * closed list here would need extending in this package every time any module adds an event, and
 * the failure mode of forgetting is the one the outbox routing table has had twice. Matching is on
 * a label boundary, so an unknown value simply never matches rather than doing something
 * surprising.
 */
const eventSubscriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/, 'An event type is dotted lower-case.');

export const createWebhookEndpointSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    url: z.string().url().max(2_000),
    /**
     * The signing key the receiver will verify with.
     *
     * Optional: omitted, the server generates one and returns it once, exactly as an API key's
     * secret is returned once. Supplied, it is because the receiver already has one — which is the
     * common case when somebody is pointing this at a platform that issued them a secret.
     */
    secret: z.string().min(32).max(200).optional(),
    eventTypes: z.array(eventSubscriptionSchema).max(50).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

export type CreateWebhookEndpointBody = z.infer<typeof createWebhookEndpointSchema>;

export const updateWebhookEndpointSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    url: z.string().url().max(2_000).optional(),
    secret: z.string().min(32).max(200).optional(),
    eventTypes: z.array(eventSubscriptionSchema).max(50).optional(),
    /**
     * Re-enabling also clears the failure count, which is why this is not merely a flag.
     *
     * An endpoint disabled by twenty consecutive failures and re-enabled with its counter intact
     * would disable itself again on the next failure, which is not what the administrator who
     * fixed their receiver asked for.
     */
    enabled: z.boolean().optional(),
  })
  .strict();

export type UpdateWebhookEndpointBody = z.infer<typeof updateWebhookEndpointSchema>;

/** The one response carrying a webhook's signing key: the create, and nothing else. */
export interface CreatedWebhookEndpoint {
  readonly endpoint: WebhookEndpoint;
  readonly secret: string;
}

export const webhookDeliveryListQuerySchema = pageQuerySchema.extend({
  state: z.enum(['PENDING', 'DELIVERED', 'RETRYING', 'DEAD']).optional(),
});

// --- Federation -------------------------------------------------------------------------

export interface IdentityProvider {
  readonly id: string;
  readonly kind: z.infer<typeof identityProviderKindSchema>;
  readonly name: string;
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly clientId: string;
  readonly domains: readonly string[];
  readonly claimMapping: {
    readonly subject: string;
    readonly email: string;
    readonly displayName: string;
    readonly groups: string | null;
  };
  readonly roleMappings: readonly { readonly claimValue: string; readonly roleKey: string }[];
  readonly defaultRoleKeys: readonly string[];
  readonly jitProvisioning: boolean;
  readonly enabled: boolean;
  readonly version: number;
}

const claimMappingSchema = z
  .object({
    subject: z.string().trim().min(1).max(80).default('sub'),
    email: z.string().trim().min(1).max(80).default('email'),
    displayName: z.string().trim().min(1).max(80).default('name'),
    /**
     * Null where the provider issues no groups claim.
     *
     * Google Workspace's ID token is the case this exists for: it has no groups claim at all, so a
     * schema requiring one would make the second of the brief's two named providers
     * unconfigurable.
     */
    groups: z.string().trim().min(1).max(80).nullable().default('groups'),
  })
  .strict();

export const upsertIdentityProviderSchema = z
  .object({
    kind: identityProviderKindSchema.default('OIDC'),
    name: z.string().trim().min(1).max(120),
    issuer: z.string().url().max(500),
    discoveryUrl: z.string().url().max(500),
    clientId: z.string().trim().min(1).max(300),
    /** Write-only, like a webhook secret and for the same reason. */
    clientSecret: z.string().min(1).max(500),
    domains: z.array(z.string().trim().min(1).max(253)).min(1).max(20),
    claimMapping: claimMappingSchema.optional(),
    roleMappings: z
      .array(
        z
          .object({
            claimValue: z.string().trim().min(1).max(300),
            roleKey: z.string().trim().min(1).max(80),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    defaultRoleKeys: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
    jitProvisioning: z.boolean().default(true),
    enabled: z.boolean().default(false),
  })
  .strict();

export type UpsertIdentityProviderBody = z.infer<typeof upsertIdentityProviderSchema>;

/**
 * What an unauthenticated caller may learn about a tenant's federation, for one address.
 *
 * Deliberately thin. It answers *"should this address see a password box or a redirect"* and
 * nothing else — no issuer, no client id, no provider name — because a sign-in screen is a public
 * surface and "which company uses which identity provider" is not a fact this endpoint should
 * publish about a customer. A caller supplying an address at a domain no provider claims gets
 * `federated: false`, which is also the answer for a tenant with no provider at all: the two are
 * indistinguishable, so the endpoint is not a probe for which tenants federate.
 */
export interface FederationDiscovery {
  readonly federated: boolean;
  /** Present only when `federated` — the URL to send the browser to. */
  readonly authorizationUrl: string | null;
}

export const federationDiscoverySchema = z
  .object({ email: z.string().trim().email().max(320) })
  .strict();

export const federationCallbackSchema = z
  .object({
    code: z.string().min(1).max(4_000),
    /**
     * The CSRF token the authorization request carried.
     *
     * Not optional. An OIDC callback without a verified `state` is an endpoint that will exchange
     * any code anybody sends it, which is login-CSRF: an attacker completes a flow with *their*
     * provider account and the victim's browser ends up signed in as the attacker.
     */
    state: z.string().min(1).max(500),
    tenant: z.string().trim().min(1).max(63).optional(),
  })
  .strict();

export type FederationCallbackBody = z.infer<typeof federationCallbackSchema>;

// --- Audit sink -------------------------------------------------------------------------

export interface AuditSink {
  readonly id: string;
  readonly kind: z.infer<typeof auditSinkKindSchema>;
  readonly name: string;
  readonly endpointUrl: string | null;
  readonly actions: readonly string[];
  /** A string: `sequence` is a `BIGINT` and exceeds `Number.MAX_SAFE_INTEGER` at scale. */
  readonly lastStreamedSequence: string;
  readonly lastStreamedAt: string | null;
  readonly lastError: string | null;
  readonly enabled: boolean;
  readonly version: number;
}

export const upsertAuditSinkSchema = z
  .object({
    kind: auditSinkKindSchema,
    name: z.string().trim().min(1).max(120),
    /** Required for `PUSH`, refused for `PULL` — checked in the use case, where the pair is known. */
    endpointUrl: z.string().url().max(2_000).optional(),
    secret: z.string().min(32).max(200).optional(),
    /** Empty means the whole trail. Naming actions is how a volume-priced SIEM stays affordable. */
    actions: z.array(z.string().trim().min(1).max(80)).max(200).default([]),
    enabled: z.boolean().default(false),
  })
  .strict();

export type UpsertAuditSinkBody = z.infer<typeof upsertAuditSinkSchema>;

/**
 * The pull cursor's query.
 *
 * `afterSequence` rather than a page number, because the guarantee this endpoint exists to offer
 * is completeness: a collector that has seen N asks for what came after N, and a gap in what comes
 * back is a **finding** rather than a paging artefact. An offset would give a different answer
 * depending on when it was asked.
 */
export const auditStreamQuerySchema = z
  .object({
    afterSequence: z.string().regex(/^\d+$/, 'A cursor is a whole number.').max(20).default('0'),
    limit: z.coerce.number().int().min(1).max(2_000).optional(),
  })
  .strict();

export interface AuditStreamPage {
  readonly events: readonly unknown[];
  /** Where to resume. Equal to the last event's sequence, or to the request's when empty. */
  readonly cursor: string;
  readonly hasMore: boolean;
}
