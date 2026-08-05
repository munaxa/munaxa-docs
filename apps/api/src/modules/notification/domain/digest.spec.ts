import { describe, expect, it } from 'vitest';

import { DigestFrequency } from '@edms/domain';

import { composeDigestItems, digestWindowEnd, periodLabelFor } from './digest';

/**
 * Digests — 18 §5's "immediate, digest, or off", as arithmetic and composition.
 *
 * `DigestFrequency` has had four values since Phase 1 and nothing read one. These are the tests
 * of what now does.
 */

describe('when a digest window closes', () => {
  it('closes an hourly window at the next hour, in real time', () => {
    // An hour is an hour in every zone, so this one needs no local clock — and using one would
    // make it wrong across a half-hour offset.
    const end = digestWindowEnd(
      DigestFrequency.HOURLY,
      new Date('2026-08-05T09:41:12.000Z'),
      'Asia/Kolkata',
      7,
    );
    expect(end?.toISOString()).toBe('2026-08-05T10:00:00.000Z');
  });

  it('closes a daily window at the tenant’s own morning', () => {
    const end = digestWindowEnd(
      DigestFrequency.DAILY,
      new Date('2026-08-05T09:00:00.000Z'),
      'UTC',
      7,
    );
    // 07:00 has passed today, so the window this message belongs to closes tomorrow morning.
    expect(end?.toISOString()).toBe('2026-08-06T07:00:00.000Z');
  });

  it('never closes a window in the past when the clock is exactly on the boundary', () => {
    const end = digestWindowEnd(
      DigestFrequency.DAILY,
      new Date('2026-08-05T07:00:00.000Z'),
      'UTC',
      7,
    );
    // The window that is closing has already been collected; this message belongs to the next.
    expect(end?.toISOString()).toBe('2026-08-06T07:00:00.000Z');
  });

  it('closes a weekly window on the following Monday morning', () => {
    // 5 August 2026 is a Wednesday.
    const end = digestWindowEnd(
      DigestFrequency.WEEKLY,
      new Date('2026-08-05T09:00:00.000Z'),
      'UTC',
      7,
    );
    expect(end?.toISOString()).toBe('2026-08-10T07:00:00.000Z');
    expect(end?.getUTCDay()).toBe(1);
  });

  it('has no window for IMMEDIATE, because that is the absence of a digest', () => {
    expect(digestWindowEnd(DigestFrequency.IMMEDIATE, new Date(), 'UTC', 7)).toBeNull();
  });
});

describe('composing the list', () => {
  it('renders one line per message, oldest first', () => {
    const items = composeDigestItems([
      { subject: 'Approved: B', occurredAt: new Date('2026-08-05T11:00:00.000Z') },
      { subject: 'Approved: A', occurredAt: new Date('2026-08-05T09:00:00.000Z') },
    ]);
    // A digest is read as a narrative of what happened; the newest-first ordering an inbox uses
    // reads backwards in prose.
    expect(items).toBe('• Approved: A\n• Approved: B');
  });

  it('carries no markup, because it is a value and values are escaped', () => {
    const items = composeDigestItems([
      { subject: '<script>alert(1)</script>', occurredAt: new Date() },
    ]);
    // The renderer escapes it like any other value. What matters here is that this function did
    // not put a tag in beside it that escaping would then have destroyed.
    expect(items).toBe('• <script>alert(1)</script>');
    expect(items).not.toContain('<li>');
  });

  it('names its own window in the recipient’s language, falling back to English', () => {
    expect(periodLabelFor(DigestFrequency.DAILY, 'en')).toBe('since yesterday');
    expect(periodLabelFor(DigestFrequency.DAILY, 'ar')).toBe('منذ الأمس');
    expect(periodLabelFor(DigestFrequency.DAILY, 'fr')).toBe('since yesterday');
  });
});
