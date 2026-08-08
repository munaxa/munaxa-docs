import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import {
  type AnyId,
  BulkItemOutcome,
  BulkOperationKind,
  type DocumentId,
  Permission,
  ScopeType,
  type ScopeRef,
  asId,
  normaliseTargets,
} from '@edms/domain';

import {
  BULK_EXECUTOR,
  BULK_OPERATION_REPOSITORY,
  BULK_PLAN_REGISTRY,
  type BulkExecutor,
  type BulkOperationRepository,
  type BulkPlan,
  type BulkPlanRegistry,
  type BulkResult,
} from '../../../core/bulk';
import { ACL_RESOLVER, type AclResolver } from '../../../core/authorization/acl-resolver.port';
import { NotFoundError, ValidationError } from '../../../core/errors/application-errors';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import {
  DOCUMENT_CONTENT_GATE,
  DOCUMENT_REPOSITORY,
  type DocumentContentGate,
  type DocumentRepository,
  type DocumentRow,
} from './ports';

/**
 * Bulk export — the third export mechanism in this product, and the one that had to argue for
 * itself hardest.
 *
 * ## Reuse, generalise or diverge
 *
 * Phase 9 built `audit.export` and the evidence bundle. Phase 15 built the `reporting.export` lane,
 * a `report_export` record with an idempotent claim, an audited run, and `StreamDigest`. A third
 * would be the third, so the choice has to be stated.
 *
 * **This diverges in mechanism and reuses the shape**, and the reason is one sentence in the brief:
 * a bulk document export moves *bytes* rather than rows. The other two read a table and write a
 * file; there is nothing to read here — every document already *is* a file, content-addressed and
 * deduplicated since ADR-0007, sitting in storage with a digest. Generalising `report_export` to
 * cover it would mean teaching a row-streaming lane to move blobs, which is not a generalisation
 * of anything: it is a second mechanism with the first one's name.
 *
 * ## What it therefore produces, and why that is stronger than an archive
 *
 * A **manifest and a signed link per document**, exactly as Phase 9's evidence bundle produces
 * three artefacts and three links rather than one ZIP. That is not a limitation worked around; it
 * is the better answer for this product, for two reasons.
 *
 * The first is compliance. Every byte still leaves through `createDownloadUrl`, so every document
 * released writes its own `FILE_DOWNLOAD_ISSUED`. A ZIP would produce **one** audit row for five
 * hundred documents leaving the building, and "which of these did they actually take" would become
 * unanswerable — in an EDMS, that is the wrong trade at any price. `BULK_DOWNLOAD` is written once
 * for the act, beside the per-document rows, which is precisely the pairing 13 §2 already has for
 * an evidence bundle.
 *
 * The second is storage. An archive would copy every document's bytes into a second object,
 * turning a deduplicated store into one holding N extra copies for the length of the grace period
 * — which would undo the storage optimisation this same phase was asked about. The manifest is one
 * small derived artefact; the content is referenced, never duplicated.
 *
 * The honest cost is stated rather than hidden: a caller wanting one file to hand to somebody does
 * not get one. The manifest is the deliverable, and it is a better evidentiary artefact than an
 * archive — it names each document's number, revision, digest and size, so a recipient can prove
 * what they received — but it is not a ZIP, and a client that wants one assembles it from the
 * links. A server-side archiver is named in the report as what a later phase would add, and what
 * it would cost.
 */
