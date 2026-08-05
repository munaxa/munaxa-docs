import { Injectable } from '@nestjs/common';

import { type AnyId, type ApiScopeKey, type UserId, asId, isApiScope } from '@edms/domain';
import { type Page, type PageRequest, toPage } from '@edms/utils';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { TenantDatabase } from '../../../core/prisma/tenant-database';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  ApiClientCredential,
  ApiClientRecord,
  ApiClientRepository,
} from '../application/api-client.ports';

/**
 * Machine credentials.
 *
 * Every read joins the use case's transaction, so row-level security scopes it whether or not the
 * `where` clause remembers — the rule every repository here has followed since Phase 1.
 *
 * `touch` is the one exception and says why on its own method.
 */
@Injectable()
export class PrismaApiClientRepository implements ApiClientRepository {
  constructor(private readonly databases: TenantDatabase) {}

  async findCredentialByPrefix(prefix: string): Promise<ApiClientCredential | null> {
    const row = await requireTransaction().apiClient.findFirst({
      where: { keyPrefix: prefix, deletedAt: null },
      select: {
        id: true,
        secretHash: true,
        subjectUserId: true,
        scopes: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
    if (!row) {
      return null;
    }
    return {
      id: asId<AnyId>(row.id),
      secretHash: row.secretHash,
      subjectUserId: asId<UserId>(row.subjectUserId),
      scopes: row.scopes,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  async findById(id: AnyId): Promise<ApiClientRecord | null> {
    const row = await requireTransaction().apiClient.findFirst({
      where: { id, deletedAt: null },
    });
    return row ? toRecord(row) : null;
  }

  async list(page: PageRequest): Promise<Page<ApiClientRecord>> {
    const transaction = requireTransaction();
    const where = { deletedAt: null };
    const [rows, total] = await Promise.all([
      transaction.apiClient.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      transaction.apiClient.count({ where }),
    ]);
    return toPage(rows.map(toRecord), total, page);
  }

  async create(input: {
    readonly id: AnyId;
    readonly name: string;
    readonly description: string | null;
    readonly keyPrefix: string;
    readonly secretHash: string;
    readonly subjectUserId: UserId;
    readonly scopes: readonly string[];
    readonly expiresAt: Date | null;
  }): Promise<ApiClientRecord> {
    const context = requireContext();
    const row = await requireTransaction().apiClient.create({
      data: {
        id: input.id,
        tenantId: context.tenantId,
        name: input.name,
        description: input.description,
        keyPrefix: input.keyPrefix,
        secretHash: input.secretHash,
        subjectUserId: input.subjectUserId,
        scopes: [...input.scopes],
        expiresAt: input.expiresAt,
        createdBy: context.userId,
        updatedBy: context.userId,
      },
    });
    return toRecord(row);
  }

  async revoke(
    id: AnyId,
    at: Date,
    by: UserId | null,
    expectedVersion: number,
  ): Promise<ApiClientRecord> {
    const row = await requireTransaction().apiClient.update({
      // The version in the `where`, so a concurrent revocation loses rather than overwriting —
      // the optimistic lock every aggregate in this product carries.
      where: { id, version: expectedVersion },
      data: { revokedAt: at, revokedBy: by, updatedBy: by, version: { increment: 1 } },
    });
    return toRecord(row);
  }

  /**
   * The last-used stamp, in its **own** connection rather than the request's transaction.
   *
   * Two reasons, and the second is the one that matters. A write inside the caller's transaction
   * would roll back with it, so a key used on a request that then failed validation would look
   * unused — and "has anything used this key recently" is exactly the question somebody asks
   * before revoking one. And an authenticated `GET` has no transaction of its own to join, so the
   * alternative is opening one per read just to stamp a column.
   *
   * A failure here is swallowed. A key that authenticated successfully must not have its request
   * refused because a bookkeeping column could not be written.
   */
  async touch(id: AnyId, at: Date): Promise<void> {
    const { tenantId } = requireContext();
    try {
      await this.databases.withTenant(tenantId, async (tx) => {
        await tx.apiClient.update({ where: { id }, data: { lastUsedAt: at } });
      });
    } catch {
      // Deliberately silent: see above.
    }
  }
}

interface ApiClientRow {
  id: string;
  name: string;
  description: string | null;
  keyPrefix: string;
  subjectUserId: string;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
  version: number;
}

function toRecord(row: ApiClientRow): ApiClientRecord {
  return {
    id: asId<AnyId>(row.id),
    name: row.name,
    description: row.description,
    keyPrefix: row.keyPrefix,
    subjectUserId: asId<UserId>(row.subjectUserId),
    // Narrowed against the catalogue rather than cast, exactly as `isPermissionKey` narrows a
    // stored permission: a scope removed from the product but still sitting in a row admits
    // nothing, which is the safe direction.
    scopes: row.scopes.filter((scope): scope is ApiScopeKey => isApiScope(scope)),
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy ? asId<UserId>(row.createdBy) : null,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy ? asId<UserId>(row.updatedBy) : null,
    // The same instant under the name the list component reads. See the port's own note.
    deletedAt: row.revokedAt,
    deletedBy: row.revokedBy ? asId<UserId>(row.revokedBy) : null,
    version: row.version,
  };
}
