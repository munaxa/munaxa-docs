import { ConditionOperator, type ConditionOperatorKey } from '@edms/domain';

/**
 * The closed expression language a stage condition is written in, and the pure function that
 * evaluates it.
 *
 * `07-workflow-architecture.md` §2 is explicit about the shape and about why: conditions are "a
 * small, closed expression language evaluated by a **pure function**; no expression ever reaches an
 * evaluator that can touch I/O or the database". That sentence is a security property, not a
 * performance one. A tenant authors the expression, so an evaluator that could dereference a path
 * into a live object graph — or, worse, one built on a general expression library — would be a
 * tenant-authored program running inside the transaction that approves their documents.
 *
 * So there is no path resolution here at all. The facts are gathered *before* evaluation, by code
 * that knows what it is fetching, into a flat map of pre-approved keys. The evaluator does a lookup
 * and a comparison. It cannot reach anything that was not put in front of it, and it has nothing to
 * reach with.
 *
 * The allow-list of keys lives in `version-validator.ts`, which is what refuses a condition naming
 * a fact this cannot resolve — at publish, where the message can say which facts exist, rather than
 * at somebody's submission.
 */

/** What a condition may be compared against. Deliberately not `unknown`. */
export type FactValue = string | number | boolean | readonly string[] | null;

/**
 * The document, as a condition sees it.
 *
 * Flat, and assembled by the caller. A nested object would invite a dotted-path walker, and a
 * dotted-path walker over an object the tenant names the keys of is how an evaluator ends up
 * reading `constructor.prototype`.
 */
export type DocumentFacts = ReadonlyMap<string, FactValue>;

export interface Condition {
  readonly field: string;
  readonly op: ConditionOperatorKey;
  readonly value: string | number | boolean | readonly string[];
}

/**
 * Whether a condition holds.
 *
 * **An unresolvable fact is false, never an error and never true.** A stage whose condition names
 * something this document does not have — a metadata field the type does not carry — is a stage
 * that does not apply, and skipping it is the same outcome as a comparison that returned false.
 * Treating it as true would run a control the definition scoped away; throwing would stall an
 * approval in front of an author who cannot fix the definition.
 *
 * That is safe *because* of what §8 forbids separately: a stage is skipped for a false condition
 * and never for want of participants. The two failure modes look alike from the outside and are
 * handled oppositely, deliberately.
 */
export function evaluateCondition(condition: Condition, facts: DocumentFacts): boolean {
  if (!facts.has(condition.field)) {
    return false;
  }
  const actual = facts.get(condition.field) ?? null;

  switch (condition.op) {
    case ConditionOperator.EQUALS:
      return equals(actual, condition.value);
    case ConditionOperator.NOT_EQUALS:
      // Not `!equals(...)`: a fact that is null is not equal to anything and is also not
      // *unequal* to anything, in the sense a workflow author means. "Department is not QA" should
      // not route a document that has no department through a stage scoped to everybody else.
      return actual !== null && !equals(actual, condition.value);
    case ConditionOperator.GREATER_THAN:
      return compare(actual, condition.value, (left, right) => left > right);
    case ConditionOperator.GREATER_OR_EQUAL:
      return compare(actual, condition.value, (left, right) => left >= right);
    case ConditionOperator.LESS_THAN:
      return compare(actual, condition.value, (left, right) => left < right);
    case ConditionOperator.LESS_OR_EQUAL:
      return compare(actual, condition.value, (left, right) => left <= right);
    case ConditionOperator.IN:
      return isIn(actual, condition.value);
    case ConditionOperator.CONTAINS:
      return contains(actual, condition.value);
    default:
      // The operator set is closed and the wire schema validates against it, so this is a stored
      // version written by something other than the product. False rather than a throw, for the
      // same reason an unresolvable fact is false.
      return false;
  }
}

/**
 * Equality, without coercion.
 *
 * `'3' == 3` being true is how a confidentiality rank typed into a form as text ends up passing a
 * comparison it should have failed. A list is equal to a list with the same members in any order —
 * a multi-select is a set, and the order options were ticked in is not a fact about the document.
 */
function equals(actual: FactValue, expected: Condition['value']): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    const left = toList(actual);
    const right = toList(expected);
    return left !== null && right !== null && sameMembers(left, right);
  }
  return actual === expected;
}

/**
 * Ordering, over numbers only.
 *
 * String ordering is deliberately not offered even though JavaScript would happily provide it:
 * `'10' < '9'` is true and is never what somebody comparing document codes meant. The fields worth
 * ordering — a confidentiality rank, a revision ordinal — are numbers, and the ones that are not
 * are compared with equality and membership.
 */
function compare(
  actual: FactValue,
  expected: Condition['value'],
  ordered: (left: number, right: number) => boolean,
): boolean {
  return typeof actual === 'number' && typeof expected === 'number' && ordered(actual, expected);
}

/** The fact is one of the listed values. The everyday "applies to these three document types". */
function isIn(actual: FactValue, expected: Condition['value']): boolean {
  const options = toList(expected);
  if (options === null || actual === null) {
    return false;
  }
  if (Array.isArray(actual)) {
    // A multi-select is "in" a list when any of its members is: "tagged with any of these".
    return toList(actual)?.some((member) => options.includes(member)) ?? false;
  }
  return options.includes(String(actual));
}

/** The fact contains the value: a member of a list, or a substring of a text field. */
function contains(actual: FactValue, expected: Condition['value']): boolean {
  if (Array.isArray(actual)) {
    return toList(actual)?.includes(String(expected)) ?? false;
  }
  return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
}

/** Narrows to a list of strings, or null when the value is not a list of them. */
function toList(value: FactValue | Condition['value']): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.every((member): member is string => typeof member === 'string') ? value : null;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const expected = new Set(right);
  return left.every((member) => expected.has(member));
}
