import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { CanonicalFormatRegistry, verifyChain } from '@munaxa/audit';
import type { CanonicalFormat, CanonicalInput } from '@munaxa/audit';
import { ROOT_TENANT_ID, unsafeId } from '@munaxa/types';
import type { AuditRecord } from '@munaxa/interfaces';
import type { CorrelationId } from '@munaxa/types';

import {
  chainHash,
  CHAIN_HASH_V1,
  CHAIN_HASH_V2,
  CHAIN_HASH_V3,
  GENESIS_HASH,
  type ChainedEventInput,
  type ChainHashVersion,
} from './hash-chain';
import {
  DOCS_CANONICAL_FORMATS,
  toPlatformFormatVersion,
  type DocsAuditFields,
} from './platform-canonical';

/**
 * The only question this file exists to answer: do the Platform canonical formats produce the
 * *same bytes* as `chainHash()` has produced since Phase 1?
 *
 * The comparison is against `chainHash` itself rather than against a stored fixture, because
 * `chainHash` is what wrote every row in every deployment. If these two ever disagree, the rows
 * cannot be rehashed to match — the table refuses `UPDATE` to every role — so disagreement means
 * the evidence is gone. That makes this the highest-stakes test in the repository.
 */

const OCCURRED_AT = new Date('2026-01-15T09:30:00.123Z');

function docsEvent(overrides: Partial<ChainedEventInput> = {}): ChainedEventInput {
  return {
    eventId: '0199aaaa-0000-7000-8000-000000000001',
    tenantId: ROOT_TENANT_ID,
    sequence: 42n,
    occurredAt: OCCURRED_AT,
    actorId: '0199bbbb-0000-7000-8000-000000000002',
    onBehalfOfId: '0199cccc-0000-7000-8000-000000000003',
    channel: 'API',
    action: 'DOCUMENT_DOWNLOADED',
    subjectType: 'DOCUMENT',
    subjectId: '0199dddd-0000-7000-8000-000000000004',
    outcome: 'SUCCESS',
    payload: { pages: 12, nested: { b: 2, a: 1 }, when: OCCURRED_AT },
    reason: 'CONFIDENTIAL_ACCESS',
    correlationId: 'corr-abc',
    ipAddress: '198.51.100.4',
    userAgent: 'Mozilla/5.0',
    apiClientId: '0199eeee-0000-7000-8000-000000000005',
    ...overrides,
  };
}

/** The mapping the migrated writer and reader both use. Exercised here so it cannot drift. */
function toPlatformRecord(
  event: ChainedEventInput,
  previousHash: string,
  version: ChainHashVersion,
): AuditRecord<string> {
  const docs: DocsAuditFields = {
    outcome: event.outcome,
    reason: event.reason,
    apiClientId: event.apiClientId,
    payload: event.payload,
  };
  return {
    id: event.eventId,
    event: {
      name: event.action,
      occurredAt: event.occurredAt.getTime(),
      tenantId: unsafeId(event.tenantId),
      correlationId: unsafeId<CorrelationId>(event.correlationId),
      // The platform-shaped projection, for querying. Never hashed by these formats — the digest
      // reads `docs.outcome`, which is the token that was actually written.
      outcome: event.outcome === 'SUCCESS' ? 'success' : 'denied',
      severity: 'info',
      ...(event.actorId === null
        ? {}
        : {
            actor: {
              id: event.actorId,
              kind: 'user',
              ...(event.onBehalfOfId === null ? {} : { onBehalfOf: event.onBehalfOfId }),
            },
          }),
      target: { id: event.subjectId, type: event.subjectType },
      source: {
        component: event.channel,
        ...(event.ipAddress === null ? {} : { ipAddress: event.ipAddress }),
        ...(event.userAgent === null ? {} : { userAgent: event.userAgent }),
      },
      payload: { docs },
    },
    recordedAt: event.occurredAt.getTime(),
    sequence: event.sequence,
    previousHash: previousHash === GENESIS_HASH ? null : previousHash,
    hash: chainHash(previousHash, event, version),
    formatVersion: toPlatformFormatVersion(version),
  };
}

/**
 * What the Platform actually stores: `sha256` over the format's material.
 *
 * Applied here rather than inside the format, because the Platform applies it — a format that
 * digested its own output would be hashed twice and every record would read as tampered.
 */
function platformDigest(format: CanonicalFormat, input: CanonicalInput): string {
  return createHash('sha256').update(format.canonicalize(input), 'utf8').digest('hex');
}

const registry = new CanonicalFormatRegistry([...DOCS_CANONICAL_FORMATS]);
const VERSIONS: ChainHashVersion[] = [CHAIN_HASH_V1, CHAIN_HASH_V2, CHAIN_HASH_V3];

