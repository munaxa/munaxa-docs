import type { AnyId, ApiScopeKey, PermissionKey, TenantId, UserId } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * The machine caller's contracts — Phase 17.
 *
 * `AuthenticationService.signIn` has been password-only since Phase 1, and this is not a second
 * sign-in: an API key exchanges for **no session, no refresh token and no access token**. It is
 * presented on every request and resolved on every request, which is the whole difference between
 * a credential a script holds and a session a person holds.
 *
 * That resolution is what
 * [ADR-0018](../../../../../docs/architecture/adr/0018-machine-identity-as-a-delegated-subject.md)
 * is about, and the shape below encodes its consequence: `ApiClientPrincipal.subjectUserId` is not
 * optional, and it is the value that becomes `RequestContext.userId`.
 */

export const API_CLIENT_REPOSITORY = Symbol('ApiClientRepository');
export const API_CLIENT_SERVICE = Symbol('ApiClientService');
export const API_CLIENT_AUTHENTICATOR = Symbol('ApiClientAuthenticator');

/** A client as it is stored. The secret is a digest and is never returned by any read path. */
export interface ApiClientRecord {
  readonly id: AnyId;
  readonly name: string;
  readonly description: string | null;
  readonly keyPrefix: string;
  readonly subjectUserId: UserId;
  readonly scopes: readonly ApiScopeKey[];
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly createdBy: UserId | null;
  readonly updatedAt: Date;
  readonly updatedBy: UserId | null;
  /**
   * The revocation, under the name every administered list already renders.
   *
   * Equal to `revokedAt` rather than a second column: a revoked key is *withdrawn*, and for a
   * screen asking "is this row still usable" that is the same fact a soft delete is. Carrying both
   * lets the ordinary list component render it with no special case while an access review still
   * reads the honest word.
   */
  readonly deletedAt: Date | null;
  readonly deletedBy: UserId | null;
  readonly version: number;
}

/** What the authenticator needs, and nothing else: the digest, the subject, the bounds. */
export interface ApiClientCredential {
  readonly id: AnyId;
  readonly secretHash: string;
  readonly subjectUserId: UserId;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface ApiClientRepository {
  /**
   * The authenticator's lookup, by the key's clear prefix.
   *
   * One indexed read rather than a scan that verifies every row's digest in turn — which is why
   * the key carries a selector at all. The digest is still verified afterwards, in constant time,
   * so the prefix narrows the search and proves nothing.
   */
  findCredentialByPrefix(prefix: string): Promise<ApiClientCredential | null>;
  findById(id: AnyId): Promise<ApiClientRecord | null>;
  list(page: PageRequest): Promise<Page<ApiClientRecord>>;
  create(input: {
    readonly id: AnyId;
    readonly name: string;
    readonly description: string | null;
    readonly keyPrefix: string;
    readonly secretHash: string;
    readonly subjectUserId: UserId;
    readonly scopes: readonly string[];
    readonly expiresAt: Date | null;
  }): Promise<ApiClientRecord>;
  revoke(id: AnyId, at: Date, by: UserId | null, expectedVersion: number): Promise<ApiClientRecord>;
  /**
   * Stamps the last use.
   *
   * Deliberately **outside** the request's transaction and deliberately coarse — it writes at most
   * once an hour per key. A write on every authenticated request would put an `UPDATE` in front of
   * every read a machine performs, and would make two concurrent requests on one key contend on
   * one row. "This key was used today" is what an administrator deciding whether to revoke needs;
   * "this key was used 41ms ago" is not.
   */
  touch(id: AnyId, at: Date): Promise<void>;
}

/**
 * Who a presented key resolves to.
 *
 * The permissions are already the intersection: `effectiveApiPermissions(subject's grants, scopes)`
 * has been applied, so nothing downstream has to remember to. A caller reading this cannot
 * accidentally use the subject's unfiltered set, because it is not on the object.
 */
export interface ApiClientPrincipal {
  readonly apiClientId: AnyId;
  readonly tenantId: TenantId;
  /** The person this key acts as. Never null — see ADR-0018 and the schema comment beside it. */
  readonly subjectUserId: UserId;
  readonly roleKeys: readonly string[];
  readonly roleIds: readonly AnyId[];
  readonly permissions: readonly PermissionKey[];
  readonly permissionVersion: number;
}

export interface ApiClientAuthenticator {
  /**
   * Resolves a presented key against one tenant, or `null`.
   *
   * Null for every failure without distinction — unknown prefix, wrong secret, revoked, expired,
   * subject disabled, feature flag off. The reasoning is `signIn`'s, unchanged: a caller holding a
   * key that stopped working learns that it stopped working, and a caller *probing* keys learns
   * nothing about which of the six they hit.
   */
  authenticate(tenantId: TenantId, presented: string): Promise<ApiClientPrincipal | null>;
}

/** A key at the one moment its secret exists in clear: the response to the request that made it. */
export interface MintedApiClient {
  readonly client: ApiClientRecord;
  /**
   * The full key, returned **once and never again**.
   *
   * Not stored, not recoverable, and not in the audit payload — the trail records that a key was
   * created, by whom, for which subject and with which scopes, which is everything an
   * investigation needs and none of what would let it sign in as one.
   */
  readonly secret: string;
}

export interface CreateApiClientCommand {
  readonly name: string;
  readonly description?: string;
  readonly subjectUserId: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: string;
}

export interface ApiClientService {
  list(page: PageRequest): Promise<Page<ApiClientRecord>>;
  get(id: string): Promise<ApiClientRecord>;
  create(command: CreateApiClientCommand): Promise<MintedApiClient>;
  /**
   * Revocation, and there is no `update`.
   *
   * A key's scopes and subject are what its holder was told they had; changing either silently
   * changes what a running integration can do, and the failure would surface as somebody's
   * nightly job starting to `403` with nothing in their own logs to explain it. Revoke and mint
   * is one more step for an administrator and is a fact both sides can see.
   */
  revoke(id: string, expectedVersion: number | undefined): Promise<ApiClientRecord>;
}
