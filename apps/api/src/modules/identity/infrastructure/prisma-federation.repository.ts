import { Injectable } from '@nestjs/common';

import {
  type AnyId,
  type ClaimMapping,
  type RoleMapping,
  type UserId,
  DEFAULT_CLAIM_MAPPING,
  asId,
} from '@edms/domain';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  IdentityProviderCredential,
  IdentityProviderRecord,
  IdentityProviderRepository,
} from '../application/federation.ports';
import type { FederatedUserRepository } from '../application/ports';

/**
 * The tenant's identity provider — at most one, enforced by a unique index on `tenant_id`.
 *
 * 17 §2 says *"the tenant's domain determines the provider"*, which is a sentence about one
 * provider; a tenant with two would need a rule for which wins that §2 does not give, and the
 * obvious rule — first match by domain — makes the answer depend on row order. A tenant migrating
 * between providers replaces the row.
 *
 * `findCredential` is split from `find` for the reason the webhook repository splits its two: the
 * client secret is on the row because the token exchange presents it, and a read path that
 * returned it would put it on an administration screen.
 */
@Injectable()
export class PrismaIdentityProviderRepository implements IdentityProviderRepository {
  async find(): Promise<IdentityProviderRecord | null> {
    const row = await requireTransaction().identityProvider.findFirst({
      where: { deletedAt: null },
      select: PROVIDER_FIELDS,
    });
    return row ? toRecord(row) : null;
  }

  async findCredential(): Promise<IdentityProviderCredential | null> {
    const row = await requireTransaction().identityProvider.findFirst({
      where: { deletedAt: null },
      select: { ...PROVIDER_FIELDS, clientSecret: true },
    });
    return row ? { ...toRecord(row), clientSecret: row.clientSecret } : null;
  }

  async upsert(input: {
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
  }): Promise<IdentityProviderRecord> {
    const context = requireContext();
    const shared = {
      name: input.name,
      issuer: input.issuer,
      discoveryUrl: input.discoveryUrl,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      // Lower-cased on the way in, so the label-boundary match in `domainMatches` never has to
      // worry about case and two rows cannot differ only by it.
      domains: input.domains.map((domain) => domain.trim().toLowerCase().replace(/^@/, '')),
      claimMapping: { ...input.claimMapping },
      roleMappings: input.roleMappings.map((mapping) => ({ ...mapping })),
      defaultRoleKeys: [...input.defaultRoleKeys],
      jitProvisioning: input.jitProvisioning,
      enabled: input.enabled,
    };
    const row = await requireTransaction().identityProvider.upsert({
      where: { tenantId: context.tenantId },
      create: {
        id: input.id,
        tenantId: context.tenantId,
        ...shared,
        createdBy: context.userId,
        updatedBy: context.userId,
      },
      update: {
        ...shared,
        deletedAt: null,
        deletedBy: null,
        updatedBy: context.userId,
        version: { increment: 1 },
      },
      select: PROVIDER_FIELDS,
    });
    return toRecord(row);
  }

  async remove(id: AnyId, at: Date): Promise<void> {
    const context = requireContext();
    await requireTransaction().identityProvider.update({
      where: { id },
      data: { deletedAt: at, deletedBy: context.userId, enabled: false },
    });
  }
}

/**
 * The four columns Phase 17 added to `user`, and nothing else.
 *
 * Its own class rather than four methods on `PrismaCredentialRepository`, because this is the only
 * repository in the product that creates a person **without an administrator having asked for
 * one** — and a capability like that is worth being able to find every caller of by opening one
 * file.
 */
@Injectable()
export class PrismaFederatedUserRepository implements FederatedUserRepository {
  async findByExternalIdentity(
    providerId: AnyId,
    externalId: string,
    emailNormalized: string,
  ): Promise<UserId | null> {
    const transaction = requireTransaction();
    // **The subject first.** It is the identity: somebody who changes their address at the
    // provider is the same person, and matching on address alone would give them a second account.
    const byExternal = await transaction.user.findFirst({
      where: { identityProviderId: providerId, externalId, deletedAt: null },
      select: { id: true },
    });
    if (byExternal) {
      return asId<UserId>(byExternal.id);
    }
    // The address second, and only for an account not already bound to some *other* provider
    // subject. That condition is what stops a second person at the same provider claiming an
    // account the first one is already using.
    const byEmail = await transaction.user.findFirst({
      where: { emailNormalized, deletedAt: null, externalId: null },
      select: { id: true },
    });
    return byEmail ? asId<UserId>(byEmail.id) : null;
  }

  async linkToProvider(
    id: UserId,
    providerId: AnyId,
    externalId: string,
    displayName: string,
    at: Date,
  ): Promise<void> {
    await requireTransaction().user.update({
      where: { id },
      data: {
        identityProviderId: providerId,
        externalId,
        identitySource: 'FEDERATED',
        displayName,
        federatedAt: at,
      },
    });
  }

