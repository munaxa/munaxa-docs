import { Inject, Injectable } from '@nestjs/common';

import {
  type RoleId,
  type TenantId,
  type UserId,
  ALL_PERMISSIONS,
  AuditOutcome,
  AuditSubjectType,
  SystemRole,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { AUDIT_WRITER, type AuditWriter } from '../../../core/audit/audit-writer.port';
import { DuplicateError, ValidationError } from '../../../core/errors/application-errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { PASSWORD_HASHER, type PasswordHasher } from './authentication.ports';
import { checkPassword } from '../domain/password-policy';
import { isPlausibleEmail, normalizeEmail } from '../domain/user';
import { PROVISIONING_REPOSITORY, type ProvisioningRepository } from './ports';

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
}

/**
 * Bootstrapping a tenant: the organisation, an administrator role, and one person who can
 * sign in.
 *
 * **This is not administration.** Creating, editing and deleting users and roles is Phase 2,
 * and nothing here grows into it: there is one operation, it runs once per tenant, and it
 * refuses to run twice. What it exists for is the chicken-and-egg problem underneath every
 * access-controlled system — the first account cannot be created by someone signed in, because
 * nobody is.
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

    if (await this.repository.slugExists(slug)) {
      // Named explicitly, unlike a sign-in failure: this is an operator provisioning a tenant,
      // not an anonymous caller probing for which organisations exist.
      throw new DuplicateError('organisation', 'slug');
    }

    const tenantId = asId<TenantId>(uuidv7(this.clock.now().getTime()));
    const roleId = asId<RoleId>(uuidv7(this.clock.now().getTime()));
    const adminUserId = asId<UserId>(uuidv7(this.clock.now().getTime()));
    const passwordHash = await this.passwords.hash(command.adminPassword);

    // The tenant row is written first and outside the tenant context, because the context is
    // keyed on an identifier that does not exist until this succeeds. `tenant` is the one table
    // with no row-level security policy, which is exactly what makes that possible.
    await this.repository.createTenant({ id: tenantId, slug, name: command.name.trim() });

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
        await this.repository.createAdminRole({
          id: roleId,
          key: SystemRole.TENANT_ADMIN,
          name: 'Tenant administrator',
          // Every permission the product defines. A first administrator who cannot grant
          // themselves what they need is a tenant that needs a database console to finish
          // setting up. The role is ordinary data afterwards — Phase 2 edits it like any other.
          permissions: ALL_PERMISSIONS,
        });

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
            payload: { slug, adminUserId, roleId },
          },
        );

        return { tenantId, roleId, adminUserId };
      }),
    );
  }
}
