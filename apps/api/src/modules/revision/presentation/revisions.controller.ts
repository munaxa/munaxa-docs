import { Controller, Get, Param, Query } from '@nestjs/common';

import type { RevisionCompare, RevisionHistory, RevisionHistoryEntry } from '@edms/contracts';
import { Permission, ScopeType } from '@edms/domain';

import { RequirePermission, ScopedTo } from '../../../core/authorization/permission.decorator';
import { ValidationError } from '../../../core/errors/application-errors';
import type { RevisionHistoryRow } from '../application/ports';
import { RevisionQueryService } from '../application/revision-query.service';

/**
 * The revision history and the compare API — Revision's reads.
 *
 * Behind `document:history:view` rather than `document:view`, deliberately: a superseded
 * revision remains readable *to anyone with history permission*
 * (`10-revision-architecture.md` §2), and the matrix in `08-permission-model.md` gives the
 * key a wider row than the write permissions precisely because history is compliance
 * evidence, not clutter. The writes — check-out, check-in, publish, restore — live in the
 * Document module, whose aggregate they move.
 */
@Controller({ version: '1' })
export class RevisionsController {
  constructor(private readonly revisions: RevisionQueryService) {}

  /** The timeline: every revision ever, oldest first, discarded ones included and saying so. */
  @Get('documents/:id/revisions')
  @RequirePermission(Permission.DOCUMENT_HISTORY_VIEW)
  @ScopedTo('id', ScopeType.DOCUMENT)
  async history(@Param('id') id: string): Promise<RevisionHistory> {
    const rows = await this.revisions.history(id);
    return { documentId: id, revisions: rows.map(toEntry) };
  }

  /**
   * Two revisions, compared — by ordinal, because ordinals are the truth the labels render.
   * Content by checksum, metadata by published snapshot, text by paragraph from the preview
   * pipeline's artefacts — `PENDING` while one is still rendering, which is 10 §4's queued
   * comparison — and `pages.comparable` saying whether a side-by-side page view is possible.
   */
  @Get('documents/:id/revisions/compare')
  @RequirePermission(Permission.DOCUMENT_HISTORY_VIEW)
  @ScopedTo('id', ScopeType.DOCUMENT)
  async compare(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<RevisionCompare> {
    const fromOrdinal = asOrdinal('from', from);
    const toOrdinal = asOrdinal('to', to);
    const comparison = await this.revisions.compare(id, fromOrdinal, toOrdinal);
    return {
      documentId: id,
      from: toSide(comparison.from),
      to: toSide(comparison.to),
      content: comparison.content,
      metadata: {
        available: comparison.metadata.available,
        changes: comparison.metadata.changes.map((change) => ({ ...change })),
      },
      text: {
        state: comparison.text.state,
        source: comparison.text.source,
        changes:
          comparison.text.comparison === null
            ? []
            : comparison.text.comparison.changes.map((change) => ({
                kind: change.kind,
                from: change.from,
                to: change.to,
                fromWords:
                  change.fromWords === null ? null : change.fromWords.map((word) => ({ ...word })),
                toWords:
                  change.toWords === null ? null : change.toWords.map((word) => ({ ...word })),
              })),
        identical: comparison.text.comparison?.identical ?? null,
        truncated: comparison.text.comparison?.truncated ?? false,
      },
      pages: { comparable: comparison.pages.comparable },
    };
  }
}

function asOrdinal(field: string, raw: string | undefined): number {
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError('A comparison names two revisions by ordinal.', [
      { field, message: 'a non-negative integer' },
    ]);
  }
  return value;
}

function toEntry(row: RevisionHistoryRow): RevisionHistoryEntry {
  return {
    id: row.id,
    ordinal: row.ordinal,
    label: row.label,
    status: row.status,
    changeNote: row.changeNote,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    restoredFromRevisionId: row.restoredFromRevisionId,
    restoredFromLabel: row.restoredFromLabel,
    file: toFile(row),
  };
}

function toSide(row: RevisionHistoryRow) {
  return {
    id: row.id,
    ordinal: row.ordinal,
    label: row.label,
    status: row.status,
    changeNote: row.changeNote,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    file: toFile(row),
  };
}

function toFile(row: RevisionHistoryRow) {
  return {
    fileObjectId: row.file.fileObjectId,
    filename: row.file.filename,
    mimeType: row.file.mimeType,
    sizeBytes: row.file.sizeBytes,
    checksumSha256: row.file.checksumSha256,
    scanStatus: row.file.scanStatus,
    reachable: row.file.scanStatus === 'CLEAN',
    thumbnailUrl: null,
  };
}