  async provision(input: {
    readonly id: UserId;
    readonly email: string;
    readonly emailNormalized: string;
    readonly displayName: string;
    readonly providerId: AnyId;
    readonly externalId: string;
    readonly roleKeys: readonly string[];
    readonly at: Date;
  }): Promise<void> {
    const transaction = requireTransaction();
    const context = requireContext();

    /*
     * Resolved against this tenant's **live** roles, and a key matching none is **dropped**. A
     * provider that could bring a role into existence would be a provider that decides this
     * tenant's permission model — which is exactly what "pre-mapped" in 17 §2 rules out.
     *
     * `deletedAt: null` is the whole of Slice 22 and it is not defensive dressing. A withdrawn role
     * keeps its `role_permission` rows — `setRoleDeleted` stamps the role and nothing else — and
     * `uq_role_tenant_key` is a **partial** index (`WHERE "deleted_at" IS NULL`), so a tenant may
     * delete a role and create a new one under the same key. Without this clause a mapping naming
     * that key resolved *both* rows, and the person who signed in was granted the union of a role
     * this tenant deliberately withdrew and the one that replaced it.
     *
     * Nothing forces an administrator to edit the provider's mapping when they delete a role —
     * this service drops unmatched keys silently by design — so "the mapping still names it" is the
     * expected state rather than a misconfiguration, which is what makes the recycle bin a way back
     * in rather than an edge case.
     */
    const roles =
      input.roleKeys.length === 0
        ? []
        : await transaction.role.findMany({
            where: { key: { in: [...input.roleKeys] }, deletedAt: null },
            select: { id: true },
          });

    await transaction.user.create({
      data: {
        id: input.id,
        tenantId: context.tenantId,
        email: input.email,
        emailNormalized: input.emailNormalized,
        displayName: input.displayName,
        // Active rather than invited: the provider has just authenticated them, so there is no
        // invitation for them to accept. An `INVITED` row would be an account that exists and
        // cannot sign in, immediately after somebody signed in.
        status: 'ACTIVE',
        // No password hash, and `FEDERATED` beside it — which together are what make "no password
        // because they federate" distinguishable from "no password because the invitation is
        // outstanding", a distinction this product could not make before Phase 17.
        identitySource: 'FEDERATED',
        identityProviderId: input.providerId,
        externalId: input.externalId,
        federatedAt: input.at,
        lastLoginAt: input.at,
        roles: {
          create: roles.map((role) => ({ tenantId: context.tenantId, roleId: role.id })),
        },
      },
    });
  }
}

const PROVIDER_FIELDS = {
  id: true,
  kind: true,
  name: true,
  issuer: true,
  discoveryUrl: true,
  clientId: true,
  domains: true,
  claimMapping: true,
  roleMappings: true,
  defaultRoleKeys: true,
  jitProvisioning: true,
  enabled: true,
  version: true,
} as const;

interface ProviderRow {
  id: string;
  kind: string;
  name: string;
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  domains: string[];
  claimMapping: unknown;
  roleMappings: unknown;
  defaultRoleKeys: string[];
  jitProvisioning: boolean;
  enabled: boolean;
  version: number;
}

function toRecord(row: ProviderRow): IdentityProviderRecord {
  return {
    id: asId<AnyId>(row.id),
    kind: 'OIDC',
    name: row.name,
    issuer: row.issuer,
    discoveryUrl: row.discoveryUrl,
    clientId: row.clientId,
    domains: row.domains,
    claimMapping: toClaimMapping(row.claimMapping),
    roleMappings: toRoleMappings(row.roleMappings),
    defaultRoleKeys: row.defaultRoleKeys,
    jitProvisioning: row.jitProvisioning,
    enabled: row.enabled,
    version: row.version,
  };
}

/**
 * A stored `jsonb` narrowed to the mapping, falling back per field to the product's defaults.
 *
 * Per field rather than all-or-nothing, so a row written by an older release that names only
 * `groups` keeps the three defaults rather than losing them. This is the settings catalogue's rule
 * — *a stored value that no longer parses falls back to the default* — applied to a column.
 */
function toClaimMapping(raw: unknown): ClaimMapping {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    subject: asString(value['subject']) ?? DEFAULT_CLAIM_MAPPING.subject,
    email: asString(value['email']) ?? DEFAULT_CLAIM_MAPPING.email,
    displayName: asString(value['displayName']) ?? DEFAULT_CLAIM_MAPPING.displayName,
    // Explicit `null` is meaningful here and is not "absent": it is how a provider with no groups
    // claim at all — Google Workspace's ID token — is configured.
    groups:
      value['groups'] === null ? null : (asString(value['groups']) ?? DEFAULT_CLAIM_MAPPING.groups),
  };
}

function toRoleMappings(raw: unknown): readonly RoleMapping[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    const value = (entry ?? {}) as Record<string, unknown>;
    const claimValue = asString(value['claimValue']);
    const roleKey = asString(value['roleKey']);
    return claimValue && roleKey ? [{ claimValue, roleKey }] : [];
  });
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
