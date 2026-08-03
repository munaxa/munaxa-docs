import { createHash } from 'node:crypto';

/**
 * The audit hash chain.
 *
 * Each event's digest covers the previous event's digest, so removing or editing any event
 * breaks every digest after it. That is what makes the trail *tamper-evident* rather than
 * merely append-only: the database grants already forbid `UPDATE` and `DELETE` to the
 * application role, and this catches anyone who gets around them
 * (`docs/architecture/13-audit-architecture.md`).
 *
 * Pure and deterministic on purpose — the verifier that runs daily is the same function.
 */
export const GENESIS_HASH = '0'.repeat(64);

export interface ChainedEventInput {
  readonly eventId: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  readonly actorId: string | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcome: string;
  readonly payload: unknown;
}

/**
 * Canonical serialisation: field order fixed here rather than taken from object key order,
 * and object keys sorted recursively. A digest that depends on how a payload happened to be
 * constructed would break verification for reasons that have nothing to do with tampering.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`);
  return `{${entries.join(',')}}`;
}

export function chainHash(previousHash: string, event: ChainedEventInput): string {
  const material = [
    previousHash,
    event.eventId,
    event.tenantId,
    event.occurredAt.toISOString(),
    event.actorId ?? '',
    event.action,
    event.subjectType,
    event.subjectId,
    event.outcome,
    canonicalize(event.payload),
  ].join('|');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

export interface ChainLink {
  readonly hash: string;
  readonly previousHash: string;
  readonly event: ChainedEventInput;
}

export interface VerificationResult {
  readonly intact: boolean;
  /** The first link whose digest does not recompute — where the trail stops being evidence. */
  readonly brokenAt: string | null;
  readonly verified: number;
}

export function verifyChain(links: readonly ChainLink[], from = GENESIS_HASH): VerificationResult {
  let previous = from;
  let verified = 0;

  for (const link of links) {
    if (link.previousHash !== previous || chainHash(previous, link.event) !== link.hash) {
      return { intact: false, brokenAt: link.event.eventId, verified };
    }
    previous = link.hash;
    verified += 1;
  }
  return { intact: true, brokenAt: null, verified };
}
