/**
 * The locales the product ships. Arabic is not an afterthought: the UI is authored with
 * logical properties and verified in RTL per screen
 * (`docs/architecture/16-frontend-architecture.md` §8).
 */
export const Locale = {
  EN: 'en',
  AR: 'ar',
} as const;

export type LocaleKey = (typeof Locale)[keyof typeof Locale];

export const DEFAULT_LOCALE: LocaleKey = Locale.EN;
export const SUPPORTED_LOCALES: readonly LocaleKey[] = Object.freeze([Locale.EN, Locale.AR]);

export const TEXT_DIRECTION: Readonly<Record<LocaleKey, 'ltr' | 'rtl'>> = Object.freeze({
  [Locale.EN]: 'ltr',
  [Locale.AR]: 'rtl',
});

export function isLocale(value: string): value is LocaleKey {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Picks the best supported locale from an `Accept-Language` header, falling back to English. */
export function negotiateLocale(acceptLanguage: string | undefined): LocaleKey {
  if (!acceptLanguage) {
    return DEFAULT_LOCALE;
  }
  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const quality = params
        .map((param) => param.trim())
        .find((param) => param.startsWith('q='))
        ?.slice(2);
      return { tag: tag.trim().toLowerCase(), quality: quality ? Number(quality) : 1 };
    })
    .filter((entry) => entry.tag.length > 0 && !Number.isNaN(entry.quality))
    .sort((left, right) => right.quality - left.quality);

  for (const entry of ranked) {
    const base = entry.tag.split('-')[0] ?? '';
    if (isLocale(base)) {
      return base;
    }
  }
  return DEFAULT_LOCALE;
}
