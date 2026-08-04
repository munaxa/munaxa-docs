import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type DocumentId,
  type RevisionId,
  RevisionLabelStyle,
  type RevisionLabelStyleKey,
  RevisionStatus,
  type RevisionStatusKey,
  asId,
} from '@edms/domain';

import { NotFoundError, VersionConflictError } from '../../../core/errors/application-errors';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { RevisionFacts, RevisionWriter } from '../../document/application/ports';
import {
  revisionCreatedEvent,
  revisionPublishedEvent,
  revisionRestoredEvent,
  revisionSupersededEvent,
} from '../domain/events';
import { revisionLabelFor } from '../domain/revision-label';

/**
 * Every write onto `document_revision`, behind Document's inverted port.
 *
 * Phase 3 built `createInitial` and called it the whole of Revision; Phase 6 fills in the rest
 * of the port the same way, and the shape has not changed: Revision sits *below* Document — it
 * depends on Document, not the other way round — so Document declares what it needs in its own
 * vocabulary (`RevisionWriter` in `document/application/ports.ts`) and this class implements
 * it. The import direction is the proof: this file imports Document's port, and nothing in
 * Document imports anything of this module's.
 *
 * Revision's own events are published from in here, inside the caller's transaction, because
 * `revision.created` is Revision's fact in Revision's vocabulary — Document causes it without
 * having to know how it is spelled.
 *
 * Everything joins the caller's transaction. A revision is never a fact on its own: it exists
 * with the lock release, the status move and the audit event of the operation that made it.
 */
@Injectable()
export class PrismaRevisionWriter implements RevisionWriter {
  constructor(
    private readonly stamps: RecordStamps,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
  ) {}

  async createInitial(input: {
    documentId: string;
    fileObjectId: string;
    filename: string;
    changeNote: string | null;
    labelStyle: string;
  }): Promise<{ readonly revisionId: string; readonly label: string }> {
    const id = this.stamps.nextId();
    // Ordinal zero is the first issue. Contiguous and strictly increasing per document is the rule
    // (`10-revision-architecture.md` §2), and starting anywhere else would make the first
    // check-in's ordinal a guess.
    const ordinal = 0;
    const label = revisionLabelFor(ordinal, asLabelStyle(input.labelStyle));

    await requireTransaction().documentRevision.create({
      data: {
        id,
        tenantId: requireContext().tenantId,
        documentId: input.documentId,
        ordinal,
        // Stored, not derived on read. A document type whose label style is changed later must not
        // silently relabel history: a printed copy saying `R1` and a screen saying `B` for the same
        // revision is a document-control system whose evidence contradicts the paper.
        label,
        status: RevisionStatus.DRAFT,
        fileObjectId: input.fileObjectId,
        filename: input.filename,
        changeNote: input.changeNote,
        ...this.stamps.creation(),
      },
    });

    return { revisionId: id, label };
  }

  async createNext(input: {
    documentId: string;
    fileObjectId: string;
    filename: string;
    changeNote: string | null;
    labelStyle: string;
    restoredFromRevisionId: string | null;
  }): Promise<{ readonly revisionId: string; readonly ordinal: number; readonly label: string }> {
    const tx = requireTransaction();
    const tenantId = requireContext().tenantId;

    // The lineage in one read: the next ordinal, how many revisions have published, and how far
    // the newest is past the last publication — which is everything the label styles between
    // them need. Read inside the same transaction that inserts, and the ordinal's uniqueness is
    // still `uq_revision_ordinal`'s to enforce, not this read's to guess right.
    const revisions = await tx.documentRevision.findMany({
      where: { documentId: input.documentId, tenantId },
      select: { ordinal: true, publishedAt: true },
      orderBy: { ordinal: 'desc' },
    });
    const newest = revisions[0];
    if (newest === undefined) {
      throw new NotFoundError('The document this revision extends');
    }
    const ordinal = newest.ordinal + 1;
    const published = revisions.filter((row) => row.publishedAt !== null).length;
    const lastPublished = revisions.find((row) => row.publishedAt !== null);
    const sinceLastPublished =
      lastPublished === undefined ? ordinal : ordinal - lastPublished.ordinal - 1;
    const label = revisionLabelFor(ordinal, asLabelStyle(input.labelStyle), {
      published,
      sinceLastPublished,
    });

    const id = this.stamps.nextId();
    try {
      await tx.documentRevision.create({
        data: {
          id,
          tenantId,
          documentId: input.documentId,
          ordinal,
          label,
          status: RevisionStatus.DRAFT,
          fileObjectId: input.fileObjectId,
          filename: input.filename,
          changeNote: input.changeNote,
          restoredFromRevisionId: input.restoredFromRevisionId,
          ...this.stamps.creation(),
        },
      });
    } catch (error) {
      if (isOrdinalCollision(error)) {
        // Two check-ins racing on one document. `uq_revision_ordinal` decides — the read above
        // was a moment old — and the loser is told to look again, not handed a stack trace.
        throw new VersionConflictError(ordinal, ordinal + 1);
      }
      throw error;
    }

    const authorId = requireContext().userId ?? '';
    await this.outbox.publish([
      revisionCreatedEvent(asId<AnyId>(id), {
        revisionId: id,
        documentId: input.documentId,
        ordinal,
        authorId,
      }),
      ...(input.restoredFromRevisionId === null
        ? []
        : [
            revisionRestoredEvent(asId<AnyId>(id), {
              revisionId: id,
              documentId: input.documentId,
              restoredFromRevisionId: input.restoredFromRevisionId,
            }),
          ]),
    ]);

    return { revisionId: id, ordinal, label };
  }

