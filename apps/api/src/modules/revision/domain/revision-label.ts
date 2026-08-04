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
export function revisionLabelFor(ordinal: number, style: RevisionLabelStyleKey): string {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error('A revision ordinal is a non-negative integer.');
  }
  switch (style) {
    case RevisionLabelStyle.NUMERIC:
      // Zero is the first issue, and calling it `R0` reads as a mistake to everybody outside the
      // database. `Original` is what the architecture's own diagram calls it.
      return ordinal === 0 ? 'Original' : `R${String(ordinal)}`;

    case RevisionLabelStyle.ALPHABETIC:
      return alphabetic(ordinal);

    case RevisionLabelStyle.MAJOR_MINOR:
      // Phase 3 only ever creates ordinal zero, and Phase 6 decides what increments a major. Until
      // it does, every ordinal is a minor of major one, which is what a draft series looks like
      // before anything is approved: 1.0, 1.1, 1.2.
      return `1.${String(ordinal)}`;
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
