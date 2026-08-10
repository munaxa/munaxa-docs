import { ar } from './catalogues/ar';
import { type Catalogue, en } from './catalogues/en';
import { DEFAULT_LOCALE, type LocaleKey } from './locale';
import { type PluralMessage, isPluralMessage, selectPluralForm } from './plural';

const CATALOGUES: Readonly<Record<LocaleKey, Catalogue>> = Object.freeze({ en, ar });

/**
 * Every leaf path in the catalogue, as a dotted string — `state.loading`, `error.NOT_FOUND`.
 * Typing the key means a renamed string breaks the build at every call site instead of
 * silently rendering the key to a user.
 */
export type MessageKey = LeafPaths<Catalogue>;

/**
 * The keys of the *plural* messages, as their own union — Phase 7.4.
 *
 * Two walks over one tree rather than one walk producing both. `LeafPaths` stops at a
 * `PluralMessage` and yields nothing; `PluralPaths` stops at a `string` and yields nothing. The two
 * unions are therefore disjoint by construction, which is what lets `translate` be overloaded
 * across them: a plural key cannot be called without a `count`, and a plain key cannot be given one.
 *
 * `MessageKey` itself is unchanged in meaning — it is still every plain string leaf — so no existing
 * consumer of it had to move.
 */
export type PluralKey = PluralPaths<Catalogue>;

type LeafPaths<T, TPrefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${TPrefix}${K}`
    : T[K] extends PluralMessage
      ? never
      : LeafPaths<T[K], `${TPrefix}${K}.`>;
}[keyof T & string];

type PluralPaths<T, TPrefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends PluralMessage
    ? `${TPrefix}${K}`
    : T[K] extends string
      ? never
      : PluralPaths<T[K], `${TPrefix}${K}.`>;
}[keyof T & string];

export function getCatalogue(locale: LocaleKey): Catalogue {
  return CATALOGUES[locale];
}

/**
 * Resolves a message, substituting `{name}` placeholders.
 *
 * Falls back to the default locale rather than to the key: a user seeing English is a
 * translation gap, a user seeing `state.loading` is a defect.
 */
export type PluralValues = Readonly<Record<string, string | number>> & { readonly count: number };

export function translate(
  locale: LocaleKey,
  key: MessageKey,
  values?: Readonly<Record<string, string | number>>,
): string;
/**
 * A plural message, which **must** be given the `count` that selects its form.
 *
 * `count` is required by the type rather than by a convention, so the failure mode Phase 7.3 found
 * — a counted noun rendered with no idea how many — cannot be written. The same value is available
 * to interpolation, so `{count}` in the chosen form renders the number without being passed twice.
 */
export function translate(locale: LocaleKey, key: PluralKey, values: PluralValues): string;
export function translate(
  locale: LocaleKey,
  key: MessageKey | PluralKey,
  values: Readonly<Record<string, string | number>> = {},
): string {
  const entry = lookup(getCatalogue(locale), key) ?? lookup(getCatalogue(DEFAULT_LOCALE), key);
  if (entry === undefined) {
    return key;
  }
  const message = isPluralMessage(entry)
    ? selectPluralForm(locale, entry, Number(values['count']))
    : entry;
  return message.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

/** Binds a locale once, for a request or a rendered tree. */
export interface Translator {
  (key: MessageKey, values?: Readonly<Record<string, string | number>>): string;
  (key: PluralKey, values: PluralValues): string;
}

export function translatorFor(locale: LocaleKey): Translator {
  return ((key: MessageKey, values?: Readonly<Record<string, string | number>>): string =>
    translate(locale, key, values)) as Translator;
}

function lookup(catalogue: Catalogue, key: string): string | PluralMessage | undefined {
  let current: unknown = catalogue;
  for (const segment of key.split('.')) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === 'string') {
    return current;
  }
  return isPluralMessage(current) ? current : undefined;
}
