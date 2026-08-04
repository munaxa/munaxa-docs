import {
  type NumberSegmentKindKey,
  NumberSegmentKind,
  SequenceResetScope,
  type SequenceResetScopeKey,
} from '@edms/domain';

/**
 * The document-number recipe, as arithmetic.
 *
 * Pure, and that is the point: a document number is an external identifier that appears in printed
 * copies, contracts and other systems, so it is issued once, never changes, and is never reused
 * ([ADR-0004](../../../../../../docs/architecture/adr/0004-numbering-assigned-at-approval.md)).
 * Everything here can therefore be tested exhaustively against golden samples, without a database
 * and without issuing anything.
 *
 * Phase 2 owns *configuring* a rule and *previewing* what it produces. Drawing a real number from a
 * sequence is Phase 5's, and it will call `formatNumber` with a claimed value — which is why the
 * formatter takes the counter as a parameter rather than fetching one.
 */

/** A segment, as stored on a rule. Mirrors `numberSegmentSchema` in `@edms/contracts`. */
export type NumberSegment =
  | { readonly kind: 'LITERAL'; readonly value: string }
  | { readonly kind: 'COMPANY_CODE'; readonly optional?: boolean }
  | { readonly kind: 'ENTITY_CODE'; readonly optional?: boolean }
  | { readonly kind: 'BRANCH_CODE'; readonly optional?: boolean }
  | { readonly kind: 'DEPARTMENT_CODE'; readonly optional?: boolean }
  | { readonly kind: 'DOCUMENT_TYPE_CODE'; readonly optional?: boolean }
  | { readonly kind: 'CATEGORY_CODE'; readonly optional?: boolean }
  | { readonly kind: 'YEAR'; readonly digits?: 2 | 4 }
  | { readonly kind: 'MONTH' }
  | { readonly kind: 'SEQUENCE'; readonly padding?: number };

export interface NumberingRuleShape {
  readonly separator: string;
  readonly segments: readonly NumberSegment[];
  readonly resetScope: readonly SequenceResetScopeKey[];
  readonly reserveOnSubmit?: boolean;
  readonly strictGapless?: boolean;
}

/** The codes a document's context can supply. Absent means the document has no such node. */
export interface NumberingContext {
  readonly companyCode?: string | undefined;
  readonly entityCode?: string | undefined;
  readonly branchCode?: string | undefined;
  readonly departmentCode?: string | undefined;
  readonly documentTypeCode?: string | undefined;
  readonly categoryCode?: string | undefined;
  /** The **assignment** date, in the tenant's timezone — never the creation date (§1). */
  readonly assignedAt: Date;
}

export type RuleRejection =
  | 'NO_SEQUENCE'
  | 'MULTIPLE_SEQUENCES'
  | 'AMBIGUOUS_OPTIONAL_SEGMENTS'
  | 'OPTIONAL_WITHOUT_SEPARATOR'
  | 'EMPTY_RULE'
  | 'RESET_SCOPE_EMPTY'
  | 'RESET_SCOPE_NEVER_COMBINED'
  | 'RESET_SCOPE_DUPLICATED'
  | 'RESET_SCOPE_MONTHLY_AND_YEARLY'
  | 'RESET_SCOPE_WITHOUT_SEGMENT'
  | 'GAPLESS_CANNOT_RESERVE'
  | 'PADDING_OUT_OF_RANGE';

const MINIMUM_PADDING = 1;
const MAXIMUM_PADDING = 12;

/**
 * Which segment kind a reset scope needs the number to contain.
 *
 * A sequence that restarts per entity but whose number does not contain the entity code produces two
 * documents with the *same* number in different entities — the counter restarted, and nothing in the
 * text distinguishes them. That is the one way a reset scope can silently break uniqueness, so the
 * validator checks the pairing rather than trusting whoever configured it.
 *
 * `PER_DEPARTMENT` is the exception: a department code is not required, because two departments in one
 * entity drawing from separate counters still produce distinguishable numbers as long as *something*
 * varies — and the department is frequently deliberately absent from a customer-facing number. It is
 * checked against the sequence's scope key instead, which always contains it.
 */
const SCOPE_REQUIRES_SEGMENT: Readonly<
  Partial<Record<SequenceResetScopeKey, readonly NumberSegmentKindKey[]>>
> = Object.freeze({
  [SequenceResetScope.YEARLY]: [NumberSegmentKind.YEAR],
  // Month *and* year: a monthly counter restarts every month of every year, and a number whose
  // text carries only the month renders identically in March of two different years — the same
  // text for two different documents, one year apart.
  [SequenceResetScope.MONTHLY]: [NumberSegmentKind.MONTH, NumberSegmentKind.YEAR],
});

