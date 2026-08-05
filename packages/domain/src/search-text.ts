/**
 * Arabic normalisation for indexing and querying (`12-search-architecture.md` §4).
 *
 * Arabic text reaches the index spelled the way its author spelled it, and reaches the query
 * box spelled the way the searcher spells it — and the two legitimately differ: hamza carriers
 * (alef with hamza above, below, madda, wasla — all "alef" to a reader), final ya versus alef
 * maqsura, ta marbuta versus ha, and the optional diacritics (tashkeel) most writers omit and
 * some documents carry. The rule is: **index both the original and the normalised form, query
 * the normalised form** — so a differently-spelled query still lands, and an exact-form query
 * still lands too.
 *
 * This is a deliberately small, well-known set of folds, not a stemmer: stemming is the text
 * search configuration's job (`arabic` snowball), and over-folding here would merge words a
 * reader keeps apart. The classes are written as escapes because a literal combining mark in
 * source is invisible to review.
 */

/**
 * Tashkeel and annotation marks — pronunciation, not spelling: the U+0610–061A honorifics,
 * U+064B–065F harakat, U+0670 superscript alef, and the U+06D6–06ED annotation block.
 */
const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;

/** Tatweel (U+0640): typographic stretching, never meaning. */
const TATWEEL = /ـ/g;

/** Arabic letters, base and extended blocks — not digits, not punctuation. */
const ARABIC_LETTER = /[ء-يٱ-ۓ]/;

const FOLDS: readonly (readonly [RegExp, string])[] = [
  // Alef with madda (U+0622), hamza above (U+0623), hamza below (U+0625), wasla (U+0671) → bare alef.
  [/[آأإٱ]/g, 'ا'],
  // Waw with hamza (U+0624) → waw.
  [/ؤ/g, 'و'],
  // Ya with hamza (U+0626) → ya.
  [/ئ/g, 'ي'],
  // Alef maqsura (U+0649) → ya.
  [/ى/g, 'ي'],
  // Ta marbuta (U+0629) → ha.
  [/ة/g, 'ه'],
];

export function hasArabic(text: string): boolean {
  return ARABIC_LETTER.test(text);
}

export function normalizeArabic(text: string): string {
  let normalized = text.replace(TASHKEEL, '').replace(TATWEEL, '');
  for (const [pattern, replacement] of FOLDS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized;
}

/**
 * The text a field is indexed as: the original, and — when normalisation changes anything —
 * the normalised form beside it, so both spellings produce lexemes.
 */
export function withNormalizedArabic(text: string): string {
  if (!hasArabic(text)) {
    return text;
  }
  const normalized = normalizeArabic(text);
  return normalized === text ? text : `${text}\n${normalized}`;
}

/**
 * Per-revision language detection (`docs/architecture/12-search-architecture.md` §4).
 *
 * Per revision rather than per tenant, because a bilingual tenant is the ordinary case in the
 * markets this product serves — one library holds English procedures beside Arabic ones, and a
 * tenant-level setting would stem half of them with the wrong analyser.
 *
 * Script counting, not a language model: Arabic is written in its own script, so "which
 * analyser should stem this" is answerable by counting letters. The threshold leans Arabic —
 * a document that is one-third Arabic letters is an Arabic document with Latin codes and
 * numbers in it, which describes most numbered Arabic procedures.
 */
const LATIN_LETTERS = /[a-z]/gi;
const ARABIC_LETTERS_GLOBAL = new RegExp(ARABIC_LETTER.source, 'g');

const ARABIC_RATIO_THRESHOLD = 1 / 3;

export type DetectedLanguage = 'ar' | 'en';

export function detectLanguage(text: string): DetectedLanguage {
  const arabic = text.match(ARABIC_LETTERS_GLOBAL)?.length ?? 0;
  if (arabic === 0) {
    return 'en';
  }
  const latin = text.match(LATIN_LETTERS)?.length ?? 0;
  return arabic / (arabic + latin) >= ARABIC_RATIO_THRESHOLD ? 'ar' : 'en';
}
