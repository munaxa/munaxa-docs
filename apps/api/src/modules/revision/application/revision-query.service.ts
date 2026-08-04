import { Inject, Injectable } from '@nestjs/common';

import {
  type DocumentId,
  PreviewRenderState,
  type RevisionId,
  RevisionStatus,
  asId,
} from '@edms/domain';

import { NotFoundError } from '../../../core/errors/application-errors';
import { AdministeredWriter } from '../../../core/persistence';
import { PreviewQueryService } from '../../preview/application/preview-query.service';
import { type TextComparison, compareTexts } from '../domain/text-diff';
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
 * - **Text and pages**, from Phase 7 on, consume the preview pipeline's artefacts, exactly as
 *   the `UNAVAILABLE` contract promised: extracted text diffed by paragraph with word-level
 *   highlighting, `PENDING` while an artefact is still rendering (10 §4's queued comparison —
 *   the render *is* the queued work, and the UI says so rather than showing a partial diff),
 *   and `UNAVAILABLE` where a format honestly has no words. The rendered-pages row is the
 *   `pages.comparable` flag: the client fetches each side's preview per click, because issuing
 *   a page URL is an audited act.
 */
@Injectable()
export class RevisionQueryService {
  constructor(
    @Inject(REVISION_QUERY) private readonly revisions: RevisionQuery,
    private readonly writer: AdministeredWriter,
    private readonly previews: PreviewQueryService,
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
        text: await this.compareText(from, to),
        pages: { comparable: await this.pagesComparable(from, to) },
      };
    });
  }

  private async compareText(
    from: RevisionHistoryRow,
    to: RevisionHistoryRow,
  ): Promise<TextComparisonSection> {
    const [fromFacts, toFacts] = await Promise.all([
      this.previews.facts(asId<RevisionId>(from.id)),
      this.previews.facts(asId<RevisionId>(to.id)),
    ]);
    if (fromFacts.hasText && toFacts.hasText) {
      const [fromPages, toPages] = await Promise.all([
        this.previews.textPages(asId<RevisionId>(from.id)),
        this.previews.textPages(asId<RevisionId>(to.id)),
      ]);
      if (fromPages !== null && toPages !== null) {
        const sources = new Set([fromPages.source, toPages.source]);
        return {
          state: 'AVAILABLE',
          source: sources.size === 1 ? fromPages.source : 'MIXED',
          comparison: compareTexts(joinPages(fromPages.pages), joinPages(toPages.pages)),
        };
      }
    }
    // 10 §4: a missing artefact means the comparison is queued and the UI says so. The render
    // pipeline is the queue; PENDING here is that promise kept, and a terminal render with no
    // text — an unsupported format, a drawing, an exhausted failure — is honestly UNAVAILABLE.
    const stillRendering =
      fromFacts.state === PreviewRenderState.PENDING ||
      toFacts.state === PreviewRenderState.PENDING;
    return { state: stillRendering ? 'PENDING' : 'UNAVAILABLE', source: null, comparison: null };
  }

  private async pagesComparable(
    from: RevisionHistoryRow,
    to: RevisionHistoryRow,
  ): Promise<boolean> {
    const [fromFacts, toFacts] = await Promise.all([
      this.previews.facts(asId<RevisionId>(from.id)),
      this.previews.facts(asId<RevisionId>(to.id)),
    ]);
    const viewable = (mode: string | null): boolean => mode === 'PDF' || mode === 'IMAGE';
    return viewable(fromFacts.mode) && viewable(toFacts.mode);
  }
}

export interface TextComparisonSection {
  readonly state: 'UNAVAILABLE' | 'PENDING' | 'AVAILABLE';
  readonly source: 'TEXT' | 'OCR' | 'MIXED' | null;
  readonly comparison: TextComparison | null;
}

function joinPages(pages: readonly { readonly text: string }[]): string {
  return pages.map((page) => page.text).join('\n\n');
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
  readonly text: TextComparisonSection;
  readonly pages: { readonly comparable: boolean };
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
