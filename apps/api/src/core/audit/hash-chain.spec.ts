import { describe, expect, it } from 'vitest';

import { GENESIS_HASH, type ChainLink, canonicalize, chainHash, verifyChain } from './hash-chain';

const event = (id: string, action = 'DOCUMENT_PUBLISHED') => ({
  eventId: id,
  tenantId: 'tenant-1',
  occurredAt: new Date('2026-01-01T10:00:00.000Z'),
  actorId: 'user-1',
  action,
  subjectType: 'DOCUMENT',
  subjectId: 'doc-1',
  outcome: 'SUCCESS',
  payload: { from: 'APPROVED', to: 'PUBLISHED' },
});

function chain(count: number): ChainLink[] {
  const links: ChainLink[] = [];
  let previous = GENESIS_HASH;
  for (let index = 0; index < count; index += 1) {
    const current = event(`event-${index}`);
    const hash = chainHash(previous, current);
    links.push({ hash, previousHash: previous, event: current });
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
    const result = verifyChain(chain(5));
    expect(result.intact).toBe(true);
    expect(result.verified).toBe(5);
  });

  it('detects an edited event', () => {
    const links = chain(5);
    links[2] = { ...links[2]!, event: { ...links[2]!.event, action: 'DOCUMENT_DELETED' } };
    const result = verifyChain(links);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe('event-2');
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
});