  async describe(documentId: string, revisionId: string): Promise<RevisionFacts | null> {
    const row = await requireTransaction().documentRevision.findFirst({
      // The document is in the predicate, so a revision of another document is "not found"
      // rather than somebody else's fact described under this document's URL.
      where: { id: revisionId, documentId, tenantId: requireContext().tenantId, deletedAt: null },
    });
    return row === null ? null : toFacts(row);
  }

  async describePublished(documentId: string): Promise<RevisionFacts | null> {
    const row = await requireTransaction().documentRevision.findFirst({
      where: {
        documentId,
        tenantId: requireContext().tenantId,
        status: RevisionStatus.PUBLISHED,
      },
    });
    return row === null ? null : toFacts(row);
  }

  async setWorkingStatus(input: {
    revisionId: string;
    from: readonly RevisionStatusKey[];
    to: RevisionStatusKey;
  }): Promise<void> {
    // The current status is in the predicate: a revision in neither named state matches nothing
    // and stays what it is, which is what makes the engine's repeated transitions harmless.
    await requireTransaction().documentRevision.updateMany({
      where: {
        id: input.revisionId,
        tenantId: requireContext().tenantId,
        status: { in: [...input.from] },
      },
      data: { status: input.to, ...this.stamps.update(), version: { increment: 1 } },
    });
  }

  async publish(input: {
    documentId: string;
    revisionId: string;
    publishedAt: Date;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    metadataSnapshot: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly supersededRevisionId: string | null }> {
    const tx = requireTransaction();
    const tenantId = requireContext().tenantId;

    // Supersede first, publish second — in that order because `uq_revision_published` is not
    // deferrable: while the old row still says PUBLISHED, the new row may not. The prior
    // revision keeps its own `published_at` and its effective window; what it loses is only
    // the status, which is the definition of superseded.
    const prior = await tx.documentRevision.findFirst({
      where: { documentId: input.documentId, tenantId, status: RevisionStatus.PUBLISHED },
      select: { id: true },
    });
    if (prior !== null) {
      await tx.documentRevision.updateMany({
        where: { id: prior.id, tenantId, status: RevisionStatus.PUBLISHED },
        data: {
          status: RevisionStatus.SUPERSEDED,
          ...this.stamps.update(),
          version: { increment: 1 },
        },
      });
    }

    const { count } = await tx.documentRevision.updateMany({
      // The states a revision may publish from. IN_APPROVAL is the two-machine model working;
      // DRAFT covers every revision approved before Phase 6 existed, which nothing ever moved.
      where: {
        id: input.revisionId,
        documentId: input.documentId,
        tenantId,
        status: { in: [RevisionStatus.IN_APPROVAL, RevisionStatus.DRAFT] },
      },
      data: {
        status: RevisionStatus.PUBLISHED,
        publishedAt: input.publishedAt,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        metadataSnapshot: input.metadataSnapshot as never,
        ...this.stamps.update(),
        version: { increment: 1 },
      },
    });
    if (count === 0) {
      // Raced by another publish, or handed a revision in a state publication cannot take.
      // Refusing is the only honest move — the supersession above rolls back with this.
      throw new NotFoundError('A publishable revision of this document');
    }

    const revision = await tx.documentRevision.findFirstOrThrow({
      where: { id: input.revisionId, tenantId },
      select: { fileObjectId: true },
    });
    await this.outbox.publish([
      revisionPublishedEvent(asId<AnyId>(input.revisionId), {
        revisionId: input.revisionId,
        documentId: input.documentId,
        fileObjectId: revision.fileObjectId,
      }),
      ...(prior === null
        ? []
        : [
            revisionSupersededEvent(asId<AnyId>(prior.id), {
              revisionId: prior.id,
              documentId: input.documentId,
              supersededByRevisionId: input.revisionId,
            }),
          ]),
    ]);

    return { supersededRevisionId: prior?.id ?? null };
  }

  async discard(input: { documentId: string; revisionId: string }): Promise<void> {
    // Only a DRAFT can be discarded — the predicate is the guard. The row stays: the ordinal is
    // spent, and a history with a silent gap is unusable as evidence.
    await requireTransaction().documentRevision.updateMany({
      where: {
        id: input.revisionId,
        documentId: input.documentId,
        tenantId: requireContext().tenantId,
        status: RevisionStatus.DRAFT,
      },
      data: {
        status: RevisionStatus.DISCARDED,
        ...this.stamps.update(),
        version: { increment: 1 },
      },
    });
  }
}

/**
 * The style, narrowed.
 *
 * The port takes a string because Document should not have to import Revision's vocabulary to say
 * which style a type chose — and an unrecognised one falls back to numeric rather than throwing,
 * because a label is a display convention and refusing to create a document over one would be
 * losing a document to a decoration.
 */
function asLabelStyle(raw: string): RevisionLabelStyleKey {
  return raw === RevisionLabelStyle.ALPHABETIC || raw === RevisionLabelStyle.MAJOR_MINOR
    ? raw
    : RevisionLabelStyle.NUMERIC;
}

/** A unique violation on the insert — two check-ins raced and `uq_revision_ordinal` decided. */
function isOrdinalCollision(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

interface RevisionRow {
  id: string;
  documentId: string;
  ordinal: number;
  label: string;
  status: string;
  fileObjectId: string;
  filename: string;
  changeNote: string | null;
  publishedAt: Date | null;
  restoredFromRevisionId: string | null;
}

function toFacts(row: RevisionRow): RevisionFacts {
  return {
    id: asId<RevisionId>(row.id),
    documentId: asId<DocumentId>(row.documentId),
    ordinal: row.ordinal,
    label: row.label,
    status: row.status as RevisionStatusKey,
    fileObjectId: row.fileObjectId,
    filename: row.filename,
    changeNote: row.changeNote,
    publishedAt: row.publishedAt,
    restoredFromRevisionId: row.restoredFromRevisionId,
  };
}
