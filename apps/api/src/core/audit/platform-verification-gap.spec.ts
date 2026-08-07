import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { CanonicalFormatRegistry, verifyChain as platformVerifyChain } from '@munaxa/audit';
import type { AuditRecord } from '@munaxa/interfaces';
import { ROOT_TENANT_ID, unsafeId, type CorrelationId } from '@munaxa/types';

import {
  DOCS_CANONICAL_FORMATS,
  DOCS_CANONICAL_V3,
  type DocsAuditFields,
} from './platform-canonical';

/**
 * Why P4.7 stopped, executed rather than asserted.
 *
 * The phase was to replace this product's chain verification with `@munaxa/audit`'s `verifyChain`.
 * It did not, because the platform's verifier can only start a walk at genesis: it initialises
 * `previousHash` and the expected sequence to `null`, and `VerifyChainOptions` carries nothing but
 * `formats`. This product never verifies from genesis — every call passes a starting digest and a
 * starting sequence, because the daily pass resumes from a *signed* checkpoint and walks in
 * batches of 5,000.
 *
 * These tests establish three things and nothing else:
 *
 * 1. The two verifiers agree exactly on a chain that does start at genesis. The gap is not about
 *    digests, formats or this product's canonicalisation — those all migrated cleanly in P4.5C.
 * 2. The platform reports a *sound* continuation batch as broken. That is the blocker, and it is
 *    the failure mode that matters: not a missed break, but a fabricated one, nightly.
 * 3. The platform cannot see a record removed from the front of a batch, which this product's
 *    `fromSequence` does see.
 *
 * They are written to fail loudly if the platform ever gains a starting head — at which point
 * this file is deleted and the migration proceeds. See `docs/platform-migration/p4.7-*.md`.
 */

const registry = new CanonicalFormatRegistry([...DOCS_CANONICAL_FORMATS]);

function docsRecord(
  sequence: bigint,
  previousHash: string | null,
): AuditRecord<string> & { readonly formatVersion: number } {
  const docs: DocsAuditFields = {
    outcome: 'SUCCESS',
    reason: null,
    apiClientId: null,
    payload: { sequence: sequence.toString() },
  };
  const record = {
    id: `0199aaaa-0000-7000-8000-${sequence.toString().padStart(12, '0')}`,
    event: {
      name: 'DOCUMENT_VIEWED',
      occurredAt: 1_700_000_000_000 + Number(sequence),
      tenantId: ROOT_TENANT_ID,
      correlationId: unsafeId<CorrelationId>('corr-1'),
      outcome: 'success' as const,
      severity: 'info' as const,
      actor: { id: 'u1', kind: 'user' },
      target: { id: 'd1', type: 'DOCUMENT' },
      source: { component: 'API' },
      payload: { docs },
    },
    recordedAt: 1_700_000_000_000 + Number(sequence),
    sequence,
    previousHash,
    formatVersion: DOCS_CANONICAL_V3.version,
  };
  const hash = createHash('sha256')
    .update(
      DOCS_CANONICAL_V3.canonicalize({
        event: record.event,
        previousHash: record.previousHash,
        recordedAt: record.recordedAt,
        sequence: record.sequence,
        recordId: record.id,
      }),
      'utf8',
    )
    .digest('hex');
  return { ...record, hash };
}

/** A sound chain of `length` records, the first chaining from genesis. */
function chain(length: number): (AuditRecord<string> & { readonly formatVersion: number })[] {
  const records: (AuditRecord<string> & { readonly formatVersion: number })[] = [];
  let previous: string | null = null;
  for (let index = 1; index <= length; index++) {
    const record = docsRecord(BigInt(index), previous);
    records.push(record);
    previous = record.hash;
  }
  return records;
}

