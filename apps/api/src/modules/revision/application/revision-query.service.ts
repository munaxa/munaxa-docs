import { Inject, Injectable } from '@nestjs/common';

import { type DocumentId, RevisionStatus, asId } from '@edms/domain';

import { NotFoundError } from '../../../core/errors/application-errors';
import { AdministeredWriter } from '../../../core/persistence';
import {
  REVISION_QUERY,
  type RevisionHistoryRow,
  type RevisionQuery,
  type SnapshotEntry,
} from './ports';

/**
 * History and comparison — Revision's answers to "what did it look like, and how do these two
 * differ".
 *
 * Comparison is read-only and derived, never a mutation and never authoritative
 * (`10-revision-architecture.md` §4). Three layers of it exist in the design; this phase
 * builds the two the current pipeline can answer honestly:
 *
 * - **Content**, by checksum. Content-addressed storage makes "identical bytes" exact and
 *   free — reported as identical or changed, never diffed.
 * - **Metadata**, from the snapshots publication wrote. Two published revisions diff field by
 *   field; a side that has no snapshot yet (a draft, or anything published before nothing —
 *   there is none, snapshots arrive with publication) makes the answer "unavailable" rather
 *   than a diff of live values that proves nothing about what an approver saw.
 * - **Text and pages** consume the preview pipeline's artefacts, which are Phase 7's. The
 *   contract states `UNAVAILABLE`; the state fills in when the artefacts exist.
 */
@Injectable()
export class RevisionQueryService {
  constructor(
    @Inject(REVISION_QUERY) private readonly revisions: RevisionQuery,
    private readonly writer: AdministeredWriter,
  ) {}

  async history(documentId: string): Promise<readonly RevisionHistoryRow[]> {
    return this.writer.read(async () => {
      const rows = await this.revisions.historyFor(asId<DocumentId>(documentId));
      if (rows.length === 0) {
        // Every document has ordinal zero from the moment it exists, so an empty history is
        // a document this tenant does not have.
        throw new NotFoundError('The requested document');
      }
      return rows;
    });
  }

  async compare(documentId: string, fromOrdinal: number, toOrdinal: number): Promise<Comparison> {
    return this.writer.read(async () => {
      const id = asId<DocumentId>(documentId);
      const [from, to] = await Promise.all([
        this.revisions.byOrdinal(id, fromOrdinal),
        this.revisions.byOrdinal(id, toOrdinal),
      ]);
      if (from === null || to === null) {
        throw new NotFoundError('A revision named in the comparison');
      }

      return {
        from,
        to,
        content: {
          identical: from.file.checksumSha256 === to.file.checksumSha256,
          sizeDelta: to.file.sizeBytes - from.file.sizeBytes,
          mimeChanged: from.file.mimeType !== to.file.mimeType,
          filenameChanged: from.file.filename !== to.file.filename,
        },
        metadata: compareSnapshots(from, to),
      };
    });
  }
}

export interface Comparison {
  readonly from: RevisionHistoryRow;
  readonly to: RevisionHistoryRow;
  readonly content: {
    readonly identical: boolean;
    readonly sizeDelta: number;
    readonly mimeChanged: boolean;
    readonly filenameChanged: boolean;
  };
  readonly metadata: {
    readonly available: boolean;
    readonly changes: readonly MetadataChangeRow[];
  };
}

export interface MetadataChangeRow {
  readonly key: string;
  readonly name: string;
  readonly from: string | null;
  readonly to: string | null;
}

function compareSnapshots(
  from: RevisionHistoryRow,
  to: RevisionHistoryRow,
): Comparison['metadata'] {
  const snapshotsExist =
    from.metadataSnapshot !== null &&
    to.metadataSnapshot !== null &&
    wasPublished(from) &&
    wasPublished(to);
  if (!snapshotsExist) {
    return { available: false, changes: [] };
  }
  const fromSnapshot = from.metadataSnapshot ?? {};
  const toSnapshot = to.metadataSnapshot ?? {};

  const keys = new Set([...Object.keys(fromSnapshot), ...Object.keys(toSnapshot)]);
  const changes: MetadataChangeRow[] = [];
  for (const key of [...keys].sort()) {
    const before = fromSnapshot[key];
    const after = toSnapshot[key];
    const beforeValue = render(before);
    const afterValue = render(after);
    if (beforeValue !== afterValue) {
      changes.push({
        key,
        name: after?.name ?? before?.name ?? key,
        from: beforeValue,
        to: afterValue,
      });
    }
  }
  return { available: true, changes };
}

function wasPublished(row: RevisionHistoryRow): boolean {
  return row.status === RevisionStatus.PUBLISHED || row.status === RevisionStatus.SUPERSEDED;
}

/** A snapshot value as one comparable string; structure beyond that is Phase 7's viewer. */
function render(entry: SnapshotEntry | undefined): string | null {
  if (entry === undefined || entry.value === null || entry.value === undefined) {
    return null;
  }
  const { value } = entry;
  if (Array.isArray(value)) {
    return value.map((item) => renderScalar(item)).join(', ');
  }
  return renderScalar(value);
}

/** A single stored scalar. The snapshot writes scalars and lists of them, nothing deeper. */
function renderScalar(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}
