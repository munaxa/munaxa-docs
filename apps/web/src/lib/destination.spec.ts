import { describe, expect, it } from 'vitest';

import { safeDestination } from './destination';

/**
 * The login flow's `next` — RC validation, D-19.
 *
 * Each malicious value is checked two ways: `safeDestination` answers `/`, and — the invariant
 * itself — whatever it answers, resolved as a browser resolves a `Location` against this
 * application's origin, stays on that origin.
 */

const ORIGIN = 'https://docs.example.test';

function landsOn(location: string): string {
  return new URL(location, `${ORIGIN}/login`).origin;
}

describe('internal destinations are kept', () => {
  it.each([
    ['/', '/'],
    ['/documents', '/documents'],
    [
      '/documents/0197a0b2-7c1e-7d3a-9f00-1234567890ab',
      '/documents/0197a0b2-7c1e-7d3a-9f00-1234567890ab',
    ],
    ['/settings', '/settings'],
    ['/documents?libraryId=l-1&page=2', '/documents?libraryId=l-1&page=2'],
    ['/documents#top', '/documents#top'],
    ['/search?q=a%20b', '/search?q=a%20b'],
  ])('%s', (value, expected) => {
    expect(safeDestination(value)).toBe(expected);
  });
});

describe('nothing leaves the origin', () => {
  it.each([
    '//evil.example',
    '//evil.example/documents',
    '/\\evil.example',
    '\\\\evil.example',
    '\\/evil.example',
    '/\\/evil.example',
    'https://evil.example',
    'https://evil.example/documents',
    'http://evil.example',
    'HTTPS://evil.example',
    'https:evil.example',
    'https:/evil.example',
    '///evil.example',
    '////evil.example',
    ' //evil.example',
    '\t//evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r\n/evil.example',
    // On-origin to the parser, `//evil.example` once dot segments are removed.
    '/.//evil.example',
    '/..//evil.example',
    '/%2e//evil.example',
    '/%2E%2E//evil.example',
    '/documents/..//evil.example',
    'javascript:alert(document.domain)',
    'data:text/html,<script>alert(1)</script>',
    'mailto:someone@evil.example',
    '//evil.example@docs.example.test',
    'http://docs.example.test.evil.example',
  ])('%j', (value) => {
    const destination = safeDestination(value);
    expect(destination).toBe('/');
    expect(landsOn(destination)).toBe(ORIGIN);
  });

  it.each([
    // Encoded separators stay encoded: a path on this origin, never a host.
    '/%2F%2Fevil.example',
    '/%5Cevil.example',
    '/%5C%5Cevil.example',
    'evil.example',
  ])('%j stays a path on this origin', (value) => {
    const destination = safeDestination(value);
    expect(destination.startsWith('/')).toBe(true);
    expect(destination.startsWith('//')).toBe(false);
    expect(landsOn(destination)).toBe(ORIGIN);
  });

  it.each([[undefined], [null], [''], [42], [{}], [['//evil.example', '/documents']]])(
    'falls back to / for %j',
    (value) => {
      expect(safeDestination(value)).toBe('/');
    },
  );

  it('takes the first of a repeated parameter', () => {
    expect(safeDestination(['/documents', '//evil.example'])).toBe('/documents');
  });
});
