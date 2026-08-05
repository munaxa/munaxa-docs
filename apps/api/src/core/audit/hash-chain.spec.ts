import { describe, expect, it } from 'vitest';

import {
  CHAIN_HASH_V1,
  CHAIN_HASH_V2,
  GENESIS_HASH,
  type ChainHashVersion,
  type ChainLink,
  attestedFields,
  canonicalize,
  chainHash,
  verifyChain,
} from './hash-chain';

const event = (id: string, sequence: bigint, action = 'DOCUMENT_PUBLISHED') => ({
  eventId: id,
  tenantId: 'tenant-1',
  sequence,
  occurredAt: new Date('2026-01-01T10:00:00.000Z'),
  actorId: 'user-1',
  onBehalfOfId: null,
  channel: 'WEB',
  action,
  subjectType: 'DOCUMENT',
  subjectId: 'doc-1',
  outcome: 'SUCCESS',
  payload: { from: 'APPROVED', to: 'PUBLISHED' },
  reason: null,
  correlationId: 'correlation-1',
  ipAddress: null,
  userAgent: null,
  apiClientId: null,
});

function chain(count: number, version: ChainHashVersion = CHAIN_HASH_V2): ChainLink[] {
  const links: ChainLink[] = [];
  let previous = GENESIS_HASH;
  for (let index = 0; index < count; index += 1) {
    const current = event(`event-${index}`, BigInt(index + 1));
    const hash = chainHash(previous, current, version);
    links.push({ hash, previousHash: previous, version, event: current });
    previous = hash;
  }
  return links;
}

describe('canonicalize', () => {
  it('is independent of key order', () => {
    expect(canonicalize({ b: 1, a: { d: 4, c: 3 } })).toBe(
      canonicalize({ a: { c: 3, d: 4 }, b: 1 }),
    );
  });
});

describe('audit hash chain', () => {
  it('verifies an untouched chain', () => {
    const result = verifyChain(chain(5), { fromSequence: 1n });
    expect(result.intact).toBe(true);
    expect(result.verified).toBe(5);
  });

  it('detects an edited event', () => {
    const links = chain(5);
    links[2] = { ...links[2]!, event: { ...links[2]!.event, action: 'DOCUMENT_DELETED' } };
    const result = verifyChain(links);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe('event-2');
    expect(result.reason).toBe('DIGEST_MISMATCH');
  });

  it('detects a removed event', () => {
    const links = chain(5);
    links.splice(2, 1);
    expect(verifyChain(links).intact).toBe(false);
  });

  it('detects a reordered chain', () => {
    const links = chain(3);
    expect(verifyChain([links[1]!, links[0]!, links[2]!]).intact).toBe(false);
  });

  it('names a gap in the sequence even when what remains chains perfectly', () => {
    // The hole the digest cannot see: truncate from the *end* and every surviving link still
    // recomputes. Only the contiguity claim catches it, and only when the caller says where the
    // range was supposed to start.
    const links = chain(5).slice(2);
    const withoutSequence = verifyChain(links, { from: links[0]!.previousHash });
    expect(withoutSequence.intact).toBe(true);

    const withSequence = verifyChain(links, {
      from: links[0]!.previousHash,
      fromSequence: 1n,
    });
    expect(withSequence.intact).toBe(false);
    expect(withSequence.reason).toBe('SEQUENCE_GAP');
  });
});

describe('the widened digest', () => {
  it('covers the fields v1 left uncovered', () => {
    const base = event('event-0', 1n);
    const withReason = { ...base, reason: 'Regulator request' };

    // Under v1 a changed reason is invisible: the field was never in the material.
    expect(chainHash(GENESIS_HASH, base, CHAIN_HASH_V1)).toBe(
      chainHash(GENESIS_HASH, withReason, CHAIN_HASH_V1),
    );
    expect(chainHash(GENESIS_HASH, base, CHAIN_HASH_V2)).not.toBe(
      chainHash(GENESIS_HASH, withReason, CHAIN_HASH_V2),
    );
  });

  it('leaves the v1 material byte-for-byte as Phase 1 wrote it', () => {
    // Every row written before Phase 9 has to keep verifying, and the table refuses the
    // `UPDATE` that would rehash them. If this ever changes, the trail loses its history.
    expect(chainHash(GENESIS_HASH, event('event-0', 1n), CHAIN_HASH_V1)).toBe(
      'a6216a9a4a0db1e21099bc78e9a90e26cc8768c9b465d4ac5f4626be085ab1f1',
    );
  });

  it('verifies a chain whose versions change part-way through', () => {
    // What an upgraded deployment actually holds: v1 rows, then v2 rows, one unbroken chain.
    const links: ChainLink[] = [];
    let previous = GENESIS_HASH;
    for (const [index, version] of [CHAIN_HASH_V1, CHAIN_HASH_V1, CHAIN_HASH_V2].entries()) {
      const current = event(`event-${String(index)}`, BigInt(index + 1));
      const hash = chainHash(previous, current, version as ChainHashVersion);
      links.push({
        hash,
        previousHash: previous,
        version: version as ChainHashVersion,
        event: current,
      });
      previous = hash;
    }
    expect(verifyChain(links, { fromSequence: 1n }).intact).toBe(true);
  });

  it('says which fields each version attests', () => {
    expect(attestedFields(CHAIN_HASH_V1)).not.toContain('reason');
    expect(attestedFields(CHAIN_HASH_V2)).toContain('reason');
    expect(attestedFields(CHAIN_HASH_V2)).toContain('sequence');
  });
});
