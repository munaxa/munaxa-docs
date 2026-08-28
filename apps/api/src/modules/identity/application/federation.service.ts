import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type TenantId,
  type UserId,
  AuditOutcome,
  AuditSubjectType,
  Settings,
  asId,
  domainMatches,
  rolesForClaims,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import {
  AUDIT_WRITER,
  type AuditActor,
  type AuditWriter,
} from '../../../core/audit/audit-writer.port';
import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { UnauthenticatedError } from '../../../core/errors/application-errors';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { TENANT_REGISTRY, type TenantRegistry } from '../../../core/tenancy/tenant-registry.port';
import { CACHE_PORT, type CachePort } from '../../../ports/cache.port';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { IntegrationAudit, SecurityAudit } from '../domain/audit-actions';
import {
  claimAsStrings,
  constantTimeEquals,
  digestOf,
  verifyIdToken,
  type Jwk,
} from '../domain/oidc';
import { normalizeEmail } from '../domain/user';
import {
  ACCESS_TOKEN_ISSUER,
  type AccessTokenIssuer,
  type AuthenticationResult,
  REFRESH_TOKEN_FACTORY,
  type RefreshTokenFactory,
} from './authentication.ports';
import {
  IDENTITY_PROVIDER_REPOSITORY,
  OIDC_DISCOVERY,
  type FederationOffer,
  type FederationService,
  type IdentityProviderRepository,
  type OidcDiscovery,
  type PendingAuthorization,
} from './federation.ports';
import {
  CREDENTIAL_REPOSITORY,
  type CredentialRepository,
  FEDERATED_USER_REPOSITORY,
  type FederatedUserRepository,
  SESSION_REPOSITORY,
  type SessionRepository,
} from './ports';

/** One rejection message for every way a callback can fail. The log records which it was. */
const REJECTED = 'That sign-in could not be completed.';

/** How long a browser has to come back from the provider. Ten minutes is generous for a redirect. */
const AUTHORIZATION_TTL_SECONDS = 600;

/**
 * Federated sign-in — one adapter, and the tenant's domain chooses the provider.
 *
 * ## The flow, and the two checks that make it safe
 *
 * The browser asks `GET /auth/federation` with an address. If the address's domain is one this
 * tenant's provider claims, a `state` and a `nonce` are generated, their **digests** are stored in
 * the cache under the state's digest, and the browser is sent to the provider. The provider sends
 * it back with a code, the code is exchanged for an ID token over TLS with the client secret, and
 * the token is verified.
 *
 * `state` is the CSRF defence. Without it this endpoint exchanges any code anybody sends it, which
 * is **login CSRF**: an attacker completes a flow against their own provider account, hands the
 * resulting code to a victim's browser, and the victim ends up signed in as the attacker — after
 * which everything they do lands in the attacker's account. It is stored server-side rather than
 * in a cookie because the callback may arrive on a different origin from the one that started.
 *
 * `nonce` is the replay defence, and it is checked inside `verifyIdToken` rather than here, so a
 * token captured from any other flow with the same provider fails verification rather than failing
 * a check somebody could forget to call.
 *
 * ## JIT provisioning, and what it may not do
 *
 * 17 §2: *"JIT provisioning to pre-mapped roles"*. `ProvisioningService` bootstraps a *tenant* and
 * was the nearest existing seam; it is deliberately not reused, because what it does — create an
 * organisation, seed eight roles, refuse to run twice — is a different act from creating one
 * person on their first sign-in, and generalising it would put the tenant bootstrap one branch
 * away from a path an unauthenticated caller reaches.
 *
 * What provisioning may grant is **exactly what the mapping says and nothing more**:
 * `rolesForClaims` is pure, the mapping runs one way, and a role key that resolves to no role in
 * this tenant is dropped rather than created. A returning federated user's roles are **not**
 * re-synchronised on every sign-in, and that is the decision to argue: re-synchronising would make
 * the provider the authority on Munaxa roles, so an administrator's local grant of
 * `document:approve` would silently vanish at the person's next sign-in. The mapping decides what
 * somebody *starts* with; what they end up with is this tenant's own business.
 */
