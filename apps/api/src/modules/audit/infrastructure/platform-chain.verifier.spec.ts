import { describe, expect, it } from 'vitest';

import { asId, type AnyId, type TenantId, type UserId } from '@edms/domain';

import {
  CHAIN_HASH_V1,
  CHAIN_HASH_V2,
  CHAIN_HASH_V3,
  GENESIS_HASH,
  chainHash,
  type ChainHashVersion,
} from '../../../core/audit/hash-chain';
import type { AuditEventRecord, ChainTail } from '../application/ports';
import { PlatformChainVerifier } from './platform-chain.verifier';

/**
 * The chain verifier, after P4.7 moved it to `@munaxa/audit`.
 *
 * Every row here is sealed with `chainHash` — the function that wrote every row in every
 * deployment — and verified with the Platform. That is deliberate and it is the point: the
 * migration is only sound if the Platform reproduces those bytes exactly, and a test that sealed
 * with the Platform and verified with the Platform would agree with itself no matter what it did.
 *
 * The first four cases came from `hash-chain.spec.ts` when the local verifier was deleted. They
 * run over real `audit_event` rows now rather than hand-built links, so they exercise the mapping
 * as well.
 */

const verifier = new PlatformChainVerifier();

function row(
  sequence: bigint,
  previousHash: string,
  version: ChainHashVersion,
  action = 'DOCUMENT_PUBLISHED',
): AuditEventRecord {
  const input = {
    eventId: `0199aaaa-0000-7000-8000-${sequence.toString().padStart(12, '0')}`,
    tenantId: '019489f0-0000-7000-8000-0000000000a1',
    sequence,
    occurredAt: new Date(1_700_000_000_000 + Number(sequence)),
    actorId: '0199bbbb-0000-7000-8000-000000000002',
    onBehalfOfId: null,
    channel: 'API',
    action,
    subjectType: 'DOCUMENT',
    subjectId: '0199dddd-0000-7000-8000-000000000004',
    outcome: 'SUCCESS',
    payload: { pages: 12 },
    reason: 'CONFIDENTIAL_ACCESS',
    correlationId: 'corr-1',
    ipAddress: '198.51.100.4',
    userAgent: 'Mozilla/5.0',
    apiClientId: null,
  } as const;

  return {
    id: asId<AnyId>(input.eventId),
    tenantId: asId<TenantId>(input.tenantId),
    sequence,
    occurredAt: input.occurredAt,
    actorId: asId<UserId>(input.actorId),
    onBehalfOfId: null,
    channel: 'API',
    action: action as AuditEventRecord['action'],
    subjectType: 'DOCUMENT',
    subjectId: asId<AnyId>(input.subjectId),
    outcome: 'SUCCESS',
    payload: input.payload,
    reason: input.reason,
    correlationId: input.correlationId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    apiClientId: null,
    hash: chainHash(previousHash, input, version),
    previousHash,
    chainHashVersion: version,
  };
}

/** A chain of `count` rows, sealed by `versionFor` — one per row, so a chain may span versions. */
function chain(count: number, versionFor: (n: number) => ChainHashVersion = () => CHAIN_HASH_V3) {
  const rows: AuditEventRecord[] = [];
  let previous = GENESIS_HASH;
  for (let index = 1; index <= count; index++) {
    const record = row(BigInt(index), previous, versionFor(index));
    rows.push(record);
    previous = record.hash;
  }
  return rows;
}

const tailOf = (record: AuditEventRecord): ChainTail => ({
  sequence: record.sequence,
  hash: record.hash,
});

describe('the chain, verified from genesis', () => {
  it('verifies an untouched chain', () => {
    const result = verifier.verify(chain(5), null);
    expect(result.intact).toBe(true);
    expect(result.verified).toBe(5);
  });

  it('detects an edited event, and names it by id', () => {
    const rows = chain(5);
    rows[2] = { ...rows[2]!, action: 'DOCUMENT_MOVED' };

    const result = verifier.verify(rows, null);

    expect(result.intact).toBe(false);
    expect(result.reason).toBe('DIGEST_MISMATCH');
    expect(result.brokenAt).toBe(rows[2].id);
    // The digest the contents produce, against the one the row claims.
    expect(result.actualHash).toBe(rows[2].hash);
    expect(result.expectedHash).not.toBe(result.actualHash);
  });

  it('detects a removed event', () => {
    const rows = chain(5);
    rows.splice(2, 1);
    expect(verifier.verify(rows, null).intact).toBe(false);
  });

  it('detects a reordered chain', () => {
    const rows = chain(3);
    expect(verifier.verify([rows[1]!, rows[0]!, rows[2]!], null).intact).toBe(false);
  });

  it('verifies a chain whose versions change part-way through', () => {
    // What an upgraded deployment actually holds: v1 rows, then v2, then v3 — one unbroken chain,
    // each row verified against the field set it was written under.
    const rows = chain(9, (n) => (n <= 3 ? CHAIN_HASH_V1 : n <= 6 ? CHAIN_HASH_V2 : CHAIN_HASH_V3));
    expect(verifier.verify(rows, null)).toMatchObject({ intact: true, verified: 9 });
  });
});

