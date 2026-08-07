import { Injectable } from '@nestjs/common';
import { CanonicalFormatRegistry, verifyChain } from '@munaxa/audit';
import type { ChainBreakCode } from '@munaxa/audit';
import type { ChainHead } from '@munaxa/interfaces';

import { isChainHashVersion } from '../../../core/audit/hash-chain';
import { DOCS_CANONICAL_FORMATS } from '../../../core/audit/platform-canonical';
import type {
  AuditEventRecord,
  BreakReason,
  ChainTail,
  ChainVerifier,
  SliceVerification,
} from '../application/ports';
import { toPlatformRecord } from './platform-audit.mapping';

/**
 * The chain, recomputed by `@munaxa/audit`.
 *
 * This is the last piece of the audit trail to move. The Platform has owned the canonical
 * material, the digest, the chain linkage and the append since P4.5C; verification stayed behind
 * because `verifyChain` could only begin a walk at genesis, and this product has never verified
 * that way — its daily pass resumes from a signed checkpoint and walks in batches of 5,000.
 * Platform 2.4.1 added `VerifyChainOptions.from`, and this class is what that unblocked.
 *
 * ## What did not move, and must not
 *
 * **Trust in the resume point.** The Platform verifies *from* the head it is given and cannot
 * authenticate it — it has no way to tell a signed checkpoint from the first row of the batch
 * being verified, and taking the head from the batch would verify the batch against itself. The
 * checkpoint store refuses a checkpoint whose signature does not recompute, with a key held in
 * neither the database nor the object store, and that stays here because the key must live
 * somewhere the Platform cannot reach.
 *
 * ## The three formats
 *
 * Registered rather than defaulted. `verifyChain` refuses a record sealed by a format it was not
 * given rather than skipping it — a verifier that cannot check a record has not established that
 * it is intact — so a chain spanning this product's v1, v2 and v3 digests needs all three, and
 * gets them from the same declarations the writer seals with.
 */
@Injectable()
export class PlatformChainVerifier implements ChainVerifier {
  readonly #formats = new CanonicalFormatRegistry([...DOCS_CANONICAL_FORMATS]);

  verify(events: readonly AuditEventRecord[], from: ChainTail | null): SliceVerification {
    // A row stamped with a chain hash version this build does not know cannot be mapped, let
    // alone verified — `toPlatformRecord` refuses it rather than guessing a format. That refusal
    // is right for the write path and wrong here: an unverifiable row is a *finding*, not a
    // crash, and a pass that threw would produce no result for the rows before it either.
    //
    // So the walk stops at the first such row. Everything before it is verified normally, because
    // a break in the prefix is the earlier and more serious finding and must be reported instead.
    const unverifiable = events.findIndex((event) => !isChainHashVersion(event.chainHashVersion));
    const verifiable = unverifiable === -1 ? events : events.slice(0, unverifiable);

    const result = verifyChain(
      verifiable.map(toPlatformRecord),
      // `ChainTail` and `ChainHead` are the same two facts under two names — this product's and
      // the Platform's. The conversion is here so the application layer never has to name one.
      { from: toHead(from), formats: this.#formats },
    );

    if (result.valid && unverifiable !== -1) {
      const record = events[unverifiable];
      return {
        intact: false,
        brokenAt: record?.id ?? null,
        // Not tampering. The row may be perfectly sound and written by a later build; what is
        // true is that this one cannot check it, and saying more than that would be an accusation
        // the evidence does not support.
        reason: 'UNVERIFIABLE_FORMAT',
        expectedHash: null,
        actualHash: null,
        verified: result.checked,
      };
    }

    if (result.valid) {
      return {
        intact: true,
        brokenAt: null,
        reason: null,
        expectedHash: null,
        actualHash: null,
        verified: result.checked,
      };
    }

    return {
      intact: false,
      // The Platform reports the record's own id alongside its position. The id is what this
      // product has always reported, because it is what an auditor looks up and what the alert
      // and the evidence bundle name.
      brokenAt: result.brokenAtId ?? null,
      reason: toBreakReason(result.code),
      expectedHash: result.expectedHash ?? null,
      actualHash: result.actualHash ?? null,
      verified: result.checked,
    };
  }
}

function toHead(from: ChainTail | null): ChainHead | null {
  return from === null ? null : { sequence: from.sequence, hash: from.hash };
}

/**
 * The Platform's code in this product's vocabulary.
 *
 * The first three map straight across: they are the same three accusations this product has made
 * since Phase 9, under the same names.
 *
 * The last two are **renamed rather than folded in**, and that is the point of doing this by hand
 * rather than passing the Platform's token through. `UNKNOWN_FORMAT` and `MISSING_IDENTIFIER` mean
 * the record could not be checked — not that it was altered. Reporting either as `DIGEST_MISMATCH`
 * would accuse somebody of tampering on the evidence that this build did not recognise a format,
 * which is a false accusation in the one place a product cannot afford to make one.
 *
 * `undefined` cannot occur — the Platform sets `code` on every failure — but a verifier that
 * silently treated an unrecognised outcome as one of the tamper reasons would be doing exactly
 * what the paragraph above forbids, so it is refused instead.
 */
function toBreakReason(code: ChainBreakCode | undefined): BreakReason {
  switch (code) {
    case 'DIGEST_MISMATCH':
    case 'LINK_MISMATCH':
    case 'SEQUENCE_GAP':
      return code;
    case 'UNKNOWN_FORMAT':
      return 'UNVERIFIABLE_FORMAT';
    case 'MISSING_IDENTIFIER':
      return 'UNVERIFIABLE_RECORD';
    default:
      throw new Error(
        `The chain verifier returned no failure code. Refusing to guess which accusation to make.`,
      );
  }
}
