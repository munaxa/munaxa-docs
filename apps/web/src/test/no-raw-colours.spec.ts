import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * No colour is named in this repository — Phase 7.9.
 *
 * `ARCHITECTURE.md`'s rule is that the only visual difference between this product and its siblings
 * is the theme it imports, and that nothing here hardcodes a colour, a font, a radius or a shadow.
 * Phase 7.9 found the rule had two exceptions in it: the revision comparison rendered
 * `bg-red-500/10` and `bg-green-500/10` from **Tailwind's own palette**, which is theme-blind — the
 * same colour in light and dark, and unmoved when the Docs palette is retuned upstream. They are
 * now `bg-destructive/10` and `bg-success/10`, which are the platform's semantic tokens for exactly
 * that meaning.
 *
 * A grep, not an opinion. The named-palette scales are the ones that bypass the theme; the semantic
 * names (`primary`, `destructive`, `success`, `warning`, `info`, `muted`, `accent`, `border`) are
 * the theme, and are what a product is supposed to use.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..');

/** Tailwind's built-in palette scales. `slate-500`, `red-500/10`, `bg-emerald-600` — all of these. */
const RAW_SCALES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
] as const;

const RAW_CLASS = new RegExp(
  `\\b(?:bg|text|border|ring|fill|stroke|from|via|to|shadow|outline|decoration|accent|caret|divide|placeholder)-(?:${RAW_SCALES.join('|')})-(?:50|\\d{3})\\b`,
);

/** `#a1b2c3`, `rgb(…)`, `hsl(…)` written into a class or a style. */
const LITERAL_COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      // `test/` is where colours are legitimately *asserted* — the contrast measurements and the
      // recorded platform exceptions both quote hex values on purpose.
      return entry === 'test' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** Comments quote the classes they replaced; the rule is about what renders. */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');
}

describe('the product names no colour of its own', () => {
  const files = sourceFiles(SOURCE);

  it('scans a meaningful number of files', () => {
    // A regex suite that silently stops matching anything passes forever. This is the tripwire.
    expect(files.length).toBeGreaterThan(50);
  });

  it('uses no Tailwind palette scale', () => {
    const offenders = files
      .map((file) => ({ file, match: RAW_CLASS.exec(stripComments(readFileSync(file, 'utf8'))) }))
      .filter((entry) => entry.match !== null)
      .map((entry) => `${entry.file.slice(SOURCE.length + 1)}: ${entry.match?.[0] ?? ''}`);

    expect(offenders).toStrictEqual([]);
  });

  it('writes no literal colour value', () => {
    const offenders = files
      .map((file) => ({
        file,
        match: LITERAL_COLOUR.exec(stripComments(readFileSync(file, 'utf8'))),
      }))
      .filter((entry) => entry.match !== null)
      .map((entry) => `${entry.file.slice(SOURCE.length + 1)}: ${entry.match?.[0] ?? ''}`);

    expect(offenders).toStrictEqual([]);
  });
});
