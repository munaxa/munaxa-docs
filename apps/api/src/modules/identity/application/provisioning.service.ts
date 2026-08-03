import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type RoleId,
  type TenantId,
  type UserId,
  ALL_SYSTEM_ROLES,
  AuditOutcome,
  AuditSubjectType,
  SystemRole,
  asId,
  deriveCode,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { AUDIT_WRITER, type AuditWriter } from '../../../core/audit/audit-writer.port';
import { DuplicateError, ValidationError } from '../../../core/errors/application-errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { TENANT_REGISTRY, type TenantRegistry } from '../../../core/tenancy/tenant-registry.port';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { PASSWORD_HASHER, type PasswordHasher } from './authentication.ports';
import { checkPassword } from '../domain/password-policy';
import {
  DEFAULT_ROLE_DESCRIPTIONS,
  DEFAULT_ROLE_NAMES,
  DEFAULT_ROLE_PERMISSIONS,
} from '../domain/role-seed';
import { isPlausibleEmail, normalizeEmail } from '../domain/user';
import { PROVISIONING_REPOSITORY, type ProvisioningRepository } from './ports';

/**
 * What the scope-tree root is coded when the organisation's short name yields nothing usable.
 * "Head Office" — the name it is given alongside it.
 */
const DEFAULT_ROOT_CODE = 'HQ';

export interface ProvisionTenantCommand {
  readonly slug: string;
  readonly name: string;
  readonly adminEmail: string;
  readonly adminPassword: string;
  readonly adminDisplayName: string;
}

export interface ProvisionedTenant {
  readonly tenantId: TenantId;
  readonly roleId: RoleId;
  readonly adminUserId: UserId;
  readonly companyId: AnyId;
  readonly entityId: AnyId;
}