describe('byte-for-byte equality with the historical digest', () => {
  it.each(VERSIONS)('reproduces chainHash v%i exactly', (version) => {
    const event = docsEvent();
    const previousHash = 'a'.repeat(64);
    const format = registry.get(toPlatformFormatVersion(version));

    expect(format).toBeDefined();
    expect(
      platformDigest(format!, {
        event: toPlatformRecord(event, previousHash, version).event,
        previousHash,
        recordedAt: event.occurredAt.getTime(),
        sequence: event.sequence,
        recordId: event.eventId,
      }),
    ).toBe(chainHash(previousHash, event, version));
  });

  it.each(VERSIONS)('reproduces a genesis record under v%i', (version) => {
    // The first record in a tenant's chain carries 64 zeros, not null. Hashing null here would
    // break the first record of every tenant.
    const event = docsEvent({ sequence: 1n });
    const format = registry.get(toPlatformFormatVersion(version));

    expect(
      platformDigest(format!, {
        event: toPlatformRecord(event, GENESIS_HASH, version).event,
        previousHash: null,
        recordedAt: event.occurredAt.getTime(),
        sequence: 1n,
        recordId: event.eventId,
      }),
    ).toBe(chainHash(GENESIS_HASH, event, version));
  });

  it.each(VERSIONS)('reproduces v%i with every nullable field absent', (version) => {
    const event = docsEvent({
      actorId: null,
      onBehalfOfId: null,
      reason: null,
      ipAddress: null,
      userAgent: null,
      apiClientId: null,
      payload: {},
    });
    const previousHash = 'b'.repeat(64);
    const format = registry.get(toPlatformFormatVersion(version));

    expect(
      platformDigest(format!, {
        event: toPlatformRecord(event, previousHash, version).event,
        previousHash,
        recordedAt: event.occurredAt.getTime(),
        sequence: event.sequence,
        recordId: event.eventId,
      }),
    ).toBe(chainHash(previousHash, event, version));
  });
});

describe('verification through the Platform', () => {
  function chain(versions: ChainHashVersion[]): AuditRecord<string>[] {
    const records: AuditRecord<string>[] = [];
    let previous = GENESIS_HASH;
    versions.forEach((version, index) => {
      const event = docsEvent({
        sequence: BigInt(index + 1),
        eventId: `0199aaaa-0000-7000-8000-00000000000${index + 1}`,
      });
      const record = toPlatformRecord(event, previous, version);
      records.push(record);
      previous = record.hash;
    });
    return records;
  }

  it('verifies a historical chain', () => {
    expect(verifyChain(chain([CHAIN_HASH_V3, CHAIN_HASH_V3]), { formats: registry })).toEqual({
      valid: true,
      checked: 2,
    });
  });

  it('verifies a mixed-version chain, exactly as the estate is', () => {
    // Real deployments contain all three: v1 rows from Phase 1, v2 from Phase 9, v3 since 17.
    expect(
      verifyChain(chain([CHAIN_HASH_V1, CHAIN_HASH_V2, CHAIN_HASH_V3]), { formats: registry }),
    ).toEqual({ valid: true, checked: 3 });
  });

  it('detects a changed recordId', () => {
    // The property this product bought by hashing the event id, now checkable through the Platform.
    const records = chain([CHAIN_HASH_V3]);
    const renumbered = [{ ...records[0]!, id: '0199ffff-0000-7000-8000-000000000009' }];

    const result = verifyChain(renumbered, { formats: registry });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('record contents do not match its hash');
  });

  it('detects altered historical bytes', () => {
    const records = chain([CHAIN_HASH_V3]);
    const tampered = [
      {
        ...records[0]!,
        event: {
          ...records[0]!.event,
          payload: {
            docs: {
              ...(records[0]!.event.payload as { docs: DocsAuditFields }).docs,
              outcome: 'DENIED',
            },
          },
        },
      },
    ];

    expect(verifyChain(tampered, { formats: registry }).valid).toBe(false);
  });

  it('detects a removed record', () => {
    const records = chain([CHAIN_HASH_V3, CHAIN_HASH_V3, CHAIN_HASH_V3]);
    const truncated = [records[0]!, records[2]!];

    const result = verifyChain(truncated, { formats: registry });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expected sequence 2/);
  });

  it('refuses a format whose required recordId is missing', () => {
    // Rather than hashing `undefined` and reporting a tamper that did not happen.
    const records = chain([CHAIN_HASH_V3]);
    const withoutId = [{ ...records[0]!, id: '' }];

    // An empty id is still a string, so it hashes — and mismatches, which is the honest outcome.
    expect(verifyChain(withoutId, { formats: registry }).valid).toBe(false);
  });
});

describe('appending Platform-sealed records after history', () => {
  it('leaves historical verification intact', () => {
    // The migration's end state: v3 history, then new records under the same v3 format, in one
    // chain with one gap-free sequence.
    let previous = GENESIS_HASH;
    const records: AuditRecord<string>[] = [];
    for (let i = 1; i <= 5; i++) {
      const record = toPlatformRecord(
        docsEvent({ sequence: BigInt(i), eventId: `0199aaaa-0000-7000-8000-00000000000${i}` }),
        previous,
        CHAIN_HASH_V3,
      );
      records.push(record);
      previous = record.hash;
    }

    expect(verifyChain(records, { formats: registry })).toEqual({ valid: true, checked: 5 });
    // …and the first two — the "historical" ones — still verify on their own.
    expect(verifyChain(records.slice(0, 2), { formats: registry }).valid).toBe(true);
  });
});
