import {
  type IntegrityStatusKey,
  ScanStatus,
  type ScanStatusKey,
  isServableIntegrity,
} from '@edms/domain';

/**
 * Whether a stored blob may be handed to anybody. Pure.
 *
 * The one predicate every door that serves bytes asks — the signed download, the preview stream,
 * the text a preview reads back. It used to be two: the download gate checked the scan and nothing
 * else, and `isReachable` checked the scan and the integrity finding but had no caller, so a blob
 * the rolling verifier had quarantined was still signed for and served (`17-security-architecture.md`
 * §8: a mismatch "becomes unreachable through the same gate an infected one fails").
 *
 * Two questions, in this order:
 *
 * - **Was it passed as safe?** `CLEAN` from the scanner, or — for a file the product generated
 *   itself (an export, an evidence bundle, a rendition) — `SKIPPED` by construction, because it
 *   never goes near the scanner. Anything a person uploaded still needs `CLEAN`.
 * - **Are the bytes still the bytes?** `VERIFIED`, or `UNVERIFIED` because the verifier has not
 *   reached it yet. `MISMATCH` and `UNREADABLE` are quarantined until a successful re-read clears
 *   them; nothing here repairs or re-marks anything.
 */

export interface ReachabilityFacts {
  readonly scanStatus: ScanStatusKey;
  readonly derived: boolean;
  readonly integrityStatus: IntegrityStatusKey;
}

export type Unreachable =
  | { readonly reason: 'SCAN'; readonly scanStatus: ScanStatusKey }
  | { readonly reason: 'INTEGRITY'; readonly integrityStatus: IntegrityStatusKey };

/** Null when the blob may be served; otherwise why it may not. */
export function unreachableBecause(file: ReachabilityFacts): Unreachable | null {
  const passed =
    file.scanStatus === ScanStatus.CLEAN ||
    (file.derived && file.scanStatus === ScanStatus.SKIPPED);
  if (!passed) {
    return { reason: 'SCAN', scanStatus: file.scanStatus };
  }
  if (!isServableIntegrity(file.integrityStatus)) {
    return { reason: 'INTEGRITY', integrityStatus: file.integrityStatus };
  }
  return null;
}