@Injectable()
export class BulkExportService implements OnModuleInit {
  constructor(
    @Inject(BULK_EXECUTOR) private readonly executor: BulkExecutor,
    @Inject(BULK_PLAN_REGISTRY) private readonly plans: BulkPlanRegistry,
    @Inject(BULK_OPERATION_REPOSITORY) private readonly operations: BulkOperationRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_CONTENT_GATE) private readonly content: DocumentContentGate,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
  ) {}

  /**
   * Releases many documents, under the caller's own reach, per document.
   *
   * `document:download` rather than `document:view`, because this is a release of content and
   * 08 §6 separates the two — a reader who may look at a controlled drawing on screen and may not
   * take a copy of it is the ordinary case in this product, not an edge one. A document the caller
   * may view and may not download is `REFUSED` here, and appears in neither the manifest nor the
   * links.
   */
  async export(ids: readonly string[]): Promise<BulkResult> {
    return this.executor.run({
      kind: BulkOperationKind.EXPORT,
      payload: {},
      targetIds: normaliseTargets(ids),
    });
  }

  onModuleInit(): void {
    this.plans.register(BulkOperationKind.EXPORT, () => this.exportPlan());
  }

  /**
   * The EXPORT plan — Phase 6.2, and the one kind whose shape had to change to be queueable.
   *
   * Phase 16 accumulated the released rows in a closure and attached the manifest after
   * `executor.run` returned. That is unavailable to a worker, which never holds the closure, so
   * the manifest step is now `finalise` and reads its rows back from the applied targets. The
   * bytes, the manifest and the artefact are otherwise unchanged.
   */
  private exportPlan(): BulkPlan {
    return {
      kind: BulkOperationKind.EXPORT,
      permission: Permission.DOCUMENT_DOWNLOAD,
      parameters: {},
      resolveScope: async (id) => {
        const row = await this.rowOf(id);
        return row === null
          ? null
          : ({ type: ScopeType.DOCUMENT, id: asId<AnyId>(row.id) } satisfies ScopeRef);
      },
      apply: async (id) => {
        const row = await this.rowOf(id);
        if (row === null) {
          throw new NotFoundError('The requested document');
        }
        const revision = row.currentRevision ?? row.latestRevision;
        if (revision === null) {
          // A document with no revision has no content. `BLOCKED` rather than `REFUSED`, which is
          // why this is a `ValidationError` and not a `NotFoundError`: the caller reaches the
          // document perfectly well, and there is nothing in it to release. The executor's mapping
          // treats `NOT_FOUND` as a reach answer, so getting this wrong would report a content gap
          // as a permission problem.
          throw new ValidationError('This document has no revision to release.', [
            { field: 'revisionId', message: 'absent' },
          ]);
        }
        // Read, and refused above if there is nothing to release. The row itself is re-read in
        // `finalise` from the applied targets rather than carried here, because a closure does not
        // survive the queue.
      },
      finalise: async (operationId, appliedTargetIds) => {
        const released: DocumentRow[] = [];
        for (const id of appliedTargetIds) {
          const row = await this.rowOf(id);
          if (row !== null) {
            released.push(row);
          }
        }
        if (released.length > 0) {
          await this.attachManifest(asId<AnyId>(operationId), released);
        }
      },
    };
  }

  /**
   * The manifest: one line per released document, as JSON.
   *
   * Stored as a derived artefact so it acquires a digest and a `file_object` row — the same
   * property Phase 9 wanted for its bundle and Phase 15 for its export. Content-addressed, so two
   * identical releases are one blob rather than two.
   *
   * It records the *revision* and its digest rather than only the document, because "we released
   * QA-014" is not a statement anybody can check six months later and "we released QA-014 Rev 3,
   * sha256 a1b2…" is. That is the same reasoning as the signature statement's, and for the same
   * reason: an artefact that names a mutable thing attests nothing.
   */
  private async attachManifest(
    operationId: AnyId,
    released: readonly DocumentRow[],
  ): Promise<void> {
    const body = {
      operationId: operationId as string,
      documentCount: released.length,
      documents: released.map((row) => {
        const revision = row.currentRevision ?? row.latestRevision;
        return {
          documentId: row.id,
          documentNumber: row.documentNumber,
          title: row.title,
          folderPath: row.folderPath,
          revisionLabel: revision?.label ?? null,
          filename: revision?.file.filename ?? null,
          mimeType: revision?.file.mimeType ?? null,
          sizeBytes: revision?.file.sizeBytes ?? null,
          checksumSha256: revision?.file.checksumSha256 ?? null,
        };
      }),
    };
    const content = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, 'utf8');

    await this.unitOfWork.run(async () => {
      const stored = await this.content.storeManifest({ content, mimeType: 'application/json' });
      // A reference, so the reaper does not reclaim the manifest of a release somebody is still
      // reading. It comes back when the operation record is disposed of, on the same clock as
      // everything else derived.
      await this.content.reference(stored.fileObjectId);
      await this.operations.attachArtifact({
        id: operationId,
        fileObjectId: stored.fileObjectId,
        sizeBytes: stored.sizeBytes,
        sha256: stored.checksumSha256,
      });
    });
  }

  /**
   * The signed links for a completed export, re-checked against the caller's reach *now*.
   *
   * Not at export time, and this is the decision worth stating: an export is a record of what was
   * released, and a link is a release happening. Issuing durable links at export time would make a
   * caller whose access was revoked an hour later still able to take the content, which is exactly
   * what an EDMS must not allow. So the record is permanent and the links are minted per request,
   * through the same per-object reach the export itself used.
   */
  async links(
    operationId: string,
  ): Promise<readonly { documentId: string; filename: string; url: string; expiresAt: Date }[]> {
    const items = await this.unitOfWork.run(() =>
      this.operations.itemsOf(operationId, { page: 1, pageSize: 1_000 }),
    );
    const links: { documentId: string; filename: string; url: string; expiresAt: Date }[] = [];
    for (const item of items.data) {
      if (item.outcome !== BulkItemOutcome.APPLIED) {
        continue;
      }
      const row = await this.rowOf(item.targetId);
      const revision = row?.currentRevision ?? row?.latestRevision ?? null;
      if (row === null || revision === null) {
        continue;
      }
      // The reach question, asked again, now. `findById` is not ACL-filtered — Phase 14 put the
      // predicate in `whereFor`, which lists rather than fetches — so a link minted without this
      // would be a link minted for whoever holds the operation identifier.
      const decision = await this.unitOfWork.run(() =>
        this.acl.resolve(
          this.subject(),
          { type: ScopeType.DOCUMENT, id: asId<AnyId>(row.id) },
          Permission.DOCUMENT_DOWNLOAD,
        ),
      );
      if (!decision.allowed) {
        continue;
      }
      const signed = await this.content.downloadUrl(
        revision.file.fileObjectId,
        revision.file.filename,
      );
      links.push({
        documentId: row.id,
        filename: revision.file.filename,
        url: signed.url,
        expiresAt: signed.expiresAt,
      });
    }
    return links;
  }

  private subject(): Parameters<AclResolver['resolve']>[0] {
    const context = requireContext();
    return {
      userId: asId<AnyId>(context.userId ?? ''),
      roleIds: context.roles.map((role) => asId<AnyId>(role)),
      departmentIds: [],
      delegationIds: [],
    } as Parameters<AclResolver['resolve']>[0];
  }

  private rowOf(id: string): Promise<DocumentRow | null> {
    return this.unitOfWork.run(() => this.documents.findById(asId<DocumentId>(id), false));
  }
}
