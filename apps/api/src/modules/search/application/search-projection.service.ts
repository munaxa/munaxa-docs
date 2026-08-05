import { Inject, Injectable } from '@nestjs/common';

import { type DocumentId, Permission, ScopeType, asId, detectLanguage } from '@edms/domain';

import { ACL_RESOLVER, type AclResolver } from '../../../core/authorization/acl-resolver.port';
import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { RecordStamps } from '../../../core/persistence/record-stamps';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { INDEX_PORT, type IndexDocument, type IndexPort } from '../../../ports/search.port';
import { PreviewQueryService } from '../../preview/application/preview-query.service';
import { documentIndexedEvent } from '../domain/events';
import {
  SEARCH_REBUILD_REPOSITORY,
  SEARCH_SOURCE,
  type SearchProjection,
  type SearchRebuildRepository,
  type SearchSource,
  type SearchSourceFacts,
} from './ports';

/**
 * Keeps one document's index entry equal to its sources (`12-search-architecture.md` §2).
 *
 * Idempotent by construction: every projection reads the document's *current* truth and
 * upserts, so at-least-once delivery, coalesced redelivery and a projection racing its own
 * duplicate all converge on the same row. There is no partial update — an event does not
 * carry state, it carries the fact that state changed, and the row is rebuilt whole.
 *
 * A document that stopped being findable — soft-deleted, purged — projects as a removal.
 * The one decision in an entry, who may see it, is `ACL_RESOLVER`'s; the text is Preview's
 * own read side; everything else is rows read as rows through `SEARCH_SOURCE`.
 *
 * While a rebuild runs, every live projection dual-writes into the build target too, so a
 * change that lands mid-fill survives the swap (ADR-0008's dual-write, inside one engine).
 */
@Injectable()
export class SearchProjectionService implements SearchProjection {
  constructor(
    @Inject(SEARCH_SOURCE) private readonly source: SearchSource,
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
    @Inject(INDEX_PORT) private readonly index: IndexPort,
    @Inject(SEARCH_REBUILD_REPOSITORY) private readonly rebuilds: SearchRebuildRepository,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly previews: PreviewQueryService,
    private readonly stamps: RecordStamps,
  ) {}

  async project(documentId: DocumentId): Promise<void> {
    await this.unitOfWork.run(async () => {
      const facts = await this.source.factsFor(documentId);
      if (facts === null) {
        await this.removeEverywhere(documentId);
        return;
      }
      const document = await this.indexDocumentFrom(facts);
      await this.index.upsert(document);
      if ((await this.rebuilds.findRunning()) !== null) {
        await this.index.rebuildUpsert([document]);
      }
      await this.outbox.publish([
        documentIndexedEvent(documentId, {
          documentId,
          aclHash: document.aclHash,
          indexedAt: this.stamps.now().toISOString(),
        }),
      ]);
    });
  }

  async remove(documentId: DocumentId): Promise<void> {
    await this.unitOfWork.run(() => this.removeEverywhere(documentId));
  }

  /** The full entry for one document, from its sources — shared with the rebuild. */
  async indexDocumentFrom(facts: SearchSourceFacts): Promise<IndexDocument> {
    const text = await this.extractedText(facts);
    const acl = await this.acl.aclSubjectsFor(
      { type: ScopeType.DOCUMENT, id: asId(facts.document.id) },
      Permission.DOCUMENT_VIEW,
    );
    const language = detectLanguage(
      `${facts.document.title}\n${facts.document.description ?? ''}\n${text.body}`,
    );
    return {
      documentId: facts.document.id,
      // The ambient context decides the tenant; the projection never takes one as a parameter.
      tenantId: requireContext().tenantId,
      // Raw truth crosses the port; how text is folded and analysed is the engine's
      // (`ports/search.port.ts` — nothing above the port knows how text is analysed).
      title: facts.document.title,
      documentNumber: facts.document.documentNumber,
      description: facts.document.description,
      filename: facts.revision?.filename ?? null,
      metadataText: facts.metadata.searchableText,
      metadata: facts.metadata.values,
      body: text.body,
      bodySource: text.source,
      contentPending: text.pending,
      lowConfidence: text.lowConfidence,
      language,
      status: facts.document.status,
      documentTypeId: facts.document.documentTypeId,
      categoryId: facts.document.categoryId,
      confidentialityRank: facts.document.confidentialityRank,
      entityId: facts.placement.entityId,
      branchId: facts.placement.branchId,
      departmentId: facts.placement.departmentId,
      libraryId: facts.placement.libraryId,
      folderId: facts.placement.folderId,
      folderPath: facts.placement.folderPath,
      ownerId: facts.document.ownerUserId,
      approverIds: facts.approverIds,
      revisionOrdinal: facts.revision?.ordinal ?? null,
      revisionLabel: facts.revision?.label ?? null,
      createdAt: facts.document.createdAt,
      updatedAt: facts.document.updatedAt,
      publishedAt: facts.revision?.publishedAt ?? null,
      effectiveFrom: facts.revision?.effectiveFrom ?? null,
      aclSubjects: acl.allowSubjects,
      aclDenySubjects: acl.denySubjects,
      aclHash: acl.fingerprint,
      sourceVersion: facts.document.version,
    };
  }

  /**
   * The document's content, from the preview pipeline's read side (`14` §6): the file's own
   * text layer when the renderer found one, the OCR read otherwise, and honestly nothing when
   * neither exists. "Pending" is `preview_render.state` materialised — a render still queued
   * means the words are coming, and the UI says so instead of pretending the document has
   * none (`12-search-architecture.md` §4).
   */
  private async extractedText(facts: SearchSourceFacts): Promise<{
    readonly body: string;
    readonly source: 'TEXT' | 'OCR' | null;
    readonly pending: boolean;
    readonly lowConfidence: boolean;
  }> {
    if (facts.revision === null) {
      return { body: '', source: null, pending: false, lowConfidence: false };
    }
    const preview = await this.previews.facts(facts.revision.id);
    const pending = preview.state === 'PENDING';
    if (!preview.hasText) {
      return { body: '', source: null, pending, lowConfidence: false };
    }
    const pages = await this.previews.textPages(facts.revision.id);
    if (pages === null) {
      return { body: '', source: null, pending, lowConfidence: false };
    }
    const body = pages.pages
      .map((page) => page.text)
      .join('\n\n')
      .slice(0, this.config.search.maxBodyChars);
    return { body, source: pages.source, pending, lowConfidence: pages.lowConfidence };
  }

  private async removeEverywhere(documentId: DocumentId): Promise<void> {
    await this.index.remove(documentId);
    if ((await this.rebuilds.findRunning()) !== null) {
      await this.index.rebuildRemove(documentId);
    }
  }
}
