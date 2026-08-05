import { describe, expect, it } from 'vitest';

import { localMinuteOfDay, releaseAfterQuietHours, windowCovers } from './quiet-hours';

/**
 * Quiet hours as arithmetic — 18 §5's second sentence.
 *
 * These are unit tests because the rule genuinely is arithmetic: given a wall clock and a window,
 * is it quiet, and when does it stop being. The database-level question — whether a held message
 * is actually withheld and then sent — is in the integration suite, where it belongs.
 */

const EVENING = { startMinute: 19 * 60, endMinute: 7 * 60, timezone: 'UTC' };

describe('a window that wraps midnight', () => {
  it('covers the evening and the small hours, and not the working day', () => {
    expect(windowCovers(EVENING, 20 * 60)).toBe(true);
    expect(windowCovers(EVENING, 3 * 60)).toBe(true);
    expect(windowCovers(EVENING, 12 * 60)).toBe(false);
  });

  it('excludes the closing minute, so a release is never zero minutes away', () => {
    expect(windowCovers(EVENING, 7 * 60 - 1)).toBe(true);
    expect(windowCovers(EVENING, 7 * 60)).toBe(false);
  });

  it('treats a zero-length window as none at all', () => {
    // Somebody who set the same value twice meant "no quiet hours". The opposite reading would
    // silence every non-urgent notification for ever.
    const none = { startMinute: 480, endMinute: 480, timezone: 'UTC' };
    expect(windowCovers(none, 480)).toBe(false);
    expect(windowCovers(none, 0)).toBe(false);
  });
});

describe('when a held message may go out', () => {
  it('releases at the window’s end on the following morning', () => {
    const at = new Date('2026-08-05T23:00:00.000Z');
    expect(releaseAfterQuietHours(EVENING, at)?.toISOString()).toBe('2026-08-06T07:00:00.000Z');
  });

  it('releases the same morning for a message held after midnight', () => {
    const at = new Date('2026-08-06T02:30:00.000Z');
    expect(releaseAfterQuietHours(EVENING, at)?.toISOString()).toBe('2026-08-06T07:00:00.000Z');
  });

  it('answers null when it is not quiet, when there is no window, and when the zone is unknown', () => {
    expect(releaseAfterQuietHours(EVENING, new Date('2026-08-05T12:00:00.000Z'))).toBeNull();
    expect(releaseAfterQuietHours(null, new Date('2026-08-05T23:00:00.000Z'))).toBeNull();
    // A stored zone that has been renamed or mistyped degrades to "not quiet" rather than
    // throwing on a delivery path.
    expect(
      releaseAfterQuietHours(
        { ...EVENING, timezone: 'Mars/Olympus_Mons' },
        new Date('2026-08-05T23:00:00.000Z'),
      ),
    ).toBeNull();
  });

  it('reads the window in the recipient’s zone, not the server’s', () => {
    // 23:00 UTC is 02:00 in Amman — inside an evening window there, and the release is 07:00
    // local, which is 04:00 UTC.
    const amman = { ...EVENING, timezone: 'Asia/Amman' };
    const at = new Date('2026-08-05T23:00:00.000Z');
    expect(localMinuteOfDay(at, 'Asia/Amman')).toBe(2 * 60);
    expect(releaseAfterQuietHours(amman, at)?.toISOString()).toBe('2026-08-06T04:00:00.000Z');
  });
});
