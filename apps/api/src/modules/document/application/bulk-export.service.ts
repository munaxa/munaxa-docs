import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  BulkItemOutcome,
  BulkOperationKind,
  BulkOperationState,
  type DocumentId,
  DomainError,
  ErrorCode,
  IntegrityStatus,
  Permission,
  type PermissionKey,
  ScanStatus,
  ScopeType,
  type ScopeRef,
  asId,
  isReachableFile,
  normaliseTargets,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import {
  BULK_EXECUTOR,
  BULK_OPERATION_REPOSITORY,
  BULK_PLAN_REGISTRY,
  BulkAudit,
  type BulkExecutor,
  type BulkOperationRecord,
  type BulkOperationRepository,
  type BulkPlan,
  type BulkPlanRegistry,
  type BulkResult,
} from '../../../core/bulk';
import { ACL_RESOLVER, type AclResolver } from '../../../core/authorization/acl-resolver.port';
import { APP_CONFIG, type AppConfig } from '../../../core/config';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import {
  DOCUMENT_CONTENT_GATE,
  DOCUMENT_REPOSITORY,
  type DocumentContentGate,
  type DocumentRepository,
  type DocumentRow,
} from './ports';
import { DOCUMENT_CONFIGURATION, type DocumentConfiguration } from './configuration.port';
import { refuseWhereLevelForbidsDownload } from './download-confidentiality';

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
 * A **manifest and a verified link per document**, issued when it is clicked, exactly as Phase 9's evidence bundle produces
 * three artefacts and three links rather than one ZIP. That is not a limitation worked around; it
 * is the better answer for this product, for two reasons.
 *
 * The first is compliance. Every byte leaves through a verified link (`itemLink`, ADR-0026 §10),
 * issued when that one document is clicked, so every document released writes its own
 * `FILE_DOWNLOAD_ISSUED`. A ZIP would produce **one** audit row for five
 * hundred documents leaving the building, and "which of these did they actually take" would become
 * unanswerable — in an EDMS, that is the wrong trade at any price. Opening the list of released
 * documents writes one `BULK_EXPORT_OPENED`, with counts only, beside the per-document rows.
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
    @Inject(DOCUMENT_CONFIGURATION) private readonly configuration: DocumentConfiguration,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly writer: AdministeredWriter,
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
        // The same rule the single download applies: a level that forbids download refuses it, and
        // being one of many selected documents changes nothing. `ForbiddenError`, so the executor
        // records it as `REFUSED` (a reach answer) and the manifest does not name the document.
        await refuseWhereLevelForbidsDownload(this.configuration, row.confidentialityId);
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
        // survive the queue. What *is* kept is which revision this release named, on the item's
        // own row, so the export's list can say "exported Rev 2, current Rev 3" later.
        return {
          detail: JSON.stringify({ revisionId: revision.id, revisionLabel: revision.label }),
        };
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
          const tally = await this.unitOfWork.run(() => this.operations.tallyOf(operationId));
          await this.attachManifest(asId<AnyId>(operationId), released, {
            requested: tally.requested,
            applied: tally.applied,
          });
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
    counts: { readonly requested: number; readonly applied: number },
  ): Promise<void> {
    const body = {
      operationId: operationId as string,
      documentCount: released.length,
      // Counted, never named: a document that was not released is not in this file at all, and
      // "how many were left out" is the most a recipient may learn about it.
      includedCount: released.length,
      refusedCount: Math.max(0, counts.requested - counts.applied),
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
      const { displacedFileObjectId } = await this.operations.attachArtifact({
        id: operationId,
        fileObjectId: stored.fileObjectId,
        sizeBytes: stored.sizeBytes,
        sha256: stored.checksumSha256,
      });
      /*
       * Reference counting follows what the row actually did — the render pipeline's rule, applied
       * to the one other place in the product that attaches a derived artefact to a record.
       *
       * Two deliveries of one export both reach here: `finalise` is handed the pass's own applied
       * targets, and a delivery that resumed past what another had settled names only what it
       * itself released, so the manifests differ and the pointer really moves. Each took a
       * reference; only one pointer survives, so the displaced blob's must go back or the reaper —
       * which selects on a count of zero — can never collect it, and bytes the retention rules say
       * to destroy become indestructible.
       *
       * Unconditional on the identifier, including when it equals the one just attached: two
       * deliveries that produced identical bytes converge on one content-addressed blob and take
       * two references on it, and exactly one of them is owed back.
       */
      if (displacedFileObjectId !== null) {
        await this.content.dereference(displacedFileObjectId);
      }
    });
  }

  /**
   * A page of a completed export's released documents, as the caller may see them **now** — the
   * export design §3.1. No URL: a link is issued only when one item is clicked (`itemLink`).
   *
   * Paged (E-3: there is no silent 1,000-item ceiling), and each item re-asked: a document the
   * caller can no longer *view* is counted in `hidden` and never described; one they can view but
   * no longer download says why, as far as they may know (`NOT_PERMITTED` for a withdrawn
   * permission, an ACL change and a confidentiality level alike). Membership of the export grants
   * nothing.
   *
   * Audited once per request as `BULK_EXPORT_OPENED`, with counts only — never the identity of an
   * item the caller can no longer see.
   */
  async items(operationId: string, page: PageRequest): Promise<BulkExportItemsPage> {
    const operation = await this.requireCompletedOwnExport(operationId);
    const pageRequest = { page: page.page, pageSize: Math.min(page.pageSize, 100) };
    const applied = await this.unitOfWork.run(() =>
      this.operations.itemsOf(operationId, pageRequest, { outcome: BulkItemOutcome.APPLIED }),
    );
    const data: BulkExportItemView[] = [];
    let hidden = 0;
    for (const item of applied.data) {
      const row = await this.rowOf(item.targetId);
      if (row === null || !(await this.reaches(row.id, Permission.DOCUMENT_VIEW))) {
        hidden += 1;
        continue;
      }
      const exported = exportedRevisionOf(item.detail);
      const current = row.currentRevision ?? row.latestRevision;
      data.push({
        documentId: row.id,
        documentNumber: row.documentNumber,
        title: row.title,
        filename: current?.file.filename ?? null,
        sizeBytes: current?.file.sizeBytes ?? null,
        exportedRevisionLabel: exported?.revisionLabel ?? null,
        currentRevisionLabel: current?.label ?? null,
        ...(await this.availability(row)),
      });
    }

    await this.writer.read(() =>
      this.writer.record({
        action: BulkAudit.BULK_EXPORT_OPENED,
        subjectType: AuditSubjectType.BULK_OPERATION,
        subjectId: asId<AnyId>(operationId),
        operation: AdministrativeOperation.UPDATED,
        after: {
          page: pageRequest.page,
          applied: applied.meta.total,
          availableNow: data.filter((entry) => entry.available).length,
          unavailableNow: data.filter((entry) => !entry.available).length,
          hiddenNow: hidden,
        },
      }),
    );

    return {
      operationId,
      tally: operation.tally,
      hidden,
      manifestAvailable: operation.fileObjectId !== null,
      data,
      meta: applied.meta,
    };
  }

  /**
   * A verified download link for one released document, issued when it is clicked — never before.
   *
   * Every question is asked again, as for a document's own download: the export is the caller's
   * own, `EXPORT` and `COMPLETED`; the document is one it released (membership is required, and
   * grants nothing); the caller reaches it for `document:download`; its confidentiality level
   * allows download; and Storage's own checks (scan, integrity, size, the store's HEAD). The link
   * serves the document's **current** effective revision — the single download's rule — and names
   * the export, so its redemption re-asks the export's questions too. `FILE_DOWNLOAD_ISSUED` is
   * written only with the link it describes.
   */
  async itemLink(
    operationId: string,
    documentId: string,
  ): Promise<{
    readonly documentId: string;
    readonly filename: string;
    readonly url: string;
    readonly expiresAt: Date;
  }> {
    await this.requireCompletedOwnExport(operationId);
    const target = await this.releasedTarget(operationId, documentId, 'issue');
    const link = await this.content.downloadLink(target.fileObjectId, target.filename, {
      documentId,
      revisionId: null,
      operationId,
    });
    return { documentId, filename: target.filename, url: link.url, expiresAt: link.expiresAt };
  }

  /**
   * A verified download link for the export's manifest — the requester's, and only while it names
   * nothing they can no longer see (the export design §4).
   *
   * The manifest names documents. A document reclassified or moved out of the requester's reach
   * after the export would still be named in a file handed over later, and a stored file cannot be
   * re-checked the way a link can. So it is refused (403) as soon as **any** document the export
   * released is no longer viewable by the requester; the per-item list still shows what they may
   * see.
   */
  async manifestLink(
    operationId: string,
  ): Promise<{ readonly filename: string; readonly url: string; readonly expiresAt: Date }> {
    const operation = await this.requireCompletedOwnExport(operationId);
    if (operation.fileObjectId === null) {
      throw new NotFoundError('The requested bulk export');
    }
    await this.refuseWhenManifestNamesHidden(operationId);
    const filename = manifestNameFor(operationId);
    const link = await this.content.manifestLink(operation.fileObjectId, filename, operationId);
    return { filename, url: link.url, expiresAt: link.expiresAt };
  }

  /**
   * Redemption of a released document's link: the export's half (the document's own questions —
   * permission, ACL — are asked by the redeemer before this). Own, `EXPORT`, `COMPLETED`, released
   * by it, level allows, and the link's file is still the document's current file.
   */
  async redeemItemDownload(
    documentId: string,
    operationId: string,
    fileObjectId: string,
  ): Promise<void> {
    await this.requireCompletedOwnExport(operationId);
    const target = await this.releasedTarget(operationId, documentId, 'redeem');
    if (target.fileObjectId !== fileObjectId) {
      throw new NotFoundError('the document’s content changed since it was issued');
    }
  }

  /** Redemption of a manifest link: the issuing checks again, and the file is still the manifest. */
  async redeemManifestDownload(
    operationId: string,
    fileObjectId: string,
    filename: string,
    mimeType: string,
  ): Promise<void> {
    const operation = await this.requireCompletedOwnExport(operationId);
    if (
      operation.fileObjectId !== fileObjectId ||
      filename !== manifestNameFor(operationId) ||
      mimeType !== MANIFEST_MEDIA_TYPE
    ) {
      throw new NotFoundError('the link does not describe this export’s manifest');
    }
    try {
      await this.refuseWhenManifestNamesHidden(operationId);
    } catch (error) {
      if (error instanceof DomainError && error.code === ErrorCode.FORBIDDEN) {
        throw new NotFoundError('the manifest names documents the person can no longer see');
      }
      throw error;
    }
  }

  /**
   * The operation, if it is the caller's own **export** and has **finished** (E-2).
   *
   * Links are the release of an export's results, so nothing else qualifies:
   * - another person's operation, or an identifier this tenant's database does not hold;
   * - an operation of another kind (UPLOAD, METADATA, APPROVAL, RESTORE), whose applied items were
   *   never decided as releases;
   * - an export not yet `COMPLETED` — `REQUESTED` or `RUNNING` has not decided every item, and
   *   `FAILED` is defined as one whose per-item outcomes are incomplete (`BulkOperationState`).
   *
   * All of them answer the same `404`, as the controller's own check does: "not yours", "not an
   * export" and "not finished" must not be a probe for which identifiers exist.
   */
  private async requireCompletedOwnExport(operationId: string): Promise<BulkOperationRecord> {
    const { userId } = requireContext();
    const operation = await this.unitOfWork.run(() => this.operations.findById(operationId));
    if (
      operation === null ||
      userId === null ||
      (operation.requestedById as string) !== userId ||
      operation.kind !== BulkOperationKind.EXPORT ||
      operation.state !== BulkOperationState.COMPLETED
    ) {
      throw new NotFoundError('The requested bulk export');
    }
    return operation;
  }

  /**
   * The file a download of a released document serves now: released by this export, reachable by
   * the caller for `document:download`, with content, at a level that allows download. The same
   * target the single download serves (`DefaultDocumentService.downloadTarget`).
   */
  private async releasedTarget(
    operationId: string,
    documentId: string,
    moment: 'issue' | 'redeem',
  ): Promise<{ readonly fileObjectId: string; readonly filename: string }> {
    const item = await this.unitOfWork.run(() => this.operations.itemOf(operationId, documentId));
    if (item === null || item.outcome !== BulkItemOutcome.APPLIED) {
      throw new NotFoundError('The requested document');
    }
    const row = await this.rowOf(documentId);
    if (row === null || !(await this.reaches(row.id, Permission.DOCUMENT_DOWNLOAD))) {
      throw new NotFoundError('The requested document');
    }
    const revision = row.currentRevision ?? row.latestRevision;
    if (revision === null) {
      throw new NotFoundError('The requested file');
    }
    if (moment === 'redeem') {
      if (!(await this.levelAllowsDownload(row.confidentialityId))) {
        throw new NotFoundError('the document’s level no longer allows download');
      }
    } else {
      await this.unitOfWork.run(() =>
        refuseWhereLevelForbidsDownload(this.configuration, row.confidentialityId),
      );
    }
    return { fileObjectId: revision.file.fileObjectId, filename: revision.file.filename };
  }

  /** Whether a released document may be downloaded now, and if not, why — as far as may be said. */
  private async availability(row: DocumentRow): Promise<{
    readonly available: boolean;
    readonly unavailableReason: BulkExportUnavailableKey | null;
  }> {
    const no = (reason: BulkExportUnavailableKey) =>
      ({ available: false, unavailableReason: reason }) as const;
    // The tenant-wide `document:download` is the route's own guard; what varies per item is the
    // document's reach and its level.
    if (
      !(await this.reaches(row.id, Permission.DOCUMENT_DOWNLOAD)) ||
      !(await this.levelAllowsDownload(row.confidentialityId))
    ) {
      return no('NOT_PERMITTED');
    }
    const revision = row.currentRevision ?? row.latestRevision;
    if (revision === null) {
      return no('NO_CONTENT');
    }
    const file = revision.file;
    if (
      file.integrityStatus === IntegrityStatus.MISMATCH ||
      file.integrityStatus === IntegrityStatus.UNREADABLE
    ) {
      return no('INTEGRITY_FAILED');
    }
    if (file.scanStatus === ScanStatus.PENDING) {
      return no('SCAN_PENDING');
    }
    if (!isReachableFile(file)) {
      return no('SCAN_FAILED');
    }
    if (file.sizeBytes > this.config.download.maxFileBytes) {
      return no('TOO_LARGE');
    }
    return { available: true, unavailableReason: null };
  }

  /** 403 when any document the export released is no longer viewable by the caller. Paged. */
  private async refuseWhenManifestNamesHidden(operationId: string): Promise<void> {
    for (let page = 1; ; page += 1) {
      const batch = await this.unitOfWork.run(() =>
        this.operations.itemsOf(
          operationId,
          { page, pageSize: 200 },
          { outcome: BulkItemOutcome.APPLIED },
        ),
      );
      for (const item of batch.data) {
        const row = await this.rowOf(item.targetId);
        if (row === null || !(await this.reaches(row.id, Permission.DOCUMENT_VIEW))) {
          throw new ForbiddenError(
            'download this manifest: it names documents you can no longer see',
          );
        }
      }
      if (!batch.meta.hasMore) {
        return;
      }
    }
  }

  private async reaches(documentId: string, permission: PermissionKey): Promise<boolean> {
    const decision = await this.unitOfWork.run(() =>
      this.acl.resolve(
        this.subject(),
        { type: ScopeType.DOCUMENT, id: asId<AnyId>(documentId) },
        permission,
      ),
    );
    return decision.allowed;
  }

  private async levelAllowsDownload(confidentialityId: string): Promise<boolean> {
    try {
      await this.unitOfWork.run(() =>
        refuseWhereLevelForbidsDownload(this.configuration, confidentialityId),
      );
      return true;
    } catch (error) {
      if (error instanceof DomainError && error.code === ErrorCode.FORBIDDEN) {
        return false;
      }
      throw error;
    }
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

/** The manifest's media type and download name: fixed, so a link cannot name anything else. */
export const MANIFEST_MEDIA_TYPE = 'application/json';

export function manifestNameFor(operationId: string): string {
  return `bulk-export-${operationId}.json`;
}

/** The revision an export's `APPLIED` row says it released; null for rows written before it did. */
function exportedRevisionOf(
  detail: string | null,
): { readonly revisionId: string; readonly revisionLabel: string } | null {
  if (detail === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(detail) as { revisionId?: unknown; revisionLabel?: unknown };
    return typeof parsed.revisionId === 'string' && typeof parsed.revisionLabel === 'string'
      ? { revisionId: parsed.revisionId, revisionLabel: parsed.revisionLabel }
      : null;
  } catch {
    return null;
  }
}

export type BulkExportUnavailableKey =
  | 'NOT_PERMITTED'
  | 'NO_CONTENT'
  | 'SCAN_PENDING'
  | 'SCAN_FAILED'
  | 'INTEGRITY_FAILED'
  | 'TOO_LARGE';

export interface BulkExportItemView {
  readonly documentId: string;
  readonly documentNumber: string | null;
  readonly title: string;
  readonly filename: string | null;
  readonly sizeBytes: number | null;
  readonly exportedRevisionLabel: string | null;
  readonly currentRevisionLabel: string | null;
  readonly available: boolean;
  readonly unavailableReason: BulkExportUnavailableKey | null;
}

export interface BulkExportItemsPage {
  readonly operationId: string;
  readonly tally: BulkOperationRecord['tally'];
  readonly hidden: number;
  readonly manifestAvailable: boolean;
  readonly data: readonly BulkExportItemView[];
  readonly meta: Page<BulkExportItemView>['meta'];
}
