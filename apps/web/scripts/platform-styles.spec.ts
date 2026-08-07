import { describe, expect, it } from 'vitest';

// Plain ESM, deliberately not TypeScript: the build-time checker that imports it runs as
// `node scripts/verify-platform-styles.mjs` against built output, with no compile step in front
// of it. `allowJs` is what lets this spec type-check against it anyway.
import { hasRule, isUtility, splitClasses, toSelector } from './platform-styles.mjs';

/**
 * The guard's guard.
 *
 * Phase 19 found a defect that survived six green gates because nothing inspected the built
 * stylesheet. The check that now does is only worth its place if it cannot repeat the same
 * trick — and its first draft did, reporting every class present because `.bg-primary` matched
 * inside `.bg-primary-strong`. Both helpers fail open, so both are tested here.
 */
describe('hasRule', () => {
  it('finds a class that has its own rule', () => {
    expect(hasRule('.bg-card{background-color:var(--card)}', 'bg-card')).toBe(true);
  });

  it('does not accept a longer class that merely starts the same way', () => {
    // The exact bug. `.bg-primary-strong` is present; `.bg-primary` is not.
    expect(hasRule('.bg-primary-strong{color:red}', 'bg-primary')).toBe(false);
  });

  it('does not accept an escaped modifier as the bare class', () => {
    // `.bg-muted\/30` is a different utility from `.bg-muted`.
    expect(hasRule('.bg-muted\\/30{opacity:.3}', 'bg-muted')).toBe(false);
  });

  it('finds the bare class when both it and a longer relative are present', () => {
    const css = '.bg-primary-strong{color:red}.bg-primary{color:blue}';
    expect(hasRule(css, 'bg-primary')).toBe(true);
  });

  it('accepts a class that appears in a selector list rather than alone', () => {
    expect(
      hasRule('.border-border,.border-border\\/50{border-color:var(--b)}', 'border-border'),
    ).toBe(true);
  });

  it('accepts a class carrying a pseudo-class', () => {
    expect(hasRule('.underline:hover{text-decoration:underline}', 'underline')).toBe(true);
  });

  it('reports a class that is absent', () => {
    expect(hasRule('.flex{display:flex}', 'backdrop-blur-xs')).toBe(false);
  });

  it('handles the escaping Tailwind applies to a variant', () => {
    expect(hasRule('.hover\\:bg-accent:hover{background:var(--a)}', 'hover:bg-accent')).toBe(true);
  });
});

describe('toSelector', () => {
  it('escapes the characters Tailwind escapes', () => {
    expect(toSelector('bg-muted/30')).toBe('.bg-muted\\/30');
    expect(toSelector('h-2.5')).toBe('.h-2\\.5');
    expect(toSelector('hover:bg-accent')).toBe('.hover\\:bg-accent');
    // `&` is escaped too. Verified against the real stylesheet, which contains exactly
    // `.\[\&\>div\:first-child\]\:sr-only`.
    expect(toSelector('[&>div:first-child]:sr-only')).toBe(
      '.\\[\\&\\>div\\:first-child\\]\\:sr-only',
    );
  });
});

describe('splitClasses', () => {
  it('splits on whitespace', () => {
    expect(splitClasses('flex items-center gap-2')).toStrictEqual([
      'flex',
      'items-center',
      'gap-2',
    ]);
  });

  it('keeps an arbitrary value containing a comma intact', () => {
    // Splitting naively produced `w-[min(36rem` and `90vw)]`, neither of which can ever match —
    // a false failure that has nothing to do with the platform.
    expect(splitClasses('w-[min(36rem,90vw)] p-4')).toStrictEqual(['w-[min(36rem,90vw)]', 'p-4']);
  });

  it('keeps an arbitrary value containing a space intact', () => {
    expect(splitClasses('grid-cols-[repeat(2, minmax(0, 1fr))]')).toStrictEqual([
      'grid-cols-[repeat(2, minmax(0, 1fr))]',
    ]);
  });

  it('collapses runs of whitespace and newlines', () => {
    expect(splitClasses('  flex\n   gap-2  ')).toStrictEqual(['flex', 'gap-2']);
  });
});

describe('isUtility', () => {
  it('keeps lowercase utilities and arbitrary-variant selectors', () => {
    expect(isUtility('bg-card')).toBe(true);
    expect(isUtility('[&>div:first-child]:sr-only')).toBe(true);
  });

  it('drops a component name from a clsx argument object', () => {
    expect(isUtility('Button')).toBe(false);
  });

  it('drops a fragment carrying a template hole', () => {
    expect(isUtility('bg-${color}')).toBe(false);
  });
});
