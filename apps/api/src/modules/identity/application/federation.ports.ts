import type { AnyId, ClaimMapping, RoleMapping, TenantId } from '@edms/domain';

import type { AuthenticationResult } from './authentication.ports';

/**
 * Federation's contracts — Phase 17, and the phase's first sorting decision made concrete.
 *
 * The brief names **SSO, LDAP, Azure AD, Microsoft 365 and Google Workspace** as five items. They
 * are not five integrations:
 *
 * - **SSO, Azure AD and Google Workspace are one adapter.** 17 §2 already decided the shape —
 *   *"Per-tenant OIDC/SAML; the tenant's domain determines the provider; JIT provisioning to
 *   pre-mapped roles"* — and Entra ID and Google Workspace are OIDC providers that differ in
 *   their **discovery URL** and in **which claim carries the groups**. Both of those are columns
 *   on `identity_provider`. Building three adapters would be building one adapter three times, and
 *   the third would be the one that drifts.
 * - **LDAP is genuinely different and is not built.** It is a wire protocol rather than an HTTP
 *   redirect flow: BER-encoded ASN.1 over a socket, with its own bind, search and TLS
 *   negotiation. `ldapjs` is absent from the store entirely and the lockfile cannot gain it, so
 *   the choice was between hand-writing an ASN.1 codec in a security product and naming the phase
 *   that closes it. The report names the phase.
 * - **Microsoft 365 is a third thing again**, and conflating it with Azure AD because both say
 *   "Microsoft" is the trap the brief warns about. It is not authentication at all — it is a
 *   *content* integration, SharePoint and OneDrive as a document source or destination — and it
 *   belongs with the import mapping the report scopes rather than here.
 *
 * ## What a provider may and may not assert
 *
 * A provider asserts **who somebody is** and **which groups they are in**. It never asserts what
 * they may do here. `RoleMapping` runs one way — provider value → Munaxa role key — so nothing in
 * a token can name a role, and 17 §2's word "pre-mapped" is what that encodes: a provider that
 * could name a role would be a provider that can grant itself `user:manage`.
 */

export const IDENTITY_PROVIDER_REPOSITORY = Symbol('IdentityProviderRepository');
export const FEDERATION_SERVICE = Symbol('FederationService');
export const OIDC_DISCOVERY = Symbol('OidcDiscovery');

export interface IdentityProviderRecord {
  readonly id: AnyId;
  readonly kind: 'OIDC';
  readonly name: string;
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly clientId: string;
  readonly domains: readonly string[];
  readonly claimMapping: ClaimMapping;
  readonly roleMappings: readonly RoleMapping[];
  readonly defaultRoleKeys: readonly string[];
  readonly jitProvisioning: boolean;
  readonly enabled: boolean;
  readonly version: number;
}

/** The provider plus its client secret — for the token exchange alone, never for a read path. */
export interface IdentityProviderCredential extends IdentityProviderRecord {
  readonly clientSecret: string;
}

export interface IdentityProviderRepository {
  find(): Promise<IdentityProviderRecord | null>;
  findCredential(): Promise<IdentityProviderCredential | null>;
  upsert(input: {
    readonly id: AnyId;
    readonly name: string;
    readonly issuer: string;
    readonly discoveryUrl: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly domains: readonly string[];
    readonly claimMapping: ClaimMapping;
    readonly roleMappings: readonly RoleMapping[];
    readonly defaultRoleKeys: readonly string[];
    readonly jitProvisioning: boolean;
    readonly enabled: boolean;
  }): Promise<IdentityProviderRecord>;
  remove(id: AnyId, at: Date): Promise<void>;
}

/**
 * What a provider publishes about itself.
 *
 * Fetched through the allow-listed outbound port and nowhere else — this is *the* URL 17 §6's SSRF
 * row has always been about, and until this phase it was the only outbound request the section
 * could point at.
 */
export interface DiscoveryDocument {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

export interface OidcDiscovery {
  /**
   * The provider's metadata and its current signing keys.
   *
   * Cached, because a discovery document and a JWKS change when a provider rotates keys — which is
   * rarely — and fetching both on every sign-in would put two outbound round trips in front of
   * every federated authentication and make the provider's availability our own.
   */
  resolve(provider: IdentityProviderRecord): Promise<{
    readonly document: DiscoveryDocument;
    readonly keys: readonly unknown[];
  } | null>;

  /** Exchanges an authorization code for the token response. One attempt, no retry. */
  exchange(
    provider: IdentityProviderCredential,
    document: DiscoveryDocument,
    code: string,
    redirectUri: string,
  ): Promise<{ readonly idToken: string } | null>;
}

/** What an unauthenticated caller learns: whether to render a password box or a redirect. */
export interface FederationOffer {
  readonly federated: boolean;
  readonly authorizationUrl: string | null;
}

export interface FederationService {
  /**
   * Whether this address federates, and where to send the browser if it does.
   *
   * Deliberately answers `federated: false` for an address at an unclaimed domain, for a tenant
   * with no provider, and for a provider that is configured but disabled — three states that are
   * indistinguishable from outside, so the endpoint is not a probe for which customers federate.
   */
  offerFor(email: string, tenantSlug: string): Promise<FederationOffer>;

  /**
   * Completes the flow: verifies the ID token, resolves or provisions the person, mints a session.
   *
   * Returns the same `AuthenticationResult` a password sign-in does. That is the point — a
   * federated session is an ordinary session, carrying the same claims and the same rotating
   * refresh token, so nothing downstream of authentication knows or cares which way somebody
   * arrived.
   */
  complete(input: {
    readonly code: string;
    readonly state: string;
    readonly tenantSlug: string;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
    readonly correlationId: string;
    readonly locale: string;
  }): Promise<AuthenticationResult>;
}

/**
 * Where an in-flight authorization request is remembered between the redirect and the callback.
 *
 * `state` and `nonce` are generated when the browser is sent to the provider and checked when it
 * comes back, so they have to outlive one request without a session to hold them — the browser is
 * at somebody else's site in between, and there is nobody signed in yet to attach them to.
 *
 * Stored **as digests** in the cache, keyed by the `state` digest. A cache that leaked would then
 * yield neither value in a usable form, and the lookup is still one key.
 */
export interface PendingAuthorization {
  readonly tenantId: TenantId;
  readonly nonceDigest: string;
  readonly redirectUri: string;
  readonly createdAt: string;
}
