import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type ApiScopeKey,
  type PermissionKey,
  type TenantId,
  type UserId,
  ALL_API_SCOPES,
  API_KEY_PREFIX,
  API_KEY_PREFIX_LENGTH,
  API_KEY_SEPARATOR,
  AuditSubjectType,
  Settings,
  asId,
  effectiveApiPermissions,
  isApiScope,
  parseApiKey,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';
import type { Page, PageRequest } from '@edms/utils';

import { NotFoundError, ValidationError } from '../../../core/errors/application-errors';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { IntegrationAudit } from '../domain/audit-actions';
import { canSignIn } from '../domain/user';
import { PASSWORD_HASHER, type PasswordHasher } from './authentication.ports';
import {
  API_CLIENT_REPOSITORY,
  type ApiClientAuthenticator,
  type ApiClientPrincipal,
  type ApiClientRecord,
  type ApiClientRepository,
  type ApiClientService,
  type CreateApiClientCommand,
  type MintedApiClient,
} from './api-client.ports';
import { CREDENTIAL_REPOSITORY, type CredentialRepository } from './ports';

/**
 * How long a `lastUsedAt` stamp is allowed to be stale before it is rewritten.
 *
 * An hour, because the question the column answers is "has anything used this key recently" and
 * an hour answers it. Writing per request would put an `UPDATE` in front of every read a machine
 * performs and make two concurrent requests on one key contend on one row.
 */
const TOUCH_INTERVAL_MS = 3_600_000;

/**
 * Minting, revoking and — separately — resolving a machine credential.
 *
 * ## The reach question, which is the hardest one in the phase
 *
 * Every route in this product is authenticated as a *person*. `RequestContext.userId` is the
 * subject of every reach decision in it: `ACL_RESOLVER.visibilityFilter` takes a subject,
 * `PrismaDocumentRepository.whereFor` builds its predicate from one, and `AclGuard` resolves a
 * chain for one. There was no principal in the product that was not somebody.
 *
 * There are three ways to give a machine a reach, and two of them are wrong:
 *
 * 1. **No subject.** The key authenticates and `userId` stays null. This is the one that looks
 *    natural and is a data breach: `visibilityCondition` answers a subject-less caller with an
 *    **empty predicate**, which is every document in the tenant, and Phase 15 found exactly that
 *    in the export lane. Every list route in the product would become a full tenant dump.
 * 2. **A principal of its own.** The key gets ACL entries, appears in the permissions screen and
 *    is nameable in an entry. This is defensible and it is a large amount of new surface — a
 *    second kind of subject in the resolver, in the search index's `acl_subjects`, in every
 *    `@ScopedTo` route and on the permissions tab — and it is Phase 11's rejected shape: a
 *    delegation that could be named in an ACL entry would be a permission grant, and so would
 *    this.
 * 3. **A delegated subject.** The key acts *as* a person, chosen when it was minted, and narrowed
 *    by scopes. Nothing in the resolver changes, nothing in the index changes, and no predicate
 *    learns what a machine is.
 *
 * [ADR-0018](../../../../../docs/architecture/adr/0018-machine-identity-as-a-delegated-subject.md)
 * chooses the third, and `api_client.subject_user_id` is `NOT NULL` so the first is not
 * representable.
 *
 * ## Read at authentication, never copied at creation
 *
 * The subject's roles and permissions are read from the credential repository **on every
 * request**, not snapshotted onto the key when it was minted. That is Phase 11's rule for
 * delegation authority applied to a credential, and the consequence is the point: removing
 * somebody's `document:approve` removes it from every key bound to them on the next call, and
 * disabling their account stops every key they back. A snapshot would make a key outlive the
 * authority that justified it, which is precisely what an offboarding process must not leave
 * behind.
 */
