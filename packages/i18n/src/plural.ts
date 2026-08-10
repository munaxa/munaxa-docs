import { type LocaleKey } from './locale';

/**
 * Plural messages — Phase 7.4.
 *
 * ## Why this exists
 *
 * The catalogue had twenty-eight strings interpolating a `{count}`, and three different ways of
 * dodging the fact that a number changes the words around it:
 *
 * ```
 * '{count} rows'                         wrong at one
 * '{count} row(s)'                       the parenthetical hedge, for the same idea
 * '{count} person/people hold this role' the slashed hedge, for the same idea again
 * ```
 *
 * All three are English-shaped problems with an English-shaped workaround, and none of them
 * survives contact with Arabic, which selects between **six** categories rather than two. A
 * `count === 1` ternary in a screen would have fixed the first language and entrenched the failure
 * of the second, which is why Phase 7.3 stopped rather than patching one string.
 *
 * ## What a plural message is
 *
 * A record of CLDR plural categories. `other` is required because every locale has it and it is the
 * fallback when a locale asks for a category this message does not carry; the rest are optional
 * because a locale that never selects `two` has no use for a `two` form.
 *
 * The selection is `Intl.PluralRules`, which ships in every runtime this product targets — Node for
 * the API and the server render, the browser for the client. **No plural table is written here.**
 * The categories a locale uses, and which number lands in which, are the runtime's business, so
 * adding a language means adding a catalogue rather than teaching this file about a grammar.
 *
 * ## Why the brand
 *
 * `MessageKey` is `LeafPaths<Catalogue>`, which walks the catalogue until it finds a `string`. A
 * plural message is an *object*, so without a way to recognise one, `LeafPaths` would descend into
 * it and mint `admin.grid.rowCount.one` as a key — changing the key type that every call site in
 * the API, the worker and the web application depends on.
 *
 * `plural()` returns a branded type instead, so the types can tell a plural message from a group of
 * strings and stop there. That is what keeps `MessageKey` exactly what it was: the plural keys live
 * in their own `PluralKey` union, and `translate` is overloaded across the two. A caller cannot
 * reach a plural message without a `count`, and cannot pass a `count` where there is nothing to
 * select — both are compile errors rather than conventions.
 */

declare const PLURAL_BRAND: unique symbol;

/** The CLDR categories. `other` is the only one every locale is guaranteed to use. */
export interface PluralForms {
  readonly other: string;
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
}

export type PluralMessage = PluralForms & { readonly [PLURAL_BRAND]: true };

/**
 * Declares a plural message in a catalogue.
 *
 * The brand exists only in the type; at runtime this is the object it was given, so a catalogue is
 * still a plain tree of data and `en.state.error` still reads as a string.
 */
export function plural(forms: PluralForms): PluralMessage {
  return forms as PluralMessage;
}

export function isPluralMessage(value: unknown): value is PluralMessage {
  return (
    typeof value === 'object' && value !== null && typeof (value as PluralForms).other === 'string'
  );
}

/**
 * One `Intl.PluralRules` per locale, built once.
 *
 * Constructing one is not free and this runs on every rendered count — a list of two hundred rows
 * with a badge each is two hundred selections. The set of locales is closed and tiny, so a plain
 * record is the whole cache.
 */
const RULES = new Map<LocaleKey, Intl.PluralRules>();

function rulesFor(locale: LocaleKey): Intl.PluralRules {
  const existing = RULES.get(locale);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Intl.PluralRules(locale);
  RULES.set(locale, created);
  return created;
}

/**
 * The form this locale uses for this number.
 *
 * `other` is the fallback in two distinct situations, and both are deliberate. A locale may select a
 * category the message does not carry — English never asks for `few`, but a message written for
 * Arabic and rendered in a locale added later might — and a count that is not a finite number is not
 * a count at all. Neither should render a key or an empty string to a user: `other` is the form that
 * reads correctly for the widest range of numbers in every locale, so it is what an unanswerable
 * question resolves to.
 *
 * Negative and fractional counts are passed to `Intl.PluralRules` unchanged rather than being
 * clamped. That is the honest thing: `-1` and `1.5` select whatever the locale's own rules say, and
 * this product has no counted quantity where pretending otherwise would help.
 */
export function selectPluralForm(locale: LocaleKey, message: PluralForms, count: number): string {
  if (!Number.isFinite(count)) {
    return message.other;
  }
  const category: Intl.LDMLPluralRule = rulesFor(locale).select(count);
  // `LDMLPluralRule` and the optional keys of `PluralForms` are the same six names, so the lookup is
  // total: every category the runtime can return is a field this message may carry.
  return message[category] ?? message.other;
}
