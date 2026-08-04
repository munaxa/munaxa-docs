import { Injectable } from '@nestjs/common';

import {
  type FileObjectId,
  type PreviewArtifactKindKey,
  PreviewRenderState,
  type PreviewRenderStateKey,
  type RevisionId,
  asId,
} from '@edms/domain';

import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  ArtifactSaveOutcome,
  OcrResultRecord,
  OcrResultRepository,
  PreviewArtifactRecord,
  PreviewArtifactRepository,
  PreviewRenderRecord,
  PreviewRenderRepository,
} from '../application/ports';

/**
 * The artefact rows. Everything joins the caller's transaction, and the uniqueness that makes
 * at-least-once delivery harmless is `uq_preview_artifact` — recreated `NULLS NOT DISTINCT` in
 * this phase's migration, because a thumbnail's NULL page is one page, not infinitely many.
 */
@Injectable()
export class PrismaPreviewArtifactRepository implements PreviewArtifactRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async find(
    revisionId: RevisionId,
    kind: PreviewArtifactKindKey,
    page: number | null,
  ): Promise<PreviewArtifactRecord | null> {
    const row = await requireTransaction().previewArtifact.findFirst({
      where: { revisionId, kind, page, tenantId: requireContext().tenantId },
    });
    return row === null ? null : toArtifact(row);
  }

  async listForRevision(revisionId: RevisionId): Promise<readonly PreviewArtifactRecord[]> {
    const rows = await requireTransaction().previewArtifact.findMany({
      where: { revisionId, tenantId: requireContext().tenantId },
      orderBy: [{ kind: 'asc' }, { page: 'asc' }],
    });
    return rows.map(toArtifact);
  }

  async save(artifact: PreviewArtifactRecord): Promise<ArtifactSaveOutcome> {
    const tx = requireTransaction();
    const tenantId = requireContext().tenantId;
    const existing = await tx.previewArtifact.findFirst({
      where: {
        revisionId: artifact.revisionId,
        kind: artifact.kind,
        page: artifact.page,
        tenantId,
      },
    });
    if (existing === null) {
      await tx.previewArtifact.create({
        data: {
          id: this.stamps.nextId(),
          tenantId,
          revisionId: artifact.revisionId,
          kind: artifact.kind,
          page: artifact.page,
          fileObjectId: artifact.fileObjectId,
          renderer: artifact.renderer,
          rendererVersion: artifact.rendererVersion,
          ...this.stamps.creation(),
        },
      });
      return { outcome: 'CREATED' };
    }
    if (existing.fileObjectId === artifact.fileObjectId) {
      // A redelivered render: content addressing made the artefact byte-identical, so there is
      // nothing to move and nothing to recount.
      return { outcome: 'UNCHANGED' };
    }
    await tx.previewArtifact.update({
      where: { id: existing.id },
      data: {
        fileObjectId: artifact.fileObjectId,
        renderer: artifact.renderer,
        rendererVersion: artifact.rendererVersion,
        ...this.stamps.update(),
      },
    });
    return {
      outcome: 'REPLACED',
      displacedFileObjectId: asId<FileObjectId>(existing.fileObjectId),
    };
  }
}

@Injectable()
export class PrismaPreviewRenderRepository implements PreviewRenderRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async find(revisionId: RevisionId): Promise<PreviewRenderRecord | null> {
    const row = await requireTransaction().previewRender.findFirst({
      where: { revisionId, tenantId: requireContext().tenantId },
    });
    return row === null ? null : toRender(row);
  }

  async claim(revisionId: RevisionId): Promise<PreviewRenderRecord> {
    const tx = requireTransaction();
    const row = await tx.previewRender.upsert({
      where: { revisionId },
      create: {
        id: this.stamps.nextId(),
        tenantId: requireContext().tenantId,
        revisionId,
        state: PreviewRenderState.PENDING,
        attempts: 1,
        ...this.stamps.creation(),
      },
      update: { attempts: { increment: 1 }, ...this.stamps.update() },
    });
    return toRender(row);
  }

  async settle(
    revisionId: RevisionId,
    outcome: {
      state: PreviewRenderStateKey;
      reason: string | null;
      renderer: string | null;
      rendererVersion: string | null;
      pageCount: number | null;
    },
  ): Promise<void> {
    await requireTransaction().previewRender.update({
      where: { revisionId },
      data: {
        state: outcome.state,
        reason: outcome.reason,
        renderer: outcome.renderer,
        rendererVersion: outcome.rendererVersion,
        pageCount: outcome.pageCount,
        ...this.stamps.update(),
      },
    });
  }
}

@Injectable()
export class PrismaOcrResultRepository implements OcrResultRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async findForRevision(revisionId: RevisionId): Promise<OcrResultRecord | null> {
    const row = await requireTransaction().ocrResult.findFirst({
      where: { revisionId, tenantId: requireContext().tenantId },
    });
    if (row === null) {
      return null;
    }
    return {
      revisionId: asId<RevisionId>(row.revisionId),
      engine: row.engine,
      engineVersion: row.engineVersion,
      language: row.language,
      confidence: row.confidence,
      characterCount: row.characterCount,
    };
  }

  async save(result: OcrResultRecord): Promise<void> {
    await requireTransaction().ocrResult.upsert({
      where: { revisionId: result.revisionId },
      create: {
        id: this.stamps.nextId(),
        tenantId: requireContext().tenantId,
        revisionId: result.revisionId,
        engine: result.engine,
        engineVersion: result.engineVersion,
        language: result.language,
        confidence: result.confidence,
        characterCount: result.characterCount,
        ...this.stamps.creation(),
      },
      update: {
        engine: result.engine,
        engineVersion: result.engineVersion,
        language: result.language,
        confidence: result.confidence,
        characterCount: result.characterCount,
        ...this.stamps.update(),
      },
    });
  }
}

interface ArtifactRow {
  revisionId: string;
  kind: string;
  page: number | null;
  fileObjectId: string;
  renderer: string;
  rendererVersion: string;
}

function toArtifact(row: ArtifactRow): PreviewArtifactRecord {
  return {
    revisionId: asId<RevisionId>(row.revisionId),
    kind: row.kind as PreviewArtifactKindKey,
    page: row.page,
    fileObjectId: asId<FileObjectId>(row.fileObjectId),
    renderer: row.renderer,
    rendererVersion: row.rendererVersion,
  };
}

interface RenderRow {
  revisionId: string;
  state: string;
  reason: string | null;
  renderer: string | null;
  rendererVersion: string | null;
  pageCount: number | null;
  attempts: number;
}

function toRender(row: RenderRow): PreviewRenderRecord {
  return {
    revisionId: asId<RevisionId>(row.revisionId),
    state: row.state as PreviewRenderStateKey,
    reason: row.reason,
    renderer: row.renderer,
    rendererVersion: row.rendererVersion,
    pageCount: row.pageCount,
    attempts: row.attempts,
  };
}
