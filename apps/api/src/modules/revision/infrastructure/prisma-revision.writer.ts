import { Injectable } from '@nestjs/common';

import { RevisionLabelStyle, type RevisionLabelStyleKey, RevisionStatus } from '@edms/domain';

import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { RevisionWriter } from '../../document/application/ports';
import { revisionLabelFor } from '../domain/revision-label';

/**
 * The first revision of a document.
 *
 * This class is the whole of Revision in Phase 3, and its shape is the dependency inversion the
 * boundary rules require. Revision sits *below* Document — it depends on Document, not the other
 * way round — so Document cannot call it. What Document can do is declare what it needs, in its own
 * words, and that is `RevisionWriter` in `document/application/ports.ts`. This implements it.
 *
 * The direction of the import is the proof: this file imports Document's port, and nothing in
 * Document imports anything of Revision's. The Nest wiring in `document.module.ts` points the other
 * way, as DI wiring always does — from the consumer to the container entry that satisfies it — and
 * that is composition rather than dependency.
 *
 * **Ordinal zero, and nothing else.** Check-out, check-in, compare and restore are Phase 6's;
 * publishing is Phase 4's. What is here is the record that binds a document to its bytes, which is
 * what makes "prove what was approved" answerable later: revision → file → checksum.
 *
 * It joins the caller's transaction. A document with no revision has no content, and there is no
 * moment at which that state should be observable.
 */
@Injectable()
export class PrismaRevisionWriter implements RevisionWriter {
  constructor(private readonly stamps: RecordStamps) {}

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
