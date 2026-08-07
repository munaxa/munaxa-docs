import { describe, expect, it } from 'vitest';

import {
  CHAIN_HASH_V1,
  CHAIN_HASH_V2,
  GENESIS_HASH,
  attestedFields,
  canonicalize,
  chainHash,
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

describe('canonicalize', () => {
  it('is independent of key order', () => {
    expect(canonicalize({ b: 1, a: { d: 4, c: 3 } })).toBe(
      canonicalize({ a: { c: 3, d: 4 }, b: 1 }),
    );
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

  // The mixed-version chain moved to `platform-chain.verifier.spec.ts` with the verifier itself,
  // where it now runs over real `audit_event` rows rather than hand-built links.

  it('leaves the v1 material byte-for-byte as Phase 1 wrote it', () => {
    // Every row written before Phase 9 has to keep verifying, and the table refuses the
    // `UPDATE` that would rehash them. If this ever changes, the trail loses its history.
    expect(chainHash(GENESIS_HASH, event('event-0', 1n), CHAIN_HASH_V1)).toBe(
      'a6216a9a4a0db1e21099bc78e9a90e26cc8768c9b465d4ac5f4626be085ab1f1',
    );
  });

  it('says which fields each version attests', () => {
    expect(attestedFields(CHAIN_HASH_V1)).not.toContain('reason');
    expect(attestedFields(CHAIN_HASH_V2)).toContain('reason');
    expect(attestedFields(CHAIN_HASH_V2)).toContain('sequence');
  });
});