describe('the platform verifier on a chain that starts at genesis', () => {
  it('agrees with this product, so the gap is not about digests or formats', () => {
    const records = chain(6);
    expect(platformVerifyChain(records, { formats: registry })).toEqual({
      valid: true,
      checked: 6,
    });
  });

  it('still detects an altered field, a swapped id and a removed record', () => {
    const records = chain(4);

    const altered = [...records];
    altered[2] = { ...records[2]!, event: { ...records[2]!.event, name: 'DOCUMENT_PRINTED' } };
    expect(platformVerifyChain(altered, { formats: registry }).valid).toBe(false);

    const swapped = [...records];
    swapped[2] = { ...records[2]!, id: '0199aaaa-0000-7000-8000-999999999999' };
    expect(platformVerifyChain(swapped, { formats: registry }).valid).toBe(false);

    const removed = [records[0]!, records[1]!, records[3]!];
    expect(platformVerifyChain(removed, { formats: registry }).valid).toBe(false);
  });
});

describe('the gap: a walk that does not start at genesis', () => {
  it('reports a sound continuation batch as broken', () => {
    // The whole chain is intact. This is simply the second batch of a two-batch walk — which is
    // what every pass over a real trail looks like, at 5,000 rows a batch.
    const records = chain(6);
    const secondBatch = records.slice(3);

    const result = platformVerifyChain(secondBatch, { formats: registry });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('previous hash does not match the preceding record');
    // A false break, on intact evidence. `13-audit-architecture.md` §4 pages at the highest
    // severity in the product on this result; a verifier that raises it nightly is worse than no
    // verifier, because it trains an operator to ignore the one alarm that must never be ignored.
    expect(result.checked).toBe(0);
  });

  it('has nowhere to put the signed checkpoint the resume depends on', () => {
    // The resume point is authenticated: the store refuses a checkpoint whose signature does not
    // recompute, so "start from sequence 4 with digest 9c2f…" is a claim signed with a key held in
    // neither the database nor the bucket. `VerifyChainOptions` has one member, `formats`, so
    // there is no argument that claim can be passed as — and without it, resuming means trusting
    // the batch's own first `previousHash`, which is exactly the row an attacker would forge.
    const records = chain(6);
    const options: Parameters<typeof platformVerifyChain>[1] = { formats: registry };
    expect(Object.keys(options)).toEqual(['formats']);
    expect(platformVerifyChain(records.slice(3), options).valid).toBe(false);
  });

  it('cannot see a record removed from the front of a batch', () => {
    // Every record present chains to the one before it, so the digests are all sound; what is
    // missing is that the batch should have started at sequence 4 and starts at 5. This product
    // passes `fromSequence` and reports `SEQUENCE_GAP`. The platform starts its expectation at the
    // first record it is given, so there is nothing to compare against.
    const records = chain(6);
    const truncated = records.slice(4);

    // Sound in isolation, once the leading link is disregarded — which is the point.
    const asIfGenesis = [{ ...truncated[0]!, previousHash: null }, ...truncated.slice(1)];
    const result = platformVerifyChain(asIfGenesis, { formats: registry });

    // It fails only because rewriting `previousHash` broke that record's digest — not because a
    // record is missing. The removal itself is invisible to it.
    expect(result.brokenAt).toBe(5n);
    expect(result.reason).toBe('record contents do not match its hash');
  });
});

describe('the diagnostic the product reports and the platform does not', () => {
  it('gives one prose reason where this product gives three distinct accusations', () => {
    const records = chain(4);
    const altered = [...records];
    altered[2] = { ...records[2]!, event: { ...records[2]!.event, name: 'DOCUMENT_PRINTED' } };

    const result = platformVerifyChain(altered, { formats: registry });

    // The information is there, in prose. What is not there is a stable token to branch on, the
    // expected and actual digests an alert quotes, or the record *id* an auditor looks up —
    // `brokenAt` is the sequence. Recovering `DIGEST_MISMATCH` by matching on this string would be
    // a product-specific workaround against an unversioned message.
    expect(result.reason).toBe('record contents do not match its hash');
    expect(result).not.toHaveProperty('expectedHash');
    expect(result).not.toHaveProperty('actualHash');
    expect(result.brokenAt).toBe(3n);
  });
});
