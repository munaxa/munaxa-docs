/**
 * Paragraph-level text comparison with word-level highlighting — 10 §4's third row.
 *
 * Comparison is read-only and derived, never authoritative: what is diffed is the extracted
 * text the preview pipeline produced, and what comes out is presentation, not evidence — the
 * evidence is the checksums, which the content section already reports exactly.
 *
 * The algorithm is an LCS over paragraphs, then an LCS over words inside each changed pair.
 * Deliberately bounded: above the cap the comparison is truncated and says so, because a diff
 * of a two-thousand-page manual is not something a person reads — it is something that should
 * have been a smaller question.
 */

export type ParagraphChangeKind = 'EQUAL' | 'ADDED' | 'REMOVED' | 'CHANGED';

export interface WordSpan {
  readonly text: string;
  readonly changed: boolean;
}

export interface ParagraphChange {
  readonly kind: ParagraphChangeKind;
  /** The paragraph on each side. Null where the side has none (ADDED / REMOVED). */
  readonly from: string | null;
  readonly to: string | null;
  /** Word-level spans, present on CHANGED rows only. */
  readonly fromWords: readonly WordSpan[] | null;
  readonly toWords: readonly WordSpan[] | null;
}

export interface TextComparison {
  readonly changes: readonly ParagraphChange[];
  readonly identical: boolean;
  readonly truncated: boolean;
}

/** Above this many paragraphs a side is truncated — the LCS is quadratic and a reader is not. */
export const MAX_COMPARED_PARAGRAPHS = 1_000;

export function splitParagraphs(text: string): readonly string[] {
  return text
    .split(/\n{2,}|\r?\n(?=\S)/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function compareTexts(fromText: string, toText: string): TextComparison {
  const fromAll = splitParagraphs(fromText);
  const toAll = splitParagraphs(toText);
  const truncated =
    fromAll.length > MAX_COMPARED_PARAGRAPHS || toAll.length > MAX_COMPARED_PARAGRAPHS;
  const from = fromAll.slice(0, MAX_COMPARED_PARAGRAPHS);
  const to = toAll.slice(0, MAX_COMPARED_PARAGRAPHS);

  const aligned = align(from, to);
  const changes: ParagraphChange[] = [];
  let index = 0;
  while (index < aligned.length) {
    const entry = aligned[index];
    if (entry === undefined) {
      break;
    }
    // A REMOVED immediately followed by an ADDED is one edited paragraph, not two events —
    // pairing them is what makes word-level highlighting possible.
    const next = aligned[index + 1];
    if (entry.kind === 'REMOVED' && next !== undefined && next.kind === 'ADDED') {
      changes.push(changedPair(entry.value, next.value));
      index += 2;
      continue;
    }
    if (entry.kind === 'EQUAL') {
      changes.push({
        kind: 'EQUAL',
        from: entry.value,
        to: entry.value,
        fromWords: null,
        toWords: null,
      });
    } else if (entry.kind === 'REMOVED') {
      changes.push({
        kind: 'REMOVED',
        from: entry.value,
        to: null,
        fromWords: null,
        toWords: null,
      });
    } else {
      changes.push({ kind: 'ADDED', from: null, to: entry.value, fromWords: null, toWords: null });
    }
    index += 1;
  }

  return {
    changes,
    identical: !truncated && changes.every((change) => change.kind === 'EQUAL'),
    truncated,
  };
}

function changedPair(from: string, to: string): ParagraphChange {
  const fromWords = from.split(' ');
  const toWords = to.split(' ');
  const common = lcs(fromWords, toWords);
  return {
    kind: 'CHANGED',
    from,
    to,
    fromWords: markWords(fromWords, common.fromMatched),
    toWords: markWords(toWords, common.toMatched),
  };
}

function markWords(words: readonly string[], matched: readonly boolean[]): readonly WordSpan[] {
  return words.map((text, index) => ({ text, changed: matched[index] !== true }));
}

interface Aligned {
  readonly kind: 'EQUAL' | 'ADDED' | 'REMOVED';
  readonly value: string;
}

/** The paragraph alignment: LCS, emitted as removed-then-added runs between common lines. */
function align(from: readonly string[], to: readonly string[]): readonly Aligned[] {
  const { fromMatched, toMatched, pairs } = lcs(from, to);
  const result: Aligned[] = [];
  let fromIndex = 0;
  let toIndex = 0;
  for (const pair of [...pairs, { from: from.length, to: to.length }]) {
    while (fromIndex < pair.from) {
      const value = from[fromIndex];
      if (value !== undefined && fromMatched[fromIndex] !== true) {
        result.push({ kind: 'REMOVED', value });
      }
      fromIndex += 1;
    }
    while (toIndex < pair.to) {
      const value = to[toIndex];
      if (value !== undefined && toMatched[toIndex] !== true) {
        result.push({ kind: 'ADDED', value });
      }
      toIndex += 1;
    }
    const value = from[pair.from];
    if (pair.from < from.length && value !== undefined) {
      result.push({ kind: 'EQUAL', value });
      fromIndex = pair.from + 1;
      toIndex = pair.to + 1;
    }
  }
  return result;
}

interface LcsResult {
  readonly fromMatched: readonly boolean[];
  readonly toMatched: readonly boolean[];
  /** Matched index pairs, in order. */
  readonly pairs: readonly { readonly from: number; readonly to: number }[];
}

/** Classic dynamic-programming LCS. Inputs are already capped, so quadratic is affordable. */
function lcs(from: readonly string[], to: readonly string[]): LcsResult {
  const rows = from.length + 1;
  const cols = to.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = from.length - 1; i >= 0; i -= 1) {
    for (let j = to.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        from[i] === to[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }
  const fromMatched = new Array<boolean>(from.length).fill(false);
  const toMatched = new Array<boolean>(to.length).fill(false);
  const pairs: { from: number; to: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < from.length && j < to.length) {
    if (from[i] === to[j]) {
      fromMatched[i] = true;
      toMatched[j] = true;
      pairs.push({ from: i, to: j });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return { fromMatched, toMatched, pairs };
}
