import { describe, expect, it } from 'vitest';

import { Locale, negotiateLocale } from './locale';
import { translate } from './translate';

describe('translate', () => {
  it('resolves a message in the requested locale', () => {
    expect(translate(Locale.EN, 'state.retry')).toBe('Try again');
    expect(translate(Locale.AR, 'state.retry')).not.toBe(translate(Locale.EN, 'state.retry'));
  });

  it('substitutes placeholders and leaves unknown ones intact', () => {
    expect(translate(Locale.EN, 'app.name', { unused: 'x' })).toBe('Munaxa Docs');
  });
});

describe('negotiateLocale', () => {
  it('honours quality values and regional tags', () => {
    expect(negotiateLocale('ar-JO,ar;q=0.9,en;q=0.8')).toBe(Locale.AR);
    expect(negotiateLocale('fr-FR,en-GB;q=0.7')).toBe(Locale.EN);
  });

  it('falls back to the default for absent or unsupported languages', () => {
    expect(negotiateLocale(undefined)).toBe(Locale.EN);
    expect(negotiateLocale('de')).toBe(Locale.EN);
  });
});