/**
 * Whether a rule may be saved.
 *
 * Returns every reason rather than the first, because an administrator building a rule wants to see
 * what is wrong with it, not to discover the next problem after fixing this one.
 */
export function checkRule(rule: NumberingRuleShape): readonly RuleRejection[] {
  const rejections: RuleRejection[] = [];

  if (rule.segments.length === 0) {
    return ['EMPTY_RULE'];
  }

  const sequences = rule.segments.filter((segment) => segment.kind === NumberSegmentKind.SEQUENCE);
  if (sequences.length === 0) {
    rejections.push('NO_SEQUENCE');
  }
  if (sequences.length > 1) {
    // Two counters in one number means two series, and no answer to which one a reservation belongs
    // to.
    rejections.push('MULTIPLE_SEQUENCES');
  }
  for (const sequence of sequences) {
    const padding = sequence.kind === NumberSegmentKind.SEQUENCE ? (sequence.padding ?? 4) : 4;
    if (padding < MINIMUM_PADDING || padding > MAXIMUM_PADDING) {
      rejections.push('PADDING_OUT_OF_RANGE');
    }
  }

  const optional = rule.segments.filter((segment) => isOptional(segment));
  if (optional.length > 1) {
    // An optional segment that resolves empty is dropped along with its separator. With two of them,
    // dropping either produces the same number of parts: `[ENTITY?, DEPT?, SEQ]` with entity "A" and
    // no department renders `A-0001`, and so does no entity with department "A". Two different
    // documents, one number (§1).
    rejections.push('AMBIGUOUS_OPTIONAL_SEGMENTS');
  }
  if (optional.length > 0 && rule.separator.length === 0) {
    // Without a separator there is nothing to drop *with* the segment, so `A` + `B` and `AB` are the
    // same string before any code content is considered.
    rejections.push('OPTIONAL_WITHOUT_SEPARATOR');
  }

  rejections.push(...checkResetScope(rule));

  if (rule.strictGapless === true && rule.reserveOnSubmit === true) {
    // Gapless is *defined* by not reserving early: a reservation that can be abandoned is a gap.
    rejections.push('GAPLESS_CANNOT_RESERVE');
  }

  return rejections;
}

function checkResetScope(rule: NumberingRuleShape): readonly RuleRejection[] {
  const rejections: RuleRejection[] = [];
  const scope = rule.resetScope;

  if (scope.length === 0) {
    rejections.push('RESET_SCOPE_EMPTY');
    return rejections;
  }
  if (new Set(scope).size !== scope.length) {
    rejections.push('RESET_SCOPE_DUPLICATED');
  }
  if (scope.length > 1 && scope.includes(SequenceResetScope.NEVER)) {
    rejections.push('RESET_SCOPE_NEVER_COMBINED');
  }
  if (scope.includes(SequenceResetScope.YEARLY) && scope.includes(SequenceResetScope.MONTHLY)) {
    // Monthly already restarts within a year. Asking for both describes one behaviour twice and
    // leaves the scope key with a component nobody can reason about.
    rejections.push('RESET_SCOPE_MONTHLY_AND_YEARLY');
  }

  const kinds = new Set(rule.segments.map((segment) => segment.kind));
  for (const entry of scope) {
    const required = SCOPE_REQUIRES_SEGMENT[entry] ?? [];
    if (required.some((kind) => !kinds.has(kind))) {
      rejections.push('RESET_SCOPE_WITHOUT_SEGMENT');
    }
  }
  return rejections;
}

function isOptional(segment: NumberSegment): boolean {
  return 'optional' in segment && segment.optional === true;
}

export interface FormattedNumber {
  readonly formatted: string;
  /** Segments dropped because they resolved empty — what a preview shows and why. */
  readonly omitted: readonly NumberSegmentKindKey[];
}

/**
 * Renders a number.
 *
 * The counter is a parameter rather than something this fetches: a formatter that could draw a
 * sequence value would be a formatter that burns a number every time a preview is rendered.
 *
 * A required segment that resolves empty renders as the empty string and is **not** dropped — it
 * leaves a visible gap between separators. That is deliberate: it is the shape of a misconfiguration
 * (a rule demanding a branch code for a document with no branch), and producing a shorter, valid-
 * looking number instead would hide it behind a number somebody then prints.
 */
