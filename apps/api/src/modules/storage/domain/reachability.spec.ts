import { describe, expect, it } from 'vitest';

import { IntegrityStatus, ScanStatus } from '@edms/domain';

import { unreachableBecause } from './reachability';

/**
 * The whole truth table of "may these bytes be served" — RC validation, D-8 and D-11 together.
 *
 * Every scan verdict, uploaded and product-made, against every integrity finding: the table is
 * small enough to state in full, and stating it in full is what stops the next exception from
 * quietly widening one row.
 */
describe('unreachableBecause', () => {
  const servable = [IntegrityStatus.UNVERIFIED, IntegrityStatus.VERIFIED] as const;
  const quarantined = [IntegrityStatus.MISMATCH, IntegrityStatus.UNREADABLE] as const;
  const scans = Object.values(ScanStatus);

  it('serves scanner-cleared content, uploaded or product-made, while its bytes verify', () => {
    for (const derived of [false, true]) {
      for (const integrityStatus of servable) {
        expect(
          unreachableBecause({ scanStatus: ScanStatus.CLEAN, derived, integrityStatus }),
        ).toBeNull();
      }
    }
  });

  it('serves a product-made artefact SKIPPED by construction, while its bytes verify', () => {
    for (const integrityStatus of servable) {
      expect(
        unreachableBecause({ scanStatus: ScanStatus.SKIPPED, derived: true, integrityStatus }),
      ).toBeNull();
    }
  });

  it('refuses anything a person uploaded that the scanner did not clear, whatever its integrity', () => {
    for (const scanStatus of scans.filter((status) => status !== ScanStatus.CLEAN)) {
      for (const integrityStatus of Object.values(IntegrityStatus)) {
        expect(unreachableBecause({ scanStatus, derived: false, integrityStatus })).toEqual({
          reason: 'SCAN',
          scanStatus,
        });
      }
    }
  });

  it('refuses a product-made artefact in any scan state but SKIPPED or CLEAN', () => {
    for (const scanStatus of scans.filter(
      (status) => status !== ScanStatus.CLEAN && status !== ScanStatus.SKIPPED,
    )) {
      expect(
        unreachableBecause({
          scanStatus,
          derived: true,
          integrityStatus: IntegrityStatus.VERIFIED,
        }),
      ).toEqual({ reason: 'SCAN', scanStatus });
    }
  });

  it('quarantines bytes the verifier found changed or missing, however they were cleared', () => {
    for (const [scanStatus, derived] of [
      [ScanStatus.CLEAN, false],
      [ScanStatus.CLEAN, true],
      [ScanStatus.SKIPPED, true],
    ] as const) {
      for (const integrityStatus of quarantined) {
        expect(unreachableBecause({ scanStatus, derived, integrityStatus })).toEqual({
          reason: 'INTEGRITY',
          integrityStatus,
        });
      }
    }
  });
});
