import { RevisionLabelStyle, type RevisionLabelStyleKey } from '@edms/domain';

/**
 * What a revision is called, rendered from what it is.
 *
 * The ordinal is the truth and the label is a display convention the document's type chooses
 * (`10-revision-architecture.md` §2). Two documents of different types may show `R1` and `B` for
 * the same ordinal and both are right.
 *
 * The label is **stored** rather than derived on read, and this function is called once, at
 * creation. That is the whole reason it is worth writing down: a type whose style is changed later
 * must not silently relabel history. A printed copy of revision 3 says `R3`, and a document control
 * system in which the same revision is called something different next year is a document control
 * system whose evidence does not match the paper.
 */
/**
 * Where a revision stands in its document's publication history, for the one style that cares.
 *
 * Phase 3 left "what increments a major" as Phase 6's decision, and this is it: **publication
 * increments the major**. `published` counts the revisions published before this one was
 * created; `sinceLastPublished` counts the drafts created since the last publication (zero for
 * the first draft after one, and for ordinal zero). So a document reads `1.0` as its original,
 * `2.0` as the first draft after the original publishes, `2.1` as that draft's replacement if
 * it is discarded and re-checked-in — and the ordinal underneath stays the contiguous truth.
 *
 * Both are facts at creation, because the label is rendered once and stored: a revision's name
 * never changes when its document's later history does.
 */
export interface RevisionLineage {
  readonly published: number;
  readonly sinceLastPublished: number;
}

const FIRST_ISSUE: RevisionLineage = Object.freeze({ published: 0, sinceLastPublished: 0 });

export function revisionLabelFor(
  ordinal: number,
  style: RevisionLabelStyleKey,
  lineage: RevisionLineage = FIRST_ISSUE,
): string {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error('A revision ordinal is a non-negative integer.');
  }
  if (
    !Number.isInteger(lineage.published) ||
    lineage.published < 0 ||
    !Number.isInteger(lineage.sinceLastPublished) ||
    lineage.sinceLastPublished < 0
  ) {
    throw new Error('A revision lineage counts whole revisions.');
  }
  switch (style) {
    case RevisionLabelStyle.NUMERIC:
      // Zero is the first issue, and calling it `R0` reads as a mistake to everybody outside the
      // database. `Original` is what the architecture's own diagram calls it.
      return ordinal === 0 ? 'Original' : `R${String(ordinal)}`;

    case RevisionLabelStyle.ALPHABETIC:
      return alphabetic(ordinal);

    case RevisionLabelStyle.MAJOR_MINOR:
      return `${String(lineage.published + 1)}.${String(lineage.sinceLastPublished)}`;
  }
}

/**
 * `A`, `B`, … `Z`, `AA`, `AB` — spreadsheet column lettering.
 *
 * Not base-26: there is no zero digit, so `Z` is followed by `AA` rather than by `BA`. Getting this
 * wrong produces labels that look right for the first twenty-six revisions and then collide, which
 * is the kind of defect that ships.
 */
function alphabetic(ordinal: number): string {
  let remaining = ordinal;
  let label = '';
  do {
    label = String.fromCharCode(65 + (remaining % 26)) + label;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return label;
}
