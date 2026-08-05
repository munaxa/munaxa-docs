import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type ClaimMapping,
  type RoleMapping,
  AuditSubjectType,
  DEFAULT_CLAIM_MAPPING,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { NotFoundError, ValidationError } from '../../../core/errors/application-errors';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { OUTBOUND_HTTP_PORT, type OutboundHttpPort } from '../../../ports/outbound-http.port';
import { IntegrationAudit } from '../domain/audit-actions';
import {
  IDENTITY_PROVIDER_REPOSITORY,
  type IdentityProviderRecord,
  type IdentityProviderRepository,
} from './federation.ports';

export const IDENTITY_PROVIDER_ADMIN_SERVICE = Symbol('IdentityProviderAdminService');

export interface UpsertIdentityProviderCommand {
  readonly name: string;
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly domains: readonly string[];
  readonly claimMapping?: Partial<ClaimMapping>;
  readonly roleMappings: readonly RoleMapping[];
  readonly defaultRoleKeys: readonly string[];
  readonly jitProvisioning: boolean;
  readonly enabled: boolean;
}

export interface IdentityProviderAdminService {
  get(): Promise<IdentityProviderRecord | null>;
  upsert(command: UpsertIdentityProviderCommand): Promise<IdentityProviderRecord>;
  remove(): Promise<void>;
}

/**
 * Configuring the tenant's provider, behind `integration:manage`.
 *
 * Two checks happen here rather than in the schema, and both are relationships a zod refinement
 * would have to repeat in the web form.
 *
 * **The discovery URL is checked against the outbound allow-list at save time.** It is checked
 * again at every fetch — the port does that unconditionally — but an administrator who saved a
 * provider successfully and then found that nobody could sign in would have no way to discover
 * that this deployment simply will not reach that host. `permits()` makes no request, so asking is
 * not itself an SSRF.
 *
 * **A role mapping onto `TENANT_ADMIN` is accepted, deliberately, and it is the one that matters.**
 * It would be easy to refuse it on the grounds that a directory group should not confer full
 * administration, and that would be this product deciding a customer's access model for them —
 * "the Entra group `edms-admins` is our administrators" is exactly what a large customer wants
 * federation for. What the product owes instead is that the decision is **visible**: the mapping
 * is in the audit trail's `before`/`after`, so "who made `all-staff` map to `TENANT_ADMIN`" is a
 * question the trail answers.
 */
@Injectable()
export class DefaultIdentityProviderAdminService implements IdentityProviderAdminService {
  constructor(
    @Inject(IDENTITY_PROVIDER_REPOSITORY) private readonly repository: IdentityProviderRepository,
    @Inject(OUTBOUND_HTTP_PORT) private readonly http: OutboundHttpPort,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    private readonly writer: AdministeredWriter,
  ) {}

  get(): Promise<IdentityProviderRecord | null> {
    return this.writer.read(() => this.repository.find());
  }

  async upsert(command: UpsertIdentityProviderCommand): Promise<IdentityProviderRecord> {
    const verdict = await this.http.permits(command.discoveryUrl);
    if (!verdict.allowed) {
      throw new ValidationError(verdict.reason ?? 'That discovery URL cannot be used.');
    }

    const claimMapping: ClaimMapping = {
      subject: command.claimMapping?.subject ?? DEFAULT_CLAIM_MAPPING.subject,
      email: command.claimMapping?.email ?? DEFAULT_CLAIM_MAPPING.email,
      displayName: command.claimMapping?.displayName ?? DEFAULT_CLAIM_MAPPING.displayName,
      // `undefined` means "not stated, take the default"; explicit `null` means "this provider has
      // no groups claim", which is Google Workspace's ID token and is a real configuration rather
      // than an omission.
      groups:
        command.claimMapping?.groups === undefined
          ? DEFAULT_CLAIM_MAPPING.groups
          : command.claimMapping.groups,
    };

    const id = asId<AnyId>(uuidv7(this.clock.now().getTime()));
    return this.writer.write(async () => {
      const existing = await this.repository.find();
      const upserted = await this.repository.upsert({
        id: existing?.id ?? id,
        name: command.name.trim(),
        issuer: command.issuer.trim(),
        discoveryUrl: command.discoveryUrl.trim(),
        clientId: command.clientId.trim(),
        clientSecret: command.clientSecret,
        domains: command.domains,
        claimMapping,
        roleMappings: command.roleMappings,
        defaultRoleKeys: command.defaultRoleKeys,
        jitProvisioning: command.jitProvisioning,
        enabled: command.enabled,
      });
      return {
        result: upserted,
        change: {
          action: IntegrationAudit.IDENTITY_PROVIDER_CHANGED,
          subjectType: AuditSubjectType.INTEGRATION,
          subjectId: upserted.id,
          operation:
            existing === null ? AdministrativeOperation.CREATED : AdministrativeOperation.UPDATED,
          ...(existing && {
            before: {
              issuer: existing.issuer,
              domains: [...existing.domains],
              roleMappings: existing.roleMappings.map((mapping) => ({ ...mapping })),
              defaultRoleKeys: [...existing.defaultRoleKeys],
              enabled: existing.enabled,
            },
          }),
          // The mapping in full, in both directions. This is the payload that answers "who made
          // that group an administrator", which is the highest-privilege change this resource can
          // carry. The **client secret** is absent, for the reason every other secret in this
          // phase's payloads is.
          after: {
            issuer: upserted.issuer,
            domains: [...upserted.domains],
            roleMappings: upserted.roleMappings.map((mapping) => ({ ...mapping })),
            defaultRoleKeys: [...upserted.defaultRoleKeys],
            jitProvisioning: upserted.jitProvisioning,
            enabled: upserted.enabled,
          },
        },
      };
    });
  }

  async remove(): Promise<void> {
    await this.writer.write(async () => {
      const existing = await this.repository.find();
      if (!existing) {
        throw new NotFoundError('identity provider');
      }
      await this.repository.remove(existing.id, this.clock.now());
      return {
        result: undefined,
        change: {
          action: IntegrationAudit.IDENTITY_PROVIDER_CHANGED,
          subjectType: AuditSubjectType.INTEGRATION,
          subjectId: existing.id,
          operation: AdministrativeOperation.DELETED,
          // Federated accounts survive: `user.identity_provider_id` is `ON DELETE SET NULL` and
          // this is a soft delete anyway, so removing a provider stops new federated sign-ins
          // rather than orphaning everybody it ever provisioned. Those accounts have no password,
          // so a tenant doing this must set one — which is a `user:manage` act and is why removing
          // a provider is not something the product does on the tenant's behalf.
          before: { issuer: existing.issuer, domains: [...existing.domains] },
        },
      };
    });
  }
}
