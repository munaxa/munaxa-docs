import { describe, expect, it } from 'vitest';

import { IntegrityStatus, ScanStatus, isReachableFile } from './index';

/**
 * Whether a document's file may be opened — the rule every screen is told before it offers a
 * download (Hetzner Phase B, finding 4). It used to be "scanned CLEAN" alone, so a quarantined file
 * still showed an enabled Download button that the download gate then refused.
 */
describe('isReachableFile', () => {
  it.each([IntegrityStatus.UNVERIFIED, IntegrityStatus.VERIFIED])(
    'is true for a CLEAN file whose integrity is %s',
    (integrityStatus) => {
      expect(isReachableFile({ scanStatus: ScanStatus.CLEAN, integrityStatus })).toBe(true);
    },
  );

  it.each([IntegrityStatus.MISMATCH, IntegrityStatus.UNREADABLE])(
    'is false for a CLEAN file quarantined %s',
    (integrityStatus) => {
      expect(isReachableFile({ scanStatus: ScanStatus.CLEAN, integrityStatus })).toBe(false);
    },
  );

  it.each([ScanStatus.PENDING, ScanStatus.INFECTED, ScanStatus.FAILED, ScanStatus.SKIPPED])(
    'is false for a file the scanner has not cleared (%s), whatever its integrity',
    (scanStatus) => {
      expect(isReachableFile({ scanStatus, integrityStatus: IntegrityStatus.VERIFIED })).toBe(
        false,
      );
    },
  );
});
