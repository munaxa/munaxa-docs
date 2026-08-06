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
 *
 * ## Why there are two versions
 *
 * Phase 1's digest covered nine fields and left seven uncovered: `sequence`, `channel`,
 * `reason`, `onBehalfOfId`, `correlationId`, `ipAddress` and `userAgent`. Three of those are
 * evidence in their own right — a confidentiality level can *require* a stated reason, a
 * delegation puts a second identity on the act, and the sequence is the whole of the argument
 * that nothing was removed from the end. A bundle that claimed to attest them would be
 * claiming more than the chain proved.
 *
 * So the digest is widened, and the widening is *versioned* rather than retrospective. Rows
 * written before Phase 9 cannot be rehashed — the table refuses `UPDATE` to every role,
 * including the owner, which is precisely the property that makes the trail worth having. A
 * version stamped on each row is therefore the only honest way to widen: v1 rows are verified
 * against the field set they were written under, v2 rows against the wider one, and
 * `attestedFields()` tells an evidence bundle's manifest exactly which of the two applies to
 * each row it contains.
 */
export const GENESIS_HASH = '0'.repeat(64);

/** The Phase 1 digest: nine fields, and the seven `CHAIN_HASH_V2` adds left uncovered. */
export const CHAIN_HASH_V1 = 1;
/** The Phase 9 digest: every column that carried a fact when Phase 9 wrote it. */
export const CHAIN_HASH_V2 = 2;
/**
 * The Phase 17 digest: v2 plus `apiClientId`.
 *
 * Widened for the same reason and by the same mechanism Phase 9 used, which is why this is three
 * lines rather than a redesign. `api_client_id` records *which credential* took an action — the
 * first question an incident asks — and a column the digest does not cover is a column somebody
 * with write access can change without breaking anything. Phase 9's own words apply unchanged: a
 * bundle that claimed to attest it would be claiming more than the chain proved.
 *
 * Versioned rather than retrospective, again, and for the reason that has not changed: the table
 * refuses `UPDATE` to every role including the owner, so rows written under v1 and v2 cannot be
 * rehashed and must keep verifying against the field set they were written under.
 */
export const CHAIN_HASH_V3 = 3;

/**
 * What a new append is written with. Reading dispatches on the row's own stamp, never this.
 *
 * The append path no longer reads it: `@munaxa/audit` seals new records under
 * `DOCS_CANONICAL_V3`, which reproduces `chainHash(…, CHAIN_HASH_V3)` byte for byte
 * (`platform-canonical.spec.ts`). It survives because the *verifier* still needs a version to
 * fall back to for a row stamped with something this build does not recognise.
 */
export const CURRENT_CHAIN_HASH_VERSION = CHAIN_HASH_V3;

export type ChainHashVersion = typeof CHAIN_HASH_V1 | typeof CHAIN_HASH_V2 | typeof CHAIN_HASH_V3;

export function isChainHashVersion(value: number): value is ChainHashVersion {
  return value === CHAIN_HASH_V1 || value === CHAIN_HASH_V2 || value === CHAIN_HASH_V3;
}

export interface ChainedEventInput {
  readonly eventId: string;
  readonly tenantId: string;
  readonly sequence: bigint;
  readonly occurredAt: Date;
  readonly actorId: string | null;
  readonly onBehalfOfId: string | null;
  readonly channel: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcome: string;
  readonly payload: unknown;
  readonly reason: string | null;
  readonly correlationId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /** The API key the request arrived on — Phase 17. Null for every human request. */
  readonly apiClientId: string | null;
}

/**
 * The fields each version's digest covers, in digest order.
 *
 * Exported because an evidence bundle has to say what it proves. A manifest that listed every
 * column beside a v1 hash would be asserting attestation the digest does not provide, which is
 * the one failure mode an evidence bundle cannot have.
 */
export function attestedFields(version: ChainHashVersion): readonly string[] {
  if (version === CHAIN_HASH_V3) {
    return V3_FIELDS;
  }
  return version === CHAIN_HASH_V2 ? V2_FIELDS : V1_FIELDS;
}

const V1_FIELDS: readonly string[] = Object.freeze([
  'previousHash',
  'eventId',
  'tenantId',
  'occurredAt',
  'actorId',
  'action',
  'subjectType',
  'subjectId',
  'outcome',
  'payload',
]);

const V2_FIELDS: readonly string[] = Object.freeze([
  ...V1_FIELDS,
  'sequence',
  'channel',
  'onBehalfOfId',
  'reason',
  'correlationId',
  'ipAddress',
  'userAgent',
]);

const V3_FIELDS: readonly string[] = Object.freeze([...V2_FIELDS, 'apiClientId']);

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

