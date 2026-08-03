import { ar } from './catalogues/ar';
import { type Catalogue, en } from './catalogues/en';
import { DEFAULT_LOCALE, type LocaleKey } from './locale';

const CATALOGUES: Readonly<Record<LocaleKey, Catalogue>> = Object.freeze({ en, ar });

/**
 * Every leaf path in the catalogue, as a dotted string — `state.loading`, `error.NOT_FOUND`.
 * Typing the key means a renamed string breaks the build at every call site instead of
 * silently rendering the key to a user.
 */
export type MessageKey = LeafPaths<Catalogue>;

type LeafPaths<T, TPrefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${TPrefix}${K}`
    : LeafPaths<T[K], `${TPrefix}${K}.`>;
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
export function translate(
  locale: LocaleKey,
  key: MessageKey,
  values: Readonly<Record<string, string | number>> = {},
): string {
  const message = lookup(getCatalogue(locale), key) ?? lookup(getCatalogue(DEFAULT_LOCALE), key);
  if (message === undefined) {
    return key;
  }
  return message.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

/** Binds a locale once, for a request or a rendered tree. */
export function translatorFor(locale: LocaleKey) {
  return (key: MessageKey, values?: Readonly<Record<string, string | number>>): string =>
    translate(locale, key, values);
}

function lookup(catalogue: Catalogue, key: string): string | undefined {
  let current: unknown = catalogue;
  for (const segment of key.split('.')) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' ? current : undefined;
}
