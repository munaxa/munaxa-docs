import type { CanonicalFormat, CanonicalInput } from '@munaxa/audit';

import { canonicalize, GENESIS_HASH } from './hash-chain';

/**
 * Munaxa Docs' three historical digests, expressed as Platform canonical formats.
 *
 * These are not a re-implementation and not an approximation. Each one reproduces, byte for byte,
 * the material `chainHash()` has produced since the phase that introduced it — because the rows
 * they verify cannot be rehashed. The audit table refuses `UPDATE` to every role including the
 * owner, which is exactly the property that makes the trail worth having, and it means the only
 * way history stays verifiable is if the new verifier speaks the old format precisely.
 *
 * The material is `sha256` over a `|`-joined list. v2 *appends* to v1 and v3 to v2, which is why
 * this file is three declarations rather than three algorithms.
 *
 * ## Why the version numbers are 901–903
 *
 * A `CanonicalFormatRegistry` is keyed by number and the Platform owns 1…n for its own formats.
 * Docs' three are offset into a range the Platform will not reach, so a future `CANONICAL_FORMAT_V2`
 * cannot collide with a Docs format and silently reinterpret three years of digests. The offset is
 * arithmetic on the stored `chain_hash_version`, so the column keeps its own 1/2/3 values and no
 * row is rewritten.
 */
export const DOCS_FORMAT_OFFSET = 900;

/** Turn a stored `chain_hash_version` into its registry key, and back. */
export const toPlatformFormatVersion = (chainHashVersion: number): number =>
  DOCS_FORMAT_OFFSET + chainHashVersion;
export const toChainHashVersion = (formatVersion: number): number =>
  formatVersion - DOCS_FORMAT_OFFSET;

/**
 * The fields the Platform event cannot carry losslessly, kept verbatim under `docs`.
 *
 * `outcome` is here rather than read from `event.outcome` because the Platform's `EventOutcome` is
 * a closed lowercase union (`success` | `failure` | `denied` | `error`) while this product stored
 * and hashed `SUCCESS` | `DENIED` | `FAILED`. Mapping between them would be a guess about which
 * token produced which digest — `failure` and `FAILED` differ, and `error` never occurred here.
 * The digest covers what was written, so what was written is what is kept.
 *
 * `reason` and `apiClientId` are here because the Platform event has no field for them and the
 * digest covers both; `payload` is here because the digest covers the product's payload alone,
 * not the wrapper this object forms.
 */
export interface DocsAuditFields {
  readonly outcome: string;
  readonly reason: string | null;
  readonly apiClientId: string | null;
  readonly payload: unknown;
}

function docsFields(input: CanonicalInput): DocsAuditFields {
  const wrapper = input.event.payload as { docs?: DocsAuditFields } | undefined;
  const fields = wrapper?.docs;
  if (!fields) {
    // Refusing beats hashing `undefined` into the material: that produces a plausible digest and a
    // tamper report indistinguishable from a real one.
    throw new Error('Audit record is missing its Munaxa Docs field set; cannot canonicalize.');
  }
  return fields;
}

/**
 * The v1 material: nine fields, in the order Phase 1 wrote them.
 *
 * `previousHash` falls back to `GENESIS_HASH` because this product's column is `char(64)` and not
 * nullable — the first record in a tenant's chain carries 64 zeros where the Platform would carry
 * `null`. Hashing `null` here would break every genesis record in every tenant.
 */
function v1Material(input: CanonicalInput): string[] {
  const { event, previousHash, sequence, recordId } = input;
  const fields = docsFields(input);
  void sequence;
  return [
    previousHash ?? GENESIS_HASH,
    recordId ?? '',
    event.tenantId,
    new Date(event.occurredAt).toISOString(),
    event.actor?.id ?? '',
    event.name,
    event.target?.type ?? '',
    event.target?.id ?? '',
    fields.outcome,
    canonicalize(fields.payload),
  ];
}

/** v2 appends the seven fields Phase 9 widened the digest to cover. */
function v2Material(input: CanonicalInput): string[] {
  const { event, sequence } = input;
  const fields = docsFields(input);
  return [
    ...v1Material(input),
    sequence.toString(),
    event.source?.component ?? '',
    event.actor?.onBehalfOf ?? '',
    fields.reason ?? '',
    event.correlationId,
    event.source?.ipAddress ?? '',
    event.source?.userAgent ?? '',
  ];
}

/**
 * The canonical *material*, not a digest.
 *
 * The Platform hashes whatever `canonicalize` returns — `sha256(format.canonicalize(input))` — so a
 * format that returned a digest would be hashed a second time and every record would verify as
 * tampered. `chainHash` is `sha256(material.join('|'))`, so returning the join is what makes the
 * two byte-identical.
 */
const material = (parts: string[]): string => parts.join('|');

/**
 * Every format declares `recordId`, because all three hash the event id.
 *
 * That declaration is what makes the Platform refuse to run these against a record with no id,
 * instead of hashing `undefined` and reporting the whole chain as tampered.
 */
export const DOCS_CANONICAL_V1 = Object.freeze({
  version: toPlatformFormatVersion(1),
  requires: ['recordId'] as const,
  covers:
    'previousHash, eventId, tenantId, occurredAt, actorId, action, subjectType, subjectId, ' +
    'outcome, payload. Leaves sequence, channel, onBehalfOfId, reason, correlationId, ipAddress, ' +
    'userAgent and apiClientId uncovered — see CHAIN_HASH_V2.',
  canonicalize: (input: CanonicalInput) => material(v1Material(input)),
}) satisfies CanonicalFormat;

export const DOCS_CANONICAL_V2 = Object.freeze({
  version: toPlatformFormatVersion(2),
  requires: ['recordId'] as const,
  covers:
    'v1 plus sequence, channel, onBehalfOfId, reason, correlationId, ipAddress, userAgent. ' +
    'Leaves apiClientId uncovered — see CHAIN_HASH_V3.',
  canonicalize: (input: CanonicalInput) => material(v2Material(input)),
}) satisfies CanonicalFormat;

export const DOCS_CANONICAL_V3 = Object.freeze({
  version: toPlatformFormatVersion(3),
  requires: ['recordId'] as const,
  covers: 'v2 plus apiClientId. Every column carrying a fact at the time of writing.',
  canonicalize: (input: CanonicalInput) =>
    material([...v2Material(input), docsFields(input).apiClientId ?? '']),
}) satisfies CanonicalFormat;

/** The three formats, for a `CanonicalFormatRegistry`. */
export const DOCS_CANONICAL_FORMATS = [
  DOCS_CANONICAL_V1,
  DOCS_CANONICAL_V2,
  DOCS_CANONICAL_V3,
] as const;