/**
 * The digest for one event under one version.
 *
 * The v1 material is byte-for-byte what Phase 1 produced, because every row written since then
 * has to keep verifying. The v2 material *appends* rather than interleaving, for the same
 * reason a wire format appends: a third version can extend it without moving anything.
 *
 * **Nothing appends through this any more.** `@munaxa/audit` seals every new record, under the
 * same three formats expressed as `CanonicalFormat`s in `platform-canonical.ts`. What is left
 * here is the *verification* path — `verifyChain` below, and the daily pass that calls it — which
 * has not been migrated. Keeping one function rather than two implementations of the same digest
 * was the point of expressing the formats over this one: `platform-canonical.spec.ts` asserts the
 * two agree by comparing against this function directly, so a drift is a failing test rather than
 * a trail that silently stops verifying.
 */
export function chainHash(
  previousHash: string,
  event: ChainedEventInput,
  version: ChainHashVersion = CURRENT_CHAIN_HASH_VERSION,
): string {
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
  ];
  if (version === CHAIN_HASH_V2 || version === CHAIN_HASH_V3) {
    material.push(
      event.sequence.toString(),
      event.channel,
      event.onBehalfOfId ?? '',
      event.reason ?? '',
      event.correlationId,
      event.ipAddress ?? '',
      event.userAgent ?? '',
    );
  }
  // Appended rather than interleaved, exactly as v2 appended to v1: a fourth version extends the
  // material without moving a byte of what came before, so every existing row keeps verifying.
  if (version === CHAIN_HASH_V3) {
    material.push(event.apiClientId ?? '');
  }
  return createHash('sha256').update(material.join('|'), 'utf8').digest('hex');
}

export interface ChainLink {
  readonly hash: string;
  readonly previousHash: string;
  readonly version: ChainHashVersion;
  readonly event: ChainedEventInput;
}

export interface VerificationResult {
  readonly intact: boolean;
  /** The first link whose digest does not recompute — where the trail stops being evidence. */
  readonly brokenAt: string | null;
  /** What went wrong at `brokenAt`, so an alert says more than "something". */
  readonly reason: BreakReason | null;
  readonly expectedHash: string | null;
  readonly actualHash: string | null;
  readonly verified: number;
}

/**
 * How a chain can fail, and each is a different accusation.
 *
 * `DIGEST_MISMATCH` — a field was altered. `LINK_MISMATCH` — a record was removed or inserted
 * in the middle. `SEQUENCE_GAP` — a record was removed, and the chain of the survivors is
 * intact because the removal took the link with it. The last is the case the hash alone cannot
 * see, and the reason `sequence` exists at all.
 */
export type BreakReason = 'DIGEST_MISMATCH' | 'LINK_MISMATCH' | 'SEQUENCE_GAP';

export interface VerifyOptions {
  /** The digest the first link must chain from — a checkpoint's hash, or genesis. */
  readonly from?: string;
  /**
   * The sequence the first link must carry. Given, the walk also proves contiguity; omitted,
   * it proves only that what is present chains, which is a weaker claim and is reported as one.
   */
  readonly fromSequence?: bigint;
}

export function verifyChain(
  links: readonly ChainLink[],
  options: VerifyOptions | string = {},
): VerificationResult {
  // A bare string is the Phase 1 signature — the starting digest — kept working because the
  // pure verifier is called from the chain's own tests as well as from the daily job.
  const { from = GENESIS_HASH, fromSequence } =
    typeof options === 'string' ? { from: options, fromSequence: undefined } : options;

  let previous = from;
  let expectedSequence = fromSequence;
  let verified = 0;

  for (const link of links) {
    if (expectedSequence !== undefined && link.event.sequence !== expectedSequence) {
      return broken(link, 'SEQUENCE_GAP', null, null, verified);
    }
    if (link.previousHash !== previous) {
      return broken(link, 'LINK_MISMATCH', previous, link.previousHash, verified);
    }
    const recomputed = chainHash(previous, link.event, link.version);
    if (recomputed !== link.hash) {
      return broken(link, 'DIGEST_MISMATCH', recomputed, link.hash, verified);
    }
    previous = link.hash;
    expectedSequence = link.event.sequence + 1n;
    verified += 1;
  }
  return {
    intact: true,
    brokenAt: null,
    reason: null,
    expectedHash: null,
    actualHash: null,
    verified,
  };
}

function broken(
  link: ChainLink,
  reason: BreakReason,
  expectedHash: string | null,
  actualHash: string | null,
  verified: number,
): VerificationResult {
  return {
    intact: false,
    brokenAt: link.event.eventId,
    reason,
    expectedHash,
    actualHash,
    verified,
  };
}
