import { describe, expect, it } from 'vitest';

import { detectLanguage, hasArabic, normalizeArabic, withNormalizedArabic } from './search-text';

describe('normalizeArabic', () => {
  it('folds the hamza carriers onto their bare letters', () => {
    expect(normalizeArabic('أإآٱ')).toBe('اااا');
    expect(normalizeArabic('مسؤول')).toBe('مسوول');
    expect(normalizeArabic('طوارئ')).toBe('طواري');
  });

  it('folds alef maqsura to ya and ta marbuta to ha', () => {
    expect(normalizeArabic('مستشفى')).toBe('مستشفي');
    expect(normalizeArabic('وثيقة')).toBe('وثيقه');
  });

  it('strips tashkeel and tatweel without touching the letters', () => {
    expect(normalizeArabic('أَحْمَد')).toBe('احمد');
    expect(normalizeArabic('الجـــودة')).toBe('الجوده');
  });

  it('leaves Latin text alone', () => {
    expect(normalizeArabic('QMS-001 Quality Manual')).toBe('QMS-001 Quality Manual');
  });
});

describe('withNormalizedArabic', () => {
  it('indexes both spellings when they differ', () => {
    const indexed = withNormalizedArabic('إجراء');
    expect(indexed).toContain('إجراء');
    expect(indexed).toContain('اجراء');
  });

  it('keeps already-normalised Arabic single', () => {
    expect(withNormalizedArabic('احمد')).toBe('احمد');
  });

  it('keeps Latin text single', () => {
    expect(withNormalizedArabic('Quality Manual')).toBe('Quality Manual');
  });
});

describe('detectLanguage', () => {
  it('detects Arabic even when Latin codes ride along', () => {
    expect(detectLanguage('إجراء ضبط الوثائق QMS-001 rev 2')).toBe('ar');
  });

  it('detects English with a stray Arabic word as English', () => {
    expect(
      detectLanguage('Quality manual for the document control procedure revision two مرحبا'),
    ).toBe('en');
  });

  it('answers en for empty and non-letter text', () => {
    expect(detectLanguage('')).toBe('en');
    expect(detectLanguage('12345')).toBe('en');
  });

  it('hasArabic answers from the script, not the length', () => {
    expect(hasArabic('a ب c')).toBe(true);
    expect(hasArabic('abc')).toBe(false);
  });
});
