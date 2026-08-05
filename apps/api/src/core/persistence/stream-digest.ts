import { createHash } from 'node:crypto';

/**
 * A digest accumulated over bytes as they stream past.
 *
 * A manifest — or an export record — has to state the digest of an artefact the process never held
 * in one piece, so it is computed on the way through rather than by reading the object back, which
 * would also mean trusting the store to return what it was given.
 *
 * ## Why it is here rather than in the module that first needed it
 *
 * Phase 9 wrote this class inside `audit/domain/evidence-bundle.ts`, where it was the only thing in
 * that file with nothing to do with evidence: it hashes bytes. Phase 15 needs exactly the same
 * accumulator to record what a report export actually wrote, and the module boundary lint forbids
 * reaching into another module's `domain/` — correctly, because a reporting service importing an
 * *evidence bundle* would be a dependency on the audit phase's vocabulary rather than on a hash.
 *
 * The alternatives were both worse. A second copy in `reporting/domain/` is nine lines that cannot
 * disagree today and can tomorrow, and the day they do, one export's stated digest stops matching
 * the way the other computes it. Promoting the *whole* evidence bundle to core would move a
 * compliance artefact's definition out of the module accountable for it.
 *
 * So the accumulator moved and nothing else did. `evidence-bundle.ts` re-exports it, so Phase 9's
 * call sites and its unit test are unchanged, and the manifest's shape is untouched.
 */
export class StreamDigest {
  private readonly hash = createHash('sha256');
  private bytes = 0;

  update(chunk: Uint8Array): void {
    this.hash.update(chunk);
    this.bytes += chunk.byteLength;
  }

  get sizeBytes(): number {
    return this.bytes;
  }

  digest(): string {
    return this.hash.digest('hex');
  }
}