/**
 * Bootstrapping a tenant: the organisation, the eight seeded roles, and one person who can sign in.
 *
 * **This is not administration.** Creating, editing and deleting users and roles is Phase 2's, and
 * nothing here grows into it: there is one operation, it runs once per tenant, and it refuses to run
 * twice. What it exists for is the chicken-and-egg problem underneath every access-controlled system
 * — the first account cannot be created by someone signed in, because nobody is.
 *
 * Phase 2 changed one thing here: it seeds all eight roles from `08-permission-model.md` §6 rather
 * than only the administrator's. The administrator is still the only role anybody *holds*; the others
 * exist so that an administrator's first act — making a colleague an author — is a role assignment
 * rather than a matrix-design exercise.
 *
 * Everything is one transaction. A half-provisioned tenant — an organisation with no
 * administrator, or a role with nobody holding it — is a workspace nobody can enter and nobody
 * can fix, so it either all commits or none of it does
 * (`docs/architecture/21-saas-commercial-architecture.md` §5).
 *
 * The password policy applies here, unlike at sign-in: this is a password being *set*.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    @Inject(PROVISIONING_REPOSITORY) private readonly repository: ProvisioningRepository,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
  ) {}

  async provision(command: ProvisionTenantCommand): Promise<ProvisionedTenant> {
    const slug = command.slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
      throw new ValidationError(
        'The organisation short name must be lower-case letters, digits and hyphens.',
      );
    }

    const email = normalizeEmail(command.adminEmail);
    if (!isPlausibleEmail(email)) {
      throw new ValidationError('That does not look like an email address.');
    }

    const rejections = checkPassword(command.adminPassword, [email, command.adminDisplayName]);
    if (rejections.length > 0) {
      throw new ValidationError(`That password is not acceptable: ${rejections.join(', ')}.`);
    }

    // The tenant must already be *placed* — its database, storage and index configured — because
    // provisioning writes into that database and there is no other one to fall back on. This is the
    // order ADR-0015 imposes: an operator adds the tenant to the catalogue, migrates its database,
    // then provisions it. Discovering the gap here, by name, is the whole point of checking.
    const placement = await this.registry.bySlug(slug);
    if (!placement) {
      throw new ValidationError(
        `'${slug}' is not in this deployment's tenant catalogue, so it has no database to be ` +
          'provisioned into. Add it to the catalogue and migrate its database first.',
      );
    }

    // The scope-tree root needs a code, and the organisation's short name is the best guess
    // available at provisioning time. Only a guess, though: a slug may be long and descriptive
    // where a code is printed on documents, so it is derived rather than required to fit — and
    // an administrator renames it in Phase 2.
    const code = deriveCode(slug, DEFAULT_ROOT_CODE);

    // From the registry, never generated. The identifier is what routes every request to this
    // database, so it is configuration an operator holds before provisioning runs — and it has to be
    // the same value on a re-run against a database that already has rows carrying it.
    const tenantId = asId<TenantId>(placement.id);
    const companyId = asId<AnyId>(uuidv7(this.clock.now().getTime()));
    const entityId = asId<AnyId>(uuidv7(this.clock.now().getTime()));
    const roleId = asId<RoleId>(uuidv7(this.clock.now().getTime()));
    const adminUserId = asId<UserId>(uuidv7(this.clock.now().getTime()));
    const passwordHash = await this.passwords.hash(command.adminPassword);

    const context: RequestContext = {
      tenantId,
      // Nobody is acting yet — the first user is what this creates. The audit event below
      // records the system as the actor, which is the truth.
      userId: null,
      roles: [],
      permissions: [],
      sessionId: null,
      correlationId: `provision:${slug}`,
      permissionVersion: 0,
      locale: 'en',
    };

    return runWithContext(context, () =>
      this.unitOfWork.run(async () => {
        // Checked inside the transaction, against this tenant's own database. A second provisioning
        // run would otherwise write a second set of seeded roles beside the first.
        if (await this.repository.alreadyProvisioned(tenantId)) {
          // Named explicitly, unlike a sign-in failure: this is an operator provisioning a tenant,
          // not an anonymous caller probing for which organisations exist.
          throw new DuplicateError('organisation', 'slug');
        }

        await this.repository.createTenant({ id: tenantId, slug, name: command.name.trim() });

        await this.repository.createRootScope({
          companyId,
          entityId,
          code,
          name: command.name.trim(),
        });

        // All eight seeded roles, with the permissions `08-permission-model.md` §6 marks `✓` for
        // each. The administrator's is the only one the first user is given; the rest exist so that
        // making somebody an author is one click rather than a matrix-design exercise.
        //
        // Note what the administrator does *not* get: `document:approve` and `document:reject`.
        // Approval authority comes from being assigned a task, never from seniority, and an
        // administrator who needs to approve is assigned or delegated the task — with the audit trail
        // saying so (§6, first deliberate row).
        await this.repository.createSystemRoles(
          ALL_SYSTEM_ROLES.map((key) => ({
            id:
              key === SystemRole.TENANT_ADMIN
                ? roleId
                : asId<RoleId>(uuidv7(this.clock.now().getTime())),
            key,
            name: DEFAULT_ROLE_NAMES[key],
            description: DEFAULT_ROLE_DESCRIPTIONS[key],
            permissions: DEFAULT_ROLE_PERMISSIONS[key],
          })),
        );

        await this.repository.createAdminUser({
          id: adminUserId,
          roleId,
          email: command.adminEmail.trim(),
          emailNormalized: email,
          displayName: command.adminDisplayName.trim(),
          passwordHash,
        });

        await this.audit.write(
          {
            tenantId,
            userId: null,
            channel: 'SYSTEM',
            correlationId: context.correlationId,
            ipAddress: null,
            userAgent: null,
          },
          {
            action: 'TENANT_PROVISIONED',
            subjectType: AuditSubjectType.CONFIGURATION,
            subjectId: tenantId,
            outcome: AuditOutcome.SUCCESS,
            // The identifiers, not the credential. The trail says a tenant was created and who
            // its first administrator is; it never says what their password was.
            payload: { slug, adminUserId, roleId, companyId, entityId },
          },
        );

        return { tenantId, roleId, adminUserId, companyId, entityId };
      }),
    );
  }
}
