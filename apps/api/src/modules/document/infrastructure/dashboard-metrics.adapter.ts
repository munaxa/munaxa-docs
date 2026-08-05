import { Injectable } from '@nestjs/common';

import { type DocumentId, type UserId, asId } from '@edms/domain';

import type { CountBreakdown, DashboardDocumentMetrics } from '../../dashboard/application/ports';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { PrismaDocumentRepository, liveLockOf } from './prisma-document.repository';

/**
 * What the dashboard needs from Document, answered by Document.
 *
 * Every method here goes through `PrismaDocumentRepository.whereFor` — the same function the
 * document list builds its own predicate from — so a tile and the list it links to are the same
 * query counted two ways rather than two queries that agree today. That is the dashboard module's
 * README rule ("a widget cannot become a second, divergent definition") enforced by construction
 * instead of by review.
 *
 * The counts are `groupBy` rather than one query per status. Six statuses is six round trips the
 * naive way, on the route every session opens first (`19-performance-and-scalability.md`), and a
 * status with no rows is simply absent from the result — which is why the dashboard's `Breakdown`
 * carries the entries present rather than a fixed row per enum value.
 */
@Injectable()
export class DocumentDashboardMetrics implements DashboardDocumentMetrics {
  constructor(private readonly documents: PrismaDocumentRepository) {}

  async countsForOwner(ownerUserId: UserId): Promise<CountBreakdown> {
    return this.breakdown(
      await this.documents.whereFor({
        page: 1,
        pageSize: 1,
        deleted: 'live',
        sortDirection: 'desc',
        ownerUserId,
      }),
    );
  }

  async countCheckedOutBy(userId: UserId, at: Date): Promise<number> {
    // Not routed through `whereFor`'s `lockedByMe`, which reads the *acting* caller from the
    // request context: this method takes the person as an argument so the composing service names
    // whose dashboard it is building. The predicate itself is the shared one, which is the half
    // that could otherwise drift.
    return requireTransaction().document.count({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        locks: { some: liveLockOf(userId, at) },
      },
    });
  }

  async countFavorites(userId: UserId): Promise<number> {
    return requireTransaction().document.count({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        favorites: { some: { userId } },
      },
    });
  }

  /**
   * The "Recent" card's rows.
   *
   * `document_view` holds one row per `(user, document)`, moved forward rather than appended, so
   * "most recently opened" is an ordered read of one person's own rows — the same table the
   * `/documents/recent` list reads and, like it, a list with no parameter by which to ask about
   * anybody else.
   *
   * Identifiers rather than rows: the card renders titles it fetches through the ordinary document
   * list, so the dashboard never becomes a second projection of a document. A `DocumentRow` here
   * would mean two places deciding what a document summary contains.
   */
  async recentDocumentIds(userId: UserId, limit: number): Promise<readonly DocumentId[]> {
    const rows = await requireTransaction().documentView.findMany({
      where: { tenantId: this.tenantId(), userId, document: { deletedAt: null } },
      orderBy: { viewedAt: 'desc' },
      take: limit,
      select: { documentId: true },
    });
    return rows.map((row) => asId<DocumentId>(row.documentId));
  }

  async countsByStatus(): Promise<CountBreakdown> {
    return this.breakdown(
      await this.documents.whereFor({
        page: 1,
        pageSize: 1,
        deleted: 'live',
        sortDirection: 'desc',
      }),
    );
  }

  private async breakdown(where: { readonly [key: string]: unknown }): Promise<CountBreakdown> {
    const rows = await requireTransaction().document.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    const entries = rows.map((row) => ({ key: row.status, count: row._count._all }));
    return {
      total: entries.reduce((sum, entry) => sum + entry.count, 0),
      entries,
    };
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}
