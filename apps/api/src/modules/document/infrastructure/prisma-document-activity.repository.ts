import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { type Page, type PageRequest, skipFor, toPage } from '@edms/utils';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { DocumentActivityRepository, DocumentRow, RecentRow } from '../application/ports';
import { PrismaDocumentRepository } from './prisma-document.repository';

/**
 * Favourites and recent documents — two lists that belong to a person, not to the tenant.
 *
 * That distinction is the whole design. A favourite is a private convenience; a tenant-wide
 * "important" flag is a metadata field an administrator defines, and conflating them would make one
 * person's shortcut everybody's taxonomy. Both tables are keyed on `(user_id, document_id)` for the
 * same reason.
 *
 * **Recents are updated in place, not appended.** "Which documents did I open lately" is a question
 * about at most a screenful of documents, and an append-only log would grow without bound to answer
 * it. A `count` rides along because it costs nothing once the row is being written anyway, and it
 * is the difference between "opened once by accident" and "opened every morning".
 *
 * It is deliberately not derived from the audit trail, which does record every read. Audit is
 * evidence — append-only, hash-chained, retained by policy — and serving a convenience list from it
 * would put a product query on the one table that must stay cheap to write and impossible to
 * rewrite.
 */
@Injectable()
export class PrismaDocumentActivityRepository implements DocumentActivityRepository {
  constructor(private readonly documents: PrismaDocumentRepository) {}

  async addFavorite(userId: string, documentId: string): Promise<void> {
    // Idempotent: starring something already starred is not an error, and a client that retries a
    // request whose response it never saw should not get a conflict for agreeing with itself.
    await requireTransaction().documentFavorite.upsert({
      where: { userId_documentId: { userId, documentId } },
      create: { tenantId: this.tenantId(), userId, documentId },
      update: {},
    });
  }

  async removeFavorite(userId: string, documentId: string): Promise<void> {
    await requireTransaction().documentFavorite.deleteMany({
      where: { userId, documentId, tenantId: this.tenantId() },
    });
  }

  async isFavorite(userId: string, documentId: string): Promise<boolean> {
    const found = await requireTransaction().documentFavorite.findFirst({
      where: { userId, documentId, tenantId: this.tenantId() },
      select: { documentId: true },
    });
    return found !== null;
  }

  async recordView(userId: string, documentId: string, at: Date): Promise<void> {
    await requireTransaction().documentView.upsert({
      where: { userId_documentId: { userId, documentId } },
      create: { tenantId: this.tenantId(), userId, documentId, viewedAt: at, viewCount: 1 },
      update: { viewedAt: at, viewCount: { increment: 1 } },
    });
  }

  /**
   * The documents this person opened, most recent first.
   *
   * Two queries rather than a join, and on purpose: the second one is the ordinary document read
   * with every join a row needs, so a recent document renders identically to one from a folder
   * listing. Rebuilding that projection here would be a second place for it to drift.
   *
   * A document deleted since it was viewed simply does not come back. The view row stays — it is
   * cheap and it is correct, the person did open it — and a restore brings the entry back with it.
   */
  async listRecent(userId: string, request: PageRequest): Promise<Page<RecentRow>> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    const where = { tenantId, userId, document: { deletedAt: null } };

    const [views, total] = await Promise.all([
      tx.documentView.findMany({
        where,
        orderBy: { viewedAt: Prisma.SortOrder.desc },
        skip: skipFor(request),
        take: request.pageSize,
        select: { documentId: true, viewedAt: true },
      }),
      tx.documentView.count({ where }),
    ]);

    const byId = new Map<string, DocumentRow>();
    for (const view of views) {
      const document = await this.documents.findById(
        view.documentId as Parameters<PrismaDocumentRepository['findById']>[0],
        false,
      );
      if (document !== null) {
        byId.set(view.documentId, document);
      }
    }

    return toPage(
      views.flatMap((view) => {
        const document = byId.get(view.documentId);
        return document === undefined ? [] : [{ document, viewedAt: view.viewedAt }];
      }),
      total,
      request,
    );
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}