@Injectable()
export class DefaultApiClientService implements ApiClientService, ApiClientAuthenticator {
  constructor(
    @Inject(API_CLIENT_REPOSITORY) private readonly repository: ApiClientRepository,
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly writer: AdministeredWriter,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  // --- Administration -------------------------------------------------------------------

  list(page: PageRequest): Promise<Page<ApiClientRecord>> {
    return this.writer.read(() => this.repository.list(page));
  }

  async get(id: string): Promise<ApiClientRecord> {
    const record = await this.writer.read(() => this.repository.findById(asId<AnyId>(id)));
    if (!record) {
      throw new NotFoundError('API client');
    }
    return record;
  }

  async create(command: CreateApiClientCommand): Promise<MintedApiClient> {
    const scopes = this.checkScopes(command.scopes);
    const expiresAt = this.checkExpiry(command.expiresAt);

    const prefix = randomBytes(9).toString('base64url').slice(0, API_KEY_PREFIX_LENGTH);
    // 32 bytes of CSPRNG output. The secret is never stored, never logged and never returned
    // again; the digest is scrypt with the same parameters and the same verifier a password uses,
    // because a key stolen from a table is exactly as damaging as a password stolen from one.
    const secret = randomBytes(32).toString('base64url');
    const secretHash = await this.hasher.hash(secret);
    const id = asId<AnyId>(uuidv7(this.clock.now().getTime()));

    const client = await this.writer.write(async () => {
      // The subject must exist, be in this tenant and be able to sign in. Checked here rather
      // than left to the foreign key, because the foreign key cannot see `status` — and a key
      // bound to a disabled account would authenticate to nothing while looking live in a list.
      const subject = await this.credentials.findById(asId<UserId>(command.subjectUserId));
      if (!subject || !canSignIn(subject.status)) {
        throw new ValidationError('That subject cannot hold an API client.');
      }

      const created = await this.repository.create({
        id,
        name: command.name.trim(),
        description: command.description?.trim() ?? null,
        keyPrefix: prefix,
        secretHash,
        subjectUserId: subject.id,
        scopes,
        expiresAt,
      });

      return {
        result: created,
        change: {
          action: IntegrationAudit.API_CLIENT_CREATED,
          subjectType: AuditSubjectType.INTEGRATION,
          subjectId: id,
          operation: AdministrativeOperation.CREATED,
          // The subject and the scopes — which together are the whole of what this key can do —
          // and the visible prefix so the row can be matched to a key somebody is holding.
          // **Never the secret**, and never its digest: 13 §3's minimised payload, and a trail
          // that carried either would be a second store of the credential.
          after: {
            name: created.name,
            keyPrefix: created.keyPrefix,
            subjectUserId: created.subjectUserId,
            scopes: [...created.scopes],
            expiresAt: created.expiresAt?.toISOString() ?? null,
          },
        },
      };
    });

    return {
      client,
      secret: [API_KEY_PREFIX, prefix, secret].join(API_KEY_SEPARATOR),
    };
  }

  async revoke(id: string, expectedVersion: number | undefined): Promise<ApiClientRecord> {
    const clientId = asId<AnyId>(id);
    return this.writer.write(async () => {
      const existing = await this.repository.findById(clientId);
      if (!existing) {
        throw new NotFoundError('API client');
      }
      if (existing.revokedAt !== null) {
        // Idempotent, like sign-out: revoking a revoked key is the outcome the caller wanted.
        return {
          result: existing,
          change: {
            action: IntegrationAudit.API_CLIENT_REVOKED,
            subjectType: AuditSubjectType.INTEGRATION,
            subjectId: clientId,
            operation: AdministrativeOperation.UPDATED,
            after: { alreadyRevoked: true },
          },
        };
      }
      const context = requireContext();
      const revoked = await this.repository.revoke(
        clientId,
        this.clock.now(),
        context.userId,
        expectedVersion ?? existing.version,
      );
      return {
        result: revoked,
        change: {
          action: IntegrationAudit.API_CLIENT_REVOKED,
          subjectType: AuditSubjectType.INTEGRATION,
          subjectId: clientId,
          operation: AdministrativeOperation.UPDATED,
          before: { revokedAt: null },
          after: { revokedAt: revoked.revokedAt?.toISOString() ?? null },
        },
      };
    });
  }

  // --- Authentication -------------------------------------------------------------------

  /**
   * Resolves a presented key, or `null` — uniformly, for all six ways it can fail.
   *
   * The uniformity is the same decision `signIn` makes: somebody holding a key that stopped
   * working learns it stopped working, and somebody *probing* keys learns nothing about which
   * check refused them. The log records which it was; the caller is told one thing.
   *
   * There is no timing equalisation here, unlike `signIn`'s decoy hash, and the difference is
   * deliberate rather than an omission. `signIn`'s decoy exists because the timing difference
   * reveals **whether an email address holds an account** — a fact about a person that an
   * unauthenticated caller could otherwise enumerate. The equivalent here is whether a random
   * 12-character prefix exists, which is not a fact about anybody and is not enumerable: a
   * prefix is CSPRNG output, so learning that one of 64^12 candidates is absent costs the
   * attacker a request and gains them nothing they could act on.
   */
  async authenticate(tenantId: TenantId, presented: string): Promise<ApiClientPrincipal | null> {
    const parsed = parseApiKey(presented);
    if (!parsed) {
      return null;
    }

    const resolved = await this.unitOfWork.run(async () => {
      // The flag is read first, inside the tenant's own transaction, because a tenant that has
      // turned machine access off wants every existing key to stop working *now* rather than to
      // stop being creatable. The keys survive, disabled by the flag rather than deleted.
      const enabled = await this.settings.get(Settings.FEATURE_API_CLIENTS);
      if (!enabled) {
        return { failure: 'FEATURE_OFF' } as const;
      }

      const credential = await this.repository.findCredentialByPrefix(parsed.prefix);
      if (!credential) {
        return { failure: 'NO_SUCH_KEY' } as const;
      }
      if (!(await this.hasher.verify(parsed.secret, credential.secretHash))) {
        return { failure: 'BAD_SECRET' } as const;
      }
      if (credential.revokedAt !== null) {
        return { failure: 'REVOKED' } as const;
      }
      const now = this.clock.now();
      // Expiry as a **predicate**, not as a swept state — Phase 11's rule, and for its reason: a
      // stalled sweep must never leave a dead credential working.
      if (credential.expiresAt !== null && credential.expiresAt <= now) {
        return { failure: 'EXPIRED' } as const;
      }

      // The subject's grants, read now rather than copied when the key was minted. This is the
      // line that makes offboarding work.
      const subject = await this.credentials.findById(credential.subjectUserId);
      if (!subject || !canSignIn(subject.status)) {
        return { failure: 'SUBJECT_NOT_ELIGIBLE' } as const;
      }

      return { failure: null, credential, subject, now } as const;
    });

    if (resolved.failure !== null) {
      // The key itself is never logged, only which rule refused it.
      this.logger.warn('An API key was refused', { reason: resolved.failure });
      return null;
    }

    const { credential, subject, now } = resolved;
    await this.touchIfStale(credential.id, now);

    return {
      apiClientId: credential.id,
      tenantId,
      subjectUserId: subject.id,
      roleKeys: subject.roleKeys,
      roleIds: subject.roleIds,
      // The intersection, applied here so nothing downstream can accidentally use the subject's
      // unfiltered set: `RbacGuard` reads `context.permissions`, and what it reads is this.
      permissions: effectiveApiPermissions(
        subject.permissions,
        credential.scopes,
      ) as readonly PermissionKey[],
      permissionVersion: subject.permissionVersion,
    };
  }

  /** Coarse by an hour; see `TOUCH_INTERVAL_MS` and the repository's own note. */
  private async touchIfStale(id: AnyId, now: Date): Promise<void> {
    const last = this.lastTouched.get(id);
    if (last !== undefined && now.getTime() - last < TOUCH_INTERVAL_MS) {
      return;
    }
    this.lastTouched.set(id, now.getTime());
    await this.repository.touch(id, now);
  }

  /**
   * Per-process, and deliberately not the shared cache.
   *
   * `CACHE_PORT` would make the throttle exact across instances and would cost a Redis round trip
   * on every authenticated machine request to save a database write that happens at most hourly —
   * a worse trade in both directions. Being per-process means N instances each write once an
   * hour rather than the fleet writing once, which is N writes a day per key and is fine.
   */
  private readonly lastTouched = new Map<string, number>();

  private checkScopes(scopes: readonly string[]): readonly ApiScopeKey[] {
    const narrowed = scopes.filter((scope): scope is ApiScopeKey => isApiScope(scope));
    if (narrowed.length !== scopes.length) {
      throw new ValidationError(`A scope must be one of: ${ALL_API_SCOPES.join(', ')}.`);
    }
    if (narrowed.length === 0) {
      // A key admitting nothing is a key that authenticates and can then do nothing, which is a
      // confusing artefact rather than a useful one. Refused at creation rather than discovered
      // by whoever tries to use it.
      throw new ValidationError('An API client needs at least one scope.');
    }
    return Object.freeze([...new Set(narrowed)]);
  }

  private checkExpiry(raw: string | undefined): Date | null {
    if (raw === undefined) {
      return null;
    }
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) {
      throw new ValidationError('That expiry is not a date.');
    }
    if (at <= this.clock.now()) {
      throw new ValidationError('An expiry must be in the future.');
    }
    return at;
  }
}