@Injectable()
export class DefaultFederationService implements FederationService {
  constructor(
    @Inject(IDENTITY_PROVIDER_REPOSITORY) private readonly providers: IdentityProviderRepository,
    @Inject(OIDC_DISCOVERY) private readonly discovery: OidcDiscovery,
    @Inject(FEDERATED_USER_REPOSITORY) private readonly users: FederatedUserRepository,
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(ACCESS_TOKEN_ISSUER) private readonly accessTokens: AccessTokenIssuer,
    @Inject(REFRESH_TOKEN_FACTORY) private readonly refreshTokens: RefreshTokenFactory,
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.redirectUri = config.auth.federationRedirectUri;
  }

  /**
   * Where the provider sends the browser back to.
   *
   * A **single** configured value rather than one the caller supplies, and that is the check whose
   * absence is the open-redirect in every hand-rolled OIDC integration: a `redirect_uri` taken
   * from the request is a `redirect_uri` an attacker sets to their own site, and the provider will
   * happily deliver the authorization code there. It is registered with the provider too, which is
   * the second half of the same defence — but only the half we do not control.
   */
  private readonly redirectUri: string;

  async offerFor(email: string, tenantSlug: string): Promise<FederationOffer> {
    const tenantId = await this.resolveTenant(tenantSlug);
    if (!tenantId) {
      return NOT_FEDERATED;
    }

    // `run` rather than context alone. `find()` reads through `requireTransaction()`, and a context
    // without a unit of work has none — so this threw `NoActiveTransactionError`, which is neither a
    // `DomainError` nor an `HttpException` and therefore left `AllExceptionsFilter` answering `500`.
    // Only for a tenant that had switched federation on, because the gate above returns first for
    // everyone else: the endpoint failed precisely for the tenants using the feature. The settings
    // read is unaffected either way — its repository falls back to the tenant's own client — but it
    // belongs inside the same unit of work now that there is one, so both reads see one snapshot.
    // The provider's own HTTP stays outside it, which is the boundary this method already had.
    const resolved = await this.within(tenantId, () =>
      this.unitOfWork.run(async () => {
        if (!(await this.settings.get(Settings.FEATURE_FEDERATION))) {
          return null;
        }
        const provider = await this.providers.find();
        if (!provider || !provider.enabled) {
          return null;
        }
        // The domain decides, on a label boundary — `evil-acme.com` must not select the provider
        // that claims `acme.com`.
        return domainMatches(normalizeEmail(email), provider.domains) ? provider : null;
      }),
    );

    if (!resolved) {
      // The same answer for "no such tenant", "no provider", "provider disabled" and "domain not
      // claimed". A sign-in screen is a public surface and "which company uses which identity
      // provider" is not a fact it should publish about a customer.
      return NOT_FEDERATED;
    }

    const metadata = await this.discovery.resolve(resolved);
    if (!metadata) {
      // A provider whose discovery document is unreachable falls back to the password box rather
      // than to an error page. The tenant's local credentials still work; 17 §2 lists federation
      // beside them rather than instead of them.
      this.logger.warn('A provider’s discovery document could not be read', {
        providerId: resolved.id,
      });
      return NOT_FEDERATED;
    }

    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const pending: PendingAuthorization = {
      tenantId,
      nonceDigest: digestOf(nonce),
      redirectUri: this.redirectUri,
      createdAt: this.clock.now().toISOString(),
    };
    // Keyed by the state's digest and holding the nonce's, so a leaked cache yields neither in a
    // usable form. Bounded by a TTL, because an authorization somebody abandoned must not sit
    // there for ever waiting to be completed.
    await this.cache.set(cacheKey(digestOf(state)), pending, AUTHORIZATION_TTL_SECONDS);

    const url = new URL(metadata.document.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', resolved.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    // The address the user typed, so the provider can skip its own account chooser. A hint and
    // nothing more: what comes back is decided by the token's `sub`, never by this.
    url.searchParams.set('login_hint', email);

    return { federated: true, authorizationUrl: url.toString() };
  }

  async complete(input: {
    readonly code: string;
    readonly state: string;
    readonly tenantSlug: string;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
    readonly correlationId: string;
    readonly locale: string;
  }): Promise<AuthenticationResult> {
    const pending = await this.cache.get<PendingAuthorization>(cacheKey(digestOf(input.state)));
    if (!pending) {
      // An unknown, expired or already-used state. The `delete` below makes a state single-use,
      // so a replayed callback lands here.
      this.logger.warn('A federation callback presented an unknown state', {
        correlationId: input.correlationId,
      });
      throw new UnauthenticatedError(REJECTED);
    }
    await this.cache.delete(cacheKey(digestOf(input.state)));

    const tenantId = pending.tenantId;
    // Its own unit of work, and deliberately not the one the provisioning block below opens: the
    // token exchange between them is the provider's HTTP endpoint, and holding a database
    // transaction across somebody else's network call is how a slow provider becomes a database
    // outage. This read needs a transaction because `findCredential` reads through one.
    const provider = await this.within(tenantId, () =>
      this.unitOfWork.run(() => this.providers.findCredential()),
    );
    if (!provider || !provider.enabled) {
      throw new UnauthenticatedError(REJECTED);
    }

    const metadata = await this.discovery.resolve(provider);
    if (!metadata) {
      throw new UnauthenticatedError(REJECTED);
    }
    const exchanged = await this.discovery.exchange(
      provider,
      metadata.document,
      input.code,
      pending.redirectUri,
    );
    if (!exchanged) {
      this.logger.warn('A token exchange was refused by the provider', {
        correlationId: input.correlationId,
      });
      throw new UnauthenticatedError(REJECTED);
    }

    // The nonce is compared against the digest we stored, so the cache never holds the value that
    // would let somebody forge a token — and `verifyIdToken` does the comparison in constant time
    // against the claim. The digest round trip is why the plaintext nonce is reconstructed from
    // the token rather than from the cache.
    const outcome = verifyIdToken(exchanged.idToken, metadata.keys as readonly Jwk[], {
      issuer: provider.issuer,
      audience: provider.clientId,
      nonce: nonceFromToken(exchanged.idToken),
      now: this.clock.now(),
    });
    if (!outcome.ok) {
      this.logger.warn('A federated ID token was refused', {
        reason: outcome.reason,
        correlationId: input.correlationId,
      });
      await this.recordFailure(tenantId, input, outcome.reason);
      throw new UnauthenticatedError(REJECTED);
    }
    // The nonce claim is compared against the digest we stored. `verifyIdToken` has already
    // checked the claim is a string and matches what was passed in; this is what binds it to
    // *our* flow rather than to any flow.
    const presentedNonce = outcome.claims['nonce'];
    if (
      typeof presentedNonce !== 'string' ||
      !constantTimeEquals(digestOf(presentedNonce), pending.nonceDigest)
    ) {
      this.logger.warn('A federated ID token carried another flow’s nonce', {
        correlationId: input.correlationId,
      });
      await this.recordFailure(tenantId, input, 'NONCE_NOT_OURS');
      throw new UnauthenticatedError(REJECTED);
    }

    const mapping = provider.claimMapping;
    // Read as strings or not at all. A provider that sends an object where a subject belongs is a
    // provider whose assertion this product does not understand, and coercing it would put
    // `[object Object]` in the column that identifies a person for ever.
    const externalId = claimAsString(outcome.claims[mapping.subject]);
    const email = normalizeEmail(claimAsString(outcome.claims[mapping.email]));
    const displayName = claimAsString(outcome.claims[mapping.displayName]) || email;
    const groups = mapping.groups === null ? [] : claimAsStrings(outcome.claims[mapping.groups]);

    if (externalId === '' || email === '') {
      await this.recordFailure(tenantId, input, 'INCOMPLETE_CLAIMS');
      throw new UnauthenticatedError(REJECTED);
    }

    return this.within(tenantId, () =>
      this.unitOfWork.run(async () => {
        const now = this.clock.now();
        const existing = await this.users.findByExternalIdentity(provider.id, externalId, email);

        let userId: UserId;
        if (existing) {
          userId = existing;
          // Binds a local account to this provider the first time its holder signs in through it,
          // and refreshes the display name. Deliberately **not** the roles — see the class note.
          await this.users.linkToProvider(userId, provider.id, externalId, displayName, now);
        } else {
          if (!provider.jitProvisioning) {
            await this.recordFailure(tenantId, input, 'NO_ACCOUNT_AND_JIT_OFF');
            throw new UnauthenticatedError(REJECTED);
          }
          // Exactly what the mapping says, and nothing more. `rolesForClaims` is pure and runs one
          // way; an asserted group nobody mapped contributes nothing, and a mapped role key that
          // does not exist in this tenant is dropped by the repository rather than created.
          const roleKeys = rolesForClaims(groups, provider.roleMappings, provider.defaultRoleKeys);
          const candidate = asId<UserId>(uuidv7(now.getTime()));
          const provisioned = await this.users.provision({
            id: candidate,
            email,
            emailNormalized: email,
            displayName,
            providerId: provider.id,
            externalId,
            roleKeys,
            at: now,
          });

          if (provisioned) {
            userId = candidate;
            await this.audit.write(this.actor(tenantId, input, userId), {
              action: IntegrationAudit.USER_PROVISIONED_FROM_PROVIDER,
              subjectType: AuditSubjectType.USER,
              subjectId: userId,
              outcome: AuditOutcome.SUCCESS,
              // Which provider said so, and what the mapping produced. This is what makes "which
              // accounts exist because Entra said so, and what did the mapping give them" one query.
              payload: {
                providerId: provider.id,
                assertedGroups: groups.length,
                roleKeys: [...roleKeys],
              },
            });
          } else {
            /*
             * Another callback carrying this same subject reached the insert first — Slice 61.
             *
             * The read above and that insert are the same question asked at two moments, and
             * somebody signing in for the first time from two tabs asks it twice at once. This
             * caller is now in exactly the position of one that arrived *second in order*, and is
             * owed what that one is given: the account that exists, signed in against. No second
             * account, no second grant, and no second provisioning event — the account was not
             * created here, so saying it was would file an act that never happened.
             */
            const winner = await this.users.findByExternalIdentity(provider.id, externalId, email);
            if (winner === null) {
              // Not this race. The address is already held at this tenant by an account this
              // subject is not, which the sequential path meets as a raw constraint violation.
              // Refusing is what every other "we will not sign you in" on this path does.
              throw new UnauthenticatedError(REJECTED);
            }
            userId = winner;
            // The same link the existing-account branch above makes, and for the same reason.
            await this.users.linkToProvider(userId, provider.id, externalId, displayName, now);
          }
        }

        const credential = await this.credentials.findById(userId);
        if (!credential) {
          throw new UnauthenticatedError(REJECTED);
        }

        const familyId = asId<AnyId>(uuidv7(now.getTime()));
        await this.sessions.createFamily({
          id: familyId,
          userId,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        });
        await this.credentials.recordSignIn(userId, now);
        await this.audit.write(this.actor(tenantId, input, userId), {
          action: SecurityAudit.LOGIN_SUCCEEDED,
          subjectType: AuditSubjectType.SESSION,
          subjectId: familyId,
          outcome: AuditOutcome.SUCCESS,
          // The trail says *how* somebody signed in, which is the question that distinguishes "a
          // password leaked" from "a directory account was compromised".
          payload: { userId, method: 'FEDERATED', providerId: provider.id },
        });

        const refresh = this.refreshTokens.create(now);
        await this.sessions.issueToken({
          id: asId<AnyId>(uuidv7(now.getTime())),
          familyId,
          tokenHash: refresh.hash,
          expiresAt: refresh.expiresAt,
        });
        const access = this.accessTokens.issue({
          userId: credential.id,
          tenantId,
          roles: credential.roleKeys,
          permissions: credential.permissions,
          sessionId: familyId,
          permissionVersion: credential.permissionVersion,
        });

        return {
          accessToken: access.token,
          accessTokenExpiresAt: access.expiresAt,
          refreshToken: refresh.token,
          refreshTokenExpiresAt: refresh.expiresAt,
          user: {
            id: credential.id,
            email: credential.email,
            displayName: credential.displayName,
            roleIds: credential.roleIds,
            roles: credential.roleKeys,
            permissions: credential.permissions,
            mfaEnrolled: credential.mfaEnrolled,
          },
        };
      }),
    );
  }

  /** A failed federated sign-in, recorded exactly as a failed password one is. */
  private async recordFailure(
    tenantId: TenantId,
    input: {
      readonly correlationId: string;
      readonly ipAddress: string | null;
      readonly userAgent: string | null;
    },
    reason: string,
  ): Promise<void> {
    await this.within(tenantId, () =>
      this.unitOfWork.run(async () => {
        await this.audit.write(this.actor(tenantId, input, null), {
          action: SecurityAudit.LOGIN_FAILED,
          subjectType: AuditSubjectType.SESSION,
          subjectId: asId<AnyId>(uuidv7(this.clock.now().getTime())),
          outcome: AuditOutcome.DENIED,
          // The reason code, never the token and never the address that was asserted.
          payload: { reason, method: 'FEDERATED' },
        });
      }),
    );
  }

  private actor(
    tenantId: TenantId,
    input: {
      readonly correlationId: string;
      readonly ipAddress: string | null;
      readonly userAgent: string | null;
    },
    userId: UserId | null,
  ): AuditActor {
    return {
      tenantId,
      userId,
      channel: 'API',
      correlationId: input.correlationId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    };
  }

  private async resolveTenant(slug: string): Promise<TenantId | null> {
    if (slug !== '') {
      const named = await this.registry.bySlug(slug);
      return named ? asId<TenantId>(named.id) : null;
    }
    const all = await this.registry.all();
    return all.length === 1 && all[0] ? asId<TenantId>(all[0].id) : null;
  }

  /** Establishes the context every read needs, exactly as `signIn` does before any query. */
  private within<TResult>(tenantId: TenantId, work: () => Promise<TResult>): Promise<TResult> {
    const context: RequestContext = {
      tenantId,
      userId: null,
      roles: [],
      permissions: [],
      sessionId: null,
      correlationId: `federation:${tenantId}`,
      permissionVersion: 0,
      locale: 'en',
      channel: 'API',
    };
    return runWithContext(context, work);
  }
}

const NOT_FEDERATED: FederationOffer = Object.freeze({ federated: false, authorizationUrl: null });

/** A claim, if it is a string. Anything else is absent rather than stringified. */
function claimAsString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function cacheKey(stateDigest: string): string {
  return `federation:authorization:${stateDigest}`;
}

/**
 * Reads the nonce claim without verifying anything.
 *
 * This looks alarming and is not: the value is handed straight back to `verifyIdToken`, which
 * compares it against the claim *inside a verified signature*, and the caller then compares its
 * digest against the one it stored. So an attacker rewriting this field rewrites both sides of a
 * comparison that proves nothing on its own — and then fails the digest check against the cache,
 * which is the one that matters. The alternative is holding the plaintext nonce in the cache,
 * which is what storing digests exists to avoid.
 */
function nonceFromToken(token: string): string {
  const payload = token.split('.')[1];
  if (payload === undefined) {
    return '';
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const nonce = (parsed as Record<string, unknown> | null)?.['nonce'];
    return typeof nonce === 'string' ? nonce : '';
  } catch {
    return '';
  }
}