export function formatNumber(
  rule: NumberingRuleShape,
  context: NumberingContext,
  sequenceValue: bigint,
): FormattedNumber {
  const omitted: NumberSegmentKindKey[] = [];
  const parts: string[] = [];

  for (const segment of rule.segments) {
    const rendered = renderSegment(segment, context, sequenceValue);
    if (rendered === null) {
      // Only an optional segment returns null, and it takes its separator with it by not being
      // pushed at all.
      omitted.push(segment.kind);
      continue;
    }
    parts.push(rendered);
  }

  return { formatted: parts.join(rule.separator), omitted };
}

function renderSegment(
  segment: NumberSegment,
  context: NumberingContext,
  sequenceValue: bigint,
): string | null {
  switch (segment.kind) {
    case NumberSegmentKind.LITERAL:
      return segment.value;

    case NumberSegmentKind.COMPANY_CODE:
      return codeOr(segment, context.companyCode);
    case NumberSegmentKind.ENTITY_CODE:
      return codeOr(segment, context.entityCode);
    case NumberSegmentKind.BRANCH_CODE:
      return codeOr(segment, context.branchCode);
    case NumberSegmentKind.DEPARTMENT_CODE:
      return codeOr(segment, context.departmentCode);
    case NumberSegmentKind.DOCUMENT_TYPE_CODE:
      return codeOr(segment, context.documentTypeCode);
    case NumberSegmentKind.CATEGORY_CODE:
      return codeOr(segment, context.categoryCode);

    case NumberSegmentKind.YEAR: {
      // The assignment year, in the tenant's timezone. The caller is responsible for handing over a
      // `Date` already shifted to it; doing the shift here would need a timezone database in a pure
      // module, and getting it wrong would misdate a number at midnight on 1 January.
      const year = context.assignedAt.getUTCFullYear();
      return (segment.digits ?? 4) === 2 ? String(year % 100).padStart(2, '0') : String(year);
    }

    case NumberSegmentKind.MONTH:
      return String(context.assignedAt.getUTCMonth() + 1).padStart(2, '0');

    case NumberSegmentKind.SEQUENCE:
      // Padded, never truncated: a series that outgrows its padding widens rather than wrapping,
      // because a wrapped counter re-issues a number and that is the one thing numbering forbids.
      return sequenceValue.toString().padStart(segment.padding ?? 4, '0');
  }
}

function codeOr(segment: NumberSegment, code: string | undefined): string | null {
  if (code !== undefined && code.length > 0) {
    return code;
  }
  return isOptional(segment) ? null : '';
}

/**
 * The key identifying the series a number is drawn from.
 *
 * Built from the reset scope, so two documents in the same series compute the same key and two in
 * different series cannot collide on one. Components are sorted by name, so the key does not depend
 * on the order a tenant happened to list the reset scope in — otherwise editing `[YEARLY, PER_ENTITY]`
 * to `[PER_ENTITY, YEARLY]` would silently start a *new* series at 1 alongside the old one.
 *
 * `NEVER` yields a constant key: one continuous series for the rule.
 */
export function scopeKeyFor(rule: NumberingRuleShape, context: NumberingContext): string {
  const components: string[] = [];

  for (const entry of [...rule.resetScope].sort()) {
    switch (entry) {
      case SequenceResetScope.NEVER:
        components.push('ALL');
        break;
      case SequenceResetScope.YEARLY:
        components.push(`YEAR:${String(context.assignedAt.getUTCFullYear())}`);
        break;
      case SequenceResetScope.MONTHLY:
        components.push(
          `MONTH:${String(context.assignedAt.getUTCFullYear())}-${String(
            context.assignedAt.getUTCMonth() + 1,
          ).padStart(2, '0')}`,
        );
        break;
      case SequenceResetScope.PER_COMPANY:
        components.push(`COMPANY:${context.companyCode ?? ''}`);
        break;
      case SequenceResetScope.PER_ENTITY:
        components.push(`ENTITY:${context.entityCode ?? ''}`);
        break;
      case SequenceResetScope.PER_BRANCH:
        components.push(`BRANCH:${context.branchCode ?? ''}`);
        break;
      case SequenceResetScope.PER_DEPARTMENT:
        components.push(`DEPARTMENT:${context.departmentCode ?? ''}`);
        break;
      case SequenceResetScope.PER_DOCUMENT_TYPE:
        components.push(`TYPE:${context.documentTypeCode ?? ''}`);
        break;
      case SequenceResetScope.PER_CATEGORY:
        components.push(`CATEGORY:${context.categoryCode ?? ''}`);
        break;
    }
  }

  return components.join('|');
}