describe('resuming from a checkpoint', () => {
  it('verifies a continuation batch', () => {
    // The case P4.7 stopped on, and the shape of every batch after the first.
    const rows = chain(9);
    expect(verifier.verify(rows.slice(3), tailOf(rows[2]!))).toMatchObject({
      intact: true,
      verified: 6,
    });
  });

  it('walks the whole chain in batches and agrees with one pass', () => {
    const rows = chain(11);
    let head: ChainTail | null = null;
    let verified = 0;

    for (let start = 0; start < rows.length; start += 4) {
      const batch = rows.slice(start, start + 4);
      const result = verifier.verify(batch, head);
      expect(result.intact).toBe(true);
      verified += result.verified;
      head = tailOf(batch.at(-1)!);
    }

    expect(verified).toBe(11);
  });

  it('resumes across a format change', () => {
    // A head is a position and a digest, never a format — so a checkpoint taken on a v1 row must
    // carry a v2 batch, or a deployment could never checkpoint across an upgrade.
    const rows = chain(8, (n) => (n <= 4 ? CHAIN_HASH_V1 : CHAIN_HASH_V3));
    expect(verifier.verify(rows.slice(4), tailOf(rows[3]!)).intact).toBe(true);
  });

  it('names a gap even when what remains chains perfectly', () => {
    // The hole the digest cannot see. Truncate from the *front* of the batch and every surviving
    // row still recomputes; only the position the checkpoint names catches it.
    const rows = chain(6);

    expect(verifier.verify(rows.slice(3), tailOf(rows[1]!))).toMatchObject({
      intact: false,
      reason: 'SEQUENCE_GAP',
      verified: 0,
    });
  });

  it('refuses a batch that does not follow the checkpoint', () => {
    const rows = chain(6);
    const forged: ChainTail = { sequence: rows[2]!.sequence, hash: 'b'.repeat(64) };

    expect(verifier.verify(rows.slice(3), forged)).toMatchObject({
      intact: false,
      reason: 'LINK_MISMATCH',
    });
  });
});

describe('a record this build cannot check is not a record somebody altered', () => {
  it('reports an unrecognised canonical format as UNVERIFIABLE_FORMAT', () => {
    // A row stamped with a chain hash version from a later build. It has not been shown to be
    // sound and it has not been shown to be broken, and an alert saying "tampered" would send
    // somebody after an intruder who was never there.
    const rows = chain(3);
    rows[1] = { ...rows[1]!, chainHashVersion: 9 };

    expect(verifier.verify(rows, null)).toMatchObject({
      intact: false,
      reason: 'UNVERIFIABLE_FORMAT',
      brokenAt: rows[1].id,
      // The row before it did verify, and the pass says so rather than discarding the finding.
      verified: 1,
    });
  });

  it('reports a break before the unverifiable row, because it is the earlier finding', () => {
    const rows = chain(4);
    rows[1] = { ...rows[1]!, action: 'DOCUMENT_MOVED' };
    rows[2] = { ...rows[2]!, chainHashVersion: 9 };

    expect(verifier.verify(rows, null)).toMatchObject({
      intact: false,
      reason: 'DIGEST_MISMATCH',
      brokenAt: rows[1].id,
    });
  });

  it('distinguishes tampering from unverifiability in the reason it reports', () => {
    // The two families the alert branches on. Nothing here should ever collapse into the other.
    const tampering = ['DIGEST_MISMATCH', 'LINK_MISMATCH', 'SEQUENCE_GAP'];
    const unverifiable = ['UNVERIFIABLE_FORMAT', 'UNVERIFIABLE_RECORD'];

    const altered = chain(3);
    altered[1] = { ...altered[1]!, action: 'DOCUMENT_MOVED' };
    const result = verifier.verify(altered, null);

    expect(tampering).toContain(result.reason);
    expect(unverifiable).not.toContain(result.reason);
  });
});