export type ManualNumberRejection =
  'SHAPE_MISMATCH' | 'REQUIRED_CODE_MISSING' | 'SEQUENCE_OUT_OF_RANGE';

export interface ManualNumberMatch {
  readonly sequenceValue: bigint;
  /**
   * The instant the number's own `YEAR`/`MONTH` segments name, or null when the rule renders
   * neither. A legacy number reading `2019` belongs to 2019's series regardless of when it is
   * being imported, and this is what `scopeKeyFor` is given so the right counter fast-forwards.
   */
  readonly encodedDate: Date | null;
}

/**
 * Whether a manually supplied number matches the rule's shape for this document, and which
 * sequence value it spends (§3).
 *
 * Matching is by reconstruction rather than a grammar: every non-sequence segment renders to a
 * known string given the document's own codes, so the candidate either is that rendering with a
 * counter and a date in the holes, or it is refused. The counter may be *wider* than the padding —
 * a series that outgrew its padding widens rather than wrapping — but never narrower, and never
 * zero: a value below 1 names a counter position that cannot exist.
 *
 * An optional segment whose code resolves empty is absent from the expected form, exactly as the
 * formatter drops it. One that resolves is required to appear: accepting both forms would give one
 * document two admissible spellings, which is the ambiguity the save-time validator exists to
 * prevent.
 */
export function matchManualNumber(
  rule: NumberingRuleShape,
  context: Omit<NumberingContext, 'assignedAt'>,
  candidate: string,
): ManualNumberMatch | ManualNumberRejection {
  const parts: string[] = [];
  let yearDigits: 2 | 4 | null = null;

  for (const segment of rule.segments) {
    switch (segment.kind) {
      case NumberSegmentKind.YEAR:
        yearDigits = segment.digits ?? 4;
        parts.push(`(?<year>\\d{${String(yearDigits)}})`);
        break;
      case NumberSegmentKind.MONTH:
        parts.push('(?<month>0[1-9]|1[0-2])');
        break;
      case NumberSegmentKind.SEQUENCE:
        parts.push(`(?<sequence>\\d{${String(segment.padding ?? 4)},})`);
        break;
      default: {
        const rendered = renderSegment(segment, { ...context, assignedAt: new Date(0) }, 0n);
        if (rendered === null) {
          // Optional and empty: dropped with its separator, exactly as the formatter drops it.
          continue;
        }
        if (rendered.length === 0) {
          // A required code the document cannot supply. The automatic path would render a visible
          // gap to expose the misconfiguration; the manual path refuses for the same reason.
          return 'REQUIRED_CODE_MISSING';
        }
        parts.push(escapeForPattern(rendered));
      }
    }
  }

  const pattern = new RegExp(
    `^${parts.join(escapeForPattern(rule.separator))}$`,
    // The codes carry their own case; nothing here is case-insensitive, because `qa-0001` and
    // `QA-0001` as one number would be two spellings of it.
  );
  const matched = pattern.exec(candidate);
  if (matched === null || matched.groups === undefined) {
    return 'SHAPE_MISMATCH';
  }

  const sequenceValue = BigInt(matched.groups['sequence'] ?? '0');
  if (sequenceValue < 1n) {
    return 'SEQUENCE_OUT_OF_RANGE';
  }

  const yearText = matched.groups['year'];
  const monthText = matched.groups['month'];
  if (yearText === undefined && monthText === undefined) {
    return { sequenceValue, encodedDate: null };
  }
  // A two-digit year reads as this century, which is the only reading a rule that chose two
  // digits can mean; a series older than 2000 needs the four-digit form it was issued under.
  const year = yearText === undefined ? null : Number(yearText) + (yearDigits === 2 ? 2000 : 0);
  const month = monthText === undefined ? 1 : Number(monthText);
  return {
    sequenceValue,
    encodedDate: new Date(Date.UTC(year ?? 1970, month - 1, 1)),
  };
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Placeholders a preview uses where the caller supplied no code.
 *
 * Visibly not real codes, so nobody mistakes a rendered sample for an issued number. `formatNumber`
 * would otherwise render an empty string and the sample would show a gap the administrator cannot
 * interpret.
 */
export const PREVIEW_PLACEHOLDERS: Readonly<Record<string, string>> = Object.freeze({
  companyCode: 'CO',
  entityCode: 'EN',
  branchCode: 'BR',
  departmentCode: 'DE',
  documentTypeCode: 'TY',
  categoryCode: 'CA',
});

/** The counter a preview renders. Not 1: a sample of `0001` hides the padding it is demonstrating. */
export const PREVIEW_SEQUENCE_VALUE = 42n;
